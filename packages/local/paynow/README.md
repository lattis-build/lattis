# Paynow v3 dla Lattis

Opcjonalny lokalny Node do jednorazowych płatności przekierowujących w PLN. Kod zapisuje zlecenie w bazie aplikacji, a osobny proces tworzy płatność w Paynow. Odbiornik powiadomień działa poza Core. W fazie 1 żaden kod obcego wydawcy nie jest wykonywany w procesie aplikacji.

## Aktywacja w aplikacji

Skopiuj katalog `packages/local/paynow` do własnej aplikacji i jawnie dodaj do jej `lattis.config.json`:

```json
{
  "trustedModules": ["./packages/local/paynow/index.ts"],
  "migrations": [
    { "id": "paynow_001", "path": "./packages/local/paynow/migrations/001.sql", "mariadbPath": "./packages/local/paynow/migrations/001.mariadb.sql", "phase": "expand" },
    { "id": "paynow_002", "path": "./packages/local/paynow/migrations/002.sql", "mariadbPath": "./packages/local/paynow/migrations/002.mariadb.sql", "phase": "expand" }
  ]
}
```

To fragment istniejącego pliku; zachowaj `schemaVersion`, `trustedPublishers` oraz wcześniejsze moduły i migracje. Zastosuj migrację poleceniem `npm run lattis -- db:project expand`. Migracja Core (`db:app`) musi już istnieć. Nie zmieniaj zastosowanego SQL bez nowego ID migracji.

Node `lattis.paynow.payment.request` wymaga uprawnienia `paynow.payment.create` dla zasobu `payment` oraz **tożsamości usługi**. Zaufany backend aplikacji przekazuje `externalId` jako UUID, kwotę w groszach (`amountMinor`), `currency: "PLN"`, opis i adres e-mail kupującego. Kwotę i powiązanie z zamówieniem trzeba ustalić z danych serwera; wartości przysłanej przez przeglądarkę nie wolno użyć jako ceny. Opis nie powinien zawierać danych osobowych. HTTP Core wymaga też własnego `Idempotency-Key`. Powtórzenie `externalId` z innymi danymi jest odrzucane. Odpowiedź Node ma status `QUEUED` — przekierowanie powstaje dopiero po pracy procesu Paynow.

Node `lattis.paynow.payment.get` wymaga uprawnienia `paynow.payment.read` dla tego samego `payment` i `externalId`. Zwraca aktualny status i `redirectUrl`, gdy Paynow go udostępni. Nadaj odczyt tylko usłudze obsługującej zamówienie lub użytkownikowi z uprawnieniem ograniczonym do konkretnego `externalId`; ogólna rola odczytu ujawniałaby cudze płatności.

Jeżeli aplikacja używa opcjonalnego [Commerce](../commerce/README.md), może wywołać `lattis.paynow.payment.for-sale` z `{ "saleId": "…", "description": "…" }`. Node odczytuje kwotę i e-mail z zapisanej sprzedaży, sprawdza `OPEN`, `PLN` i `scale: 2`, tworzy żądanie z `externalId = saleId` oraz wiąże oba rekordy w jednej transakcji. Aktualizacje workera i podpisanego webhooka przenoszą stan do linku sprzedaży. Potrzebne są uprawnienia `paynow.payment.create`, `commerce.sale.read` i `commerce.sale.link`; bazowy `payment.request` działa nadal bez Commerce. Obecny adapter `for-sale` tworzy jedną płatność Paynow na sprzedaż; kolejne próby z odrębnym `externalId` wymagają rozszerzenia adaptera.

## Osobne procesy i sekrety

Proces tworzący i uzgadniający płatności uruchamiaj cyklicznie, na przykład co 15–30 sekund:

```sh
node --import tsx packages/local/paynow/worker.ts
```

Odbiornik powiadomień jest długotrwałym procesem:

```sh
node --import tsx packages/local/paynow/webhook.ts
```

