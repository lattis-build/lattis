# 06. Kompozycja modułów i przenośność — kontrakty oraz backlog

**Status: projekt architektury, 28 września 2026.** Ten dokument opisuje wymagane zmiany Core, a nie zaimplementowane funkcje. Jest odpowiedzią na pierwsze realne zastosowanie Lattis: Persec oraz planowany LMS ze sprzedażą. Reguły kursów, firm, miejsc i dostawcy płatności należą do pakietów aplikacji. Żadnych testów, buildów, skanów ani prób tych kontraktów nie wykonano w ramach tego dokumentu.

## 1. Stan faktyczny i granice obecnego kodu

| Obszar | Jest w głównym repo Lattis 0.1.0 | Brakuje do deklarowanej kompozycji |
|---|---|---|
| Node | Runtime ładuje lokalne, jawnie zaufane `query` i `command`, sprawdza Zod oraz uprawnienie na wejściu HTTP. Komenda zapisuje wynik i klucz idempotencji w transakcji PostgreSQL. | Portu Node → Node, wersjonowanego kontraktu błędów, kontekstu organizacji, obsługi zdarzeń i efektów zewnętrznych. Handler dostaje `pg.PoolClient`, więc nie ma izolacji danych innych Shardów ani przenośności DB. |
| Manifest i API | Manifest waliduje metadane pakietu; runtime porównuje listę tras. OpenAPI dopisuje trasy Shardów. | Manifest deklaruje `event` i `event-handler`, których runtime nie wykonuje. OpenAPI tras ma puste schematy treści; nie jest pełnym odbiciem Zod. Runtime nie wymaga, by deklaracje Node w manifeście odpowiadały implementacji. |
| Shard | Zaufane lokalne trasy mogą korzystać z `GET` publicznego lub z chronionych metod; mutacje wymagają klucza idempotencji. | Publiczny `POST` z surowym body i podpisem, deklarowanej polityki ingress, routingu zdarzeń i własności danych egzekwowanej poza konwencją. |
| Stan trwały | Core, Geode i migrator głównego repo używają `pg`, składni PostgreSQL i jego blokad doradczych. | Portów transakcji, migracji, receipt i audytu oraz adaptera MariaDB. Fork Persec dla MariaDB nie jest wspólnym wydaniem Core. Geode może pozostać na PostgreSQL. |
| Geode → aplikacja | `geode:install` pobiera artefakt, weryfikuje digest/podpis i przypina go w `lattis.lock`; `release:prepare` opisuje kandydata. | Automatycznego przygotowania zaufanego pakietu do wydania i aktywacji. Runtime ładuje tylko `trustedModules` z lokalnych ścieżek. Pobranie pakietu nie daje działającego Node. |
| Identity, policy, secrets | Better Auth, role i zakresy kont usługi, referencje sekretów oraz zewnętrzny provider HTTP. | Stabilnego, kompletnego kontraktu dla dowolnego frontendu, organizacji i relacji do zasobu, autoryzacji każdego wywołania wewnętrznego, gotowego produkcyjnego adaptera sekretów z audytem. Sam manifest capability nie ogranicza przywilejów zaufanego kodu w procesie. |

Persec używa lokalnego forka Core z MariaDB. Jego Shard `@persec/records` nie eksportuje własnych Nodes, a produkcja nie używa jeszcze Geode. Istniejące uruchomienie nie dowodzi przenośności pakietów, pełnej ścieżki auth ani gotowości do sprzedaży. [Plan produktu Persec](</Users/krzysztofkrajewski/Documents/cybersec/persec-lattis-mariadb/LMS_IMPLEMENTATION_PLAN.md>) jest wejściem do wymagań, nie częścią Core.

## 2. ADR do wdrożenia w Core

### ADR-C01 — Jeden kontrakt pakietu, odzwierciedlony we wszystkich interfejsach

