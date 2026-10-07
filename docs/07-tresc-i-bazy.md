# Treść, import WordPress i bazy aplikacji

**Status: implementacja bez uruchomionych testów, typechecku, migracji i usług.** Ten opis dotyczy kodu w bieżącym repo. Nie potwierdza zgodności z konkretną wersją serwera PostgreSQL lub MariaDB ani gotowości do produkcji.

## Baza aplikacji

`APP_DATABASE_URL` przyjmuje `postgres://`, `postgresql://`, `mysql://` albo `mariadb://`. `db:app` wybiera odpowiednio `db/app.sql` lub `db/app.mariadb.sql`. `db:auth` przekazuje natywny pool wybranego sterownika Better Auth. `db:project` wybiera `path` dla PostgreSQL i `mariadbPath` dla MariaDB. Nowe migracje projektu tworzą oba pliki; wydanie może zawierać SQL tylko dla używanego dialektu. MariaDB wykonuje DDL z niejawnymi commitami, więc instrukcje w jej pliku muszą być idempotentne po przerwaniu; zapis migracji następuje po wykonaniu SQL. Migracje obu dialektów mają osobne sumy kontrolne w odpowiadających im bazach. Obsługiwane są zwykłe instrukcje SQL rozdzielone średnikami, bez procedur z dyrektywą `DELIMITER`. Nie należy automatycznie tłumaczyć dowolnego SQL Shardu.

Manifest zaufanego modułu deklaruje `databaseDialects`. Brak deklaracji oznacza tylko PostgreSQL; aplikacja na MariaDB odmawia załadowania modułu bez jawnego `"mariadb"` w tej liście. Sama deklaracja nie zastępuje odpowiedniego SQL i implementacji repozytorium Shardu.

Geode i jego CLI nadal używają PostgreSQL. Instancja aplikacji nie potrzebuje bazy Geode do obsługi żądań.

### Produkcyjna MariaDB: TLS i konta

`APP_DATABASE_URL` jest połączeniem procesu aplikacji. `APP_MIGRATION_DATABASE_URL` jest połączeniem używanym tylko przez polecenia `db:app`, `db:auth`, `db:admin` i `db:project`. W produkcji oba muszą wskazywać ten sam dialekt, host i bazę, ale różnych użytkowników; CLI odrzuca brak drugiego URL, rozbieżny cel lub tego samego użytkownika. Konta utwórz na serwerze bazy przed migracjami. Przykładowy punkt wyjścia dla MariaDB (zastąp nazwy bazy, hosty klientów i hasła; ogranicz hosty do rzeczywistych adresów aplikacji i operatora migracji):

```sql
CREATE USER 'lattis_runtime'@'APP_HOST' IDENTIFIED BY 'UNIQUE_LONG_PASSWORD' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE ON lattis_app.* TO 'lattis_runtime'@'APP_HOST';

CREATE USER 'lattis_migrate'@'MIGRATION_HOST' IDENTIFIED BY 'DIFFERENT_LONG_PASSWORD' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES
  ON lattis_app.* TO 'lattis_migrate'@'MIGRATION_HOST';
```

Te uprawnienia są punktem wyjścia do oceny na docelowej wersji MariaDB i Better Auth, a nie potwierdzoną listą minimalną. Konto migracyjne nie powinno znajdować się w środowisku procesu API ani w plikach aplikacji dostępnych przez zdalny MCP. Dostarczaj jego URL tylko do procesu wykonującego migrację, np. przez osobny magazyn sekretów lub jednorazowe środowisko wdrożeniowe. Nie używaj konta `root` ani wspólnego konta dla API i migracji.

W produkcji `APP_DATABASE_CA_FILE` musi wskazywać CA z zaufanego kanału administracyjnego. Dla MariaDB oba URL muszą używać nazwy DNS, a certyfikat serwera musi mieć odpowiadający jej `subjectAltName` typu `DNS`; adapter odrzuca produkcyjny URL MariaDB z adresem IP. Przy certyfikacie samopodpisanym o ogólnym CN, bez SAN, samo skopiowanie certyfikatu do `APP_DATABASE_CA_FILE` nie wystarcza. Najpierw wystaw nowy certyfikat serwera z właściwym SAN (lub poproś o to operatora hostingu), włącz go na MariaDB i dopiero wtedy wskaż zaufaną CA w Lattis. Jeśli połączenie idzie przez proxy, SAN musi odpowiadać nazwie używanej przez klienta w URL. PostgreSQL może użyć adresu IP, jeśli certyfikat ma zgodny SAN typu `IP`.

