# Canlı Çevirmen — Proje Şartnamesi

> Bu belge, Chrome eklentisinin tüm tasarım ve mimari kararlarını içerir.
> Claude Code bunu projenin tek referansı olarak kullanmalıdır. İdeali, bu
> dosyayı depo köküne `CLAUDE.md` adıyla koymaktır; Claude Code onu otomatik
> olarak kalıcı bağlam olarak okur.

---

## 1. Amaç ve felsefe

- **Kişisel kullanım** içindir, ticari değildir. Yayınlanmayacak.
- Amaç: YouTube videolarında **anlatılan konuyu doğru ve kaliteli anlamak**.
  Hedef his: "konuşan kişi sanki Türkçe anlatıyor".
- **Yalnızca sesli dublaj**. Ekranda yazı/altyazı/transkript göstermeye gerek yok.
- Çeviri ve seslendirme için **OpenAI API** kullanılır.
- Eklenti adı: **Canlı Çevirmen**. Tüm ekranların altında:
  **"Ozan Beşinci tarafından geliştirildi"**.

## 2. Temel mimari kararı: "Çeviri-önce" (translate-ahead)

Canlı akış (her cümleyi anında çevir) değil; **video açılınca arka planda işle,
sonra videoyla eş zamanlı oynat** yaklaşımı esastır. Sebebi: tam bağlamla daha
doğru ve doğal çeviri, gecikme baskısının olmaması, zaman damgasına tam hizalama
ve ses seçiminin mümkün olması.

- **Read-ahead (önden okuma):** Tüm videonun bitmesini bekleme. İlk 30–60 saniye
  hazır olunca oynatmaya başla, oynatma noktasının birkaç dakika önünü sürekli
  hazırla.
- **İki mod desteklenir:**
  - **Kaliteli** (varsayılan): çeviri-önce, üç model zinciri. Bu, projenin
    asıl amacına en uygun moddur.
  - **Canlı** (opsiyonel): `gpt-realtime-translate` ile düşük gecikme.
    Ses/ton seçimi yoktur.

## 3. İşleme hattı (Kaliteli mod)

1. **Altyazı/transcript al.** Önce YouTube'un kendi altyazısını dene.
   - İnsan yapımı altyazı → doğrudan kullan.
   - Otomatik (ASR) altyazı → önce temizle (gpt-5.5 ile noktalama + cümleleme +
     bariz hata düzeltme; içeriği değiştirme).
   - Sayfada hazır **Türkçe** altyazı varsa ona güvenme (YouTube makine çevirisi,
     düşük kalite). Orijinal dildeki altyazıyı al, kendimiz çevirelim.
2. **Altyazı yoksa:** sekme sesini yakala ve `gpt-4o-transcribe` ile transkribe et.
3. **Yeniden segmentle.** Altyazı parçaları ekranda okunsun diye cümle ortasından
   bölünmüş olabilir. Çeviri için **cümle sınırlarına göre** yeniden birleştir.
4. **Çeviri.** `gpt-5.5`; girişe videonun genel bağlamı + son 3–4 cümlelik kayan
   pencere + tespit edilen terim sözlüğü verilir. Talimat: *"Anlamı bozmadan
   akıcı ve doğal Türkçe; terimler ve özel isimler tutarlı kalsın."*
5. **Seslendirme.** `gpt-4o-mini-tts`; seçilen ses + ton talimatıyla.
6. **Süre eşitleme.** Üretilen Türkçe sesin süresini orijinal segmentin süresiyle
   karşılaştır; gerekirse konuşma hızını hafifçe ayarla ki dublaj birikip
   görüntüden kopmasın.
7. **Tampon + zamanlayıcı.** Hazır ses parçalarını sıraya al; bir oynatma
   zamanlayıcısı bunları orijinal zaman damgalarına göre sırayla çalar.
8. **Mikser (ducking).** Türkçe konuşurken orijinali otomatik kıs, sustuğunda
   geri aç. Kullanıcının iki kaydırıcısı taban/tavan seviyelerini belirler.

**Pipelining:** Aşamalar paralel çalışmalı — N. parça çalınırken N+1 seslendiriliyor,
N+2 çevriliyor olmalı. Toplam gecikme tek parçanın yolu kadar olur.

**Ayarlanabilir tek düğme:** tampon boyutu. Büyük tampon = daha akıcı + daha iyi
bağlam, daha fazla gecikme. Bu proje için kaliteden yana ~3–6 sn tampon uygundur.

## 4. Modeller (OpenAI)

Hepsi arayüzdeki model menülerinden değiştirilebilir olmalı.

| İşlev | Varsayılan | Alternatif |
|---|---|---|
| Transkripsiyon | `gpt-4o-transcribe` | `gpt-realtime-whisper` |
| Çeviri | `gpt-5.5` | `gpt-5.4-mini` (hız/maliyet) |
| Seslendirme | `gpt-4o-mini-tts` | `tts-1-hd`, `tts-1` |
| Canlı mod (S2S) | `gpt-realtime-translate` | — |

