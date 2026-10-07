# Publiczne wydanie 0.2.0-alpha.1

To wersja robocza po zmianie granic zaufania. Kod nie został uruchomiony, zbudowany, przetestowany ani poddany audytowi. Nie oznacza potwierdzonej odporności na szkodliwy kod ani gotowości do przyjmowania ruchu publicznego. Nie opublikowano paczki npm, kluczy zaufania, podpisanego katalogu ani działającej usługi.

## Co egzekwuje kod

Klient wybiera oficjalny adres `https://geode.lattis.build`. Zmiana `GEODE_BASE_URL` na inną domenę nie przełącza klienta. Rozwój z innym rejestrem wymaga jawnego `LATTIS_REGISTRY_MODE=development`, `GEODE_DEVELOPMENT_URL` i osobnej polityki `LATTIS_DEVELOPMENT_REGISTRY_POLICY`; ten tryb jest odrzucany przy `NODE_ENV=production`. Przekierowania HTTP są odrzucane. Adres jest transportem, a autoryzacja pobranych danych wynika z TUF, nie z nazwy domeny.

Kotwice zaufania dostarcza operator poza katalogiem aplikacji: `/etc/lattis/geode-trust.json`, `/etc/lattis/geode-root.json` oraz analogiczne pliki `updates-*`. Polityka zawiera SHA-256 początkowego root. Nie ma automatycznego zaufania do klucza pobranego przy pierwszym połączeniu. Bez prawidłowej kotwicy instalacja i przygotowanie wydania są blokowane. TUF sprawdza podpisy, wersje, terminy ważności, powiązania metadanych oraz długości i hashe artefaktów. Stan klienta musi być zachowany, także po restartach, aby nie usuwać pamięci o nowszych wersjach.

Publikacja trafia do `quarantined`. Katalog API udostępnia instalowalne wersje dopiero po imporcie niezależnej decyzji z aktualnego, podpisanego katalogu. API Geode i token wydawcy nie podpisują dopuszczeń. Instalator nie ufa danym discovery API przy rozwiązywaniu zależności: używa `catalog.json` jako celu TUF, następnie podpisanego artefaktu i manifestu **wewnątrz tych samych bajtów**. Przypina także digest decyzji dopuszczenia. Konflikty zależności przerywają instalację; nie ma pełnego solvera z cofaniem wyborów.

`geode:install` zapisuje `.lattis/candidates/lattis.lock`. Nie nadpisuje aktywnego `lattis.lock`, nie rozpakowuje wykonywalnego kodu, nie uruchamia instalacyjnych skryptów ani SQL. W fazie 1 pobrane pakiety pozostają danymi. Core ładuje wyłącznie jawnie wskazane `./packages/local/...` należące do `localPublisher`. To własny kod aplikacji, mający uprawnienia procesu. Nie jest sandboxem. Ręczne skopiowanie i przemianowanie obcego kodu oznacza przyjęcie go przez właściciela do własnej bazy kodu; sama nazwa wydawcy nie dowodzi jego autorstwa.

Publiczna statyczna dystrybucja w tej wersji obsługuje tylko publiczne, bezpłatne pakiety. Eksport i dopuszczenie odrzucają pakiety prywatne oraz płatne. Takie pakiety potrzebują osobnego, uwierzytelnionego transportu, zanim będzie można publikować ich artefakty. Nie umieszczaj ich w publicznym katalogu `/tuf/targets`.

## Gdzie co hostować

| Adres / miejsce | Zawartość |
|---|---|
| `lattis.build` | Własna aplikacja Lattis prezentująca projekt; osobna baza, użytkownik systemowy i sekrety. Strona nie powstała w tym zadaniu. |
| `geode.lattis.build` | API Geode, PostgreSQL, magazyn kwarantanny i odczytywany statycznie katalog `/tuf/`. |
| `geode.lattis.build/mcp` | Opcjonalny MCP Geode, proxy do osobnego portu; chronione operacje wymagają OAuth. |
| `updates.lattis.build/tuf/` | Statyczne, podpisane metadane platformy i cele zawierające spis plików Core wraz z zależnościami. |
| GitHub `lattis-build/lattis` | Źródła, historia, dokumentacja i przegląd zmian. GitHub nie zastępuje podpisanej dystrybucji. |
| Stacje wydawnicze poza serwerem | Klucze prywatne root, targets oraz właścicieli aplikacji; niezależna ocena kandydatów. |

