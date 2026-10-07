# Lattis 0.3.0-alpha.1

Headless fundament aplikacji: logowanie, uprawnienia, treść, wideo, kontrolowane rozszerzenia, katalog Geode oraz MCP. Frontend wybiera aplikacja. Własny kod repozytorium jest dostępny na [MIT](LICENSE), właściciel: **#1 GROUP PROSTA SPÓŁKA AKCYJNA**.

**Status:** przygotowane źródła alpha. W tej zmianie nie uruchomiono testów, lintów, buildów, skanów ani usług. Kod nie ma potwierdzonej gotowości produkcyjnej. Aplikacja obsługuje adaptery PostgreSQL/MariaDB; Geode zachowuje PostgreSQL. Forge, AI i Cloud pozostają planem osobnych produktów.

**Aktualny proces wydań:** [15 — Kontrolowany produkt 0.3](docs/15-kontrolowany-produkt-0.3.md). Produkcyjne rozszerzenia są deklaracjami JSON; własny TS pozostaje deweloperski. Panel korzysta ze wspólnych formularzy, a pobranie z Geode nie uruchamia pakietu. Katalog v3 i descriptor wydania v3 wiążą dokładne wersje z oceną jakości. Dodano szablony WAF, runnera i monitorowania integralności. Nie wdrożono ich na serwerze i nie opublikowano kotwic ani podpisanej dystrybucji. Przykładowe oceny są `pending` i blokują aktywację.

Zasady: [polityka produktu](PRODUCT_POLICY.md), [bezpieczeństwo i zgłoszenia](SECURITY.md), [licencja i zarabianie](docs/16-licencja-i-model-produktu.md), [zmiany i migracja](CHANGELOG.md).

| Dokument | Zawartość |
|---|---|
| [01 — Plan systemu](docs/01-plan-systemu.md) | Wizja, granice, terminologia, wybór technologii, repo, roadmapa i rewizja pierwotnej koncepcji. |
| [02 — Faza 1 i kontrakty](docs/02-faza-1-kontrakty.md) | Zakres pierwszego wydania bez UI, modele Node/Shard, Geode, MCP, auth i API. |
| [03 — Bezpieczeństwo i wydania](docs/03-bezpieczenstwo-i-wydania.md) | Granice zaufania, sekrety, publikacja kodu, aktualizacje, rollback i koszty operacyjne. |
| [04 — Decyzje i źródła](docs/04-decyzje-i-zrodla.md) | Ustalenia, rekomendacje do zatwierdzenia, otwarte pytania, odniesienia do briefu i plan przyszłej weryfikacji. |
| [05 — Pierwsza aplikacja](docs/05-implementacja-fazy-1.md) | Utworzenie pustej aplikacji, moduły, migracje, uruchomienie, wydanie i ograniczenia. |
| [06 — Kompozycja i porty](docs/06-kompozycja-porty-i-backlog.md) | Stan rzeczywisty, brakujące kontrakty Node/Shard, przenośność DB, ingress, zdarzenia, aktywacja z Geode i backlog. |
| [07 — Treść i bazy](docs/07-tresc-i-bazy.md) | Nowy model treści, API, importer WordPress i wybór PostgreSQL/MariaDB dla aplikacji. |
| [08 — Migracja WordPress](docs/08-migracja-wordpress-i-bezpieczenstwo.md) | Wtyczka WP-CLI, użytkownicy, media oraz wymagania ochrony danych. |
| [09 — Wideo](docs/09-wideo.md) | Node odtwarzania, prywatny strumień MP4, sesje widzów i granice DRM oraz znaku wodnego. |
| [10 — Architektura wideo](docs/10-architektura-wideo.md) | Niezależny od odtwarzacza kontrakt, pakowanie HLS/DASH, CMAF oraz granice DRM i znakowania śledczego. |
| [09 — Audyt immudb](docs/09-immudb-audyt.md) | Opcjonalny rejestr odcisków zdarzeń audytu, kolejka i niezależna weryfikacja. |
| [11 — Panel i zdalny MCP](docs/11-panel-i-zdalny-mcp.md) | Zdalna praca nad aplikacją, opcjonalny panel Lattis Admin i przygotowanie publicznego Geode. |
| [12 — Geode: zaufanie i izolacja](docs/12-geode-zaufanie-i-izolacja.md) | Historyczny projekt granic zaufania; bieżąca implementacja i jej ograniczenia są w dokumencie 15. |
| [13 — Aktualizacje całego Lattis](docs/13-architektura-aktualizacji-lattis.md) | Historyczny projekt aktualizatora, migracji i odzyskiwania; aktualny proces opisuje dokument 15. |
| [14 — Publiczne wydanie 0.2](docs/14-publiczne-wydanie-0.2.md) | Historyczny opis wdrożenia i kotwic. Kontrakty rozszerzeń i wydań zastępuje dokument 0.3. |
| [15 — Kontrolowany produkt 0.3](docs/15-kontrolowany-produkt-0.3.md) | Deklaracje, runner, UI, WAF, ocena jakości, updater 2 i migracja. |
| [16 — Licencja i model produktu](docs/16-licencja-i-model-produktu.md) | MIT, prawa do forków, oficjalny kanał i przyszłe Forge/AI/Cloud. |
| [Commerce](packages/local/commerce/README.md) | Opcjonalny identyfikator sprzedaży, migawka nabywcy i pozycji, statusy oraz powiązania z innymi Nodes. |
| [Paynow v3](packages/local/paynow/README.md) | Opcjonalny Node płatności z osobnym workerem i podpisanym odbiornikiem powiadomień. |
| [Fakturownia](packages/local/fakturownia/README.md) | Opcjonalny Node faktur z szyfrowanym zleceniem i osobnym workerem. |