Lattis ustawia `rejectUnauthorized: true` oraz `verifyIdentity: true` dla MySQL2. Bez drugiej opcji MySQL2 nie wykonuje sprawdzenia nazwy serwera. Używany sterownik nie daje obecnie obsługiwanej przez nas ścieżki do przypięcia certyfikatu zamiast sprawdzenia nazwy; dlatego wdrożenie z certyfikatem bez SAN pozostaje zablokowane. Nie ustawiaj `NODE_TLS_REJECT_UNAUTHORIZED=0`, nie dodawaj `rejectUnauthorized: false` ani `verifyIdentity: false` i nie zmieniaj nazwy w URL na ogólny CN certyfikatu. Nie uruchamiaj migracji ani API produkcyjnego, dopóki połączenie z poprawnym certyfikatem i oddzielnym kontem migracyjnym nie będzie przygotowane.

Przed przygotowaniem artefaktu dla konkretnego wdrożenia nadaj Core nową wersję i zsynchronizuj `package.json`, główny `package-lock.json`, `lattis.lock` oraz zakresy `coreCompatibility` lokalnych pakietów. `release:vendor-core` odmawia nadpisania artefaktu o tej samej wersji. Sama zmiana numeru nie oznacza, że kod został zweryfikowany lub jest gotowy produkcyjnie.

Opcjonalny immudb jest osobnym rejestrem odcisków audytu, nie zamiennikiem bazy aplikacji. Integrację opisuje [09 — Audyt immudb](09-immudb-audyt.md).

## Model treści

`lattis_content_type` definiuje typ i pola. Pola mają `name`, `type`, `required` i `public`. Dozwolone typy to `text`, `richtext`, `number`, `boolean`, `date`, `object`, `array`, `reference`, `media`, `json`. Dane nieznanego pola są odrzucane. Pole jest niewidoczne w publicznym API, jeśli nie ma `public: true`. `lattis_content` zawiera slug w obrębie typu, status `draft`/`published`/`archived`, treść, dane pól, znacznik publikacji i `revision`. Edycja wymaga `expectedRevision`.

`lattis_content_link` przechowuje nazwane, uporządkowane relacje do treści, zarejestrowanego Node, Shardu, medium albo zewnętrznej referencji. API sprawdza istnienie lokalnego celu. Publiczny odczyt ujawnia tylko linki do opublikowanej treści i mediów. Terminy taksonomii są osobnymi rekordami z relacją wiele do wielu. Migrator przesyła pliki mediów do prywatnego katalogu Core, a `lattis_content_source` odwzorowuje `(system, site, kind, external_id)` na trwałe ID treści i sumę wejścia.

Publiczne `GET /api/content` i `GET /api/content/:id` zwracają tylko opublikowaną treść. Zarządzanie jest w `/api/manage/content`, definicje w `/api/content-types`, terminy w `/api/taxonomy-terms`, media w `/api/media`. Trasy zarządzania wymagają sesji z grantem lub tokenu usługi z dokładnym zakresem, np. `content.write:content`, `content.type.manage:content`, `content.import:content`. Właściciel instancji ma grant `*`. Żądania modyfikujące z przeglądarki podlegają kontroli Origin. API JSON jest opisane w `openapi/app.json`; obecny opis nie zawiera pełnych schematów pól.

Przykład typu i wpisu:

```json
{"key":"article","label":"Articles","fields":[{"name":"subtitle","type":"text","required":false,"public":true}]}
```

```json
{"type":"article","slug":"hello","title":"Hello","body":"<p>Text</p>","status":"draft","data":{"subtitle":"Intro"}}
```

`PUT /api/manage/content/:id` przyjmuje `{ "expectedRevision": 1, "content": { ...pełny obiekt wpisu... } }`. `PUT /api/manage/content/:id/links` przyjmuje tablicę `{ "relation": "related", "targetKind": "content", "targetRef": "UUID", "position": 0 }`. Zastępuje całą listę linków. Analogicznie `/terms` przyjmuje tablicę UUID terminów. Relacje Node i Shard wskazują na nazwy aktualnie zarejestrowanych lokalnych modułów; nie wykonują kodu celu.

