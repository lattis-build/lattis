# 03. Bezpieczeństwo, dostępność i aktualizacje

> Aktualizacja 0.2.0-alpha.1: bieżący kontrakt instalacji i wdrożenia opisuje [dokument 14](14-publiczne-wydanie-0.2.md). Poniższe przykłady 0.1 zachowano jako kontekst rozwoju; nie są aktualną instrukcją wdrożenia produkcyjnego. Lock v1, dowolny GEODE_BASE_URL, edycja produkcyjnego workspace przez MCP i stary release:prepare nie należą do nowego procesu.

**Status:** projekt zasad. Nie przeprowadzono audytu, testów, skanów ani prób odtworzenia. Wymagania dotyczące bezpieczeństwa stają się potwierdzonymi własnościami dopiero po odpowiedniej weryfikacji zleconej przez użytkownika.

Szczegółowy projekt przeprojektowania zaufania i wykonania pakietów opisuje [12 — Geode: zaufanie i izolacja](12-geode-zaufanie-i-izolacja.md), a aktualizacji Core, usług i całych aplikacji — [13 — Aktualizacje całego Lattis](13-architektura-aktualizacji-lattis.md). Oba dokumenty są do implementacji; poniższy model wydania sam nie realizuje tych zabezpieczeń.

Wymagania kompozycji, trwałych zdarzeń, publicznego ingress i adapterów baz ujawnione przez Persec opisuje [06 — Kompozycja i porty](06-kompozycja-porty-i-backlog.md). Są to prace do wykonania, nie dodatkowe własności obecnego runtime.

## 1. Model zagrożeń i granice zaufania

| Granica | Zagrożenie | Reguła projektu |
|---|---|---|
| Frontend → API instancji | Pominięcie uprawnień przez inny klient HTTP, przejęta sesja. | API sprawdza tożsamość i autoryzację dla każdej operacji. Domyślnie odmawia dostępu; frontend nie jest autorytetem. |
| Shard/Node → Core | Pakiet czyta cudze dane, sekrety lub nadużywa sieci. | Jawne capabilities, porty usług, własność danych; tylko zaufane pakiety właściciela mogą być in-process w fazie 1. |
| Aplikacja → Geode | Podmieniony artefakt, utrata katalogu, nieautoryzowana instalacja. | Digest w lockfile, uwierzytelniona publikacja, kontrola uprawnień pobrania, lokalna kopia już wdrożonego artefaktu. |
| Publiczny opis Geode → agent | Prompt injection w README/manifeście. | Opis traktować jako dane; narzędzia MCP i Codex nie wykonują instrukcji z katalogu. |
| Zdalny MCP → Geode | Nadużycie uprawnień, tokenu lub narzędzia. | TLS, prawidłowy `Origin`, autoryzacja tokenu dla tego serwera, zakres per narzędzie/zasób, limit żądań i audyt. |
| Dostawca płatności → ingress → Node domenowy | Fałszywy lub powtórzony webhook, zmienione body, niejasny wynik ACK. | Ograniczony publiczny POST z oryginalnymi bajtami, weryfikacją podpisu przed wywołaniem Node, deduplikacją i ACK dopiero po trwałym przyjęciu. Obecny Core dopuszcza publicznie tylko GET; to wymaganie przyszłego portu. |
| CI/wydanie → produkcja | Wadliwa wersja kodu, migracja lub pakiet. | Niezmienne artefakty, kompatybilność dwóch wersji, etapowanie ruchu, kontrola gotowości, możliwość wycofania kodu. |

Podział na „Official/Partner/Community/Untrusted” z pierwotnego RFC może zostać później użyty do polityki publikacji, ale etykieta ani podpis nie są dowodem bezpieczeństwa. Podpis potwierdza źródło i integralność artefaktu. Nieznany kod trzeba izolować również wtedy, gdy podpisał go znany wydawca.

## 2. Tożsamość, uprawnienia i sekrety

