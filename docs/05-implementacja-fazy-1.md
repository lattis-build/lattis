# 05. Pierwsza aplikacja na Lattis

> Aktualizacja 0.2.0-alpha.1: bieżący kontrakt instalacji i wdrożenia opisuje [dokument 14](14-publiczne-wydanie-0.2.md). Poniższe przykłady 0.1 zachowano jako kontekst rozwoju; nie są aktualną instrukcją wdrożenia produkcyjnego. Lock v1, dowolny GEODE_BASE_URL, edycja produkcyjnego workspace przez MCP i stary release:prepare nie należą do nowego procesu.

**Stan głównego repo:** Lattis ma kod Core, CLI, Geode, MCP oraz adaptery PostgreSQL i MariaDB dla bazy aplikacji. W tym repo nie uruchomiono testów, kompilacji, skanów ani wdrożenia; obsługa MariaDB nie została potwierdzona na docelowym serwerze. Geode nadal używa PostgreSQL. Poniższa ścieżka nie jest potwierdzeniem gotowości produkcyjnej. Model treści i ograniczenia adapterów opisuje [07 — Treść i bazy](07-tresc-i-bazy.md), a pozostałe luki [06 — Kompozycja i porty](06-kompozycja-porty-i-backlog.md).

## Utworzenie projektu

CLI działa z checkoutu Core. `init` tworzy nowy, pusty katalog aplikacji: `package.json`, `tsconfig.json`, `lattis.config.json`, `lattis.lock`, `.env.example`, `.gitignore`, `packages/local/` i `migrations/`. Nie generuje CMS, LMS ani innego modelu domenowego.

```sh
cd /sciezka/do/Lattis
npm run lattis -- init ../moja-aplikacja
cd ../moja-aplikacja
npm install --ignore-scripts
```

Zależność `lattis` w utworzonym `package.json` wskazuje lokalny checkout Core przez `file:`. Jest to wygodne podczas rozwijania aplikacji. Przed przeniesieniem projektu na inną maszynę użyj opisanego niżej `release:vendor-core`; lokalna ścieżka z komputera autora nie jest przenośnym wdrożeniem.

