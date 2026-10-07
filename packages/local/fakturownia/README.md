# Fakturownia dla Lattis

Opcjonalny, lokalny Node do wystawiania faktur VAT w PLN. Node zapisuje zamiar wystawienia dokumentu w bazie aplikacji. Osobny worker komunikuje się z API Fakturowni. Kod nie jest aktywowany automatycznie i nie wykonuje kodu obcych pakietów w procesie Core.

## Podłączenie

Skopiuj `packages/local/fakturownia` do aplikacji. Do istniejącego `lattis.config.json` dodaj ścieżkę do `trustedModules` oraz migrację, zachowując pozostałe wpisy:

```json
{
  "trustedModules": ["./packages/local/fakturownia/index.ts"],
  "migrations": [
    { "id": "fakturownia_001", "path": "./packages/local/fakturownia/migrations/001.sql", "mariadbPath": "./packages/local/fakturownia/migrations/001.mariadb.sql", "phase": "expand" },
    { "id": "fakturownia_002", "path": "./packages/local/fakturownia/migrations/002.sql", "mariadbPath": "./packages/local/fakturownia/migrations/002.mariadb.sql", "phase": "expand" }
  ]
}
```

Po istniejącej migracji Core zastosuj `npm run lattis -- db:project expand`. Node `lattis.fakturownia.invoice.request` wymaga scope `fakturownia.invoice.create:invoice` i tożsamości zaufanej usługi. Node `lattis.fakturownia.invoice.get` wymaga `fakturownia.invoice.read:invoice` dla konkretnego `externalId` (UUID). Nie przyznawaj klientom dostępu do wystawiania faktur bez sprawdzenia zamówienia w zaufanym backendzie.

Zlecenie zawiera `externalId`, `departmentId`, `issueDate`, `sellDate`, nabywcę oraz pozycje. Nabywca może być istniejącym klientem Fakturowni (`{ "kind": "existing", "clientId": 123 }`) albo nowym (`{ "kind": "new", "name": "...", "email": "...", "taxNo": "..." }`). Każda pozycja ma `name`, `quantity`, `tax` i `totalGrossMinor` — **łączną kwotę brutto pozycji w groszach**, bez używania liczb zmiennoprzecinkowych w Lattis. Kontrakt celowo ogranicza dokumenty do zwykłej faktury VAT; wybór stawki podatku i danych dokumentu należy do aplikacji oraz jej procesu księgowego.

Przykładowe wejście Node (100,00 PLN brutto):

```json
{
  "externalId": "9fea23c7-cd5c-4884-9842-6f8592be65df",
  "departmentId": 12,
  "issueDate": "2026-10-04",
  "sellDate": "2026-10-04",
  "buyer": { "kind": "existing", "clientId": 123 },
  "positions": [{ "name": "Usługa", "quantity": 1, "tax": 23, "totalGrossMinor": 10000 }],
  "requireConfirmedPaynow": true
}
```

Opcja `requireConfirmedPaynow: true` wymaga lokalnej płatności Paynow o tym samym `externalId`, ze statusem `CONFIRMED`, walutą PLN i kwotą równą sumie pozycji. Przy tej opcji worker oznacza fakturę jako opłaconą w żądaniu do Fakturowni. Bez niej faktura może zostać wystawiona niezależnie od Paynow. Integracja nie tworzy automatycznie faktury po webhooku Paynow; zaufany backend składa zlecenie po uzyskaniu potwierdzenia. Własny `Idempotency-Key` żądania Core nadal jest wymagany.

Z opcjonalnym [Commerce](../commerce/README.md) użyj `lattis.fakturownia.invoice.from-sale` z `saleId`, `departmentId`, `issueDate`, `sellDate` i opcjonalnym `requireConfirmedPaynow`. Node bierze dane nabywcy, pozycje, podatek i kwotę z niezmiennej migawki sprzedaży, sprawdza `OPEN`, `PLN` oraz `scale: 2`, tworzy zlecenie z `externalId = saleId` i wiąże fakturę ze sprzedażą. Worker aktualizuje link faktury po uzgodnieniu dokumentu. Wymaga uprawnień `fakturownia.invoice.create`, `commerce.sale.read` i `commerce.sale.link`. Nabywca musi mieć nazwę, każda pozycja stawkę podatku, a liczba pozycji nie może przekraczać 50. `invoice.request` działa nadal bez Commerce. Obecny `from-sale` odpowiada jednej zwykłej fakturze na sprzedaż; korekty i dodatkowe dokumenty wymagają własnego przepływu.

