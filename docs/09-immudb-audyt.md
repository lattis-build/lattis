# Opcjonalny dziennik audytu w immudb

**Status:** implementacja nie została uruchomiona, przetestowana ani zweryfikowana z serwerem immudb. Nie jest potwierdzeniem odporności na manipulację w produkcji.

## Rola immudb

PostgreSQL lub MariaDB pozostaje bazą kont, uprawnień, treści i lokalnych wpisów audytu. immudb przechowuje osobny rejestr odcisków tych wpisów. Nie trafiają do niego adresy e-mail, treść żądań ani pełne rekordy audytu. Każdy odcisk jest HMAC-SHA-256 obliczanym z identyfikatora instancji, ID zdarzenia, czasu, aktora, działania, zasobu, wyniku i identyfikatora korelacji. Klucz HMAC pozostaje poza obiema bazami.

Trigger w bazie aplikacji dopisuje ID do `lattis_immudb_outbox` w tej samej transakcji, w której powstaje `lattis_audit`. Migracja dopisuje również starsze wpisy audytu do kolejki. Gdy `LATTIS_IMMUDB_URL` jest ustawione, Core przenosi porcje z kolejki co 15 sekund. Przed oznaczeniem wpisu jako wysłanego odczytuje odcisk z immudb; ponowienie po awarii nie tworzy celowo innej wartości pod tym samym kluczem. Niedostępność immudb nie zatrzymuje API, lecz powiększa kolejkę i jest logowana. `/health/ready` nie sprawdza immudb.

To nie jest jedna transakcja między dwiema bazami. Istnieje opóźnienie między zapisem lokalnym a rejestrem immudb. Dotychczasowe wywołania biznesowe nie wszystkie zapisują swój wpis audytu w tej samej transakcji co zmianę biznesową; kolejka chroni dopiero etap **wpis audytu → immudb**. Należy monitorować zaległości i traktować je jako ryzyko, a nie jako dowód pełnego pokrycia audytem.

## Wdrożenie

1. Uruchom osobny serwer immudb z włączonym serwerem zgodnym z protokołem PostgreSQL i TLS. Zmienne `LATTIS_IMMUDB_URL` i `LATTIS_IMMUDB_MIGRATION_URL` wskazują tę samą bazę immudb, ale w produkcji muszą używać różnych kont. Konto eksportera powinno mieć tylko `SELECT` i `INSERT` do `lattis_audit_receipt`; konto migracyjne tworzy tabelę. Nie używaj domyślnych danych logowania immudb.
2. Ustaw `LATTIS_IMMUDB_CA_FILE` na zaufany certyfikat CA. W produkcji brak CA lub wspólnego użytkownika dla eksportu i migracji jest błędem konfiguracji. Ustaw stały, unikalny `LATTIS_IMMUDB_NAMESPACE` oraz losowy `LATTIS_AUDIT_HMAC_KEY` o długości co najmniej 32 znaków w menedżerze sekretów. Nie zmieniaj tego klucza bez osobnego planu rotacji i zachowania możliwości weryfikacji starych odcisków.
3. Wykonaj migrację lokalnej bazy `db:app`, potem `db:immudb`. Po uruchomieniu Core kolejka zacznie się opróżniać. Polecenia `app:audit-status` pokazuje liczbę i wiek zaległych wpisów, `app:audit-export` wysyła jedną porcję ręcznie, a `app:audit-verify` porównuje rejestr immudb z lokalnymi wpisami i zapisanymi odciskami. Te polecenia są udostępnione, lecz w tej pracy nie zostały uruchomione.
4. Uruchom **niezależnego audytora immudb** poza procesem Core i na innym hoście lub w innej strefie administracyjnej. Przechowuj jego stan i klucz weryfikacyjny niezależnie od serwera immudb oraz ustaw powiadomienie przy manipulacji. Monitoruj także zaległości `app:audit-status`.

Oficjalna dokumentacja immudb opisuje [serwer PostgreSQL wire](https://docs.immudb.io/1.11.0/develop/sql/pg) oraz [niezależny audytor](https://docs.immudb.io/master/production/auditor.html). [Tabela SDK](https://docs.immudb.io/master/connecting/sdks) wskazuje, że weryfikacja w kliencie Node nie działa; dlatego Core nie nazywa samego zapisu przez `pg` kryptograficzną weryfikacją. Polecenie `app:audit-verify` porównuje wartości między bazami, ale nie zastępuje niezależnego audytora historii immudb.

## Granice i ryzyka

- Administrator posiadający dostęp zapisu do obu baz oraz klucz HMAC pozostaje silnym przeciwnikiem. Trzeba rozdzielić konta, sekrety, kopie zapasowe i obowiązki operacyjne.
- Odciski nie szyfrują lokalnych wpisów audytu ani pozostałych danych w bazie aplikacji. immudb służy do wykrywania zmian, a nie do zapobiegania odczytowi danych.
- Konto procesu Core powinno mieć `INSERT` do `lattis_audit` i `SELECT`/`UPDATE` do outboxu, bez `DELETE`/`TRUNCATE` na tych tabelach. Uprawnienia trzeba nadać na serwerze DB; sama aplikacja ich nie wymusza.
- Funkcja `app:audit-verify` wymaga najpierw opróżnienia kolejki. Wpis obecny już w immudb, lecz jeszcze nieoznaczony po awarii Core, zostanie rozliczony przez kolejne ponowienie eksportu.
- Integracja dotyczy audytu **aplikacji Core**. Audyt centralnego Geode ma osobną bazę i nie jest w tej wersji eksportowany do immudb.
