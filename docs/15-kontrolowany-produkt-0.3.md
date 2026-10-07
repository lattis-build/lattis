# Lattis 0.3.0-alpha.1 — kontrolowane rozszerzenia i przygotowanie wydania

**Status: przygotowane źródła alpha.** W ramach tej zmiany nie uruchomiono testów, lintów, kompilacji, skanów, benchmarków ani usług. Nie ma potwierdzenia poprawności wykonania ani gotowości produkcyjnej. Nie opublikowano paczki npm, podpisanej platformy, katalogu TUF ani publicznej instalacji. Pliki wdrożeniowe są szablonami, a oceny jakości pozostają `pending`.

Ten dokument zastępuje opis aktywacji rozszerzeń i kontraktów wydawniczych z dokumentu [0.2](14-publiczne-wydanie-0.2.md). Pozostałe elementy wcześniejszego procesu, m.in. kotwice TUF i niezależny aktualizator, nadal obowiązują jako opis architektury. Zasady produktu opisuje [PRODUCT_POLICY](../PRODUCT_POLICY.md), zakres MIT — [dokument licencyjny](16-licencja-i-model-produktu.md).

## Zmiany w kodzie

| Obszar | Zachowanie w 0.3 |
|---|---|
| Rozszerzenia produkcyjne | Wyłącznie własne deklaracje `extensions/*.json`, wpisane w konfigurację i podpisane jako część całego wydania. `trustedModules` musi być puste. |
| Wykonanie | Osobny runner interpretuje ograniczony język danych. Nie ładuje JS, TS, Wasm, bibliotek pakietu ani skryptów instalacyjnych. |
| Dostęp do Core | Zadeklarowane, stałe wywołania Nodes przechodzą przez brokera. Każde wywołanie sprawdza uprawnienia użytkownika, kontrakt danych i rodzaj operacji. Query nie może wywołać command. |
| Panel | Formularze buduje renderer Lattis ze znanych typów pól. Rozszerzenie nie dostarcza HTML, JavaScript, CSS, iframe, menu reklamowego ani własnych okien. |
| Geode | Katalog v3 wymaga przeglądu dokładnego artefaktu i dokładnych digestów jego bezpośrednich zależności. Pobranie zapisuje kandydata lock; niczego nie aktywuje. |
| Wydanie aplikacji | Descriptor v3 wiąże spis plików, konfigurację, rozszerzenia i ocenę jakości. Wymaga aktualizatora 2. |
| WAF | Szablon Nginx + ModSecurity v3 + OWASP CRS w trybie blokowania. Wdrożenie jest oddzielnym zadaniem operatora. |
| Integralność | Launcher odrzuca zmienione wydanie przed startem. Nowy timer może okresowo porównywać aktywne pliki z autoryzacją. Nie naprawia i nie usuwa plików. |
| Licencja | MIT, właściciel: `#1 GROUP PROSTA SPÓŁKA AKCYJNA`. Dotyczy istniejącego własnego kodu repozytorium. |

Core nadal zawiera uprzywilejowane implementacje logowania, treści, importu i wideo. One i ich zależności również wymagają przeglądu. Ograniczenie rozszerzeń nie dowodzi, że sam Core jest wolny od podatności.

## Model rozszerzeń

Kontrakt znajduje się w `src/extension-contract.ts`. Definicja zawiera nazwę `@localPublisher/package`, wersję, zakres kompatybilności z Core, licencję, listę dozwolonych wywołań, Nodes oraz deklaracje widoków. Własne aplikacje mogą wybrać swoją licencję; scaffold zaczyna od `UNLICENSED`, aby nie nadawać ich kodowi MIT bez decyzji autora.

Język wyrażeń obsługuje tylko literały, odczyt własnych pól wejścia i wcześniejszych wyników oraz składanie obiektów i tablic. Nie ma pętli, obliczanego celu wywołania, pobierania URL, SQL, dostępu do plików ani sekretów. Kroki wywołują wyłącznie Nodes zadeklarowane w `capabilities.invoke`. Rzeczywisty dostęp jest przecięciem tej listy i uprawnień wywołującego; rozszerzenie nie może podmienić Principal ani uzyskać podwyższonych praw własną deklaracją `action`.