Uzupełnij `.env` z `.env.example`: osobna baza aplikacji PostgreSQL albo MariaDB, długi losowy `BETTER_AUTH_SECRET`, rzeczywisty `APP_BASE_URL`, `LATTIS_OWNER_EMAIL`, adres frontendu w `LATTIS_TRUSTED_ORIGINS` i dostawcę poczty dla weryfikacji oraz resetu hasła. Produkcyjne migracje wymagają osobnego konta w `APP_MIGRATION_DATABASE_URL`; dla MariaDB wymagany jest też prawidłowy certyfikat DNS SAN i zaufany `APP_DATABASE_CA_FILE`, zgodnie z [instrukcją bazy](07-tresc-i-bazy.md#produkcyjna-mariadb-tls-i-konta). `APP_HOST` domyślnie wynosi `127.0.0.1`; dla kontenera ustaw go zgodnie z siecią wdrożenia i chroń API przez reverse proxy z TLS. Sekretów nie zapisuj w Git.

## Core, właściciel i własne moduły

Migracje Core, Better Auth i aplikacji są oddzielne. Po przygotowaniu bazy oraz `.env`:

```sh
npm run lattis -- db:app
npm run lattis -- db:auth
npm run lattis -- app:owner
```

`app:owner` uruchamia interaktywny `create-admin` Better Auth z adresem `LATTIS_OWNER_EMAIL`; hasła nie przekazuje się w argumencie. CLI tworzy administratora ze zweryfikowanym adresem. Właściciel dostaje rolę Core po zalogowaniu. Plugin Admin Better Auth ma dodatkową, własną rolę do zarządzania użytkownikami. Jeśli baza ma już użytkowników, CLI Better Auth może wymagać interaktywnego potwierdzenia.

Stwórz Node lub Shard w projekcie:

```sh
npm run lattis -- node:new @owner/nazwa packages/local/nazwa
npm run lattis -- shard:new @owner/obszar packages/local/obszar
```

Polecenie zapisuje manifest i `index.ts`, a także dodaje ścieżkę modułu do `trustedModules`. `index.ts` eksportuje początkowo pustą tablicę `nodes`; Shard eksportuje też `routes`. Własny kod dopisuje `NodeDefinition`: nazwę, pakiet, typ `query` lub `command`, akcję i typ zasobu, schematy Zod wejścia i wyjścia oraz `handler`. Core ładuje **wyłącznie lokalne ścieżki jawnie wymienione w konfiguracji**; paczka pobrana z Geode pozostaje danymi, nie kodem uruchamianym w aplikacji.

### Trasy Shardu

Shard może deklarować `ShardRouteDefinition[]` w `index.ts`. Każda trasa ma stabilną nazwę, metodę `GET`, `POST`, `PUT`, `PATCH` lub `DELETE`, lokalną ścieżkę, Zod `input` i `output`, `handler` oraz jawne `access`. Lokalną ścieżkę `/zasoby/:id` Core wystawia pod `/api/shards/<wydawca>/<pakiet>/zasoby/:id`. Trasa `/` wskazuje korzeń tej przestrzeni. Odpowiedni wpis `name`, `method`, `path` i `access` musi znaleźć się w `lattis.manifest.json` w `routes`; rozbieżność zatrzymuje start API.

Schemat `input` waliduje obiekt `{ params, query, body }`. `handler` otrzymuje port bazy aplikacji, tożsamość oraz dostęp do sekretów zadeklarowanych w manifeście i w trasie. `output` waliduje odpowiedź; błędny wynik modułu staje się błędem serwera. `GET` może mieć `access: { kind: 'public' }` albo wymagać uprawnienia przez `access: { kind: 'permission', action, resourceType, resourceId? }`. Publiczna trasa nie otrzymuje tożsamości użytkownika. Modyfikujące metody zawsze wymagają uprawnienia i `Idempotency-Key`; handler i zapis odpowiedzi są w jednej transakcji. GET dostaje połączenie z bazą bez transakcji komendy i powinien pozostać odczytem. Zaufany Shard musi jawnie deklarować obsługiwane dialekty bazy.

`/openapi.json` dołącza deklaracje załadowanych tras i wymagania uprawnień. Dokument podaje na razie ogólne schematy JSON; schematy Zod są egzekwowane w runtime, ale nie są automatycznie konwertowane do pełnego OpenAPI. Idempotencja obejmuje transakcję bazy i zapis odpowiedzi; efekty w usługach zewnętrznych wymagają osobnego wzorca, np. outbox. Silnik tras nie dodaje UI.

Tworzenie migracji domeny:

```sh
npm run lattis -- migration:new 001_struktura expand
npm run lattis -- migration:new 002_kursy expand packages/local/obszar
```

Pierwszy wariant tworzy migrację projektu. Drugi zapisuje SQL wewnątrz Shardu oraz dopisuje plik i migrację do jego manifestu, aby można było później opublikować Shard w Geode. Oba warianty dodają wpis do `lattis.config.json`. Zastąp znacznik w pliku rzeczywistym SQL, potem zastosuj świadomie wybraną fazę. Nowe pliki kodu dodawane do pakietu wpisz też do `manifest.files` przed publikacją lub przygotowaniem wydania:

```sh
npm run lattis -- db:project expand
```

`db:project` zapisuje ID i SHA-256 każdej zastosowanej migracji oraz odmawia ponownego zastosowania zmienionego pliku. PostgreSQL wykonuje pojedynczą migrację w transakcji; MariaDB wykonuje DDL z niejawnymi commitami, więc jego SQL musi być idempotentny po przerwaniu. Fazy `backfill` oraz `contract` wywołuje się osobno. Migracje projektu nie wykonują się podczas startu API. Kolejność w konfiguracji jest kolejnością zastosowania w danej fazie. Przed usuwaniem starych kolumn trzeba upewnić się, że wszystkie instancje używają nowego kodu.

Uruchomienie API aplikacji: `npm run app`. Frontend w dowolnym frameworku korzysta z `/api/auth/*`, `/api/me`, `/api/nodes` i `/api/nodes/:name/execute`. Komenda Node wymaga nagłówka `Idempotency-Key`; handler i zapis wyniku wykonują się w jednej transakcji. Każdy Node musi deklarować wymagane uprawnienie. Role i przypisania są obsługiwane przez API Core; dostęp domyślnie jest odmówiony. Zarys kontraktu HTTP jest w `openapi/app.json`.

## Geode i MCP

Geode jest osobną usługą z własną bazą i trwałym magazynem artefaktów. Do samego uruchomienia aplikacji nie jest potrzebny, ale może od początku zbierać własne Nodes i Shards. W checkoutcie Core skonfiguruj `GEODE_*`, bazę Geode, OAuth IdP dla chronionych narzędzi zdalnego MCP, następnie użyj `db:geode`, `keygen`, `geode:bootstrap` i uruchom `npm run geode`. Publikację własnego pakietu wywołaj z katalogu operatora Geode, gdzie przechowywany jest klucz wydawcy: `geode:publish /ścieżka/do/aplikacji/packages/local/obszar public|private`. Licencję oraz manifest należy uzupełnić przed publikacją; wersja w Geode jest niemutowalna. Lokalny MCP projektu aplikacji uruchamia `npm run mcp:local` i udostępnia tworzenie modułów i migracji.

`geode:install` pobiera, sprawdza podpis i przypina wersję do `lattis.lock`, lecz nie aktywuje jej nawet jako zaufanego pakietu w runtime. Aktywacja zaufanego własnego pakietu przez niezmienne wydanie jest pracą w [ADR-C07](06-kompozycja-porty-i-backlog.md). Oferta Geode obsługuje `free`, `one-time` i `subscription` jako **model oferty**. Rozliczenie i automatyczne odnawianie nie są zaimplementowane; uprawnienia do prywatnych pakietów nadaje się ręcznie. Zdalny MCP jest dostępny jako oddzielna powierzchnia publiczna po skonfigurowaniu TLS i OAuth.

## Pierwsze wydanie

Poniższa ścieżka opisuje obecne narzędzia przygotowania kandydata. Nie zawiera niezależnej autoryzacji wdrożenia ani aktualizatora odpornego na podmianę Core. Docelowy proces produkcyjny określa [13 — Aktualizacje całego Lattis](13-architektura-aktualizacji-lattis.md), a granice pakietów — [12 — Geode: zaufanie i izolacja](12-geode-zaufanie-i-izolacja.md). Projekty te wymagają implementacji.

Po ustaleniu wersji Core przygotuj jego lokalny artefakt w repo aplikacji:

```sh
npm run lattis -- release:vendor-core
npm install --ignore-scripts
npm run lattis -- release:prepare
```

`release:vendor-core` pakuje aktualną wersję Core bez skryptów instalacyjnych do `vendor/lattis-<wersja>.tgz`, zmienia zależność aplikacji na ten plik i odmawia nadpisania istniejącego artefaktu tej samej wersji. Przed tym krokiem nadaj nowy numer Core i zsynchronizuj lock oraz zgodność lokalnych pakietów; obecne `0.1.0` nie powinno identyfikować kolejnego odmiennego artefaktu. Do wydania dołącz `vendor/`, aplikacyjny `package-lock.json`, konfigurację modułów i SQL. `release:prepare` tworzy opis kandydata obejmujący wersję i sumę paczki Core, przypięte pakiety Geode oraz sumy lokalnych modułów i migracji. Polecenie jest osobną, świadomie wywoływaną kontrolą integralności; nie uruchamia testów ani migracji. Konieczne są także zarządzane sekrety, backup wybranej bazy, dostawca poczty i terminacja TLS.

Zero downtime wymaga infrastruktury z co najmniej dwiema instancjami API i load balancerem. Sekwencja: migracje `expand`, nowa instancja obok starej, skierowanie ruchu po gotowości, obserwacja, wyłączenie starej instancji, a `contract` dopiero w późniejszym wydaniu. Cofnięcie wersji kodu wymaga wstecznie zgodnego schematu. Lattis ma endpointy `/health/live` i `/health/ready`, ale nie dostarcza jeszcze automatycznego rollout/rollback, orkiestracji ani gwarancji dostępności.

## Granica fazy

Lattis dostarcza fundament i ścieżkę dodania pierwszej **własnej** domeny. Późniejszy zakres repo dodaje opcjonalny panel właściciela i zdalny MCP aplikacji, opisane w [11 — Panel i zdalny MCP](11-panel-i-zdalny-mcp.md). Nie zawiera gotowego CMS, LMS ani frontendu produktu. Nie ma uruchomionych testów, przeglądu bezpieczeństwa czy wdrożenia referencyjnego. Przed publicznym uruchomieniem właściciel powinien zlecić odpowiednią weryfikację, zgodnie z zasadą repo, że nie wykonuje się jej automatycznie podczas pracy nad kodem.
