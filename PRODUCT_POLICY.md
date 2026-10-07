# Polityka produktu Lattis

Lattis ma rozwijać się jako spójny fundament aplikacji, z przewidywalnymi wydaniami i jasno opisanymi granicami zaufania. Ta polityka opisuje oficjalny kanał i proces utrzymania. Nie ogranicza praw do kodu przyznanych przez [MIT](LICENSE) i nie certyfikuje nieweryfikowanego wydania alpha.

## Dopuszczanie zmian i rozszerzeń

- Sam podpis wydawcy potwierdza pochodzenie, nie jakość. Oficjalny kanał wymaga przeglądu dokładnych bajtów, wersji zależności, zgodności i praw do dystrybucji.
- Publikacje trafiają do kwarantanny. Token wydawcy, wynik wyszukiwania ani cena pakietu nie nadają mu uprawnień wykonania.
- W fazie 1 pobrane pakiety pozostają danymi. Nie wykonujemy obcego kodu w procesie aplikacji. Produkcyjne rozszerzenia 0.3 mają postać ocenionych własnych deklaracji; nie ma instalacji dowolnego JS/TS/Wasm.
- Deklaracje mogą wywoływać wyłącznie wskazane Nodes przez autoryzowany broker. Użytkownik nie uzyskuje dodatkowych praw przez rozszerzenie. Query nie może wywołać command. Uprzywilejowany kod Core wymaga równie starannego przeglądu.
- Nowa wersja zależności nie dziedziczy dopuszczenia starej. Wydanie obejmuje oceniony zestaw, nie płynny katalog automatycznie aktualizowanych dodatków.

## Interfejs i prywatność

Panel renderuje znane komponenty z danych. Rozszerzenia nie wstrzykują HTML, skryptów, CSS ani iframe. Nie mogą przejmować nawigacji, dodawać reklam, marketingowych pop-upów, własnych ekranów płatności ani śledzenia przez dowolne adresy zewnętrzne. Nowy typ komponentu wymaga zmiany i przeglądu Core; nie jest boczną furtką do ładowania skryptu pakietu.

Podstawowa ochrona, aktualizacje bezpieczeństwa i kontrola pochodzenia nie są elementem płatnego upsellu. Usługi Cloud, Forge i AI mogą mieć osobne warunki oraz opłaty za dostarczaną usługę. Zewnętrzne przetwarzanie danych lub telemetria wymagają jawnego projektu, podstawy i informacji dla użytkownika; nie pojawiają się ukryte w rozszerzeniu.

## Wydania i utrzymanie

Oficjalne wydanie wiąże kod, zależności, konfigurację, migracje oraz imienną ocenę z evidence. Ocenę podpisują uprawnieni właściciele; prywatne klucze wydawnicze pozostają poza serwerem aplikacji. Progi podpisów i rozdzielenie ról muszą być ustalone przez operatora. Oświadczenie w JSON nie zastępuje rzeczywistej pracy recenzenta.

Wersje alpha mogą zawierać zmiany niezgodne wstecz. Każda taka zmiana musi mieć opis migracji i wpływu na dane. Wydanie stabilne będzie wymagało osobno ogłoszonego okresu wsparcia, zakresu kompatybilności i procedury naprawczej; obecne alpha nie obiecuje LTS ani SLA. API i migracje danych nie mogą zmieniać się przez ukrytą aktualizację pakietu.

Aktywacja produkcyjna wymaga niezależnego aktualizatora i zatwierdzenia konkretnego wydania. Runtime nie zapisuje do kodu, kotwic ani polityk. Zmiana plików blokuje kolejny start; niezależny monitoring może alarmować o zmianie w działającej instalacji. Nie kasuje danych i nie wykonuje samoczynnej „naprawy”. Cofnięcie po migracji wymaga oceny i odtworzenia lub wydania naprawczego.

WAF i izolacja origin są częścią wdrożenia. Ich stan musi potwierdzić operator; zapisanie wymagania w polityce nie dowodzi jego spełnienia. Obsługa incydentów obejmuje ustalenie zakresu, nowy podpisany katalog lub wydanie, komunikat i instrukcję działania. Termin ważności TUF ogranicza świeżość odwołań; natychmiastowej awaryjnej listy odwołań jeszcze nie zaimplementowano.

## Granice obietnicy jakości

Kontrolowany proces zmniejsza powierzchnię rozszerzeń, lecz nie gwarantuje braku błędów. Root hosta, przejęte klucze, wadliwy Core, konfiguracja infrastruktury i nierzetelna ocena pozostają istotnymi ryzykami. Status oficjalnego wydania wymaga rzeczywistego procesu, a nie tylko ustawienia pola `approved`. Dostępność źródeł i prawo do forków pozostają zachowane.