Definicja ma limit 100 KB, maksymalnie 32 Nodes, 32 uprawnione cele i 16 kroków na Node. Kontrakty wejścia i wyjścia dopuszczają do 32 pól typu tekst, textarea, liczba całkowita lub boolean. Runner ogranicza zagnieżdżenie, liczbę operacji i wielkość komunikatu do 256 KiB; klient ma termin 5 sekund. Broker ma limit zagnieżdżenia 8 i 64 wywołań, wykrywa cykle i sprawdza termin między wywołaniami. Te terminy nie przerywają już rozpoczętego zapytania do bazy lub uprzywilejowanej operacji Core; timeouty bazy i usług ustawia operator.

Widok korzysta z kontraktu wskazanego Node. Serwer ponownie waliduje dane; przeglądarkowe `required` nie jest granicą zaufania. Teksty i wyniki są renderowane jako tekst. Komendy używają klucza idempotencji i transakcyjnych receipts wspólnych z API aplikacji. W tej wersji panel pozostaje dostępny właścicielowi instancji; nie wprowadza automatycznie panelu dla klientów.

Przykład: [content-preview.json](../examples/extensions/content-preview.json). Nie jest automatycznie aktywowany. Po skopiowaniu do `extensions/content-preview.json` trzeba dopisać tę ścieżkę do `extensions` w `lattis.config.json`. Inny `localPublisher` wymaga odpowiedniej własnej nazwy i przestrzeni nazw Nodes. Nieistniejący wpis treści powoduje błąd; przykład nie tworzy danych.

Tworzenie nowej deklaracji w środowisku deweloperskim:

```sh
node node_modules/lattis/bin/lattis.js extension:new @owner/example extensions/example.json
```

Do pracy deweloperskiej runner potrzebuje istniejącego, prywatnego katalogu socketu. Ustaw tę samą absolutną ścieżkę `LATTIS_RUNNER_SOCKET` dla runnera i Core, a następnie uruchom osobno `node node_modules/lattis/runner/extension-runner.mjs`. To polecenie jest instrukcją dla operatora; nie zostało uruchomione przy przygotowaniu tego wydania.

## Izolacja runnera na serwerze

`deployment/lattis-runner.service` używa odrębnego konta `lattis-runner`. Operator instaluje dokładny plik z autoryzowanej platformy w `/opt/lattis-runner/extension-runner.mjs`, jako root-owned, bez zapisu dla runtime. Wersję i digest wiąże `installation.json`; updater wymaga zgodności z plikiem w podpisanej platformie `node_modules/lattis/runner/extension-runner.mjs`. Aktualizacja runnera jest osobnym, kontrolowanym działaniem operatora, nie hookiem kandydata aplikacji.

Usługa ma dostęp do socketu Unix, limit pamięci i CPU oraz ograniczenia systemd. Nie otrzymuje środowiska z sekretami aplikacji. Nie ma dostępu do `/etc/lattis`, `/srv`, `/var/lib`, zewnętrznej sieci ani bazy aplikacji. Core przesyła wyłącznie wyrażenie, wejście i wyniki wcześniejszych wywołań; te dane mogą zawierać treść użytkownika, więc runner również należy chronić i nie logować jego payloadów.

Konta, grupy, katalogi, jednostki i uruchomienie musi przygotować operator na obsługiwanym hoście Linux. Core i Admin dostają dostęp do socketu przez grupę, lecz nie mogą zastąpić pliku ani socketu w chronionym katalogu. Runner niedostępny lub niezgodny powoduje błąd operacji rozszerzenia. To nie jest ogólny sandbox dla obcego kodu. Obcy kod pozostaje niewykonywalny w fazie 1.

## Ochrona HTTP i WAF

Szablony są w `deployment/waf/`. Operator musi dostarczyć Nginx z konektorem ModSecurity v3, obsługiwany CRS, certyfikaty, rzeczywiste domeny oraz reguły sieciowe. Repo nie pobiera tych składników i nie konfiguruje Enhance. Wyłącz publiczny dostęp do portów backendu; WAF można ominąć, jeśli origin pozostaje publiczny. Zaufaj wyłącznie rzeczywistym adresom proxy przez `LATTIS_TRUSTED_PROXY_CIDRS`, a proxy musi nadpisywać przekazane nagłówki. Nie ustawiaj zaufania do całego Internetu.

