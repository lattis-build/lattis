# Architektura wideo niezależna od odtwarzacza

**Stan:** opisuje kontrakt i pierwszy wariant pakowania. Kod nie był uruchamiany, testowany ani poddany przeglądowi bezpieczeństwa. Nie jest gotowy do produkcji. Tryby DRM i znakowania śledczego nadal celowo odmawiają odtwarzania.

## Podział odpowiedzialności

| Warstwa | Odpowiedzialność |
| --- | --- |
| Core i `lattis.video` | Tożsamość, uprawnienia, polityka filmu, sesja odtwarzania, atrybucja i audyt. Kontrakt źródeł nie wymienia odtwarzacza. |
| Proces przygotowania | Odczyt źródła, normalizacja kodeków, warianty jakości, segmenty CMAF/fMP4 i manifesty HLS/DASH. Działa poza procesem HTTP Core. |
| Dostawca DRM | Klucze, licencje Widevine/PlayReady/FairPlay, certyfikat FairPlay, polityka urządzeń i rotacja kluczy. |
| Dostawca znaku śledczego | Kodowanie A/B lub równoważne, wybór wariantu na sesję, dekoder i dowody odporności na przetworzenie kopii. |
| Aplikacja docelowa | Wybór Video.js 10, Shaka Player, odtwarzacza natywnego lub innego klienta i tłumaczenie kontraktu Lattis na jego API. |

