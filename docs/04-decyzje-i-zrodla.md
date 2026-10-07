# 04. Decyzje, źródła i przyszła weryfikacja

**Status:** decyzje oznaczone jako „uzgodnione” pochodzą z rozmowy z użytkownikiem. Rekomendacje zostały przyjęte roboczo do pierwszej implementacji po poleceniu „Przejdź do fazy 1”; stan kodu i ograniczenia opisuje [05 — Implementacja fazy 1](05-implementacja-fazy-1.md), a nowe ADR i backlog w [06 — Kompozycja i porty](06-kompozycja-porty-i-backlog.md). Stare RFC są źródłami historii projektu, nie instrukcjami obowiązującymi w tym planie.

## 1. Uzgodnione wymagania

| ID | Ustalenie |
|---|---|
| U-01 | Lattis instaluje się na początku budowy każdej aplikacji jako fundament backendowy; frontend może używać dowolnego frameworka. |
| U-02 | Faza 1 działa bez panelu administracyjnego i Canvas. |
| U-03 | Pierwszy produkt to **jedna aplikacja** z CMS, LMS i sprzedażą oraz wspólnymi użytkownikami. Na początku powstają własne aplikacje. |
| U-04 | Nodes, Shards, Geode i MCP mają być używalne w fazie 1; Geode od razu przyjmuje pakiety publiczne i prywatne. |
| U-05 | Lokalny MCP służy pracy z projektem, a publicznie dostępny zdalny MCP obsługuje Geode od pierwszej fazy. |
| U-06 | Model bezpłatnych, jednorazowo licencjonowanych i subskrypcyjnych ofert Geode powstaje teraz; pobieranie płatności i automatyczne odnawianie później. |
| U-07 | Funkcje z aplikacji mogą stać się wspólnymi pakietami przez świadomą promocję do Geode. |
| U-08 | Codex sam wykonuje rutynowe operacje techniczne w granicach uprawnień. Nie uruchamia testów, lintów, buildów, skanów, benchmarków ani innych weryfikacji bez wyraźnego polecenia. |
| U-09 | Persec używa lokalnego forka Lattis Core z MariaDB. Geode jako odrębna usługa może pozostać na PostgreSQL; wspólny Core nie powinien utrzymywać rozbieżnych forków bez jawnego kontraktu adapterów DB. |
| U-10 | Istotne Nodes i Shards tworzone w aplikacjach mają wracać do Geode jako wersjonowane pakiety możliwe do kompozycji w innym wdrożeniu Lattis. Reguły marki Persec i dostawcy dpay nie przechodzą do Core. |

## 2. Rekomendacje robocze (ADR do zatwierdzenia)

### ADR-01 — Modularny backend per aplikacja

**Wybór:** Core, API i zaufane Shards tworzą wydanie backendu konkretnej aplikacji; frontend może działać w tym samym repo, lecz rozmawia przez kontrakt HTTP. Centralne Geode pozostaje oddzielną usługą. **Powód:** jedna domena użytkowników w CMS/LMS/sprzedaży i brak zależności produkcyjnych żądań od Geode. **Koszt:** trzeba utrzymywać wersje Core w każdym projekcie. **Alternatywa:** centralna wspólna instancja dla wszystkich aplikacji daje mniej wdrożeń, lecz miesza dane, dostępność i cykle wydawnicze projektów.

### ADR-02 — TypeScript/Node.js/Fastify; baza aplikacji przez adapter

**Wybór:** TypeScript/Node.js/Fastify pozostają wyborem implementacyjnym. PostgreSQL był pierwszym adapterem; Persec używa MariaDB, więc [ADR-C06](06-kompozycja-porty-i-backlog.md) proponuje wspólny Core z adapterami PostgreSQL/MariaDB dla instancji aplikacji. Geode może nadal używać PostgreSQL. **Powód:** spójność języka pakietów/SDK/CLI/MCP, niezależny serwer HTTP i możliwość wdrożeń na obu bazach. **Koszt:** porty transakcji i migracji oraz implementacje per dialekt; to jest backlog, a nie własność głównego repo. Zaufane pakiety in-process mają przywileje procesu; obcy kod wymaga osobnej izolacji. **Alternatywy:** dwa trwałe forki Core albo jedna narzucona baza aplikacji; oba ograniczają przenośność. Nie traktować Fastify jako modelu domeny.