Konfiguracja odrzuca inne hosty, ogranicza połączenia, częstotliwość, czas i rozmiar żądań, używa TLS oraz blokowania CRS. Wyłącza analizę ciała odpowiedzi. Jedynym wyłączeniem analizy ciała żądania jest dokładna trasa binarnego uploadu MP4 z metodą PUT; jej autoryzacja i parser pozostają w Core. Import mediów WordPress ma osobny limit 18 MiB przy zachowanej analizie JSON. Zmiany wyjątków wymagają przeglądu, a nie globalnego wyłączenia reguł.

Szablon obejmuje aplikację, Admin oraz opcjonalne Geode wraz ze statycznym `/tuf/` i MCP Geode. Osobny MCP edycji aplikacji jest narzędziem deweloperskim i nie jest tu wystawiany. Geode nadal oblicza aplikacyjny limit IP według adresu bezpośredniego połączenia (`trustProxy: false`); za proxy ten limit jest wspólny dla klientów. Limity per klient stosuje ingress. Dobierz je do obciążenia i długich sesji MCP na podstawie jawnie zleconych prób.

Log HTTP pomija query string i treść żądania, redaguje standardowe sekrety, a serializer błędów pomija message/stack. WAF zapisuje ograniczone sekcje audytu bez ciał. Operator musi ocenić też logi bibliotek, bazy, proxy i wyjątków CRS — ta konfiguracja nie gwarantuje braku danych osobowych we wszystkich logach.

`edgeProtection.configurationDigest` to SHA-256 bajtów chronionego dokumentu opisującego ocenioną konfigurację brzegu, np. `/etc/lattis-edge/edge-inventory.json`. Dokument powinien wiązać dokładne pliki Nginx, ModSecurity, CRS, wersje konektora i silnika oraz reguły izolacji origin; nie umieszczaj w nim kluczy TLS ani sekretów. Ten sam digest jest w ocenie wydania i receipt wdrożenia. **Updater porównuje te deklaracje, nie odczytuje efektywnej konfiguracji Nginx ani stanu firewalla.** Rzeczywiste działanie musi potwierdzić operator i evidence. Zmiana brzegu wymaga nowej oceny, polityki i zatwierdzenia; aplikacja nie może sama obniżyć tej polityki.