## Worker i sekrety

Uruchamiaj osobny proces cyklicznie:

```sh
node --import tsx packages/local/fakturownia/worker.ts
```

Worker wymaga `APP_DATABASE_URL`, `FAKTUROWNIA_ACCOUNT` (sam prefiks konta, bez adresu URL), `FAKTUROWNIA_API_TOKEN` oraz `FAKTUROWNIA_PII_KEY`. Adres API jest budowany wyłącznie jako `https://<konto>.fakturownia.pl`, bez dowolnego adresu podawanego przez klienta. Token wysyłany jest w ciele żądania POST, zgodnie z dokumentacją Fakturowni; zapytanie GET po `oid` używa nagłówka Bearer, więc nie umieszcza tokena w URL. W produkcji adapter bazy wymaga też `APP_DATABASE_CA_FILE`.

`FAKTUROWNIA_PII_KEY` to losowy 32-bajtowy klucz zakodowany w Base64. Core pobiera go przez deklarowany sekret pakietu `@lattis/fakturownia`; w produkcji skonfiguruj zewnętrznego dostawcę sekretów oraz referencję `FAKTUROWNIA_PII_KEY` w `lattis_secret_ref`. Worker musi dostać ten sam klucz z menedżera sekretów. Dane nabywcy i pozycji są szyfrowane AES-256-GCM w bazie Lattis; czytelne dane są wysyłane dopiero przez worker do Fakturowni. Zaplanuj retencję, kontrolę dostępu do bazy i rotację klucza. Zmiana klucza bez ponownego zaszyfrowania oczekujących zleceń zablokuje ich przetwarzanie.

Przykładowa referencja, po zastąpieniu locatora identyfikatorem we własnym menedżerze sekretów:

```sql
INSERT INTO lattis_secret_ref (name, provider, locator, allowed_package)
VALUES ('FAKTUROWNIA_PII_KEY', 'external', 'fakturownia-pii-key', '@lattis/fakturownia');
```

## Duplikaty i uzgadnianie

Do Fakturowni przekazywane są `oid = externalId` i `oid_unique = "yes"`. Przed utworzeniem worker szuka istniejącego dokumentu o tym `oid`. Jeśli znajdzie dokument albo nie ma pewności, czy żądanie POST zakończyło się wystawieniem faktury, zapisuje `NEEDS_REVIEW` i **nie ponawia POST automatycznie**. Trwałe `IN_FLIGHT` po awarii procesu również wymaga ręcznego uzgodnienia. Operator porównuje dokument w Fakturowni z zamówieniem i dopiero potem rozstrzyga stan; automatyczne ponowienie przy niejednoznacznym wyniku mogłoby wystawić drugi dokument. Jednoznaczne błędy autoryzacji lub wejścia zapisują `BLOCKED`; odpowiedź `422` po POST pozostaje do uzgodnienia, bo może oznaczać konflikt `oid`. `ISSUED` jest ustawiane po odpowiedzi zawierającej oczekiwany `oid` i kwotę brutto. Statusy, numer i ID są dostępne przez Node odczytu; token dokumentu i publiczny link PDF nie są zwracane.

Moduł nie wysyła faktur e-mailem, nie pobiera PDF, nie wystawia korekt i nie obsługuje KSeF ani klasyfikacji podatkowej. Przed użyciem z prawdziwymi dokumentami potrzebne są próby na własnym koncie Fakturowni, w tym zgodność uwierzytelniania Bearer dla odczytu, sposobu liczenia kwot i pól odpowiedzi, oraz przegląd procesu księgowego. W tym zadaniu nie uruchomiono testów ani połączeń z kontem.

Źródła: [dokumentacja API Fakturowni](https://github.com/fakturownia/API), [przykłady wyszukiwania po OID i autoryzacji](https://app.fakturownia.pl/api?lang=en).