Wymagane zmienne worker: `APP_DATABASE_URL`, `PAYNOW_ENVIRONMENT=sandbox|production`, `PAYNOW_API_KEY`, `PAYNOW_SIGNATURE_KEY`, `PAYNOW_PII_KEY`. Odbiornik potrzebuje `APP_DATABASE_URL` i `PAYNOW_SIGNATURE_KEY`. `PAYNOW_PII_KEY` to niezależny, losowy 32-bajtowy klucz zakodowany jako Base64. Core pobiera go przez deklarowany sekret `PAYNOW_PII_KEY` dla `@lattis/paynow`; w produkcji przypisz referencję `external` w `lattis_secret_ref` i skonfiguruj `LATTIS_SECRET_PROVIDER_URL` oraz `LATTIS_SECRET_PROVIDER_TOKEN`. Worker musi otrzymać ten sam klucz z menedżera sekretów. W rozwoju można użyć providera `env`. Adres e-mail kupującego jest szyfrowany AES-256-GCM przed zapisem w tabeli, z `externalId` jako dodatkowymi danymi uwierzytelnianymi. Utrata klucza uniemożliwia ponowienie zleceń, a rotacja wymaga przepisania istniejących rekordów przed zmianą klucza.

Przykładowa referencja produkcyjna (locator dostosuj do własnego dostawcy sekretów):

```sql
INSERT INTO lattis_secret_ref (name, provider, locator, allowed_package)
VALUES ('PAYNOW_PII_KEY', 'external', 'paynow-pii-key', '@lattis/paynow');
```

W produkcji adapter bazy wymaga także `APP_DATABASE_CA_FILE`. Przekazuj sekrety z menedżera sekretów do procesów, nie zapisuj ich w repo. Zalecane są osobne konta bazy z minimalnymi uprawnieniami do tabel płatności i audytu; obecny adapter nie tworzy ich automatycznie.

Webhook domyślnie słucha tylko na `127.0.0.1:4110`, ścieżka `/paynow/notifications`. Przekaż do niego tę ścieżkę przez reverse proxy z HTTPS i wpisz publiczny adres powiadomień w panelu Paynow. `PAYNOW_WEBHOOK_HOST` i `PAYNOW_WEBHOOK_PORT` zmieniają lokalny adres. Nie wystawiaj procesu bezpośrednio do Internetu; na proxy ogranicz rozmiar żądania i ruch.

Powiadomienie jest przyjmowane dopiero po sprawdzeniu HMAC-SHA256 na **oryginalnych bajtach** żądania i trwałym zapisie. Duplikaty oraz starsze `modifiedAt` są ignorowane. Potwierdzonej płatności późniejszy status nie cofa. Worker uzgadnia statusy `NEW` i `PENDING` z podpisanym API Paynow; błędy uwierzytelniania lub walidacji oznacza jako `BLOCKED` do interwencji operatora. `UNKNOWN` oznacza niepewny wynik utworzenia i jest ponawiany z tym samym kluczem idempotencji Paynow.

**Przyznawaj dostęp lub realizuj zamówienie wyłącznie po lokalnym `CONFIRMED`**, powiązanym z zamówieniem po `externalId` lub `saleId` w Commerce. Powrót z przekierowania i samo wygenerowanie `redirectUrl` nie potwierdzają zapłaty. Realizacja musi być atomowa po stronie aplikacji; ten pakiet nie implementuje uprawnień ani zwrotów.

Kod nie został uruchomiony ani zweryfikowany na sandboxie Paynow lub na bazie danych w tym zadaniu. Przed użyciem z prawdziwymi środkami wymagane są próby w sandboxie, przegląd bezpieczeństwa, plan obsługi zdublowanych płatności oraz operacyjna obserwacja statusów `BLOCKED`/`UNKNOWN`.

Źródła: [integracja i podpisy Paynow](https://docs.paynow.pl/docs/v3/integration), [utworzenie płatności](https://docs.paynow.pl/docs/reference/v3/send-payment-request), [status płatności](https://docs.paynow.pl/docs/reference/v3/get-payment-status).