- **Endpoint'ler:** transkripsiyon (audio transcriptions), çeviri (chat/responses),
  seslendirme (audio/speech), canlı (realtime translation, WebRTC).
- **ÖNEMLİ:** Model adları ve sürümleri zamanla değişir. Kodlamadan önce güncel
  adları OpenAI dokümantasyonundan doğrula.

## 5. Sesler ve tonlar

**11 ses (`gpt-4o-mini-tts`)**, arayüzde üç tını grubunda sunulur (gruplama bizim
kolaylık etiketimizdir; OpenAI resmî cinsiyet etiketi vermez):

- Kadın tınılı: `nova`, `shimmer`, `coral`, `sage`
- Erkek tınılı: `onyx`, `echo`, `ash`, `ballad`
- Nötr tınılı: `alloy`, `fable`, `verse`

`tts-1` ve `tts-1-hd` yalnızca 9 sesi destekler (`ballad` ve `verse` yok).
**Seslendirme modeli değişince ses listesi otomatik güncellenmelidir.**

**Tonlar** (`gpt-4o-mini-tts` instructions alanına gönderilen serbest metin).
Hazır presetler + "Özel" (kullanıcının yazdığı):

- Sakin ve anlatan → `"Sakin, net ve açıklayıcı bir tonla, bir eğitmen gibi anlat."`
- Ciddi ve net → `"Ciddi, resmi ve net bir tonla, haber spikeri gibi oku."`
- Enerjik → `"Enerjik, canlı ve hareketli bir tonla oku."`
- Samimi → `"Samimi, sıcak ve sohbet eder gibi bir tonla oku."`

Canlı modda ses ve ton seçimi pasif olmalı (model desteklemiyor).

## 6. Arayüz — Popup (her video için kontroller)

**Tema: lacivert zemin, beyaz yazı.** Sabit renk paleti:

| Amaç | Renk |
|---|---|
| Panel zemini | `#0E2A5E` |
| Alan zemini | `#16356B` / kenarlık `#2A4A85` |
| Seçili durum | `#1E4A9E` / kenarlık `#4F86E8` |
| Koyu alan (input vb.) | `#0A2150` |
| Vurgulu düğme | `#2E63C8` |
| Beyaz metin | `#FFFFFF` |
| İkincil metin | `#B9C6E0` |
| Soluk metin | `#8A9BC4` |
| Grup etiketi | `#9DB0DA` |
| Ayraç | `#21407A` |

Bileşenler (yukarıdan aşağıya):

1. Başlık: "Canlı Çevirmen" + alt başlık "YouTube'u Türkçe dinle".
2. **Çeviri modu** — segmented kontrol: `[Kaliteli | Canlı]` (Kaliteli varsayılan seçili).
3. **Modeller** — işleve göre üç satır (Transkripsiyon, Çeviri, Seslendirme),
   her biri açılır menü. Üstte "Sırala: Kalite / Hız / Maliyet" seçeneği.
4. **Ses** — 11 ses üç tını grubunda, seçilebilir. Her sesin yanında ▶ önizleme
   düğmesi: tıklanınca o sesle kısa bir Türkçe örnek cümle çalar.
5. **Ton** — preset chip'ler + "Özel…" (tıklanınca serbest metin alanı açılır,
   modele gönderilecek talimatı gösterir/düzenletir).
6. **Ses seviyesi** — iki kaydırıcı: "Orijinal" (varsayılan %25) ve "Dublaj"
   (varsayılan %100), canlı % göstergeleriyle.
7. **"Dublajı başlat"** düğmesi.
8. Altbilgi: "Ozan Beşinci tarafından geliştirildi".

## 7. Arayüz — Ayarlar (options page)

Aynı lacivert tema.

- **OpenAI API anahtarı:** maskeli (password) input + göster/gizle (göz) düğmesi.
  - "Bağlantıyı test et" düğmesi → küçük bir doğrulama isteğiyle anahtarın
    geçerliliğini kontrol et, sonucu göster.
  - Kayıtlıysa tam göstermek yerine kısaltılmış göster: `sk-…3a9f`.
  - "Anahtarı sil" bağlantısı.
  - Yardım notu: "Anahtarın yalnızca bu tarayıcıda saklanır ve doğrudan OpenAI'a
    gönderilir."
- **Varsayılanlar:** mod, ses, ton. Popup bu değerlerle açılır.
- **Güvenlik notu:** OpenAI hesabında aylık harcama limiti belirlemeyi öner.
- "Kaydet" düğmesi.
- Altbilgi: "Ozan Beşinci tarafından geliştirildi".

## 8. Güvenlik modeli

- API anahtarı **`chrome.storage.local`** içinde saklanır (**`sync` değil** — cihazlar
  arası senkronlamayız).
