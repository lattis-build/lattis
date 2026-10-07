# Commerce: opcjonalna tożsamość sprzedaży

`@lattis/commerce` dodaje wspólny identyfikator `saleId` (UUID) dla zamówienia lub sprzedaży. Instaluj go tylko w aplikacjach, które prowadzą sprzedaż. Core pozostaje neutralny wobec produktów, koszyka, płatności i faktur. Inne zaufane Nodes mogą powiązać swoje rekordy z `saleId` przez `lattis.commerce.sale.link`.

## Podłączenie

Do istniejącego `lattis.config.json` aplikacji dodaj moduł i migrację, zachowując wcześniejsze wpisy:

```json
{
  "trustedModules": ["./packages/local/commerce/index.ts"],
  "migrations": [{
    "id": "commerce_001",
    "path": "./packages/local/commerce/migrations/001.sql",
    "mariadbPath": "./packages/local/commerce/migrations/001.mariadb.sql",
    "phase": "expand"
  }]
}
```

Zastosuj migrację poleceniem `npm run lattis -- db:project expand`. Jeśli dodajesz Paynow i Fakturownię, dodaj także ich migracje `001` oraz `002`. Migracja Commerce musi być dostępna przed użyciem integracji `for-sale` i `from-sale`. Same bazowe Nodes Paynow i Fakturowni mogą działać bez Commerce.

Utwórz niezależny losowy klucz 32-bajtowy zakodowany jako Base64 i udostępnij go jako sekret `COMMERCE_PII_KEY` wyłącznie pakietowi `@lattis/commerce`. W produkcji użyj referencji `external` w `lattis_secret_ref` i skonfiguruj zewnętrznego dostawcę sekretów. Nie zapisuj klucza w repo. Zmiana klucza wymaga wcześniejszego ponownego zaszyfrowania rekordów; utrata klucza uniemożliwi odczyt danych sprzedaży.

## Rekord sprzedaży

`lattis.commerce.sale.create` przyjmuje opcjonalny `saleId`, walutę ISO 4217, liczbę miejsc dziesiętnych (`scale`), nabywcę, pozycje i proste `metadata`. Cena jest zapisywana jako liczba całkowita w najmniejszych jednostkach waluty (`totalMinor`); suma pozycji staje się niezmienną kwotą sprzedaży. Każda pozycja ma własny `lineId` UUID i może wskazywać produkt przez `productRef`. Dane nabywcy, pozycji i metadane są szyfrowane w jednym migawkowym rekordzie AES-256-GCM, a odcisk żądania jest chroniony HMAC. `saleId` można bezpiecznie ponowić z tym samym zestawem danych; inne dane pod tym samym ID są odrzucane.

Przykładowe wejście dla sprzedaży 100,00 PLN:

```json
{
  "currency": "PLN",
  "scale": 2,
  "buyer": { "userId": "user-42", "name": "Jan Kowalski", "email": "jan@example.com" },
  "items": [{
    "lineId": "e0d8bd86-45f6-4d3b-b2bb-34ee46883835",
    "productRef": "kurs-1",
    "name": "Kurs",
    "quantity": 1,
    "totalMinor": 10000,
    "tax": 23
  }],
  "metadata": { "channel": "web" }
}
```

`sale.create`, `sale.link` i `sale.status` wymagają tożsamości zaufanej usługi. Core dodatkowo sprawdza odpowiednie uprawnienia `commerce.sale.create`, `commerce.sale.link` i `commerce.sale.status` dla zasobu `sale`. Komendy wywoływane przez HTTP wymagają `Idempotency-Key`. `sale.get` wymaga `commerce.sale.read` dla konkretnego `saleId` i zwraca pełne dane nabywcy; ogranicz to uprawnienie do usług lub właściciela sprzedaży. Ogólne uprawnienie odczytu ujawniałoby cudze dane. Nie przenoś ceny z żądania przeglądarki bez ustalenia jej po stronie serwera.

## Statusy i powiązania

`sale.status` zmienia status sprzedaży `OPEN → CANCELLED/CLOSED` i niezależny stan realizacji `UNFULFILLED → PARTIAL → FULFILLED`. Wymaga `expectedVersion` z `sale.get`, by odrzucić zapis na nieaktualnej wersji. Nie anuluje sprzedaży, jeśli istnieje już potwierdzona płatność. Późne potwierdzenie płatności po anulowaniu nadal może nadejść; aplikacja musi wtedy rozpatrzyć zwrot lub ręczną obsługę.

`sale.link` wiąże sprzedaż z rekordem dostawcy przez `(kind, provider, reference)`, na przykład `payment/paynow/<externalId>` albo `invoice/fakturownia/<externalId>`. Jednej referencji dostawcy nie można przypisać dwóm sprzedażom. `providerId` jest identyfikatorem nadanym później przez dostawcę. Jedna sprzedaż może mieć wiele linków i dodatkowe własne Nodes, np. do realizacji lub subskrypcji. Status linku jest oddzielny od statusu sprzedaży i realizacji. Uprawnienie do linkowania płatności oraz ustawiania `CONFIRMED` przyznawaj tylko procesom, które rzeczywiście uzgadniają wynik u operatora.

`sale.get` wylicza `paymentStatus` i `paymentReceivedMinor` z potwierdzonych linków płatniczych. To widok operacyjny, nie księga rozrachunków: obecny model nie rozlicza częściowych zwrotów, korekt, wielu walut w jednej sprzedaży ani automatycznego przyznania dostępu. Płatności, faktury i realizacja zachowują własne statusy oraz reguły. Stawki podatku i dane do faktury ustala aplikacja zgodnie z własnym procesem księgowym.

Integracje: [`lattis.paynow.payment.for-sale`](../paynow/README.md) tworzy żądanie płatności na kwotę z migawki sprzedaży, a [`lattis.fakturownia.invoice.from-sale`](../fakturownia/README.md) tworzy zlecenie faktury z tych samych pozycji. Dla obu adapterów `externalId = saleId`, natomiast identyfikatory nadane przez operatorów pozostają osobnymi `providerId`. Tożsamość transakcji wynika z UUID i powiązania w bazie, nie z samej kwoty.

Kod i migracje nie były uruchamiane ani weryfikowane w tym zadaniu. Przed użyciem z prawdziwymi danymi i płatnościami potrzebne są testy integracyjne, przegląd uprawnień oraz plan retencji i rotacji klucza.
