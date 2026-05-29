// Ses & ton sabitleri + model listeleri + model→ses eşlemesi.
// CLAUDE.md §4 (modeller) ve §5 (sesler/tonlar) referans alınmıştır.

// --- Sesler (gpt-4o-mini-tts: 11 ses, üç tını grubunda) --------------------
// Gruplama bizim kolaylık etiketimizdir; OpenAI resmî cinsiyet etiketi vermez.

export const VOICE_GROUPS = [
  { label: "Kadın tınılı", voices: ["nova", "shimmer", "coral", "sage"] },
  { label: "Erkek tınılı", voices: ["onyx", "echo", "ash", "ballad"] },
  { label: "Nötr tınılı", voices: ["alloy", "fable", "verse"] },
];

// tts-1 ve tts-1-hd yalnızca 9 sesi destekler (ballad ve verse yok).
export const VOICES_LIMITED = new Set([
  "nova",
  "shimmer",
  "coral",
  "sage",
  "onyx",
  "echo",
  "ash",
  "alloy",
  "fable",
]);

export const ALL_VOICES = VOICE_GROUPS.flatMap((g) => g.voices);

/** Verilen seslendirme modelinin desteklediği sesleri grupları koruyarak döndürür. */
export function voiceGroupsForModel(ttsModel) {
  const limited = ttsModel === "tts-1" || ttsModel === "tts-1-hd";
  return VOICE_GROUPS.map((g) => ({
    label: g.label,
    voices: limited ? g.voices.filter((v) => VOICES_LIMITED.has(v)) : g.voices,
  })).filter((g) => g.voices.length > 0);
}

/** Seçili ses, yeni modelde desteklenmiyorsa geçerli bir sese düşür. */
export function coerceVoice(voice, ttsModel) {
  const limited = ttsModel === "tts-1" || ttsModel === "tts-1-hd";
  if (limited && !VOICES_LIMITED.has(voice)) return "onyx";
  return voice;
}

// --- Tonlar (gpt-4o-mini-tts instructions alanı) ---------------------------

export const TONE_PRESETS = [
  {
    id: "sakin",
    label: "Sakin ve anlatan",
    text: "Sakin, net ve açıklayıcı bir tonla, bir eğitmen gibi anlat.",
  },
  {
    id: "ciddi",
    label: "Ciddi ve net",
    text: "Ciddi, resmi ve net bir tonla, haber spikeri gibi oku.",
  },
  {
    id: "enerjik",
    label: "Enerjik",
    text: "Enerjik, canlı ve hareketli bir tonla oku.",
  },
  {
    id: "samimi",
    label: "Samimi",
    text: "Samimi, sıcak ve sohbet eder gibi bir tonla oku.",
  },
];

export const DEFAULT_TONE_TEXT = TONE_PRESETS[0].text;

// --- Modeller (CLAUDE.md §4) -----------------------------------------------
// q=kalite, s=hız, c=maliyet-uygunluğu (1-5; 5 = en iyi/en ucuz)

export const MODELS = {
  transcription: [
    { id: "gpt-4o-transcribe", label: "gpt-4o-transcribe", q: 5, s: 3, c: 3 },
    { id: "gpt-realtime-whisper", label: "gpt-realtime-whisper", q: 3, s: 5, c: 4 },
  ],
  translation: [
    { id: "gpt-5.5", label: "gpt-5.5", q: 5, s: 3, c: 2 },
    { id: "gpt-5.4-mini", label: "gpt-5.4-mini", q: 3, s: 5, c: 5 },
  ],
  tts: [
    { id: "gpt-4o-mini-tts", label: "gpt-4o-mini-tts", q: 5, s: 4, c: 4 },
    { id: "tts-1-hd", label: "tts-1-hd", q: 4, s: 3, c: 2 },
    { id: "tts-1", label: "tts-1", q: 3, s: 5, c: 5 },
  ],
};

export const SORT_MODES = [
  { id: "kalite", label: "Kalite", key: "q" },
  { id: "hiz", label: "Hız", key: "s" },
  { id: "maliyet", label: "Maliyet", key: "c" },
];

/** Bir işlevin model listesini seçili sıralama moduna göre döndürür. */
export function modelsSorted(fn, sortId) {
  const mode = SORT_MODES.find((m) => m.id === sortId) || SORT_MODES[0];
  return [...MODELS[fn]].sort((a, b) => b[mode.key] - a[mode.key]);
}

// Önizleme için sabit Türkçe örnek cümle.
export const PREVIEW_TEXT =
  "Merhaba, bu ses Canlı Çevirmen için bir önizleme örneğidir.";
