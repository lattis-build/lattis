# Zmiany Lattis

## 0.3.0-alpha.1 — 2026-10-07 — przygotowane źródła

- Dodano standardową licencję MIT: #1 GROUP PROSTA SPÓŁKA AKCYJNA. Dotychczasowy własny kod, w tym Admin i Geode, pozostaje dostępny na MIT.
- Dodano deklaratywne rozszerzenia JSON, osobny runner wyrażeń, broker autoryzowanych wywołań i wspólne formularze panelu. Zablokowano produkcyjne importy rozszerzeń TypeScript.
- Dodano katalog Geode v3 z oceną konkretnych artefaktów i digestów zależności. Pobieranie nadal nie uruchamia kodu.
- Dodano descriptor wydania v3 i updater 2 z wymaganą oceną jakości oraz związaniem polityki WAF. Nowy generator oceny tworzy wyłącznie rekord pending.
- Dodano szablony Nginx/ModSecurity/OWASP CRS, izolacji runnera, jednostki Admin i okresowego monitorowania integralności, a także podstawową politykę HTTP i ograniczone logowanie.
- Dodano politykę produktu, bezpieczeństwa, model komercjalizacji oraz instrukcję migracji z 0.2.

**Niezgodność:** updater 1 i descriptor v2 wymagają migracji. Produkcja wymaga pustego `trustedModules`; istniejące Commerce, Paynow i Fakturownia pozostają integracjami deweloperskimi. Stare dopuszczenia i piny Geode wymagają odnowienia. Nie dodano automatycznego rollbacku DB ani wykonania obcego kodu.

**Stan:** nie uruchomiono testów, lintów, buildów, skanów ani usług. Nie opublikowano paczki npm/TUF i nie wdrożono WAF. Źródła są alpha, bez potwierdzenia gotowości produkcyjnej. Forge, AI i Cloud są kierunkiem osobnych produktów, nie gotowymi usługami w tym wydaniu.

## 0.2.0-alpha.1 — wcześniejsza implementacja

Kwarantanna Geode, kotwice TUF, kandydat lock v2, niezależny updater i podpisane pełne wydania. Historyczny opis: [dokument 0.2](docs/14-publiczne-wydanie-0.2.md).