**Rekomendacja:** kanoniczny, serializowalny deskryptor Node/Shard w manifeście; implementacja TypeScript jest osobnym artefaktem powiązanym digestem. Stabilna referencja ma postać `@wydawca/pakiet:nazwa@wersja`, a wywołujący przypina wersję przez wydanie/lockfile. Kontrakt zawiera: `kind`, nazwę, wersję schematu, JSON Schema wejścia/wyjścia i jawnych błędów, akcję i typ zasobu, deklarowane capabilities i nazwy sekretów, tryb idempotencji, zależności i wymagany zakres wersji Core. Nie przechowuje wartości sekretów ani funkcji JavaScript. Zod może być użyty w implementacji, ale opublikowany schemat i walidator runtime muszą opisywać tę samą semantykę; brak wiernej konwersji blokuje publikację danego kontraktu. Manifest, runtime, CLI/MCP, Geode i OpenAPI czytają tę samą definicję zamiast pięciu ręcznie utrzymywanych opisów.

`command` i `query` pozostają jedynymi wykonywalnymi typami do chwili implementacji ADR-C03. `event` jest kontraktem danych, a `event-handler` kontraktem subskrypcji; nie wolno ogłaszać ich obsługi tylko dlatego, że nazwy występują w `src/manifest.ts`. Zmiana niekompatybilna wymaga nowej wersji kontraktu oraz jawnego okresu współistnienia starej i nowej wersji.

### ADR-C02 — Port wywołań Node i granica transakcji

**Rekomendacja:** `NodeContext.invoke(ref, input, options)` wywołuje inny przypięty Node przez rejestr Core. Port przenosi ustalony przez Core `Principal` (`user`, `service` lub ograniczony `system`), kontekst organizacji i zasobu, `correlationId`, `causationId`, głębokość wywołania oraz klucz idempotencji. Kod Shardu nie może podmienić Principal ani ominąć ponownej decyzji `Policy` dla docelowej akcji. Przed wywołaniem Core sprawdza wersję, schemat wejścia i zależność pakietu; po wywołaniu schemat wyniku/błędu. Zapis audytu obejmuje także odmowę. Cykl i przekroczenie limitu głębokości kończą się jawnym błędem kontraktu.

Sama kompozycja działa zwykłym kodem Shardu; Canvas i Graph AST nie są potrzebne. Przyszły Graph AST ma odwoływać się do tych samych wersji, schematów i portu. Nie dopuszczać importu implementacji innego Shardu, wywołania własnego API po loopback ani bezpośredniego SQL do jego tabel jako sposobu kompozycji.

**Atomowość:** dla lokalnych, zaufanych Nodes tej samej instancji i jednej bazy Core może przekazać wspólny `UnitOfWork` oraz zapisać wszystkie receipt w transakcji korzeniowej. Zagnieżdżone wywołanie nie otwiera własnego commitu; klucz potomny jest deterministycznie wyprowadzany z klucza korzenia i ścieżki wywołań. Konflikt idempotencji i błąd domenowy wycofuje transakcję. Inna baza, proces lub usługa nie ma wspólnej transakcji — wtedy użyć zdarzenia i jawnej kompensacji/uzgodnienia, nie obiecywać globalnego ACID. Port danych Shardu musi ograniczać dostęp do własnych tabel; obecny `PoolClient` tego nie zapewnia. Dla kodu in-process jest to nadal granica zaufania organizacyjnego, a nie sandbox.

### ADR-C03 — Trwałe zdarzenia między modułami

**Rekomendacja:** `EventBus.publish` zapisuje wersjonowane zdarzenie do outbox w tej samej transakcji co zmianę domenową. Koperta zawiera ID zdarzenia, nazwę i wersję kontraktu, minimalny payload, klucz agregatu/kolejność, czas, correlation/causation ID oraz niezbędny kontekst autoryzacyjny bez sekretów i zbędnych danych osobowych. Worker dostarcza co najmniej raz; odbiorca zapisuje inbox/dedup po parze `subscriptionId,eventId` w tej samej transakcji co własny efekt. Retry ma backoff, limit prób, stan błędu, kolejkę ręcznej obsługi i możliwość uzgodnienia stanu z systemem źródłowym. Wersje konsumentów muszą współistnieć podczas wydania expand/contract.