### ADR-03 — Node jako kontrakt działania, Shard jako pakiet funkcji

**Wybór:** Node i Shard nie potrzebują Canvas ani wykonywalnego grafu. Shard ma właściciela danych, API i migracji; Node jest mniejszym typowanym działaniem/zdarzeniem. **Powód:** daje realną użyteczność Geode w fazie 1 bez budowy trzech produktów naraz. **Koszt:** późniejszy Graph AST musi mapować się na już opublikowane kontrakty Node.

### ADR-04 — Metadane Geode + magazyn obiektowy

**Wybór:** PostgreSQL dla katalogu i praw, artefakty adresowane digestem w magazynie obiektowym, pobieranie po autoryzacji. **Powód:** najmniej nowej infrastruktury przy publicznych/prywatnych pakietach i własnych ofertach. **Koszt:** Lattis utrzymuje własne API dystrybucji. **Alternatywa:** OCI daje standard artefaktów niezależny od treści, ale dochodzi registry i integracja uprawnień; npm jest wygodny dla TS, ale słabo mapuje oferty Geode. To nie jest wybór formatu na zawsze: pakiet ma mieć przenośny manifest i digest.

### ADR-05 — MCP jako adapter istniejących usług

**Wybór:** lokalny MCP `stdio` korzysta z usług instancji i CLI; zdalny MCP Geode przez Streamable HTTP korzysta z usług katalogu. **Powód:** jedna implementacja reguł uprawnień i audytu. **Koszt:** osobna publiczna powierzchnia, OAuth/IdP, limity i monitoring od początku. **Alternatywa:** wyłącznie lokalny MCP jest tańszy, ale nie spełnia U-05.

### ADR-06 — Niezmienne wydania i kompatybilność bazy

**Wybór:** przygotowanie kandydata, nakładanie wersji, expand/migrate/contract, rollback **kodu** tylko przy kompatybilnym stanie bazy. **Powód:** trzy etykiety STABLE/CURRENT/NEXT nie rozwiązują migracji danych. **Koszt:** kompatybilność wsteczna utrzymywana przez więcej niż jedno wydanie i co najmniej dwie instancje dla realnego przełączenia bez przerwy.

### ADR-C01–C08 — Kontrakty ujawnione przez Persec

[Dokument 06](06-kompozycja-porty-i-backlog.md) proponuje wspólny deskryptor Node/Shard, kompozycję przez Core, outbox/inbox, ograniczony ingress, trwałe efekty, adaptery DB, aktywację z Geode i porty Identity/Policy/Audit. Są to **rekomendacje i backlog**, a nie zatwierdzenie ich implementacji ani dowód bezpieczeństwa obecnego kodu.

## 3. Otwarte decyzje dla właściciela projektu

Decyzje poniżej nie blokują sporządzenia planu. Przed kodowaniem danego elementu Codex powinien przedstawić konkretny wybór, aktualne źródła i krótkie ADR; nie mnożyć pytań o szczegóły możliwe do ustalenia technicznie.

