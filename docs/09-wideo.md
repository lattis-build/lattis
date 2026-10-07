# Wideo w Core

Architektura źródeł HLS/DASH, CMAF, DRM i znakowania śledczego jest opisana w [10 — Architektura wideo](10-architektura-wideo.md).

**Status:** implementacja nie była uruchamiana, testowana ani poddana przeglądowi bezpieczeństwa. Nie należy traktować jej jako gotowej do produkcji.

## Co jest dostępne

Wbudowane Nodes `lattis.video.create`, `lattis.video.get` i `lattis.video.policy.update` tworzą metadane filmu, odczytują je i zmieniają politykę. Plik MP4 jest przesyłany strumieniowo przez `PUT /api/videos/{id}/file` do prywatnego katalogu poza webrootem. Limit `LATTIS_VIDEO_MAX_BYTES` wynosi domyślnie 2 GiB i może zostać zwiększony do 100 GiB. Core sprawdza rozmiar, SHA-256 i nagłówek MP4. Wideo jest wydawane przez `GET /api/videos/{id}/stream` z obsługą pojedynczego żądania `Range`, co pozwala przewijać bez wczytywania całego pliku; zakresy HTTP definiuje [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html). Sam upload nie sprawdza kodeków. Opcjonalne polecenie `video:package` uruchamiane poza procesem Core transkoduje materiał i tworzy pakiet HLS/DASH opisany w [architekturze wideo](10-architektura-wideo.md). Bez pakietu przygotuj MP4 z kodekami obsługiwanymi przez docelowe urządzenia i metadanymi potrzebnymi do odtwarzania progresywnego na początku pliku.

Każde odtworzenie wymaga użytkownika z grantem `video.play:video`. `POST /api/videos/{id}/playback` tworzy sesję na cztery godziny, zapisuje identyfikator użytkownika i czas, a migawkę nazwy oraz adres IP widziany przez Core szyfruje AES-256-GCM oddzielnym kluczem `LATTIS_VIDEO_ATTRIBUTION_KEY`. Następnie zwraca URL strumienia. Każde żądanie zakresu ponownie sprawdza konto, grant i ważność sesji. Sam URL nie wystarcza do pobrania pliku. Dane sesji są usuwane po okresie `LATTIS_VIDEO_PLAYBACK_RETENTION_DAYS` (domyślnie 30 dni), gdy działa zadanie czyszczące. Za reverse proxy ustaw `LATTIS_TRUSTED_PROXY_CIDRS` na dokładne adresy lub sieci zaufanych proxy; bez tego Core zapisze adres bezpośredniego peer, którym może być proxy. Nie włączaj zaufania do dowolnych nagłówków `X-Forwarded-For`.

## Uruchomienie

1. Ustaw `LATTIS_VIDEO_DIR` na prywatny katalog poza webrootem oraz `LATTIS_VIDEO_ATTRIBUTION_KEY` na niezależne 32 losowe bajty w base64 i wykonaj migrację bazy aplikacji. Proces Core potrzebuje praw zapisu; katalog, klucz i kopie zapasowe wymagają kontroli dostępu. Utrata klucza uniemożliwi późniejsze odczytanie przypisania IP i nazwy do sesji.
2. Nadaj odpowiednim rolom `video.manage:video` do zarządzania i `video.play:video` do oglądania. Rola właściciela ma grant ogólny. Zgodnie z obecnym modelem Core można ograniczyć przypisanie roli do konkretnego ID filmu.
3. Wywołaj Node `lattis.video.create` przez `POST /api/nodes/lattis.video.create/execute` z `Idempotency-Key` i danymi jak niżej. Zwrócony `uploadUrl` przyjmuje surowe bajty MP4 metodą `PUT`, z nagłówkiem `Content-Type: application/octet-stream`. `sha256` i `byteCount` muszą odpowiadać plikowi.

```json
{
  "title": "Przykładowe wideo",
  "mimeType": "video/mp4",
  "byteCount": 12345678,
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "downloadUi": "hide",
  "protectionMode": "access-controlled",
  "watermarkMode": "off"
}
```

W przykładzie `sha256` jest wartością zastępczą; przed wywołaniem wstaw rzeczywisty skrót pliku.

4. Na stronie obsługującej tę samą sesję uwierzytelnienia umieść komponent:

```html
<script type="module" src="/lattis-video-player.js"></script>
<lattis-video-player video-id="UUID-FILMU"></lattis-video-player>
```

Komponent korzysta z natywnego elementu `video`, skaluje się do dostępnej szerokości i tworzy sesję po kliknięciu. Jeśli frontend jest na innym pochodzeniu, można ustawić `api-base`, ale logowanie cookie, CORS i reguły przeglądarki dotyczące ciasteczek między witrynami muszą być skonfigurowane dla tego układu. Wbudowany komponent nie migruje frontendu WordPress.

## Ograniczenia ochrony kopii

`downloadUi: "hide"` ukrywa kontrolkę pobrania tam, gdzie przeglądarka obsługuje `controlsList`. Jest to tylko ustawienie interfejsu; [MDN opisuje `nodownload` jako sugestię dotyczącą kontrolek](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/controlsList). W trybie `access-controlled` przeglądarka otrzymuje jawne bajty MP4, więc uprawniony widz może je zapisać lub odtworzyć. Kontrola dostępu, prywatny katalog, TLS, brak publicznego URL i `Cache-Control: no-store` ograniczają przypadkowe udostępnienie, ale nie są DRM.

`protectionMode: "drm-required"` zatrzymuje odtwarzanie z odpowiedzią 501. To celowa blokada przed przypadkowym wydaniem jawnego MP4. Pełna obsługa wymaga pakowania zaszyfrowanego HLS/DASH, serwera licencji i integracji odpowiednich systemów dla urządzeń. Standard [Encrypted Media Extensions](https://www.w3.org/TR/encrypted-media/) udostępnia interfejs przeglądarki do takich systemów, lecz sam nie stanowi DRM. Na platformach Apple [FairPlay Streaming](https://developer.apple.com/streaming/fps/) chroni strumienie HLS. Aplikacja natywna Android może używać [FLAG_SECURE](https://developer.android.com/reference/android/view/WindowManager.LayoutParams) do ograniczania zrzutów i udostępniania ekranu. Żadna z tych technik nie gwarantuje zatrzymania nagrywania na wszystkich platformach ani kamerą skierowaną na ekran.

## Przyszły znak wodny

`watermarkMode: "forensic-required"` również zatrzymuje odtwarzanie z 501, dopóki nie ma faktycznego kodera i dekodera. Tabela sesji odtwarzania jest przygotowana do przypisania kopii do widza. Przyszły znak powinien kodować podpisany, losowy identyfikator sesji, a nie jawnie umieszczać w obrazie imię, adres IP czy inne dane osobowe. Dekoder odczyta identyfikator, a serwer na jego podstawie odtworzy nazwę użytkownika, IP i czas. Znaki zakodowane w samym materiale lub segmentach mają większą szansę przetrwać zrzut ekranu, rekompresję i kadrowanie niż kwadraciki nakładane przez DOM. Ich jednoczesna niewidoczność i skuteczność wymaga doboru algorytmu oraz badań na rzeczywistych nagraniach.

Przeglądarka nie udostępnia wiarygodnego adresu MAC odbiorcy zdalnej stronie. MAC może być lokalny, losowany i nie identyfikuje widza w Internecie, dlatego nie jest polem sesji ani planowanego znaku. Ewentualny identyfikator urządzenia w aplikacji natywnej wymaga osobnego projektu i przejrzystej polityki prywatności.