W Enhance utwórz osobne witryny i certyfikaty. Dla Geode skieruj API do `GEODE_PORT` (domyślnie 4200), a opcjonalny `/mcp` do `GEODE_MCP_PORT` (4201). Statyczny `/tuf/` powinien wskazywać oddzielny, wdrażany przez operatora katalog, do którego proces Geode nie ma zapisu. Proxy zachowuje `Host`. Magazyn kwarantanny, baza i klucze API nie mogą znaleźć się w publicznym document root. `GEODE_HOST` i `GEODE_MCP_HOST` ustaw zgodnie z siecią kontenera; `0.0.0.0` jest dopuszczalne tylko za kontrolowanym ingress i regułami sieciowymi. Nie wystawiaj portów bazy i backendów w publicznym firewallu.

Uprawnienia na plikach są częścią wdrożenia. Runtime nie może zmieniać `/etc/lattis`, `/opt/lattis-updater`, wydań ani stanu aktualizatora. Potrzebuje oddzielnego konta i zapisu tylko do danych aplikacji. Jeśli kontener witryny Enhance nie pozwala zachować takiego podziału, uruchom Core i aktualizator jako odrębne usługi/kontenery na posiadanym serwerze, a Enhance wykorzystaj do TLS i proxy. Dołączony `deployment/lattis-app.service` jest szablonem dla systemd, nie automatyczną konfiguracją Enhance. Osobne instalacje wymagają osobnych przestrzeni `/etc/lattis` i użytkowników, np. przez kontenery; ścieżka polityki nie jest przełączana zmienną środowiskową aplikacji.

## Niezależny aktualizator

Katalog `updater/` jest osobnym pakietem z własnym lockfile i biblioteką TUF. Zainstaluj go w chronionym `/opt/lattis-updater`, z zależnościami instalowanymi z jego lockfile, bez skryptów. Nie uruchamiaj kopii z katalogu aktualizowanej aplikacji. Przykłady polityk znajdują się w `deployment/`; zawierają puste pola i celowo nie stanowią działającego zaufania.

Operator tworzy root-owned katalogi wydań i stanu (0755, bez zapisu grupy i innych użytkowników). Pliki kotwic i polityk również są root-owned, bez zapisu grupy/innych. Publiczne klucze właścicieli w `ownerKeys` są indeksowane `sha256:` od DER SPKI; próg właściciela jest niezależny od progu wydawcy platformy. Klucze prywatne nie trafiają na serwer. Sekrety runtime są dostarczane przez chroniony plik środowiskowy, poza wydaniem; `NODE_OPTIONS` i `NODE_PATH` nie są dopuszczane przez launcher.

Przebieg wydania:

