// M1 — Çekirdek zincir doğrulaması
// İngilizce metin → gpt-5.5 ile Türkçe çeviri → gpt-4o-mini-tts ile seslendirme → cikti.mp3
//
// Çalıştırma: node m1-cekirdek.js
// Gereken ortam değişkeni: OPENAI_API_KEY

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error("HATA: OPENAI_API_KEY ortam değişkeni tanımlı değil.");
  process.exit(1);
}

const ORNEK_METIN =
  "The deep sea remains one of the least explored environments on Earth. " +
  "Scientists estimate that more than eighty percent of the ocean has never been observed by humans. " +
  "Recent advances in autonomous submersibles are finally making it possible to map these hidden ecosystems. " +
  "What we find there could reshape our understanding of life itself.";

const CEVIRI_MODELI = "gpt-5.5";
const TTS_MODELI = "gpt-4o-mini-tts";
const SES = "onyx";
const TON_TALIMATI =
  "Sakin, net ve açıklayıcı bir tonla, bir eğitmen gibi anlat.";

const CEVIRI_SISTEM_TALIMATI =
  "Sen profesyonel bir çevirmensin. Verilen İngilizce metni anlamı bozmadan " +
  "akıcı ve doğal Türkçeye çevir. Terimler ve özel isimler tutarlı kalsın. " +
  "Açıklama yapma, sadece çeviriyi döndür.";

async function ceviriYap(metin) {
  const yanit = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: CEVIRI_MODELI,
      messages: [
        { role: "system", content: CEVIRI_SISTEM_TALIMATI },
        { role: "user", content: metin },
      ],
    }),
  });

  if (!yanit.ok) {
    const hata = await yanit.text();
    throw new Error(`Çeviri API hatası (${yanit.status}): ${hata}`);
  }

  const veri = await yanit.json();
  return veri.choices[0].message.content.trim();
}

async function seslendir(metin) {
  const yanit = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: TTS_MODELI,
      voice: SES,
      input: metin,
      instructions: TON_TALIMATI,
      response_format: "mp3",
    }),
  });

  if (!yanit.ok) {
    const hata = await yanit.text();
    throw new Error(`TTS API hatası (${yanit.status}): ${hata}`);
  }

  const arrayBuffer = await yanit.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function main() {
  console.log("=== Orijinal (İngilizce) ===");
  console.log(ORNEK_METIN);
  console.log();

  console.log(`Çeviri yapılıyor (${CEVIRI_MODELI})...`);
  const turkce = await ceviriYap(ORNEK_METIN);
  console.log();
  console.log("=== Çeviri (Türkçe) ===");
  console.log(turkce);
  console.log();

  console.log(`Seslendirme yapılıyor (${TTS_MODELI}, ses: ${SES})...`);
  const mp3 = await seslendir(turkce);

  const ciktiYolu = resolve("cikti.mp3");
  await writeFile(ciktiYolu, mp3);
  console.log(`Tamam. MP3 kaydedildi: ${ciktiYolu} (${mp3.length} bayt)`);
}

main().catch((err) => {
  console.error("Hata:", err.message);
  process.exitCode = 1;
});
