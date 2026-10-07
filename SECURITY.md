# Zgłaszanie podatności i zakres wsparcia

Lattis 0.3.0-alpha.1 jest przygotowanym wydaniem źródłowym alpha. Nowe zabezpieczenia nie zostały uruchomione, przetestowane ani poddane niezależnemu audytowi. Nie deklarujemy gotowości produkcyjnej, braku podatności, certyfikacji ani czasu reakcji SLA.

## Zgłoszenia

Przed publicznym uruchomieniem właściciel projektu musi opublikować działający prywatny kanał zgłaszania podatności. W tej zmianie nie podano adresu kontaktowego ani nie potwierdzono włączenia GitHub Private Vulnerability Reporting. Jeżeli taka funkcja jest dostępna w repozytorium, użyj prywatnego zgłoszenia; w przeciwnym razie uzgodnij prywatny kanał z właścicielem projektu. Nie publikuj sekretów, danych klientów ani instrukcji aktywnego wykorzystania podatności w publicznym issue.

Zgłoszenie powinno zawierać wersję/digest wydania, dotknięty komponent, warunki odtworzenia na danych syntetycznych, skutek i sugerowane ograniczenie problemu. Usuń tokeny, hasła i dane osobowe z raportu. Dostęp do danych cudzej instancji nie jest upoważnieniem do testów.

## Utrzymanie

Aktywną linią prac jest 0.3 alpha. Nie ogłoszono wsparcia produkcyjnego, LTS ani harmonogramu poprawek dla 0.1/0.2. Wersja alpha nie powinna być przedstawiana klientom jako stabilny produkt z gwarantowanym wsparciem. Podstawowe poprawki bezpieczeństwa Core pozostają w otwartym kodzie; umowa komercyjna może określać odrębny zakres obsługi i SLA.

## Granice ochrony

Faza 1 nie wykonuje pakietów obcych wydawców w procesie aplikacji. Produkcyjne rozszerzenia 0.3 to ograniczone deklaracje danych; runner nie jest sandboxem dla dowolnego kodu. Core, biblioteki, baza, root hosta, klucze i operator pozostają częścią zaufanego środowiska.

Podpisy i hashe potwierdzają zgodność bajtów z zatwierdzeniem. Nie potwierdzają braku podatności. WAF nie zastępuje autoryzacji ani izolacji backendu. Dokumenty oceny i maintenance receipt są oświadczeniami recenzentów/operatora, a nie zdalną atestacją hosta.

Po incydencie należy ograniczyć dotknięte operacje, zachować materiał diagnostyczny bez sekretów, odwołać naruszone poświadczenia i przygotować ocenione wydanie naprawcze. Nie zakładaj bezpiecznego rollbacku bazy. Proces aktualizacji i jego ograniczenia: [wydanie 0.3](docs/15-kontrolowany-produkt-0.3.md).