1. Złóż kompletny katalog runtime poza repo roboczym: pliki aplikacji, `lattis.config.json`, lock v2, pakiet Core i cały zamrożony `node_modules`. Bez `.env`, `.git`, `.lattis`, symlinków i kluczy. Zależności powinny być instalowane bez skryptów i bez symlinków `.bin`. Oficjalny cel platformy musi obejmować **każdy** plik w `node_modules`; nie można dokładać do niego nieautoryzowanych zależności aplikacji.
2. Wydawca platformy przygotowuje spis `release:platform ASSEMBLED_PLATFORM VERSION OUTPUT`, przeprowadza niezależny przegląd i publikuje ten JSON pod celem TUF `platform/lattis-VERSION.json` w `updates.lattis.build`. Samo wygenerowanie spisu niczego nie dopuszcza.
3. W repo aplikacji wykonuje się `release:prepare ASSEMBLED_APP platform/lattis-VERSION.json [PREVIOUS_RELEASE_ID]`. Przygotowanie wymaga aktualnych metadanych TUF platformy. Konfiguracja zawiera `applicationId`, `localPublisher` i `releaseComponents` (`app`, `admin` lub `geode`). Własny Geode jest osobną instalacją z komponentem `geode`.
4. Właściciele przeglądają descriptor, diff i migracje. Każdy podpisuje te same bajty przez `release:sign DESCRIPTOR OFFLINE_PRIVATE_KEY`. Przy progu większym niż jeden należy połączyć tablice `signatures` w jednym envelope, zachowując niezmienione `signed`. `release:bundle ASSEMBLED_APP DESCRIPTOR OUTPUT` przygotowuje niezaufany transport plików.
5. Chroniony aktualizator wykonuje `stage BUNDLE AUTHORIZATION`: sprawdza podpisy właściciela, aktualne TUF platformy, spis zależności i każdy plik. Nie importuje kandydata i nie wykonuje jego skryptów. Zapisuje nieaktywny katalog nazwany SHA-256 descriptoru.
6. Operator zatrzymuje wszystkie procesy runtime, wykonuje kopię z możliwością odtworzenia i zatwierdzone migracje dla faktycznej bazy. Migracje Core/Auth również wymagają jawnego SQL i ujęcia w planie aplikacji; dynamiczny generator Better Auth nie jest produkcyjnym aktualizatorem. Updater nie wykonuje SQL ani dowolnych hooków. Po tych operacjach operator zapisuje root-owned `STATE/maintenance/HASH.json`, według `deployment/maintenance.example.json`, z rzeczywistymi digestami zastosowanych migracji. Ten dokument jest oświadczeniem zaufanego operatora, nie automatycznym dowodem zatrzymania usług ani poprawności kopii.
7. `activate sha256:HASH` wymaga dokładnego poprzednika, receipt, aktualnej autoryzacji platformy i zgodności plików. Atomowo zmienia `active.json` i zapisuje journal. Manager usług uruchamia `run app`, `run admin` albo `run geode` jako konto runtime. Launcher sprawdza autoryzację i pliki **przed** uruchomieniem kodu aplikacji. Core dodatkowo kontroluje wydanie przy starcie.
8. Operator ocenia zdrowie usługi i zapisuje wynik w swoim procesie wdrożeniowym. Wbudowanego automatycznego health rollout, wielohostowego fencing ani automatycznego rollbacku DB nie ma. Przy przerwaniu operacji należy odczytać journal i stan aktywny; stale lock nie jest automatycznie przejmowany. Cofnięcie po migracjach wymaga osobnej decyzji i odtworzenia danych lub wydania naprawczego. Aktualizator sam siebie nie aktualizuje.

Start aplikacji nie wymaga połączenia z Geode/updates. Nowe pobranie i nowa aktywacja wymagają świeżych metadanych. Niedostępność rejestru blokuje aktualizację, nie działającą aplikację. Prawidłowy zegar i zachowanie chronionego stanu TUF są założeniami systemu.

## Podpisany katalog Geode

`geode:publish` nie publikuje wersji do instalacji. Po publikacji publicznego pakietu i dodaniu bezpłatnej oferty operator używa `geode:export-quarantine NAME VERSION DIRECTORY`. Eksport tworzy artefakt oraz roboczy plik oceny. Ten plik nie jest dopuszczeniem. Osobny proces ocenia dokładne bajty, autora, zależności i prawa; wyniki zapisuje jako evidence. Narzędzia nie potwierdzają automatycznie braku szkodliwego kodu.

Ręcznie złożony `catalog.json` ma `schemaVersion: 2`, `registryId: "lattis-official"` oraz `packages`. Każdy wpis zawiera nazwę, wersję, `target: "artifacts/HASH.json"`, digest, długość, publiczny klucz i podpis wydawcy oraz `admission`: `id`, `decision: "approved"`, niepustą listę `evidence`, `reviewedAt`, `expiresAt` i `execution: "download-only"`. Kontrakt jest w `src/registry-client.ts`. Usunięcie wersji po incydencie wymaga nowego podpisanego katalogu i metadanych; samo odwołanie rekordu w bazie API nie unieważnia wcześniej podpisanego katalogu TUF. Czas reakcji jest ograniczony ważnością timestamp i dopuszczenia. Nie ma jeszcze niezależnej, natychmiastowej listy awaryjnego odwołania.

