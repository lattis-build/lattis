# 02. Faza 1 — zakres i kontrakty

To dokument kontraktów i kierunku. Zakres zaimplementowany oraz instrukcja utworzenia własnej aplikacji są w [05 — Pierwsza aplikacja](05-implementacja-fazy-1.md). Rozbieżności między kontraktem i kodem oraz kolejność ich usunięcia są w [06 — Kompozycja i porty](06-kompozycja-porty-i-backlog.md).

**Cel fazy:** zainicjować aplikację z Lattis, skorzystać z auth i autoryzacji, utworzyć Node i Shard, opublikować je w Geode, a następnie pobrać i przypiąć ich wersję. API, CLI i MCP działają bez panelu administracyjnego. Obecny kod pobrany z Geode nie jest automatycznie aktywowany w aplikacji; ścieżka aktywacji własnego, zaufanego pakietu pozostaje w backlogu. Kod obcego wydawcy nie może wykonywać się in-process w fazie 1.

## 1. Granica pierwszego wydania

| Obowiązkowe | Wyraźnie poza fazą 1 |
|---|---|
| Własna instancja Lattis dla aplikacji, HTTP API, OpenAPI, CLI/bootstrap. | Gotowy CMS, LMS i Commerce. |
| Konta użytkowników aplikacji, sesje, odzyskiwanie dostępu, minimalny model ról i reguł zasobów. | SSO i federacja między wieloma aplikacjami. |
| Referencje do sekretów, dostawca sekretów, audyt operacji uprzywilejowanych. | Własny system kryptograficzny lub własny serwer OAuth. |
| SDK/manifest Node i Shard, zależności, migracje, wersjonowanie, lockfile. | Dowolny kod wydawców zewnętrznych wykonywany w procesie produkcyjnym. |
| Geode: publikacja własnych pakietów, public/private, wyszukiwanie, instalacja, bezpłatne i płatne modele ofert, ręczne prawa dostępu. | Checkout Geode, odnawianie, faktury, wypłaty, KYC wydawców. |
| Lokalny MCP stdio oraz zdalny MCP Geode przez Streamable HTTP. | AI agent samodzielnie modyfikujący produkcyjną aplikację. |

W fazie 1 **własny pakiet** oznacza kod w repo i pod kontrolą właściciela instalacji. Można go udostępnić publicznie w katalogu. Wykonywanie pakietu obcego wydawcy wymaga osobnej izolacji, polityki dopuszczenia i bramek bezpieczeństwa z późniejszego etapu. Bez tej granicy publiczne Geode byłoby katalogiem kodu, którego nie wolno jeszcze bezpiecznie uruchamiać w produkcji.

## 2. Kontrakt instancji i tożsamości

Instancja ma `instanceId`, wersję Core, identyfikator wdrożenia, konfigurację dostawców i lockfile pakietów. Nie współdzieli tabel użytkowników z Geode. Własne użytkownictwo CMS/LMS/Commerce używa jednego katalogu tożsamości w aplikacji.

| Obiekt | Minimalne pola / zachowanie |
|---|---|
| `User` | Stabilny identyfikator, identyfikatory logowania, stan aktywny/zablokowany, metadane profilu. Nie przechowuje uprawnień jako dowolnego JSON bez kontroli. |
| `Credential` | Obsługiwany przez sprawdzony mechanizm auth; hash hasła, reset, ewentualnie passkey są wewnętrznym detalem implementacji, nigdy danymi dla modułów. |
| `Session` | Powiązana z użytkownikiem, wygasająca i odwoływalna; bezpieczne cookie dla przeglądarki, ochrona CSRF tam, gdzie cookie autoryzuje mutację. |
| `Principal` | Użytkownik, konto usługi albo proces systemowy; zawsze jawny podczas sprawdzania uprawnień i audytu. |
| `Policy` | `allow(principal, action, resource, context)` zwraca decyzję i uzasadnienie; domyślnie odmowa. Role grupują uprawnienia, a reguły zasobów ograniczają je np. do własnego kursu lub roboczej treści. |
| `Service credential` | Ograniczony zakres, okres ważności i możliwość odwołania; używany przez CLI/automatyzację, nie jako wspólny klucz administratora. |