| Decyzja | Rekomendacja domyślna | Skutek innego wyboru / moment |
|---|---|---|
| Biblioteka tożsamości i sesji aplikacji | Utrzymywana biblioteka z lokalną bazą użytkowników, opakowana stabilnym portem Core. Nie pisać własnych algorytmów haseł. | Zewnętrzny IdP może ułatwić SSO, ale dodaje usługę, koszty i zależność dostępności. Zamknąć przed implementacją auth. |
| Dostawca sekretów produkcyjnych | Adapter do sprawdzonego zewnętrznego secret managera/KMS; lokalny provider tylko do developmentu. | Szyfrowany magazyn własny wymaga zarządzania kluczem, rotacji i audytu. Zamknąć przed pierwszym produkcyjnym wdrożeniem. |
| Miejsce hostowania Geode i magazynu artefaktów | Osobna usługa Geode i magazyn obiektowy pod kontrolą właściciela. | Zewnętrzne registry zmienia model prywatności i uprawnień. Zamknąć przed publikacją zdalnego endpointu. |
| Podpis lub atestacja pakietu | Wiązać manifest, digest i wydawcę w zaufanym procesie publikacji; weryfikować przed instalacją. | Własne klucze wydawców wymagają rotacji, odzyskiwania i unieważniania; atestacja CI wiąże publikację z dostawcą. Zamknąć przed publiczną dystrybucją artefaktów. |
| Semantyka końca subskrypcji pakietu | Brak sprawdzania Geode przy każdym żądaniu; po końcu prawa zablokować nowe instalacje/aktualizacje, przewidzieć jawny okres tolerancji. | Natychmiastowe zatrzymanie działającego Node'a osłabia zasadę dostępności i wymaga lokalnego egzekwowania/licencji. Zamknąć przed sprzedażą pakietów. |
| Topologia pierwszego produkcyjnego wdrożenia | Dwie nakładające się instancje API i przełączanie ruchu, gdy zero-downtime jest wymaganiem. | Jeden serwer/proces nie daje tej gwarancji. Zamknąć przed obietnicą SLA. |
| Publiczni wydawcy spoza własnej organizacji | Na początku tylko własny wydawca; publiczny oznacza widoczność pakietu. | Otwarcie publikacji wymaga dodatkowych zasad tożsamości, moderacji, izolacji kodu i obsługi incydentów. Zamknąć przed otwarciem rejestracji. |
| Licencja Core i pakietów | Nie kodować BSL ani progów Pro w fazie 1. Zapisać licencję każdego pakietu i zasięgnąć osobnej porady prawnej przed dystrybucją. | Warunki BSL, MIT lub innej licencji wpływają na publikację, wkład społeczności i ofertę. Zamknąć przed publicznym wydaniem Core. |
| Dostawca płatności LMS | Hosted checkout i webhook potwierdzony podpisem, bez danych kart w Lattis. | Własny checkout lub obsługa kart zwiększa zakres bezpieczeństwa i operacji. Zamknąć przy planowaniu Shardu Commerce. |

## 4. Plan weryfikacji — do uruchomienia tylko na polecenie

Poniższe są **przyszłymi bramkami**, nie wykonanymi testami. Użytkownik wyraźnie zleca ich uruchomienie, kiedy chce ocenić etap lub wydanie. Bez dowodu z właściwej bramki nie twierdzić, że etap jest zweryfikowany, bezpieczny lub gotowy produkcyjnie.

| Etap | Dowód potrzebny przed deklaracją gotowości |
|---|---|
| Core/auth | Przegląd wyboru biblioteki i konfiguracji, testy logowania/resetu/odwołania sesji, próby odmowy dostępu między rolami i zasobami, kontrola braków sekretów w logach. |
| Node/Shard | Sprawdzenie zgodności manifestu, zależności, migracji, granic danych, kompatybilności dwóch wersji i pinowania digestu. |
| Geode | Próby public/private i ręcznych entitlementów, ponowna publikacja tej samej wersji, podmieniony artefakt, przerwanie publikacji, awaria magazynu, kontrola zawartości paczki. |
| MCP | Zgodność lokalnego/zdalnego transportu ze specyfikacją, uprawnienia per narzędzie, walidacja odbiorcy tokenu, `Origin`, limity, prompt injection z publicznego opisu, brak sekretów w wynikach. |
| Pierwsza aplikacja | Integracja CMS/LMS/Commerce: wspólna sesja, polityka zasobów, podpis webhooka, zdarzenie powtórzone, dokładnie jedno uprawnienie do kursu. |
| Wydania | Readiness, drenaż, stary i nowy kod na tym samym schemacie, awaria migracji, rollback kodu, backup i odtworzenie danych. |

Jeśli użytkownik zleci tylko część weryfikacji, raport musi wskazać jej zakres i pozostałą niepewność. Zestaw bramek można ograniczyć do ryzyka danego etapu; nie ma obowiązku uruchamiania wszystkiego po każdej drobnej zmianie.

## 5. Mapa źródeł i korekt