- Anahtar **yalnızca service worker / offscreen katmanında** erişilebilir.
  Content script ve YouTube sayfasının JS ortamı anahtarı **asla** görmez.
- Tüm OpenAI çağrıları arka planda (service worker/offscreen) yapılır; content
  script yalnızca worker'a "şunu çevir/seslendir" mesajı atar.
- İstemci-taraflı (sunucusuz) eklenti olduğu için anahtar OpenAI isteğinde açıkta
  yer alır. Bu **yalnızca kişisel kullanım** olduğu için kabul edilebilir.
  Kurallar: **yayınlama, paketlenmiş halini paylaşma, anahtarı koda/git'e gömme.**
- En sağlam güvenlik ağı: OpenAI hesabında **aylık harcama limiti**.

## 9. Chrome eklentisi teknik yapısı (Manifest V3)

- `manifest.json`: MV3. İzinler: `tabCapture`, `storage`, `offscreen`, `activeTab`,
  `scripting`. Host izinleri: `*://*.youtube.com/*`. `options_ui`, `action` (popup),
  `background.service_worker`.
- **Service worker:** orkestrasyon, OpenAI çağrıları, anahtar erişimi, pipeline yönetimi.
- **Offscreen document:** ses işleme. `tabCapture` MediaStream'i burada Web Audio
  API ile işlenir; iki `GainNode` (orijinal + dublaj) mikseri burada kurulur.
- **Content script (YouTube):** altyazı/transcript çekme, video oynatma durumu ve
  zaman damgası izleme, worker ile mesajlaşma.
- **Popup & Options:** yukarıdaki arayüz spesifikasyonları.
- **Ses yakalama:** `chrome.tabCapture` → MediaStream → offscreen → Web Audio.
- **Canlı mod:** `gpt-realtime-translate` için WebRTC (tarayıcı medyası).

## 10. Önerilen dosya yapısı

```
canli-cevirmen/
  manifest.json
  background/
    service-worker.js        # orkestrasyon + OpenAI çağrıları + anahtar
  offscreen/
    offscreen.html
    offscreen.js             # Web Audio, tabCapture, GainNode mikser, ducking
  content/
    youtube.js               # altyazı çekme + zaman/oynatma izleme
  popup/
    popup.html
    popup.css
    popup.js
  options/
    options.html
    options.css
    options.js
  lib/
    openai.js                # transcribe / translate / tts sarmalayıcıları
    pipeline.js              # segmentasyon, bağlam penceresi, süre eşitleme, tampon
    storage.js               # chrome.storage sarmalayıcısı
    voices.js                # ses & ton sabitleri, model→ses eşlemesi
  assets/
    icon-16.png  icon-48.png  icon-128.png
```

## 11. Yapım sırası (kilometre taşları)

Her adımı bitir, çalıştırıp doğrula, sonra ilerle.

- **M1 — Çekirdek (eklentisiz, tek script):** Örnek bir İngilizce metni `gpt-5.5`
  ile Türkçeye çevir → `gpt-4o-mini-tts` ile (seçili ses + ton) seslendir →
  bir `.mp3` üret. Bu zincirin çalıştığını doğrula.
- **M2 — Pipeline:** segmentasyon + bağlam penceresi + süre eşitleme + tampon mantığı.
- **M3 — Eklenti iskeleti:** `manifest.json`, service worker, options page
  (anahtar kaydet + test).
- **M4 — YouTube entegrasyonu:** content script ile altyazı çekme + zaman izleme.
- **M5 — Ses katmanı:** `tabCapture` + offscreen + Web Audio mikser + ducking +
  iki kaydırıcı.
- **M6 — Popup arayüzü:** bu şartnamedeki tasarım + worker'a bağlama + ses önizleme.
- **M7 — Canlı mod (opsiyonel):** `gpt-realtime-translate` + WebRTC.
- **M8 — Cilalama:** read-ahead tamponu, hata/yeniden bağlanma, kullanım/maliyet göstergesi.

## 12. Önemli kısıtlar ve uyarılar

- Dublaj, orijinalin birkaç saniye gerisinden gelir; tam dudak senkronu yoktur.
  (Amaç anlamaktır, sinema dublajı değil.)
- Maliyet: çeviri ucuzdur (metin token'ı); asıl maliyet seslendirmedir. Altyazı
  kullanıldığında transkripsiyon adımı bedava ve hatasızdır.
- Ton talimatı bir *yönlendirmedir*, kesin bir ayar değildir.
- Ses klonlama yoktur; en fazla konuşmacıya uygun tınıda hazır ses seçilir.
- Canlı modda ses ve ton seçimi yoktur.
- Model adlarını OpenAI dokümantasyonundan güncel doğrula.
- Yalnızca kişisel kullanım; eklenti Developer Mode'da yüklenir, yayınlanmaz.