HLS i DASH są formatami manifestu oraz sposobami dostarczania segmentów; CMAF określa strukturę fragmentów multimedialnych. Jeden zestaw przygotowanych fragmentów może służyć obu manifestom przy zgodnych profilach. Zgodność kodeka nadal zależy od urządzenia i DRM. [Shaka Packager](https://github.com/shaka-project/shaka-packager) obsługuje oba manifesty i szyfrowanie, a [FFmpeg](https://ffmpeg.org/ffmpeg.html) transkodowanie.

## Kontrakt odtwarzania

`POST /api/videos/{id}/playback` tworzy sesję i zwraca `contractVersion: 1`, `playbackId`, `expiresAt`, `sources[]`, `protection` i `watermark`. Element `sources[]` ma `kind` (`hls`, `dash`, `progressive`), `url`, `mimeType` i `container`. Dla materiału jawnego może zawierać HLS i DASH z `container: "cmaf"` oraz dotychczasowe MP4. `streamUrl` pozostaje aliasem starego kontraktu. Aplikacja sama wybiera najlepsze źródło i odtwarzacz. Wybór odtwarzacza nie zmienia decyzji o dostępie w Core.

Typ `VideoPlaybackDescriptorV1` jest eksportowany z `lattis/video-contract`. Przyszła odpowiedź dla DRM ma zawierać adresy sesyjnego brokera licencji per `keySystem`, a dla FairPlay również adres certyfikatu. Pole `streamUrl` jest opcjonalne, aby chronione źródło nigdy nie musiało ujawniać odnośnika do jawnego MP4.

Manifesty i segmenty lokalnego pakietu są wydawane przez ścieżkę zawierającą `playbackId`. Każdy odczyt sprawdza ponownie użytkownika, grant, sesję i bieżącą politykę filmu. Pakiet nie jest publicznym katalogiem. Przy późniejszym przejściu na CDN potrzebny będzie adapter autoryzacji na brzegu; nie wolno wtedy zastąpić kontroli sesji samym trudnym do odgadnięcia URL.

## Pierwszy wariant lokalny

Po migracji schematu `db:app` i wgraniu jawnego MP4 operator może uruchomić osobne polecenie `lattis video:package UUID`. Wymaga ono absolutnych ścieżek `LATTIS_FFPROBE_BIN`, `LATTIS_FFMPEG_BIN` i `LATTIS_SHAKA_PACKAGER_BIN`. FFmpeg tworzy H.264/AAC o wysokościach do 360p, 720p i 1080p, bez powiększania źródła; Shaka Packager tworzy manifesty HLS i DASH oraz segmenty fMP4. Wynik jest zapisywany w prywatnym katalogu i rejestrowany dopiero po zakończeniu pakowania. Źródłowy MP4 pozostaje dostępny w dotychczasowym trybie `access-controlled`.

Oznaczenie pakietu jako CMAF opisuje docelowy profil segmentów fMP4; zgodność z wybranym punktem interoperacyjności CMAF i urządzeniami musi zostać potwierdzona osobno przed użyciem produkcyjnym.

Ten wariant daje wejście dla różnych kodeków obsługiwanych przez FFmpeg, ale obecny HTTP upload nadal przyjmuje tylko MP4. Nie wolno reklamować obsługi dowolnych kontenerów, dopóki import źródła, kontrola zasobów i normalizacja nie zostaną rozszerzone. Proces pakowania powinien w produkcji działać w izolowanym workerze bez dostępu do bazy Core poza ograniczoną rolą, z limitami CPU, pamięci, czasu i dysku. Samo wywołanie polecenia nie zapewnia takiej izolacji. Nie uruchamiamy obcego kodu pakietu Geode w procesie aplikacji.

## Plan dla DRM

1. Osobny adapter dostawcy kluczy uzyskuje materiał klucza przez zarządzany kanał. Sekrety i surowe klucze nie trafiają do bazy metadanych, manifestu, odpowiedzi odtwarzania ani logów.
2. Worker tworzy oddzielny pakiet szyfrowany. Profil wybiera `cenc` lub `cbcs` według urządzeń docelowych; dla ścisłej ochrony `clear_lead` musi wynosić zero, bo [Shaka Packager domyślnie pozostawia początek jawny](https://github.com/shaka-project/shaka-packager/blob/main/docs/source/options/general_encryption_options.rst). Nie zakładamy, że jeden profil szyfrowania zadziała na wszystkich platformach.
3. Core udostępnia sesyjny broker licencji dla Widevine, PlayReady i FairPlay. Broker ponownie sprawdza grant i politykę, wiąże żądanie z pakietem i sesją oraz przekazuje je do skonfigurowanego dostawcy. Kontrakt klienta podaje adres brokera i ewentualny certyfikat FairPlay. Nie przyjmuje dowolnego adresu serwera licencji od aplikacji ani użytkownika.
4. Dopiero kompletny pakiet, działający broker i reguły zgodności urządzenia mogą zmienić `drm-required` z odmowy na odtwarzanie. Jawny MP4 i jawne pakiety muszą pozostać niedostępne w tym trybie. DRM może ograniczyć nagrywanie na obsługiwanych urządzeniach, lecz nie daje gwarancji na wszystkich platformach.

## Plan dla niewidocznego znaku wodnego

Znak ma kodować losowy, podpisany identyfikator sesji, nie nazwę ani IP wprost. Core przechowuje zaszyfrowaną migawkę nazwy i IP oraz czas sesji; dekoder zwraca identyfikator, który operator łączy z danymi sesji. Adres MAC nie jest dostępny wiarygodnie z przeglądarki.

Wymagany jest adapter kodera i dekodera oraz sesyjny wybór znakowanych segmentów A/B lub inny sprawdzony mechanizm osadzony w obrazie. Nakładka HTML lub „mini kwadraciki” rysowane przez odtwarzacz nie spełniają założenia odporności na przechwycenie i rekompresję. Przy `forensic-required` Core musi odmawiać odtwarzania, dopóki nie ma gotowego pakietu znakowanego i jego sesyjnej dystrybucji. Przykład zewnętrznego stosu: [Bitmovin z NAGRA](https://go.bitmovin.com/nagra-eventive).

## Video.js 10

Aplikacja może użyć Video.js 10, gdy jego wybrana wersja i potrzebne moduły przejdą próbę zgodności dla jej urządzeń oraz DRM. Lattis nie importuje Video.js do Core ani nie zakłada jego API. Według [wydań projektu](https://github.com/videojs/v10/releases) wersja 10.0.0 była 4 października 2026 na etapie RC; kontrakt Lattis pozostaje stabilny niezależnie od jej rozwoju.