| Źródło historyczne | Co zachowujemy | Co korygujemy |
|---|---|---|
| [Brief.md](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Brief.md:7>) | Headless/composable/security-first; pomysł współdzielonych funkcji; zewnętrzne SDK. | Brief dopuszczał Next/Astro po stronie klienta, ale wiązał Studio i runtime z Nuxt/Nitro. Faza 1 startuje od Core, Geode i MCP zamiast Graph Executor + Canvas; daty i progi sprzedaży z 2026 nie są planem technicznym. [Stack](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Brief.md:84>), [roadmapa](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Brief.md:732>). |
| [Graph AST Schema RFC.md](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Graph AST Schema RFC.md:13>) | Wersjonowanie, deterministyczny zapis przepływów, referencje do sekretów, jawne kontrakty. | AST nie jest źródłem prawdy dla całego produktu. Wymóg „bit-identical AST” koliduje z losowymi ID/timestampami i danymi layoutu; właściwy cel to równoważność semantyczna po kanonizacji. RFC dopuszcza nieznane pola, a jednocześnie odrzuca nieznane wersje schematu — trzeba zdefiniować granicę kompatybilności. Podwójne JSONB `crystal`/`shard` grozi rozjazdem; SQL z `ULID` wymaga rzeczywistego typu/konwersji. [Zasady](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Graph AST Schema RFC.md:58>), [storage](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Graph AST Schema RFC.md:1280>), [bezpieczeństwo](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Graph AST Schema RFC.md:1411>). |
| [Lattis Design System Specification.MD](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Lattis Design System Specification.MD:1>) | Tokens i wzorce dla przyszłego panelu, czytelne sygnały uprawnień. | Vue primitives i iframe nie są wymogiem dla frontendów aplikacji ani fazy 1. Iframe nie daje automatycznej izolacji procesu; przykładowe przekazanie klucza API przez stan komponentu jest sprzeczne z referencjami do sekretów. [Architektura](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Lattis Design System Specification.MD:73>), [iframe](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Lattis Design System Specification.MD:712>). |
| [Licence RFC.md](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Licence RFC.md:18>) | Osobna decyzja o licencji Core, SDK i pakietów; potrzeba zapisania warunków publikacji. | Nie przyjmować automatycznie BSL, CLA, ograniczeń rynku ani twierdzenia, że każda aplikacja rozmawiająca przez API ma z góry rozstrzygnięty status prawny. BSL jest source-available, nie OSI open source; MongoDB używa SSPL, a nie BSL. To kwestia do analizy prawnej przed publikacją. [MariaDB BSL](https://mariadb.com/bsl11/), [MongoDB SSPL](https://www.mongodb.com/legal/licensing/server-side-public-license). |
| [Security RFC.MD](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Security RFC.MD:53>) | Model zagrożeń, default deny, audyt, backup, izolacja obcego kodu. | „Always-working” nie jest gwarantowane przez trzy etykiety wersji. Polityka krytycznych aktualizacji Community jest opisana raz jako manualna, raz jako obowiązkowo automatyczna; wymaga nowego wyboru. HSM jest raz wymagany od dnia 1, a raz planowany na rok 3. Podpis i Deno nie zastępują weryfikacji oraz izolacji. [Aktualizacje](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Security RFC.MD:637>), [klucze](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Security RFC.MD:773>), [roadmapa](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Security RFC.MD:924>). |

### Aktualne źródła techniczne wykorzystane do rekomendacji

- [MCP SDK v2: HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http), [stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio), [wersja protokołu 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28). Wcześniejsze źródła z 2025 pozostają w planie historycznym.
- [Better Auth: PostgreSQL](https://better-auth.com/docs/adapters/postgresql), [Fastify](https://better-auth.com/docs/integrations/fastify), [email i reset](https://better-auth.com/docs/concepts/email), [Admin](https://better-auth.com/docs/plugins/admin).
- [OCI Distribution Spec](https://specs.opencontainers.org/distribution-spec/), [npm private packages](https://docs.npmjs.com/creating-and-publishing-private-packages/), [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).
- [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [Deno security](https://docs.deno.com/runtime/fundamentals/security/).
- [GitLab: zgodność wersji](https://docs.gitlab.com/development/multi_version_compatibility/), [GitLab: migracje bez przestoju](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/), [Kubernetes: Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).
- [Oficjalna dokumentacja OpenAI o AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) i [uprawnieniach Codexa](https://learn.chatgpt.com/docs/agent-approvals-security): preferencje pracy można później utrwalić w repo, lecz instrukcja nie znosi granic środowiska.
