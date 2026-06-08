// Yaklaşık OpenAI fiyatları (USD). TAHMİNİDİR — kesin tutar için OpenAI panosu esastır.
// Fiyatlar zamanla değişir; buradaki sabitleri güncel dokümandan güncelle.
//
// Birimler:
//   translation: $ / 1M token (giriş ve çıkış ayrı)
//   tts:         $ / 1M karakter (gpt-4o-mini-tts token bazlıdır; burada karakterle yaklaşık)
//   transcription: $ / dakika
//   live:        $ / dakika (ses giriş + çıkış toplamı, kaba tahmin)

export const PRICES = {
  translation: {
    "gpt-5.5": { in: 5.0, out: 30.0 },
    "gpt-5.4-mini": { in: 0.5, out: 2.0 },
  },
  tts: {
    "gpt-4o-mini-tts": 15.0,
  },
  transcription: {
    "gpt-4o-transcribe": 0.006,
    "gpt-realtime-whisper": 0.006,
  },
  live: {
    "gpt-realtime-translate": 0.2,
  },
};

// Token tahmini: ~4 karakter/token (İngilizce/Türkçe karışık kaba değer).
export function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

export function costTranslation(model, inTokens, outTokens) {
  const p = PRICES.translation[model] || PRICES.translation["gpt-5.5"];
  return (inTokens * p.in + outTokens * p.out) / 1e6;
}

export function costTts(model, chars) {
  const rate = PRICES.tts[model] ?? PRICES.tts["gpt-4o-mini-tts"];
  return (chars * rate) / 1e6;
}

export function costTranscription(model, seconds) {
  const rate = PRICES.transcription[model] ?? PRICES.transcription["gpt-4o-transcribe"];
  return (seconds / 60) * rate;
}

export function costLive(seconds) {
  return (seconds / 60) * PRICES.live["gpt-realtime-translate"];
}

export function formatUsd(v) {
  if (!v || v < 0) return "$0.00";
  if (v < 0.01) return "<$0.01";
  return "$" + v.toFixed(2);
}
