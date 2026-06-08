# Akış Modu — Tasarım Spesifikasyonu

**Tarih:** 2026-06-08
**Durum:** Onaylandı

---

## Amaç

Kaliteli modun "videoyu durdur → tümünü hazırla → oynat" davranışı yerine video hiç durmadan, her cümle başlamadan ~3 saniye önce çevrilip seslendirildiği bir akış modu uygulanır. Çeviri modeli `gpt-5.4-mini` (hızlı/ucuz), seslendirme `gpt-4o-mini-tts`.

---

## Genel Akış

```
startDubbing
  ├── altyazı çek + cleanAndSegment + mapSentencesToTimes  (arka planda)
  ├── video HEMEN oynat (duraklatma yok)
  └── runStreamScheduler başlar (cleanAndSegment bitince)
        └── her 300ms:
              estNow = videoState.currentTime
              idle cümleler için:
                eğer startSec - LOOKAHEAD_SEC <= estNow → translate+TTS başlat (async)
              TTS gelince → queueSegment → offscreen zamanında çalar
```

**LOOKAHEAD_SEC = 3** — cümle başlamadan bu kadar saniye önce işlem başlar.

---

## Cümle Durum Makinesi

```
idle → translating → tts-pending → queued → done
                                          └── skipped (TTS çok geç geldi, DRIFT_MAX aşıldı)
```

Her cümle için durum `sentenceStates[i]` dizisinde tutulur.

---

## Eşzamanlılık

- `MAX_TTS_CONCURRENCY`: 3 (mevcut 2'den artırıldı — gpt-5.4-mini hızı karşılar)
- Translate çağrıları paralel başlatılır; bağlam penceresi (`contextPairs`) için sıralı tamamlanma beklenmez — her cümle, başlatıldığı andaki önceki 4 çiftin anlık görüntüsüyle çevrilir. Paralel başlatmadan kaynaklanan bağlam kayması gpt-5.4-mini hızı göz önüne alındığında kabul edilebilir.
- Semaphore yalnızca TTS çağrılarını sınırlar (translate ucuz ve hızlıdır).

---

## Geç Gelen TTS

TTS `startSec` geçtikten sonra gelirse offscreen'deki mevcut drift mantığı devreye girer:
- `startSec >= estNow - DRIFT_MAX (4 sn)` → hemen çal
- `startSec < estNow - DRIFT_MAX` → atla (`skipped`)

---

## Model Değişiklikleri

### Kaldırılanlar
- `tts-1` ve `tts-1-hd` model seçenekleri UI'dan ve `lib/voices.js`'ten kaldırılır.
- Bu modellere özel ses uyarısı (`ballad`, `verse` yok) kaldırılır.

### Kalanlar
| İşlev | Model |
|---|---|
| Temizleme/segmentasyon | `gpt-5.5` (değişmez) |
| Çeviri | `gpt-5.4-mini` (akış modunda varsayılan) |
| Seslendirme | `gpt-4o-mini-tts` |

---

## Kod Değişiklikleri

### `background/service-worker.js`
- `runDubPipeline()` yerine yeni `runStreamPipeline()` fonksiyonu eklenir.
- `startDubbing()`: `pauseVideo` çağrısı ve `PREBUFFER_SEGMENTS` bekleme mantığı kaldırılır; `startReporting` hemen başlatılır, video oynatılır, `runStreamPipeline` arka planda çağrılır.
- `MAX_TTS_CONCURRENCY`: 2 → 3.

### `lib/voices.js`
- `tts-1` ve `tts-1-hd` tanımları kaldırılır.
- `MODEL_VOICES` map'inden bu modeller çıkarılır.

### `popup/popup.js` + `popup/popup.html`
- Seslendirme model `<select>` menüsünden `tts-1` ve `tts-1-hd` `<option>`'ları kaldırılır.
- Mod seçici değişmez — "Kaliteli" etiketi yeni akış davranışını temsil eder.

### `options/options.js` + `options/options.html`
- Seslendirme varsayılan menüsünden aynı modeller kaldırılır.

### `offscreen/offscreen.js`
- Değişiklik yok.

---

## Kabul Kriterleri

1. "Dublajı başlat" tıklandığında video duraklamaz, hemen oynar.
2. `cleanAndSegment` tamamlandıktan sonra (~2–3 sn) cümleler sırayla işlenmeye başlar.
3. İlk cümle en fazla ~2–3 sn geride gelir; sonrakiler senkrona yakın.
4. Seslendirme model menüsünde yalnızca `gpt-4o-mini-tts` görünür.
5. Mevcut `stopDubbing`, seek, tab kapatma davranışları bozulmaz.