Core dodaje też podstawowe nagłówki i ograniczone pamięciowo limity HTTP. Nie zastępują CRS, ochrony DDoS, autoryzacji ani aktualizacji zależności. Dokumentacja źródłowa: [OWASP WAF](https://owasp.org/www-community/Web_Application_Firewall), [OWASP CRS](https://coreruleset.org/docs/), [konektor Nginx](https://github.com/owasp-modsecurity/ModSecurity-nginx).

## Ocena i autoryzacja wydania

Nie wolno zamienić przykładowego `pending` na `approved` bez wykonanej oceny. Każda z siedmiu kategorii — bezpieczeństwo, kompatybilność, UI, zależności, odzyskiwanie, WAF i licencja — wymaga rzeczywistego wyniku oraz plików evidence dołączonych do wydania. Evidence ma ścieżkę i SHA-256 zgodny ze spisem plików. Ocena ma imiennego recenzenta, datę i ważność do 180 dni, nie dłuższą niż uzasadniona faktycznym przeglądem.

Ocena wiąże dokładną wersję Core, konfigurację, konfigurację brzegu i cały spis plików, z wyłączeniem samego `lattis.review.json`, aby uniknąć zależności kołowej. Zmiana dowolnego ocenianego pliku wymaga ponownego przygotowania oceny. Pliki evidence dodaje się **przed** policzeniem końcowego spisu. Narzędzie generuje tylko pending, nie wykonuje testów:

```sh
node node_modules/lattis/bin/lattis.js release:review-template ASSEMBLED_DIRECTORY sha256:EDGE_DIGEST REVIEW_OUTPUT.json
```

Po rzeczywistym przeglądzie recenzent uzupełnia rekord i kopiuje go jako `ASSEMBLED_DIRECTORY/lattis.review.json`. Przygotowanie kandydata `release:prepare`, etap `stage` oraz nowa aktywacja wymagają aktualnej oceny. Start już zatwierdzonego wydania sprawdza związanie dokumentu, ale nie zatrzymuje działającej usługi po upływie terminu. Taki upływ blokuje nową aktywację; nie jest awaryjnym odwołaniem kodu.

Podpisana ocena jest oświadczeniem recenzenta i właścicieli, nie automatycznym dowodem poprawności evidence. Kod nie rozumie raportów, nie wykrywa fikcyjnych wyników i nie gwarantuje braku podatności. Separacja recenzenta i podpisujących jest procedurą organizacyjną; same nazwy w JSON nie wymuszają niezależności osób.

Kolejność produkcyjna:

1. Operator aktualizuje chroniony updater do wersji 2, przygotowuje konta, runner, WAF i odizolowany origin. Uzupełnia przykładowe polityki rzeczywistymi kluczami i digestami. Puste klucze i `REPLACE` celowo nie działają.
2. Wydawca składa pełną platformę Core z zamrożonymi zależnościami, ocenia ją i publikuje jej spis pod TUF. Kotwice zaufania dostarcza niezależnym kanałem, z kluczami prywatnymi poza serwerem. Mechanizm TUF opisuje [oficjalna dokumentacja](https://theupdateframework.io/docs/overview/).
3. Właściciel składa kompletny katalog aplikacji, bez sekretów, symlinków i plików roboczych. Usuwa `trustedModules`, rejestruje tylko ocenione deklaracje i planuje SQL dla właściwego dialektu. Nie dokłada nieautoryzowanych zależności.
4. Po zleconych kontrolach przygotowuje evidence i ocenę dokładnego zestawu, następnie `release:prepare`, podpisy offline wymaganej liczby właścicieli i `release:bundle`.
5. Oddzielny updater wykonuje `stage`; operator zatrzymuje runtime, potwierdza odtwarzalną kopię, przeprowadza zatwierdzone migracje i wdraża ocenioną konfigurację brzegu. Zapisuje chroniony maintenance receipt z rzeczywistymi danymi.
6. `activate` wymaga właściwego poprzednika, receipt, świeżej autoryzacji platformy i oceny. Manager usług uruchamia launcher jako konto runtime. Kontrola zdrowia po wdrożeniu nadal należy do operatora.

Nie ma automatycznego rollbacku bazy, samonaprawy kodu, podpisywania na serwerze ani aktualizacji updatera przez aplikację. Timer `lattis-integrity.timer`, jeśli zostanie włączony przez operatora, uruchamia niezależne porównanie plików co pięć minut. Wynik i błędy trafiają do systemd journal; alarmy trzeba podłączyć osobno. Sprawdzenie plików nie jest skanem podatności ani oceną pamięci procesów. Administrator systemu i zaufany launcher pozostają poza granicą ochrony aplikacji.

## Geode i migracja z 0.2

Katalog przechodzi na `schemaVersion: 3`. Dopuszczenie wiąże artefakt, recenzenta, politykę `controlled-v1`, ważność do 180 dni i sześć wyników: security, compatibility, ui, dependencies, license, maintenance. Wpis ma dodatkowo mapę `dependencies` z dokładnymi digestami bezpośrednich zależności. Oceniony graf obejmuje także ich własne dopuszczenia. Resolver nie ma backtrackingu: gdy wybrana wersja nie pasuje do ocenionego zestawu, kończy błędem.

Lock pozostaje v2, ale `admissionDigest` obejmuje teraz również mapę zależności. Stare piny wymagają odnowienia albo usunięcia w kandydacie. Nie przepisuj ręcznie digestów w aktywnej instalacji. Pakiety prywatne i płatne nadal wymagają osobnego uwierzytelnionego transportu; nie publikuj ich w statycznym TUF.

Descriptor wydania v2 i updater 1 nie są zgodne z v3. Nie da się po prostu przestawić numeru wersji starego podpisu. Wymagane są nowa platforma, ocena i podpisy. Dotychczasowe `@lattis/commerce`, `@lattis/paynow` i `@lattis/fakturownia` pozostają kodem deweloperskim; nie zostały przeniesione do modelu deklaratywnego. Ich manifesty zachowują wcześniejszy zakres zgodności, ponieważ nie potwierdzono zgodności z 0.3. Kod wymagający własnego SQL, sieci lub sekretów musi otrzymać odrębny, oceniony projekt integracji.

## Co pozostaje przed publicznym wydaniem

Zlecenie i wykonanie weryfikacji kodu, prób odtwarzania i skuteczności izolacji/WAF; opublikowanie prywatnego kanału zgłaszania podatności; przegląd praw do zależności i wkładów; przygotowanie rzeczywistych kotwic i podpisanej dystrybucji; wdrożenie na docelowym hoście wraz z monitoringiem. Kontrole z tej listy nie zostały wykonane w tej zmianie. Przygotowane archiwum jest paczką źródeł, bez `node_modules`, sekretów, podpisów i certyfikacji.
