// chrome.storage.local için ince sarmalayıcı.
//
// GÜVENLİK: Bu modül yalnızca privileged extension context'lerden (service
// worker, options, popup) çağrılmalıdır. Content script'ler API anahtarına
// asla erişmez — gereken her şeyi service worker'a mesaj atarak yapar.

const KEY_NAME = "openai_api_key";
const DEFAULTS_KEY = "defaults";

const DEFAULT_VALUES = Object.freeze({
  mode: "kaliteli",
  voice: "onyx",
  tone: "Sakin, net ve açıklayıcı bir tonla, bir eğitmen gibi anlat.",
  // Model seçimleri (CLAUDE.md §4 varsayılanları)
  modelTranscription: "gpt-4o-transcribe",
  modelTranslation: "gpt-5.5",
  modelTts: "gpt-4o-mini-tts",
  sortMode: "kalite",
});

export async function get(keys) {
  return chrome.storage.local.get(keys);
}

export async function set(items) {
  return chrome.storage.local.set(items);
}

export async function remove(keys) {
  return chrome.storage.local.remove(keys);
}

export async function getApiKey() {
  const { [KEY_NAME]: key } = await get(KEY_NAME);
  return key || null;
}

export async function setApiKey(key) {
  await set({ [KEY_NAME]: key });
}

export async function deleteApiKey() {
  await remove(KEY_NAME);
}

/**
 * Anahtarın UI'da gösterilebilir maskeli versiyonu: `sk-…ABCD`
 * Tam anahtarı asla döndürmez.
 */
export async function getApiKeyMasked() {
  const key = await getApiKey();
  if (!key) return null;
  const tail = key.length >= 4 ? key.slice(-4) : key;
  return `sk-…${tail}`;
}

// --- Kullanım / maliyet ----------------------------------------------------

const THRESHOLD_KEY = "usage_threshold"; // aylık yumuşak uyarı eşiği (USD; 0 = kapalı)
const MONTH_KEY = "usage_month"; // { ym: "YYYY-MM", cost: number }

export async function getMonthlyThreshold() {
  const { [THRESHOLD_KEY]: v } = await get(THRESHOLD_KEY);
  return typeof v === "number" ? v : 0;
}

export async function setMonthlyThreshold(v) {
  await set({ [THRESHOLD_KEY]: Number(v) || 0 });
}

export async function getMonthUsage() {
  const { [MONTH_KEY]: m } = await get(MONTH_KEY);
  return m && typeof m.cost === "number" ? m : { ym: "", cost: 0 };
}

export async function setMonthUsage(obj) {
  await set({ [MONTH_KEY]: obj });
}

export async function getDefaults() {
  const { [DEFAULTS_KEY]: d } = await get(DEFAULTS_KEY);
  return { ...DEFAULT_VALUES, ...(d || {}) };
}

export async function setDefaults(defaults) {
  const merged = { ...DEFAULT_VALUES, ...defaults };
  await set({ [DEFAULTS_KEY]: merged });
}
