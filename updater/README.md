# Lattis Updater 2.0.0-alpha.1

Niezależny aktualizator, launcher i obserwacja integralności dla descriptoru aplikacji v3. Własny kod pakietu jest na [MIT](LICENSE), #1 GROUP PROSTA SPÓŁKA AKCYJNA. Biblioteka TUF i jej zależności zachowują odrębne licencje.

Instalacja pod `/opt/lattis-updater` musi być chroniona przez root i niezależna od katalogu aktualizowanej aplikacji. Nie uruchamiaj kopii updatera z kandydata aplikacji. Prywatne klucze nie trafiają na host produkcyjny. Polecenia `stage`, `activate` i `integrity` używają chronionej polityki `/etc/lattis/installation.json`; `run app|admin|geode` wymaga konta runtime bez root.

Wersja 2 wymaga związanej oceny jakości i polityki blokującego WAF z odizolowanym origin. Rozszerzenia wymagają odrębnego runnera o digescie zgodnym z autoryzowaną platformą. Nie wykonuje skryptów kandydata, migracji SQL ani automatycznej naprawy. Oświadczenia operatora i recenzenta nie są dowodem stanu infrastruktury.

To przygotowany kod alpha, bez wykonanych w tej zmianie testów lub weryfikacji. Szczegółowy proces: [wydanie 0.3](../docs/15-kontrolowany-produkt-0.3.md). Szablony nie zostały wdrożone.