`tools/offline-repository.ts` przygotowuje standardowe metadata TUF, podpisywane poza serwerem. Polecenia uruchamia się na stacji wydawniczej przez `node --import tsx tools/offline-repository.ts ...`:

- `keygen ROLE OFFLINE_DIRECTORY` tworzy pojedynczy klucz; role: root, targets, snapshot, timestamp. Root i targets wymagają po trzech różnych kluczach, próg podpisu 2. Snapshot i timestamp mają osobne klucze.
- `root PUBLIC_RECORD_ARRAY OUTPUT` tworzy niepodpisany root v1. Plik wejściowy to tablica rekordów publicznych z keygen. Następnie `sign INPUT OUTPUT KEY...` dodaje podpisy odpowiednich opiekunów. Przekazuj części prywatne różnym opiekunom; posiadanie dwóch kluczy przez jedną osobę nie zapewnia niezależności.
- `targets TARGET_DIRECTORY VERSION OUTPUT` sporządza niepodpisany spis katalogu celów. Po jego podpisaniu: `snapshot SIGNED_TARGETS VERSION OUTPUT`, podpis snapshot, `timestamp SIGNED_SNAPSHOT VERSION OUTPUT`, podpis timestamp. Numery rosną monotonnie; timestamp ważny 1 dzień, snapshot 7 dni, targets 30 dni. Obecne narzędzie nie odnawia metadanych automatycznie.
- Na serwer przenosi się tylko publiczny root i podpisane `targets.json`, `snapshot.json`, `timestamp.json` oraz cele. Root v1 udostępnia się także jako `1.root.json`. Metadane pod `/tuf/metadata/`, cele pod `/tuf/targets/`. Root używa `consistent_snapshot: false`; cele są nadal weryfikowane przez hashe, a artefakty mają nazwy od digestów. Wdrażaj nowe cele i targets przed snapshot oraz timestamp. Timestamp otrzymuje krótki czas cache; metadane nie powinny być zastępowane przez strony błędu HTML.
- `geode:admit NAME VERSION` pobiera i sprawdza nowy podpisany katalog, a następnie odwzorowuje dopuszczenie do bazy API. Proces online nadal nie dostaje kluczy targets.

Rotacja root wymaga standardowego kolejnego root podpisanego według starego oraz nowego progu, z zachowaniem wszystkich kolejnych numerów. Narzędzie tworzy tylko początkowy root; ceremonii rotacji i odwołania kluczy nie automatyzuje. Pierwszy root/fingerprint użytkownik otrzymuje z niezależnie uwierzytelnionego wydania/bootstrapu. Nie ma jeszcze opublikowanej oficjalnej kotwicy ani instalatora, który dostarcza ją użytkownikom — to blokuje publiczną instalację.

## Zmiany niezgodne z 0.1

Stare lockfile v1 są odrzucane. Dla pustego projektu można jawnie zmienić schemaVersion na 2 i core na 0.2.0-alpha.1. Pakiety z poprzedniego lockfile należy ponownie rozwiązać z podpisanego katalogu; nie wolno dopisywać fikcyjnych admissionDigest. W konfiguracji trzeba dodać applicationId oraz localPublisher. Zdalny MCP służy do odrębnego workspace deweloperskiego i odmawia pracy przy NODE_ENV=production. Produkcyjne polecenia modyfikujące Core, migracje i pliki są zablokowane w CLI; operacje administracyjne wymagają odrębnego procesu operatora.

Migracja Geode przenosi stare `published` do `quarantined`. Wersje nie wracają do dystrybucji bez nowej decyzji. Istniejące klucze wydawców potwierdzają autorstwo, nie zastępują targets ani kluczy właściciela.

Kod jest obecnie bazą do dalszego wdrożenia, nie zakończoną implementacją całej architektury z dokumentów 12/13. Brakuje automatycznego izolowanego runnera i brokera, platformowego bootstrapu z oficjalną kotwicą, operacyjnej ceremonii i rotacji, niezależnego admission pipeline, automatycznego prowadzenia migracji i zdrowia oraz procedury aktualizacji samego updatera. Funkcje wymagające tych elementów pozostają zablokowane albo wymagają jawnej pracy zaufanego operatora. Nie wykonywano weryfikacji.