- **Auth:** wybrać utrzymywaną bibliotekę lub usługę tożsamości z udokumentowanymi hasłami, resetem, sesjami i odwołaniem dostępu. Core definiuje własny kontrakt `Principal` i `Session`, lecz nie implementuje własnego haszowania ani protokołu OAuth. Hasła stosują adaptacyjne haszowanie zgodne z aktualnymi wskazówkami OWASP; parametry są decyzją implementacyjną podlegającą późniejszej weryfikacji. [OWASP: Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- **Autoryzacja:** akcja + zasób + kontekst, domyślna odmowa, ponowna ocena przy każdym żądaniu i wywołaniu wewnętrznym. Administrator aplikacji i wydawca Geode to różne role w różnych domenach. [OWASP: Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
- **Sekrety:** konfiguracja i manifest przechowują wyłącznie referencje. Produkcja korzysta z wybranego dostawcy sekretów/KMS lub sprawdzonego magazynu, z oddzielnym zarządzaniem kluczem. Własny plaintext „vault” w PostgreSQL jest niedopuszczalny. Dostęp Node/Shardu jest ograniczony do nazw zadeklarowanych w manifeście i zatwierdzonych przez właściciela instancji. Wartości nie pojawiają się w OpenAPI, logach, odpowiedziach MCP ani publicznych manifestach.
- **Stan implementacji sekretów:** główne repo ma interfejs providerów i generyczny provider HTTP, ale nie ma potwierdzonego produkcyjnego wdrożenia, mapowania dostępu dla Persec ani audytu każdego rozwiązania sekretu. In-process zaufany Shard nadal może odczytać środowisko procesu poza deklarowanym portem; capability nie jest sandboxem.
- **Audyt:** logować wydawcę/aktora, działanie, zasób, czas, wynik i identyfikator korelacji. Log nie zawiera sekretów ani pełnej treści żądań z danymi osobowymi. Retencja i eksport zależą od wymagań aplikacji; nie przenosić bezmyślnie sztywnych limitów z RFC.
- **Opcjonalny immudb:** obecny Core może eksportować HMAC odcisków lokalnych wpisów audytu przez trwałą kolejkę. Granice tego mechanizmu i wymóg osobnego audytora opisuje [09 — Audyt immudb](09-immudb-audyt.md).

### Granica wykonywania kodu

Faza 1 przyjmuje zaufanie do kodu własnej organizacji, który trafia do repo/wydania aplikacji. To **jawne ograniczenie modelu**, nie obietnica sandboxu. In-process pakiet jest równie uprzywilejowany jak host, niezależnie od deklaracji capabilities. Deklaracje pomagają w przeglądzie i przyszłym brokerze, lecz nie są techniczną izolacją bez osobnego procesu lub środowiska. Deno odmawia I/O domyślnie, ale moduły na tym samym wątku dzielą uprawnienia, a niektóre flagi je obchodzą; jego dokumentacja zaleca dodatkowe warstwy dla obcego kodu. [Deno: Security and permissions](https://docs.deno.com/runtime/fundamentals/security/).

Przed otwarciem Geode na wykonywanie kodu obcych wydawców trzeba zaprojektować worker poza procesem Core, limity CPU/pamięci/czasu, brokera sieci i sekretów, politykę zależności, skanowanie oraz awaryjne wyłączenie pakietu. Samo `iframe` późniejszego panelu chroni inną granicę i nie izoluje kodu backendowego. UI partnera nie dostaje wartości sekretów; formularz może przekazać je bezpośrednio do bezpiecznego API zapisu, a potem operować na referencji.

## 3. Model wydania zamiast sztywnego STABLE/CURRENT/NEXT

Pierwotny model z trzema wskaźnikami wyraża dobry cel: kandydat ma przejść przygotowanie, zanim zastąpi działającą wersję. Nie jest jednak pełnym mechanizmem zero-downtime. Wspólna baza może już zawierać nowy schemat i dane, których stary kod nie rozumie. „Rollback zachowuje dane” z RFC nie wynika z podmiany wskaźnika. [Security RFC.MD](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Security RFC.MD:356>), [Graph AST Schema RFC.md](</Users/krzysztofkrajewski/Projects/Lattis - pozostałe/Graph AST Schema RFC.md:1280>).

**Nowa reguła:** wydanie aplikacji jest niezmiennym zestawem: kod Core + dokładne pakiety i digests z lockfile + konfiguracja bez wartości sekretów + wersja kontraktów API i zdarzeń + plan migracji. Zapisujemy co najmniej wersję aktywną i kandydata oraz poprzedni artefakt potrzebny do wycofania kodu. Liczba przechowywanych wydań wynika z kosztu i polityki retencji, nie jest stałą „30”.

### Kolejność aktualizacji

1. **Expand:** dodać kompatybilne pola/tabele/interfejsy bez usuwania starego kontraktu. Stary i nowy kod mogą działać ze wspólną bazą.
2. **Backfill/migrate:** przenieść dane w kontrolowanych partiach, jeśli potrzeba. Proces może trwać niezależnie od przełączenia ruchu; nie wstrzymywać API długą migracją.
3. **Candidate:** zbudować/przygotować niezmienny artefakt i przypięte pakiety. Weryfikacje opisane w [planie](04-decyzje-i-zrodla.md#4-plan-weryfikacji-do-uruchomienia-tylko-na-polecenie) wykonuje się **dopiero na wyraźne polecenie użytkownika**.
4. **Uruchomienie obok starej wersji:** kandydat otrzymuje nową instancję, readiness i ograniczony ruch. Kolejki i zdarzenia muszą akceptować wiadomości z obu wersji przez czas przejściowy.
5. **Promocja:** zwiększać ruch dopiero przy uzgodnionych sygnałach: brak błędów krytycznych, zgodność kontraktów, poprawność ścieżki logowania i uprawnień, stan DB/workerów. Ostatecznie drenaż starych żądań.
6. **Wycofanie kodu:** jeśli kandydat nie działa, kierować ruch do poprzedniego artefaktu **pod warunkiem**, że baza i zdarzenia pozostają z nim kompatybilne. W przeciwnym razie naprawa do przodu lub odtworzenie danych według osobnego planu.
7. **Contract:** dopiero po wygaśnięciu okresu zgodności usuwać stare pola, endpointy i formaty zdarzeń. Jest to osobne wydanie i najtrudniejsza do cofnięcia część.

Wydanie z Node/Shard wymaga ponadto przypięcia wersji ich kontraktów i dialektu DB. Samo pobranie pakietu z Geode nie aktywuje go; kandydat musi mieć lokalnie zmaterializowany, zatwierdzony kod, migracje i zgodne schematy zdarzeń. Dopóki outbox/inbox nie istnieją, nie można obiecywać bezstratnego nakładania wersji obsługujących zdarzenia. [ADR-C03 i C07](06-kompozycja-porty-i-backlog.md) definiują tę brakującą warstwę.

Ten wzorzec jest praktycznie stosowany dla współistnienia wersji aplikacji i schematu. [GitLab: Backwards compatibility across updates](https://docs.gitlab.com/development/multi_version_compatibility/), [GitLab: Avoiding downtime in migrations](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/).

### Poziomy dostępności

| Topologia | Co realnie obiecać |
|---|---|
| Jeden proces na jednym serwerze | Niezmienny artefakt, przygotowanie kandydata i szybkie przywrócenie kodu; możliwa krótka przerwa przy przełączeniu. Nie nazywać tego zero-downtime. |
| Dwa procesy/repliki i przełączanie ruchu | Możliwy rollout bez przerwy w ruchu HTTP, jeśli obie wersje współpracują z DB, sesjami, kolejką i sekretami oraz infrastruktura ma zasoby na nakładanie wersji. |
| Wiele instancji/ruch canary | Lepsza obserwacja regresji i automatyczne wycofanie kodu według progów; wyższy koszt infrastruktury i operacji. |

Readiness odłącza instancję niezdolną do przyjmowania ruchu, lecz samo w sobie nie dowodzi poprawności ścieżek biznesowych. Kubernetes dokumentuje rolling update i readiness, ale plan **nie wymaga Kubernetes od pierwszej aplikacji**. [Kubernetes: Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [Kubernetes: probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/).

### Granice auto-rollbacku i odzyskiwania

| Zdarzenie | Automatyczna reakcja | Wymagana osobna ścieżka |
|---|---|---|
| Kandydat nie uruchamia się / readiness nie przechodzi | Nie przełączać ruchu; stary proces dalej obsługuje żądania. | Diagnoza i poprawka nowego artefaktu. |
| Po canary rośnie liczba błędów API | Wycofać ruch do starego kodu, jeśli baza jest zgodna. | Zbadać żądania, które kandydat już zmienił. |
| Migracja dodająca pole nie powiodła się przed promocją | Pozostawić stary kod, przerwać promocję. | Naprawić migrację; sprawdzić częściowo zapisany stan. |
| Migracja usunęła/zmieniła dane nieodwracalnie | Sama podmiana kodu nie wystarczy. | Naprawa do przodu, odtworzenie backupu lub korekta danych według runbooka. |
| Geode jest niedostępne | Już zainstalowane pakiety nadal działają lokalnie. | Wstrzymać nowe instalacje/publikacje, ponowić po przywróceniu. |
| Uprawnienie subskrypcyjne wygasło | Nie wykonywać zapytania do Geode przy każdym żądaniu aplikacji. | Zasada okresu tolerancji i prawa do już zainstalowanej wersji wymaga decyzji produktowej. |

Backup przed ryzykowną migracją, szyfrowanie backupu, osobna kopia poza serwerem i procedura odtworzenia są obowiązkowym elementem **planu wydania**. Faktyczne ćwiczenie odtwarzania jest weryfikacją wymagającą polecenia użytkownika. Cel RPO/RTO należy wyznaczyć z realnych potrzeb pierwszej aplikacji, a nie kopiować wartości z dawnego RFC.

## 4. Bezpieczeństwo zdalnego MCP

Zdalny serwer Geode obsługuje narzędzia katalogowe i operacje chronione przez te same usługi domenowe co API. Nie ma „magicznego” dostępu agenta do pakietów prywatnych. Każde wywołanie ma identyfikator aktora, zasób, żądane działanie i ślad audytowy. Narzędzia publikujące, nadające dostęp lub unieważniające wersję mają ograniczone zakresy i idempotencję. Klient nie może wykorzystać sesji jednego użytkownika do publikacji jako inny wydawca.

Transport zdalny używa Streamable HTTP, TLS, walidacji `Origin` i uwierzytelnienia dla operacji chronionych. IdP obsługuje standardowy przepływ autoryzacji, a serwer weryfikuje odbiorcę tokenu i nie przekazuje obcych tokenów do innych usług. Są to wymagania specyfikacji MCP oraz jej zaleceń bezpieczeństwa. [MCP: transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP: authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [MCP: security best practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices).

Opis publicznego pakietu jest treścią osoby trzeciej. Agent może go streścić lub użyć jako danych, ale nie powinien wykonywać poleceń umieszczonych w README, nazwie czy wynikach wyszukiwania. Atrybuty bezpieczeństwa deklarowane przez narzędzie także nie zastępują serwerowej kontroli; specyfikacja MCP każe traktować adnotacje narzędzi jako niezaufane, jeśli nie pochodzą z zaufanego serwera. [MCP: tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## 5. Koszt operacyjny wybranej granicy

Od fazy 1 utrzymywane są **dwa systemy stanu**: baza aplikacji i centralne Geode z magazynem artefaktów, oraz publiczna powierzchnia HTTP/MCP. To wymaga TLS, kopii zapasowych, monitorowania, limitów, kont publikujących i reakcji na incydent. W zamian pakiety nie są kopiowane ręcznie między repo, a aplikacja działa bez dostępności Geode. Koszt rośnie znacznie przy dopuszczeniu obcych wydawców, płatnościach i uruchamianiu ich kodu; dlatego te funkcje pozostają osobnymi etapami.
