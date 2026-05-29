# Canlı Çevirmen

YouTube videolarını OpenAI ile **gerçek zamanlı Türkçe sesli dublaja** çeviren
kişisel kullanım amaçlı bir Chrome eklentisi (Manifest V3).

> Kişisel kullanım içindir; yayınlanmaz. Geliştirici modunda yüklenir.
> Geliştiren: **Ozan Beşinci**

## Ne yapar?

- YouTube videosunun altyazısını/sesini alır, **akıcı ve doğal Türkçeye** çevirir
  ve seçilen sesle seslendirip videoyla eş zamanlı oynatır.
- Türkçe konuşurken orijinal sesi otomatik kısar (ducking).
- İki mod:
  - **Kaliteli** (varsayılan): çeviri-önce — altyazı → `gpt-5.5` çeviri →
    `gpt-4o-mini-tts` seslendirme, tam bağlamla.
  - **Canlı**: `gpt-realtime-translate` ile düşük gecikmeli, WebRTC üzerinden.
- Altyazısı olmayan videolarda sekme sesini `gpt-4o-transcribe` ile transkribe eder.
- Popup'ta tahmini maliyet göstergesi + aylık yumuşak uyarı eşiği.

## Kurulum

1. `chrome://extensions` → **Geliştirici modu**'nu aç.
2. **Paketlenmemiş öğe yükle** → bu klasörü seç.
3. Eklenti ayarlarını aç, **OpenAI API anahtarını** kaydet ve "Bağlantıyı test et".
4. Bir YouTube videosu aç → eklenti simgesi → **Dublajı başlat**.

Masaüstü test scriptleri (`m1-cekirdek.js`, `m2-pipeline.js`) için:

```bash
npm install
# PowerShell: $env:OPENAI_API_KEY = "sk-..."
node m1-cekirdek.js
```

## Güvenlik

- API anahtarı yalnızca `chrome.storage.local`'da tutulur ve **yalnızca service
  worker** katmanında kullanılır; içerik scriptine veya sayfaya asla geçmez.
- Anahtar koda/git'e gömülü **değildir** (`OPENAI_API_KEY` ortam değişkeni / eklenti ayarı).
- OpenAI hesabında **aylık harcama limiti** belirlemen önerilir.

## Yapı

```
manifest.json          # MV3 manifesti
background/             # service worker — orkestrasyon, OpenAI çağrıları, anahtar
offscreen/              # Web Audio mikser, tabCapture, ducking, WebRTC, MediaRecorder
content/                # YouTube altyazı çekme + zaman izleme
popup/ · options/       # arayüz (lacivert tema)
lib/                    # openai, pipeline, captions, voices, pricing, storage
```

Maliyet tahmini fiyatları `lib/pricing.js` içindedir; OpenAI fiyatları değişince
oradan güncellenir. Gösterilen tutar tahminîdir — kesin tutar için OpenAI panosu esastır.