Nie deklarować „exactly once” dla sieci. Zdarzenie nie nadaje odbiorcy praw użytkownika automatycznie: handler działa jako jawny principal systemowy z ograniczoną polityką i audytem. Migracja zdarzenia między bazami/instancjami jest asynchroniczna i wymaga replay/reconciliation.

### ADR-C04 — Ograniczony publiczny ingress/webhook

**Rekomendacja:** osobny rodzaj deklaracji `ingress`, nie ogólne `access: public` dla wszystkich mutacji. Dozwolony jest jawnie zarejestrowany `POST` na niekolizyjnej ścieżce, z limitem bajtów, czasem, typem treści, dozwolonymi nagłówkami, zachowaniem oryginalnych bajtów przed parserem i ograniczeniem liczby żądań. Zaufany adapter dostawcy weryfikuje podpis przed deserializacją domenową i przed wykonaniem Node. Po weryfikacji Core mapuje tożsamość dostawcy na ograniczony principal systemowy, wymusza idempotencję oraz pozwala wskazać dokładne bajty i status ACK **dopiero po trwałym przyjęciu**. Błędy podpisu, błędy domenowe i niejednoznaczny wynik mają osobne ścieżki.

Konkretny dpay wymaga raw body, weryfikacji IPN i odpowiedzi o treści dokładnie `OK`; kwotę należy porównać z zamówieniem, a zdarzenie może przyjść wielokrotnie. To wymaganie dostawcy potwierdza [dokumentacja dpay Node SDK](https://docs.dpay.pl/sdk/node/). Kod SDK, parser dpay i format ACK pozostają w pakiecie adaptera płatności, nie w Core. Do czasu wdrożenia portu ingress aplikacja może mieć własny, zweryfikowany endpoint Nuxt, który po sprawdzeniu podpisu wywoła chroniony Node Lattis; nie nazywać go trasą Shardu.

### ADR-C05 — Efekty zewnętrzne po commicie

**Rekomendacja:** komenda zapisuje w transakcji intencję efektu z `operationId`/kluczem dostawcy. Worker po commicie wykonuje sieć, zapisuje wynik i publikuje zdarzenie. Dla timeoutu status jest „nieznany”, nie „odrzucony”: adapter ma port uzgodnienia stanu (`reconcile`) i dopiero jego wynik rozstrzyga ponowienie lub kompensację. Zasada dotyczy płatności, poczty i zewnętrznego storage; nie wkładać wywołania HTTP do transakcji Node tylko dlatego, że receipt jest idempotentny. Porty efektów, limity i retry są kontraktem Core; sposób rozmowy z dostawcą pozostaje w pakiecie aplikacji. [dpay opisuje timeout jako wynik nieznany i odsyła do sprawdzenia szczegółów transakcji](https://docs.dpay.pl/sdk/node/).

### ADR-C06 — Przenośność bazy aplikacji bez pozornego „uniwersalnego SQL”

**Rekomendacja:** Core otrzymuje porty `Persistence/UnitOfWork`, `MigrationStore`, `ReceiptStore`, `IdentityStore`, `PolicyStore` i `AuditStore` z adapterami PostgreSQL oraz MariaDB. `NodeContext` nie eksportuje `pg.PoolClient` ani surowego połączenia całej instancji. Geode może pozostać PostgreSQL i mieć osobny cykl wydania. Shard, który ma działać na obu bazach, dostarcza implementacje repozytorium oraz migracje dla obu dialektów albo używa ograniczonego, jawnie zdefiniowanego neutralnego modelu. Manifest deklaruje obsługiwane dialekty; instalacja na nieobsługiwanej bazie jest błędem przed wydaniem. Nie tłumaczyć automatycznie dowolnego SQL.

Fork MariaDB Persec jest materiałem do scalenia przez te porty, nie długoterminową drugą gałęzią Core. Trzeba uwzględnić różnice składni i zachowania: placeholdery `$1`, `jsonb`, `timestamptz`, `text[]`, `ON CONFLICT`, `RETURNING`, blokady doradcze, migracje i semantykę receipt. Idempotencja wymaga unikalnego klucza, transakcji oraz blokady/serializacji odpowiedniej dla dialektu; odpowiedź dla powtórzenia musi być taka sama jak pierwsza. Podobne nazwy SQL nie oznaczają zgodności transakcyjnej.

### ADR-C07 — Granice zaufania, sekrety i aktywacja pakietu

**Rekomendacja:** manifest publikuje tylko nazwy sekretów i capabilities. Właściciel instancji wiąże referencję z produkcyjnym providerem; każde rozwiązanie sekretu ma akcję, pakiet i wpis audytu bez wartości sekretu. Obecny generyczny `ExternalSecretProvider` jest punktem integracji, nie kompletnym, wdrożonym systemem zarządzania sekretami. Zaufany kod własnej organizacji może działać in-process po świadomej aktywacji w wydaniu. Kod obcego wydawcy nie może być w ten sposób wykonany w fazie 1. Podpis i digest dowodzą pochodzenia oraz integralności artefaktu, nie bezpieczeństwa kodu.

`geode:install` ma pozostać operacją pobrania/pinowania. Osobny `release:materialize/prepare` bierze przypięty, lokalnie dostępny artefakt, sprawdza digest, podpis, zgodność Core/DB/API/eventów, zależności i komplet migracji, po czym umieszcza wyłącznie zatwierdzony kod właściciela w niezmiennym kandydacie wydania. Aktywacja wymaga jawnej decyzji zaufania oraz zarejestrowania pakietu w runtime; instalacja samego lockfile nie wystarcza. Expand/backfill/contract i kompatybilność dwóch wersji obowiązują także schematy zdarzeń. Wycofanie kodu jest możliwe tylko gdy dane i zdarzenia pozostają kompatybilne. Działająca aplikacja ma wszystkie aktywne artefakty lokalnie i nie odpytuje Geode przy obsłudze żądań.

### ADR-C08 — Identity/Policy/Audit dla organizacji bez LMS w Core

**Rekomendacja:** `Identity` wystawia stabilny kontrakt użytkownika, sesji, weryfikacji, resetu i konta usługi dla dowolnego frontendu przez HTTP/OpenAPI; adapter auth może być wymieniany bez zmiany kontraktu Shardu. `Policy` przyjmuje `Principal`, akcję, typ i ID zasobu oraz kontekst organizacji/członkostwa pochodzący z zaufanego źródła. Własność firmy, kursu lub zamówienia jest danymi Shardu, a Core zapewnia sposób odczytu atrybutów potrzebnych polityce. Polityka jest oceniana na wejściu HTTP i ponownie przy każdej kompozycji Node. `Audit` zapisuje wynik z correlation ID i bez sekretów/pełnego payloadu. Prawa Geode do pobrania pakietu nie nadają kursantowi dostępu do lekcji ani nie zwiększają puli miejsc.

## 3. Kolejność implementacji i kryteria zamknięcia

To backlog **do wykonania**, nie lista gotowych funkcji. Bramki sprawdzające uruchamia się dopiero na wyraźne polecenie użytkownika.

| Kolejność | Praca w Core/Geode | Kryterium zamknięcia projektu |
|---|---|---|
| **P0.1** | Zamknąć ADR-C01 i format kanonicznego kontraktu; usunąć z publicznych obietnic `event`/`event-handler` do ich uruchomienia. Zrównać manifest, runtime, CLI/MCP, Geode i OpenAPI. | Ten sam `@pakiet:node@wersja` daje zgodne schematy, błędy, uprawnienia i digest w każdym interfejsie; brakujący/niezgodny opis blokuje wydanie. |
| **P0.2** | Wydzielić adaptery persistence/transaction/migration/receipt/identity/policy/audit; scalić wymagania forka MariaDB, utrzymać adapter PostgreSQL dla aplikacji i Geode. | Jedna wersja Core uruchamia aplikację na wybranym dialekcie bez kodu `pg` w publicznym `NodeContext`; Shard jawnie deklaruje obsługiwane bazy. |
| **P0.3** | Dodać port `invoke` i kontekst bezpieczeństwa ADR-C02. | Dwa lokalne Nodes z różnych zaufanych pakietów komponują się bez importu, loopback i cudzych tabel; druga operacja otrzymuje własną decyzję policy, a awaria wycofuje wspólną transakcję. |
| **P0.4** | Dodać outbox/inbox i wykonanie `event`/`event-handler` ADR-C03 oraz port trwałych efektów ADR-C05. | Zmiana stanu i emisja są jednym commitem; powtórzona dostawa nie powtarza efektu; timeout zewnętrzny przechodzi do uzgodnienia, a nie do ślepego ponowienia. |
| **P0.5** | Dodać ograniczony ingress ADR-C04 i produkcyjny adapter sekretów z audytem ADR-C07. | Podpis jest sprawdzany na oryginalnych bajtach przed wywołaniem Node; nie można utworzyć dowolnej publicznej mutacji; sekret nie pojawia się w artefakcie, MCP ani logu. |
| **P0.6** | Zrealizować materializację i aktywację zaufanego pakietu z Geode przez wydanie. | Pakiet z aplikacji A po publikacji prywatnej można pobrać i uruchomić w aplikacji B bez ręcznego kopiowania kodu, przy zgodnych dialektach i migracjach; po odłączeniu Geode aplikacja B dalej obsługuje żądania. |
| **P0.7** | Domknąć frontend-neutralny kontrakt Identity/Policy/Audit ADR-C08. | Nowy frontend używa logowania, resetu, sesji i oceny dostępu przez opisane API; organizacja i zasób są egzekwowane także wewnątrz kompozycji. |
| **P1** | Zbudować pionowy produkt w oddzielnych pakietach: ogólny LMS/seat pool, adapter dpay, ewentualny mały kontrakt Commerce/Payment. | Zweryfikowana płatność może aktywować pulę raz, równoczesne przypisania nie przekraczają limitu, a zwrot ma osobny przepływ; żadna z tych reguł nie jest zaszyta w Core. |

Przed deklaracją „gotowe” potrzebne będą zamówione przez użytkownika kontrole kontraktów, zgodności obu dialektów, odmowy uprawnień, idempotencji, awarii sieci, migracji i dwóch wydań. Sama implementacja P0.1–P0.7 bez tych dowodów pozostaje niezweryfikowana.

## 4. Co pozostaje w pakietach aplikacji

| Core zapewnia | Pakiet domenowy zapewnia |
|---|---|
| Identity, Policy, Audit, referencje sekretów, port transakcji, kompozycję Node, outbox/inbox, ingress, trwałe zlecenie efektu, wydania. | Schemat kursów, lekcji, firm, członkostw, cen, zamówień, pul i przydziałów; walidację kwoty/waluty dostawcy, reguły zwrotów i okresu dostępu. |
| Kontrakt i bezpieczną granicę dla zewnętrznego webhooka/adaptera. | SDK dpay, mapowanie IPN na zdarzenie płatności, dokładne `OK`, uzgodnienie `payments.details()` i własne migracje. |
| Rejestr pakietów i deklarację zależności. | Decyzję, czy moduł jest na tyle ogólny, by opublikować go w Geode; brak danych klientów i sekretów w artefakcie. |

Pierwszy ogólny Shard LMS może zostać opublikowany prywatnie w Geode po odłączeniu marki Persec i zależności od dpay. Adapter dpay jest osobnym pakietem. Jeśli ogólny kontrakt płatności okaże się potrzebny dla co najmniej dwóch dostawców, można go wydzielić później; Core nie powinien na tym etapie zawierać modelu zamówień ani punktów programu kursu.