`NodeContext.invoke(name,input)` i `RouteContext.invoke(name,input)` wykonują zarejestrowany Node przez Core, sprawdzają uprawnienie celu i walidują jego wejście oraz wynik. Komenda wywołana z innej komendy lub mutującej trasy korzysta z tej samej transakcji i pochodnego klucza idempotencji; wywołanie komendy z query/GET jest odrzucane. Cykle i głębokość powyżej ośmiu są blokowane. Istniejące lokalne zaufane moduły nadal dostają port `db.query`; port nie zapewnia izolacji tabel Shardów. Kod obcych wydawców nie jest ładowany w procesie aplikacji.

Core rejestruje także Nodes `lattis.content.get`, `lattis.content.create`, `lattis.content.update` i `lattis.content.links.replace`. Są widoczne w `/api/nodes`, działają przez `/api/nodes/:name/execute` oraz przez `context.invoke()` z innego Node lub Shardu. Komendy wymagają nagłówka `Idempotency-Key`; `get` wymaga uprawnienia do odczytu także dla pełnych, niepublicznych danych wpisu.

## Import WordPress

Core nie pobiera plików z adresów WordPress. Wtyczka WP-CLI przesyła porcje JSON i bajty plików do Core. `POST /api/imports/wordpress/batches`; `GET /api/imports/wordpress/cursor?site=...&importKey=...` zwraca ostatni zapisany kursor treści. `site` i `importKey` muszą pozostać identyczne przy wznawianiu. `expectedCursor` musi równać się ostatniemu zapisanemu kursorowi; powtórzenie ukończonej porcji z tym samym `nextCursor` jest pomijane. Każda pozycja jest aktualizowana na podstawie trwałego mapowania źródła; ten sam payload jest pomijany. Kursor jest zapisywany po całej porcji i jej relacjach. Po przerwaniu można wysłać porcję ponownie.

```json
{
  "site":"https://example.org/",
  "importKey":"initial-export",
  "expectedCursor":null,
  "nextCursor":"page-2",
  "types":[{"type":"book","label":"Books","publicFields":["isbn"]}],
  "terms":[{"id":4,"taxonomy":"genre","slug":"fiction","label":"Fiction"}],
  "media":[],
  "items":[{"id":12,"type":"book","slug":"example-book","title":{"rendered":"Example book"},"content":{"rendered":"<p>Body</p>"},"status":"publish","acf":{"isbn":"978..."},"terms":{"genre":[4]},"featuredMedia":10}]
}
```

Typy WordPress, w tym CPT, mapują się na neutralne typy treści. ACF trafia do pól `acf.<nazwa>` i zachowuje wartość JSON; nowe pola są domyślnie prywatne, chyba że `publicFields` wskazuje je przy utworzeniu typu. `relations` może łączyć pozycje przez ich zewnętrzne `(targetType,targetId)`. Powiązane pozycje muszą być już zaimportowane, w tej samej lub wcześniejszej porcji; brak celu zwraca konflikt do ponowienia. Terminy, media i autorzy są odwzorowywani po ID źródłowym. Wtyczka przepisuje znane adresy przesłanych mediów w treści i ACF na adresy Core. Nie konwertuje motywu ani układu bloków. Surowy HTML WordPress jest przechowywany jako tekst; frontend musi określić własne zasady sanitizacji przed renderowaniem. Szczegóły instalacji i bezpieczeństwa: [08 — migracja WordPress](08-migracja-wordpress-i-bezpieczenstwo.md).

## Ograniczenia do dalszej pracy

- Kontrakty typów i pól nie mają jeszcze historii zmian ani migracji wartości między wersjami.
- Publiczny odczyt nie ma polityki per wpis poza statusem publikacji; prywatne pola są filtrowane według definicji typu.
- SQL zaufanego Shardu jest zależny od wybranego dialektu, a `db.query` nie izoluje tabel między Shardami.
- Rekonsyliacja relacji do nieobecnych pozycji i konwersja bloków Gutenberga wymagają osobnych adapterów. Zamiana adresów mediów obejmuje adresy rozpoznane przez WordPress, więc niestandardowe/CDN odwołania mogą wymagać ręcznej korekty.
- Nie uruchomiono testów, lintu, typechecku, builda ani usług. Instalacja `mysql2` była wykonana z `--ignore-scripts`, ale npm automatycznie uruchomił audit zależności; dalsze kontrole nie były wykonywane.