## Kod

- `src/app-server.ts` — instancja Core na aplikację, auth Better Auth, polityka dostępu, Nodes, trasy Shards i referencje sekretów.
- `src/content.ts`, `src/wordpress-import.ts`, `src/user-import.ts` i `src/media-transfer.ts` — treść, użytkownicy źródłowi i media.
- `wordpress/lattis-migrator/lattis-migrator.php` — wtyczka WP-CLI do przenoszenia danych, bez migracji frontendu.
- `src/app-db.ts` — adapter bazy aplikacji PostgreSQL/MariaDB; Geode zachowuje własny adapter PostgreSQL.
- `src/immudb-audit.ts` — opcjonalny eksport odcisków audytu do immudb z kolejką w bazie aplikacji.
- `src/extension-contract.ts`, `src/extensions.ts`, `runner/` — deklaracje i osobny interpreter danych; `src/node-executor.ts` — broker panelu.
- `src/runtime.ts` — ładowanie deklaracji; importy własnych modułów TS i trasy Shards wyłącznie w rozwoju.
- `src/geode-server.ts` — centralne Geode HTTP i zdalny MCP Streamable HTTP.
- `src/local-mcp.ts` — lokalny MCP `stdio` dla repo aplikacji.
- `src/remote-mcp.ts` — opcjonalny MCP aplikacji na serwerze; `src/admin-server.ts` — opcjonalny panel właściciela.
- `src/cli.ts` — inicjowanie projektu, tworzenie Node/Shard, publikacja, instalacja i przygotowanie wydania.
- `src/registry-client.ts` — pobieranie wyłącznie na podstawie aktualnego katalogu TUF; zmiany trafiają do kandydatów.
- `updater/` — osobny pakiet aktualizatora i launchera; polityka poza aplikacją.
- `tools/offline-repository.ts` — narzędzia do przygotowania i podpisywania metadanych na stacji wydawniczej.
- `src/project-migrations.ts` — migracje danych własnej aplikacji, oddzielone od Core i auth.
- `deployment/` — niewdrożone szablony usług, WAF i ocen; nie są potwierdzeniem działania ochrony.

## Zasada pracy

Codex wykonuje rutynowe operacje techniczne samodzielnie w dostępnych uprawnieniach. Testy i pozostałe weryfikacje wykonuje dopiero na wyraźne polecenie użytkownika. Ta zasada jest także w [AGENTS.md](AGENTS.md).