Każdy Shard rejestruje własne akcje i typy zasobów, np. `content.publish`, `course.read`, `enrollment.grant`, ale **Core** egzekwuje decyzję w API i usługach, również gdy wywołanie przechodzi przez MCP. Moduł nie nadpisuje globalnej polityki. RLS w PostgreSQL może być dodatkową ochroną w miejscach o wysokim ryzyku, lecz nie zastępuje autoryzacji aplikacyjnej; PostgreSQL opisuje osobne reguły ograniczające dostęp do wierszy. [PostgreSQL: Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## 3. Node i Shard bez Canvas

### Node

Docelowo Node jest stabilnym kontraktem działania (`command`, `query`, `event-handler`) lub zdarzenia (`event`). Definicja zawiera identyfikator, wersję, schemat wejścia/wyjścia i błędów, deklarowane capabilities oraz regułę idempotencji. **Obecny runtime wykonuje tylko `command` i `query`**, choć manifest dopuszcza także nazwy typów zdarzeniowych. Handler dostaje dziś klienta PostgreSQL, co nie jest obiecaną granicą capabilities ani przenośnym portem danych. Kontrakt docelowy i plan naprawy są w [ADR-C01–C03](06-kompozycja-porty-i-backlog.md). Obcy kod wymaga izolowanej granicy procesu i brokera capabilities.

### Shard

Shard jest pakietem funkcji domenowej. Docelowo deklaruje udostępniane Nodes, API, zdarzenia, własne dane i migracje, akcje autoryzacji, zależności od innych pakietów oraz wymaganą wersję Core. Ma łączyć Nodes zwykłym kodem przez port Core. Nie musi mieć grafu ani UI. Obecnie instalacja z Geode tylko przypina artefakt; kontrolowany proces aktywacji i migracji pobranego pakietu wymaga implementacji.

Granica typów powinna być serializowalna, wersjonowana i identycznie odczytywana przez manifest, runtime, OpenAPI i Geode. Dzisiejszy `lattis.manifest.json` nie spełnia jeszcze całego tego kontraktu. Schematy pakietów pochodzące z Geode są niezaufanymi danymi do czasu kontroli; nie należy ich bezpośrednio kompilować jako schematów serwera HTTP. [Fastify: Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).

### Kompatybilność

- Nazwa pakietu jest unikatowa w przestrzeni wydawcy; `name + version` identyfikuje wydanie, `digest` identyfikuje dokładne bajty.
- Raz opublikowane bajty wersji są niezmienne. Poprawka dostaje nową wersję; zła wersja może zostać oznaczona jako wycofana lub unieważniona z podaną przyczyną.
- `lattis.lock` przypina digest i dokładne wersje zależności. Zakresy wersji należą do manifestu; rozstrzygnięcie należy do etapu przygotowania wydania aplikacji.
- Publikacja wiąże manifest, digest i tożsamość wydawcy podpisem lub atestacją pochodzenia, którą instalator weryfikuje. Polityka kluczy, rotacji i unieważniania wymaga ADR; wielopoziomowe PKI/HSM z dawnego RFC nie jest warunkiem pierwszego wydania. Podpis nie jest oceną bezpieczeństwa kodu. [npm: provenance](https://docs.npmjs.com/viewing-package-provenance/).
- Kompatybilność Core i zależności jest sprawdzana przed instalacją; brak kompatybilnej wersji blokuje aktualizację pakietu, a nie działającą aplikację.
- Migracje Shardu mają właściciela i kolejność. Docelowy plan wydania ma wykrywać konflikt migracji, dialektu bazy oraz zmian API i zdarzeń przed przełączeniem ruchu; obecny `release:prepare` nie zapewnia jeszcze całej tej kontroli.

## 4. Geode: katalog, artefakty, oferty

**Geode** przechowuje metadane w relacyjnej bazie i artefakty oddzielnie. Minimalny model:

| Encja | Odpowiedzialność |
|---|---|
| `Publisher` / `Organization` | Własność nazwy pakietu i uprawnienia osób publikujących; tożsamość odrębna od użytkowników aplikacji klientów. |
| `Package` | `kind=node|shard`, nazwa, właściciel, opis, widoczność `private|public`, stan katalogowy. Publiczny opis to niezaufana treść. |
| `PackageVersion` | Wersja, digest, manifest, zależności, kompatybilność, stan `staged|published|deprecated|revoked`, pochodzenie i podpis/atestacja artefaktu. Po publikacji niezmienna. |
| `LicenseRecord` | Identyfikator/wersja i odnośnik lub hash tekstu licencji; techniczny zapis nie rozstrzyga zgodności prawnej. |
| `Offer` | Typ `free|one-time|subscription`, cena/waluta lub polityka indywidualna, zakres praw. Na początku nie inicjuje płatności. |
| `Entitlement` | Uprawnienie osoby/organizacji/instancji do pobrania lub aktualizacji pakietu, z datami, źródłem nadania i możliwością odwołania. Ręczne wydanie w fazie 1. |
| `Artifact` | Zawartość wskazana digestem, dostępna dopiero po kontroli widoczności i uprawnienia; bez sekretów z projektu źródłowego. |

Widoczność, licencja, oferta i entitlement są **oddzielnymi wymiarami**. Pakiet publiczny może być płatny; prywatny może być bezpłatny dla jednej organizacji. Uprawnienie do pobrania nie oznacza bezwarunkowego uruchomienia obcego kodu. W pierwszej fazie Geode obsługuje jednego właściciela/własną organizację jako wydawcę; struktura uwzględnia późniejszych wydawców zewnętrznych.

**Wybór magazynu artefaktów:** na start rekomendowane metadane PostgreSQL + magazyn obiektowy z zawartością adresowaną digestem i pobraniem przez krótkotrwały URL po autoryzacji. To ogranicza liczbę usług, ale własne API dystrybucji trzeba opisać i utrzymać. OCI daje standardowy protokół niezależny od typu artefaktu, lecz wymaga integracji praw dostępu i dodatkowej infrastruktury; npm jest wygodny dla TypeScript, ale jego model prywatności/ofert nie odpowiada wprost Geode i wiąże format z ekosystemem npm. Przyszły adapter OCI pozostaje możliwy przy niezmiennym manifeście. [OCI Distribution Spec](https://specs.opencontainers.org/distribution-spec/), [npm: private packages](https://docs.npmjs.com/creating-and-publishing-private-packages/).

### Promocja z aplikacji do wspólnej bazy

1. Funkcja powstaje w `packages/local` pierwszej aplikacji z jawnie opisanym kontraktem.
2. Autor wydziela zależności aplikacyjne, dane i sekrety; identyfikuje ogólny Node albo Shard. Core nie przyjmuje każdej nowej funkcji.
3. CLI tworzy manifest, dokumentację i paczkę. Użytkownik decyduje o `private` lub `public`; domyślnie `private`.
4. Publikacja sprawdza **niezmienniki operacji**: poprawność manifestu, prawa wydawcy, jednoznaczność wersji, digest, brak wartości sekretów w deklarowanych polach, kompatybilność wymaganych pól. Jest to walidacja granicy systemu, nie automatyczne uruchomienie całego zestawu testów projektu.
5. Geode zapisuje niezmienną wersję. Nowy projekt pobiera ją po kontroli dostępu i przypina do lockfile. To **nie aktywuje** kodu w obecnym runtime.
6. Docelowy proces wydania materializuje wyłącznie zatwierdzony kod własnego wydawcy, sprawdza zgodność i migracje oraz aktywuje go z lokalnego artefaktu; utrata Geode nie wpływa na obsługę żądań.
7. Zmiany kontraktu wymagają nowej wersji oraz planu migracji dla odbiorców.

Plan kontroli kodu, testów, skanów i ewentualnego podpisywania przed produkcyjnym użyciem znajduje się w [dokumencie 04](04-decyzje-i-zrodla.md). Codex nie uruchamia tych narzędzi bez polecenia użytkownika.

## 5. API i MCP

API HTTP jest źródłem kontraktów dla frontendu, CLI i adapterów. Minimalne grupy:

| API instancji | Cel |
|---|---|
| `auth` / `sessions` | Logowanie, wylogowanie, odwołanie sesji, odzyskiwanie dostępu; szczegóły zależą od wybranej biblioteki auth. |
| `users` / `principals` | Zarządzanie kontami i kontami usługi. |
| `policies` / `roles` | Zarządzanie przypisaniami i ocena uprawnień dla administratora aplikacji. |
| `modules` | Lista zainstalowanych pakietów, wersji, capabilities i stanu migracji. Instalacja jest operacją przygotowania wydania. |
| `secrets/references` | Tworzenie referencji i przypisanie dostępu; API odczytu nie zwraca wartości sekretu klientowi ani MCP. |
| `health` / `version` | Gotowość usługi i kompatybilność wydania. |

API Geode obejmuje wyszukiwanie i metadane pakietów, przygotowanie publikacji, przekazanie artefaktu, finalizację, pobranie wersji, przyznanie entitlements i dziennik publikacji. Mutacje mają klucze idempotencji oraz audyt. Publiczny opis pakietu nie może zawierać instrukcji, które agent potraktuje jako nadrzędne.

**MCP jest adapterem tych usług, a nie drugim backendem.** Minimalne narzędzia (nazwy robocze):

| Serwer | Narzędzia | Dostęp |
|---|---|---|
| Lokalny `stdio` | `project.describe`, `node.scaffold`, `shard.scaffold`, `manifest.describe`, `installed.list`, `geode.search`, `geode.install.prepare` | W kontekście konkretnego repo i lokalnej tożsamości; modyfikacje plików tylko w dozwolonym workspace. |
| Zdalny Geode, Streamable HTTP | `package.search`, `package.get`, `version.get`, `entitlement.check`, `publish.prepare`, `publish.finalize`, `access.grant` | Publiczny katalog może być odczytany anonimowo; prywatne dane i mutacje wymagają auth oraz konkretnego zakresu. |

Zdalny MCP nie widzi lokalnego dysku. Lokalny CLI/SDK pakuje i przesyła artefakt przez uwierzytelniony API upload, a zdalny MCP może koordynować przygotowanie i finalizację publikacji. Serwer MCP nie przyjmuje tokenu przeznaczonego dla innego API jako własnego i nie przekazuje go dalej. Specyfikacja MCP definiuje `stdio` i Streamable HTTP, wymogi `Origin` dla zdalnego transportu oraz walidację odbiorcy tokenu. [MCP: transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP: authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## 6. Zasady dla pierwszej własnej aplikacji

Pierwsza aplikacja powstaje jako osobny projekt z jedną bazą tożsamości, własnymi lokalnymi modułami i migracjami. Każdy Node jawnie deklaruje schemat wejścia i wyjścia oraz wymagane uprawnienie. Kod modułów powstałych przy tej aplikacji można wyodrębnić, uzupełnić manifest, opublikować w Geode i przypiąć w kolejnym projekcie. Ten przepływ nie wymaga przykładowego produktu w repo Core.

Pełne płatności produktu pozostają w pakietach aplikacji. Realne użycie w Persec pokazało, że ogólna kompozycja Node, trwała wymiana zdarzeń, outbox, ingress i przenośne wydanie pakietu muszą zostać dodane do Core **przed** deklaracją, że LMS można składać z uniwersalnych modułów. Nie są dziś dostarczane jako gotowe funkcje; kolejność jest w [backlogu 06](06-kompozycja-porty-i-backlog.md).
