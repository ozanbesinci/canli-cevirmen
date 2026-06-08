// Service worker: orkestrasyon + OpenAI çağrıları + anahtar erişimi.
// API anahtarına sadece bu dosya (ve gelecekteki offscreen) erişir.
// Content script'lerden gelen mesajlar (sender.tab tanımlı) reddedilir.

import {
  getApiKey,
  setApiKey,
  deleteApiKey,
  getApiKeyMasked,
  getDefaults,
  setDefaults,
  getMonthlyThreshold,
  getMonthUsage,
  setMonthUsage,
} from "../lib/storage.js";
import {
  costTranslation,
  costTts,
  costTranscription,
  costLive,
} from "../lib/pricing.js";
import { cleanAndSegment, translate, tts, transcribe, ApiError } from "../lib/openai.js";
import { buildWordStream, mapSentencesToTimes } from "../lib/captions.js";
import { PREVIEW_TEXT } from "../lib/voices.js";


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Sadece SW'a yönlendirilen mesajları işle (target yok veya "background").
  // target === "offscreen" olanlar offscreen.js tarafında işlenecek.
  if (message?.target && message.target !== "background") return false;
  handle(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // async yanıt
});

// --- Kullanıcıya görünür durum ---------------------------------------------
// status ∈ idle | preparing | running | network | warn | error
let lastStatus = { status: "idle", detail: "Hazır." };

function setStatus(status, detail = "") {
  lastStatus = { status, detail };
  // Popup açıksa anında al; değilse açılışta getStatus ile çeker.
  chrome.runtime.sendMessage({ type: "statusUpdate", status, detail }).catch(() => {});
}

function isAuthError(err) {
  return err instanceof ApiError && err.kind === "auth";
}

// --- Kullanım / maliyet izleme ---------------------------------------------
// Bellekte tutulur; aylık toplam storage'a debounce ile yazılır.
const usage = {
  sessionCost: 0, // bu video (oynatma oturumu)
  monthCost: 0,
  monthYm: "",
  threshold: 0,
  loaded: false,
};
let usageFlushTid = null;

function currentYm() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

async function loadUsage() {
  const m = await getMonthUsage();
  const ym = currentYm();
  if (m.ym === ym) {
    usage.monthCost = m.cost;
    usage.monthYm = ym;
  } else {
    usage.monthCost = 0;
    usage.monthYm = ym;
  }
  usage.threshold = await getMonthlyThreshold();
  usage.loaded = true;
}

function flushUsageSoon() {
  if (usageFlushTid) return;
  usageFlushTid = setTimeout(async () => {
    usageFlushTid = null;
    await setMonthUsage({ ym: usage.monthYm, cost: usage.monthCost });
  }, 2000);
}

async function addCost(delta) {
  if (!Number.isFinite(delta) || delta <= 0) return;
  if (!usage.loaded) await loadUsage();
  const ym = currentYm();
  if (usage.monthYm !== ym) {
    usage.monthYm = ym;
    usage.monthCost = 0; // ay değişti → sıfırla
  }
  usage.sessionCost += delta;
  usage.monthCost += delta;
  flushUsageSoon();
}

function resetSessionCost() {
  usage.sessionCost = 0;
}

async function getUsageSummary() {
  if (!usage.loaded) await loadUsage();
  usage.threshold = await getMonthlyThreshold();
  return {
    ok: true,
    videoCost: usage.sessionCost,
    monthCost: usage.monthCost,
    ym: usage.monthYm,
    threshold: usage.threshold,
    overThreshold: usage.threshold > 0 && usage.monthCost >= usage.threshold,
  };
}

// 401/403: kullanıcıya bildir ve aktif akışı temiz durdur.
async function abortForAuth() {
  setStatus("error", "API anahtarını ayarlardan kontrol et (401/403).");
  if (liveState.active) await stopLiveDubbing();
  else await stopDubbing();
}

const PRIVILEGED_TYPES = new Set([
  "getKeyStatus",
  "saveKey",
  "deleteKey",
  "testConnection",
  "getDefaults",
  "saveDefaults",
  "startCapture",
  "stopCapture",
  "getCaptureState",
  "startDubbing",
  "stopDubbing",
  "startLiveDubbing",
  "stopLiveDubbing",
  "previewVoice",
]);

async function handle(message, sender) {
  // Hassas işlemler yalnızca eklentinin kendi sayfalarından (popup/options) gelmeli.
  // Content script'ler "videoState" gibi düşük yetkili mesajlar gönderebilir.
  if (PRIVILEGED_TYPES.has(message?.type)) {
    assertInternal(sender);
  }

  switch (message?.type) {
    case "getKeyStatus":
      return {
        ok: true,
        hasKey: !!(await getApiKey()),
        masked: await getApiKeyMasked(),
      };

    case "saveKey": {
      const key = String(message.key || "").trim();
      if (!key.startsWith("sk-")) {
        return { ok: false, error: "Anahtar 'sk-' ile başlamıyor." };
      }
      await setApiKey(key);
      return { ok: true, masked: await getApiKeyMasked() };
    }

    case "deleteKey":
      await deleteApiKey();
      return { ok: true };

    case "testConnection":
      return await testConnection();

    case "getDefaults":
      return { ok: true, defaults: await getDefaults() };

    case "saveDefaults":
      await setDefaults(message.defaults || {});
      return { ok: true };

    case "startCapture":
      return await startCapture(message.tabId);

    case "stopCapture":
      return await stopCapture();

    case "getCaptureState":
      return await getCaptureState();

    case "getStatus":
      return { ok: true, ...lastStatus };

    case "getUsage":
      return await getUsageSummary();

    case "startDubbing":
      return await startDubbing(message.tabId);

    case "stopDubbing":
      return await stopDubbing();

    case "videoState":
      return await handleVideoState(message.state, sender);

    case "keepalive":
      // Offscreen'den gelen ping; SW'ı MV3 uykusundan uyanık tutar.
      // Canlı mod aktifken her ping ~20 sn'lik gerçek zamanlı işleme maliyetidir.
      if (liveState.active) addCost(costLive(20));
      return { ok: true };

    case "audioChunk":
      return await handleAudioChunk(message);

    case "previewVoice":
      return await previewVoice(message);

    case "startLiveDubbing":
      return await startLiveDubbing(message.tabId);

    case "stopLiveDubbing":
      return await stopLiveDubbing();

    case "liveConnectionFailed":
      // Offscreen bağlantı kopması bildirdi → yeniden bağlan.
      await reconnectLive();
      return { ok: true };

    default:
      return { ok: false, error: `Bilinmeyen mesaj türü: ${message?.type}` };
  }
}

function assertInternal(sender) {
  // Gönderen bizim extension'ın kendi sayfası mı? (options/popup/SW)
  // Content script'lerin url'i sayfa kaynağına işaret eder (https://...).
  // Extension sayfalarının url'i chrome-extension://<bizim-id>/ ile başlar.
  // Not: options_ui open_in_tab:true ile sender.tab tanımlı olur, bu yüzden
  // `sender.tab` üzerinden ayırt edemiyoruz; URL prefix'i ile ayırt ediyoruz.
  const ourPrefix = `chrome-extension://${chrome.runtime.id}/`;
  if (sender?.id !== chrome.runtime.id || !sender?.url?.startsWith(ourPrefix)) {
    throw new Error("İçerik scripti bu işleme erişemez.");
  }
}

async function testConnection() {
  const key = await getApiKey();
  if (!key) return { ok: false, error: "Önce anahtarı kaydet." };

  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      const data = await res.json();
      const count = Array.isArray(data.data) ? data.data.length : 0;
      return {
        ok: true,
        message: `Bağlantı başarılı — hesabında ${count} model erişilebilir.`,
      };
    }
    const txt = await res.text();
    return {
      ok: false,
      error: `HTTP ${res.status}: ${txt.slice(0, 200)}`,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- Transkripsiyon yedeği (altyazısız video) ------------------------------

let transcribeState = null;

async function getStreamId(tabId) {
  return await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!id) reject(new Error("Stream ID alınamadı."));
      else resolve(id);
    });
  });
}

async function startTranscribeDubbing(tabId, videoTitle, videoId) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "API anahtarı kayıtlı değil." };

  await ensureOffscreen();

  let streamId;
  try {
    streamId = await getStreamId(tabId);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "startTranscribe",
    streamId,
  });
  if (!res?.ok) {
    await stopCapture();
    return { ok: false, error: res?.error || "Offscreen transkripsiyon başlatılamadı." };
  }

  // Zaman raporlaması (scheduler + duck için videoState gerekli)
  await chrome.tabs
    .sendMessage(tabId, { target: "content", type: "startReporting" })
    .catch(() => {});

  // dubState'i transkripsiyon modunda da işaretle (videoState kabulü için)
  dubState.active = true;
  dubState.tabId = tabId;
  dubState.abort = false;
  dubState.videoId = videoId || null;

  const defaults = await getDefaults();
  transcribeState = {
    active: true,
    tabId,
    apiKey,
    defaults,
    videoTitle: videoTitle || "",
    contextPairs: [],
    segIndex: 0,
  };
  resetSessionCost();
  console.log("[SW] Transkripsiyon dublajı başladı (gpt-4o-transcribe).");
  setStatus("preparing", "Altyazı yok — ses transkribe ediliyor…");
  return { ok: true, transcribe: true, sentenceCountPlanned: "?" };
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const u8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
  return u8;
}

async function handleAudioChunk({ index, audioBase64, durSec, mimeType }) {
  const st = transcribeState;
  if (!st || !st.active) return { ok: true };

  let text;
  try {
    text = await transcribe({
      bytes: base64ToUint8(audioBase64),
      mimeType: mimeType || "audio/webm",
      model: "gpt-4o-transcribe",
      apiKey: st.apiKey,
    });
  } catch (err) {
    console.error(`[SW] Transkripsiyon parça ${index} hatası:`, err);
    if (isAuthError(err)) await abortForAuth();
    else setStatus("warn", "Bir ses parçası transkribe edilemedi (atlandı).");
    return { ok: false };
  }
  addCost(costTranscription("gpt-4o-transcribe", durSec || 20));
  text = (text || "").trim();
  if (!text) return { ok: true };

  // Transkript metnini cümlelere böl (transcribe çıktısı zaten noktalı).
  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return { ok: true };

  const dur = durSec || 20;
  const totalChars = sentences.reduce((a, s) => a + s.length, 0) || 1;

  for (const sentence of sentences) {
    if (!st.active || dubState.abort) break;
    let tr;
    try {
      const tModel = st.defaults.modelTranslation || "gpt-5.5";
      tr = await translate({
        sentence,
        contextPairs: st.contextPairs.slice(-4),
        videoContext: st.videoTitle,
        apiKey: st.apiKey,
        model: tModel,
        onUsage: (u) =>
          addCost(costTranslation(tModel, u.prompt_tokens || 0, u.completion_tokens || 0)),
      });
    } catch (err) {
      console.error("[SW] Transkript çeviri hatası:", err);
      if (isAuthError(err)) {
        await abortForAuth();
        break;
      }
      setStatus("warn", "Bir cümle atlandı (geçici hata).");
      continue;
    }
    st.contextPairs.push({ en: sentence, tr });

    // Süre eşitleme: bu cümlenin orijinal slot payı (orantısal)
    const slot = (sentence.length / totalChars) * dur;
    const speed = chooseSpeed(tr, slot);

    try {
      const ttsM = st.defaults.modelTts || "gpt-4o-mini-tts";
      const audioU8 = await tts({
        text: tr,
        voice: st.defaults.voice,
        instructions: st.defaults.tone,
        model: ttsM,
        speed,
        format: "mp3",
        apiKey: st.apiKey,
      });
      addCost(costTts(ttsM, tr.length));
      await chrome.runtime
        .sendMessage({
          target: "offscreen",
          type: "queueSegment",
          segment: {
            id: st.segIndex++,
            immediate: true, // zaman hizalaması yerine "şimdi" çal
            startSec: 0,
            endSec: 0,
            turkishText: tr,
            originalText: sentence,
            audioBase64: uint8ToBase64(audioU8),
          },
        })
        .catch(() => {});
    } catch (err) {
      console.error("[SW] Transkript TTS hatası:", err);
      if (isAuthError(err)) {
        await abortForAuth();
        break;
      }
      setStatus("warn", "Bir bölüm seslendirilemedi (atlandı).");
    }
  }
  console.log(`[SW] Transkript parça ${index}: ${sentences.length} cümle işlendi.`);
  return { ok: true };
}

async function previewVoice({ voice, tone, ttsModel }) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "API anahtarı kayıtlı değil." };
  try {
    const audioU8 = await tts({
      text: PREVIEW_TEXT,
      voice,
      instructions: tone,
      model: ttsModel || "gpt-4o-mini-tts",
      format: "mp3",
      apiKey,
    });
    return { ok: true, audioBase64: uint8ToBase64(audioU8) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- Canlı mod (gpt-realtime-translate, WebRTC) ----------------------------

const LIVE_MODEL = "gpt-realtime-translate";
const LIVE_TARGET_LANG = "tr";

const liveState = {
  active: false,
  tabId: null,
  videoId: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
};
const LIVE_MAX_RECONNECT = 5;

// API anahtarıyla kısa ömürlü client secret üretir (anahtar offscreen'e gitmez).
async function createLiveClientSecret(apiKey) {
  const res = await fetch(
    "https://api.openai.com/v1/realtime/translations/client_secrets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          model: LIVE_MODEL,
          audio: { output: { language: LIVE_TARGET_LANG } },
        },
      }),
    },
  );
  if (!res.ok) {
    const status = res.status;
    const kind = status === 401 || status === 403 ? "auth" : status >= 500 ? "server" : "client";
    throw new ApiError(
      `client_secret hatası (${status}): ${(await res.text()).slice(0, 150)}`,
      { status, kind },
    );
  }
  const data = await res.json();
  const secret = data.value || data.client_secret?.value || data.client_secret;
  if (!secret) throw new Error("client_secret yanıtında değer yok.");
  return secret;
}

async function startLiveDubbing(tabId) {
  if (liveState.active) return { ok: false, error: "Canlı çeviri zaten aktif." };
  if (dubState.active)
    return { ok: false, error: "Önce Kaliteli dublajı durdur." };
  if (!tabId) return { ok: false, error: "tabId verilmedi." };

  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "API anahtarı kayıtlı değil." };

  resetSessionCost();
  setStatus("preparing", "Canlı çeviri bağlanıyor…");
  let clientSecret;
  try {
    clientSecret = await createLiveClientSecret(apiKey);
  } catch (err) {
    if (isAuthError(err)) {
      setStatus("error", "API anahtarını ayarlardan kontrol et (401/403).");
      return { ok: false, error: "Yetki hatası — API anahtarını kontrol et." };
    }
    setStatus("error", err.message);
    return { ok: false, error: err.message };
  }

  await ensureOffscreen();

  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!id) reject(new Error("Stream ID alınamadı."));
      else resolve(id);
    });
  }).catch((err) => ({ __error: err.message }));
  if (streamId?.__error) return { ok: false, error: streamId.__error };

  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "startLive",
    streamId,
    clientSecret,
  });
  if (!res?.ok) {
    await stopLiveDubbing();
    return { ok: false, error: res?.error || "Offscreen canlı başlatma hatası." };
  }

  liveState.active = true;
  liveState.tabId = tabId;
  liveState.reconnectAttempts = 0;
  try {
    const tab = await chrome.tabs.get(tabId);
    liveState.videoId = videoIdFromUrl(tab?.url);
  } catch {
    liveState.videoId = null;
  }
  setStatus("running", "Canlı çeviri aktif.");
  return { ok: true };
}

async function stopLiveDubbing() {
  liveState.active = false;
  liveState.tabId = null;
  liveState.reconnectAttempts = 0;
  if (liveState.reconnectTimer) {
    clearTimeout(liveState.reconnectTimer);
    liveState.reconnectTimer = null;
  }
  if (await offscreenExists()) {
    await chrome.runtime
      .sendMessage({ target: "offscreen", type: "stopLive" })
      .catch(() => {});
  }
  await stopCapture();
  if (lastStatus.status !== "error") setStatus("idle", "Durduruldu.");
  return { ok: true };
}

// Bağlantı koptuğunda: üstel geri çekilmeyle yeni client secret alıp yeniden bağlan.
async function reconnectLive() {
  if (!liveState.active || !liveState.tabId) return;
  if (liveState.reconnectTimer) return; // zaten bir deneme planlandı

  liveState.reconnectAttempts++;
  if (liveState.reconnectAttempts > LIVE_MAX_RECONNECT) {
    setStatus("error", "Canlı bağlantı kurulamadı. Durduruluyor.");
    await stopLiveDubbing();
    return;
  }

  const delay = Math.min(1000 * 2 ** (liveState.reconnectAttempts - 1), 15000);
  setStatus("network", `Bağlantı koptu, yeniden deneniyor (${liveState.reconnectAttempts})…`);
  liveState.reconnectTimer = setTimeout(async () => {
    liveState.reconnectTimer = null;
    if (!liveState.active) return;
    const apiKey = await getApiKey();
    if (!apiKey) return;
    let clientSecret;
    try {
      clientSecret = await createLiveClientSecret(apiKey);
    } catch (err) {
      console.error("[SW] Canlı yeniden bağlanma hatası:", err);
      if (isAuthError(err)) {
        setStatus("error", "API anahtarını ayarlardan kontrol et (401/403).");
        await stopLiveDubbing();
        return;
      }
      return reconnectLive(); // tekrar dene (backoff artar)
    }
    console.log(`[SW] Canlı çeviri yeniden bağlanıyor (deneme ${liveState.reconnectAttempts})…`);
    const res = await chrome.runtime
      .sendMessage({ target: "offscreen", type: "reconnectLive", clientSecret })
      .catch(() => ({ ok: false }));
    if (res?.ok) {
      liveState.reconnectAttempts = 0;
      setStatus("running", "Canlı çeviri aktif.");
    } else {
      return reconnectLive();
    }
  }, delay);
}

chrome.runtime.onInstalled.addListener(async () => {
  // Varsayılanları storage'a kalıcı yaz (henüz yoksa).
  const existing = await getDefaults();
  await setDefaults(existing);
});

// --- Capture orkestrasyonu -------------------------------------------------

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification:
      "tabCapture ses akışını Web Audio mixer'ında karıştırmak için.",
  });
}

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function startCapture(tabId) {
  if (!tabId) return { ok: false, error: "tabId verilmedi." };

  await ensureOffscreen();

  // Stream ID'yi popup'tan gelen mesajla aynı user-gesture penceresinde almalıyız.
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!id) {
        reject(new Error("Stream ID alınamadı (boş)."));
      } else {
        resolve(id);
      }
    });
  });

  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "startCapture",
    streamId,
  });
  return res || { ok: true };
}

async function stopCapture() {
  if (!(await offscreenExists())) {
    return { ok: true, message: "Offscreen yok." };
  }
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "stopCapture",
    });
  } catch {
    /* yut */
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* yut */
  }
  return { ok: true };
}

async function getCaptureState() {
  if (!(await offscreenExists())) {
    return { ok: true, capturing: false };
  }
  try {
    const res = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "getState",
    });
    return res || { ok: true, capturing: false };
  } catch (err) {
    return { ok: true, capturing: false, error: err.message };
  }
}

// --- Dubbing orkestrasyonu ------------------------------------------------

const READ_AHEAD_SEC = 60; // playback noktasının önünde bu kadar hazır tut
const LOOKAHEAD_SEC = 3; // scheduler cümleyi bu kadar sn öncesinden işlemeye başlar
const MAX_TTS_CONCURRENCY = 3;

const dubState = {
  active: false,
  tabId: null,
  abort: false,
  startTime: 0, // dublajın başlatıldığı andaki video currentTime
  videoId: null,
  videoState: { currentTime: 0, paused: true, ended: false },
};

function videoIdFromUrl(url) {
  const m = (url || "").match(/[?&]v=([^&]+)/);
  return m ? m[1] : null;
}

async function handleVideoState(state, sender) {
  // Sadece dublajın yapıldığı sekmeden gelen güncellemeleri kabul et.
  if (!dubState.active) return { ok: true };
  if (sender?.tab?.id && dubState.tabId && sender.tab.id !== dubState.tabId) {
    return { ok: true };
  }
  dubState.videoState = state;
  // Video bittiyse temiz durdur. YouTube `ended` olayını güvenilir göndermediği
  // için süreye de bakıyoruz: sona ~0.5 sn kala bitmiş say.
  const atEnd =
    state.ended ||
    (state.duration > 0 && state.currentTime >= state.duration - 0.5);
  if (atEnd && dubState.active) {
    console.log("[SW] Video bitti — dublaj durduruluyor.");
    setStatus("idle", "Video bitti.");
    stopEverything();
  }
  // Offscreen'e iletmiyoruz; content script videoState'i offscreen'e DOĞRUDAN
  // gönderiyor (SW uykusundan bağımsız çalışsın diye). Burada yalnızca
  // pipeline'ın read-ahead için ihtiyaç duyduğu currentTime'ı saklıyoruz.
  return { ok: true };
}

async function startDubbing(tabId) {
  if (dubState.active) {
    return { ok: false, error: "Dublaj zaten aktif." };
  }
  if (!tabId) return { ok: false, error: "tabId verilmedi." };

  const apiKey = await getApiKey();
  if (!apiKey) {
    return { ok: false, error: "API anahtarı kayıtlı değil." };
  }

  // Content'ten altyazıları al
  let capsResp;
  try {
    capsResp = await chrome.tabs.sendMessage(tabId, {
      target: "content",
      type: "getCaptions",
    });
  } catch (err) {
    return {
      ok: false,
      error: `Content script'e ulaşılamadı: ${err.message}. Sayfa yenilenmeli.`,
    };
  }
  if (!capsResp?.ok || !Array.isArray(capsResp.captions) || capsResp.captions.length === 0) {
    // Altyazı yok → transkripsiyon yedeğine geç (sekme sesini gpt-4o-transcribe ile).
    console.log("[SW] Altyazı yok — transkripsiyon yedeğine geçiliyor.");
    return await startTranscribeDubbing(tabId, capsResp?.videoTitle || "", capsResp?.videoId || null);
  }

  // Capture'ı başlat (offscreen + tabCapture)
  const capRes = await startCapture(tabId);
  if (!capRes?.ok) {
    return { ok: false, error: `Capture başlatılamadı: ${capRes?.error || "?"}` };
  }


  // Content'in zaman raporlamasını başlat
  await chrome.tabs
    .sendMessage(tabId, { target: "content", type: "startReporting" })
    .catch(() => {});

  // State'i kur
  dubState.active = true;
  dubState.tabId = tabId;
  dubState.abort = false;
  dubState.startTime = 0;
  dubState.videoId = capsResp.videoId || null;
  dubState.videoState = { currentTime: 0, paused: false, ended: false };

  const defaults = await getDefaults();
  const videoTitle = capsResp.videoTitle || "";

  // Akış pipeline'ını arkada başlat — video duraklatılmaz
  runStreamPipeline(capsResp.captions, defaults, apiKey, videoTitle).catch((err) => {
    console.error("[SW] Akış pipeline hatası:", err);
  });

  return { ok: true, sentenceCountPlanned: capsResp.captions.length };
}

async function stopDubbing() {
  dubState.abort = true;
  dubState.active = false;

  // Transkripsiyon modunu da durdur
  if (transcribeState) transcribeState.active = false;
  transcribeState = null;

  if (dubState.tabId) {
    chrome.tabs
      .sendMessage(dubState.tabId, { target: "content", type: "stopReporting" })
      .catch(() => {});
  }

  if (await offscreenExists()) {
    await chrome.runtime
      .sendMessage({ target: "offscreen", type: "resetDub" })
      .catch(() => {});
  }

  await stopCapture();

  dubState.tabId = null;
  if (lastStatus.status !== "error") setStatus("idle", "Durduruldu.");
  return { ok: true };
}

// --- Temiz durdurma + ağ olayları ------------------------------------------

// Aktif dublajın sekmesi mi?
function isActiveTab(tabId) {
  return (
    (dubState.active && dubState.tabId === tabId) ||
    (liveState.active && liveState.tabId === tabId)
  );
}

async function stopEverything() {
  if (liveState.active) await stopLiveDubbing();
  if (dubState.active) await stopDubbing();
}

// Sekme kapanırsa kaynakları kapat.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (isActiveTab(tabId)) {
    console.log("[SW] Aktif sekme kapandı — kaynaklar kapatılıyor.");
    stopEverything();
  }
});

// Sekme başka bir sayfaya/videoya giderse durdur (URL değişimi).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (!isActiveTab(tabId)) return;
  const activeVid = dubState.active ? dubState.videoId : liveState.videoId;
  const newVid = videoIdFromUrl(changeInfo.url);
  // Aynı video oynarken &t= gibi küçük URL değişiklikleri durdurmaz; yalnızca
  // farklı bir videoya geçiş veya watch sayfasından çıkış durdurur.
  if (!newVid || (activeVid && newVid !== activeVid)) {
    console.log("[SW] Video değişti / sayfadan çıkıldı — dublaj durduruluyor.");
    stopEverything();
  }
});

// Ağ durumu (SW global scope'ta navigator.onLine + olaylar mevcut).
self.addEventListener("offline", () => {
  if (dubState.active || liveState.active) {
    setStatus("network", "Ağ bekleniyor…");
  }
});
self.addEventListener("online", () => {
  if (liveState.active) {
    setStatus("running", "Canlı çeviri aktif.");
  } else if (dubState.active) {
    setStatus("running", "Çalışıyor");
  }
});

// Bekle (ms)
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Basit semaphore
function semaphore(n) {
  let avail = n;
  const waiters = [];
  return {
    async acquire() {
      if (avail > 0) {
        avail--;
        return;
      }
      await new Promise((res) => waiters.push(res));
    },
    release() {
      if (waiters.length > 0) waiters.shift()();
      else avail++;
    },
  };
}

// Türkçe metnin tahmini TTS süresi (saniye, speed=1.0'da).
// Onyx ile yaklaşık 15 karakter/saniye (konuşma temposu) varsayıyoruz.
function estimateTrSeconds(text, speed = 1.0) {
  return text.length / 15 / speed;
}

// Süre eşitleme: çok muhafazakâr. Yalnızca Türkçe ses orijinal slottan
// belirgin biçimde uzunsa hafifçe hızlandır. Aksi halde 1.0'da bırak —
// gereksiz hızlandırma "çok hızlı dublaj" hissine yol açıyordu.
// ASR caption zaman aralıkları kısa cümlelerde güvenilmez olduğu için,
// çok kısa orijinal slotlarda (≤ 2.5 sn) hiç hızlandırmıyoruz.
function chooseSpeed(text, origDur) {
  if (origDur <= 2.5) return 1.0;
  const est = estimateTrSeconds(text);
  const ratio = est / origDur;
  if (ratio <= 1.15) return 1.0; // küçük taşmaları kabul et
  return Math.min(1.5, ratio);  // tavan 1.5 — offscreen da aynı sınırı kullanır
}

// Uint8Array → base64 (büyük veriler için chunked)
function uint8ToBase64(u8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const PREBUFFER_SEGMENTS = 2; // bu kadar segment kuyruğa girince video otomatik oynatılır

async function runDubPipeline(captions, defaults, apiKey, videoTitle) {
  const wordStream = buildWordStream(captions);
  const rawText = captions.map((c) => c.text).join(" ");

  const translationModel = defaults.modelTranslation || "gpt-5.5";
  const ttsModel = defaults.modelTts || "gpt-4o-mini-tts";

  console.log(
    `[SW] Pipeline başlıyor — ${captions.length} altyazı parçası, ` +
      `çeviri=${translationModel}, ses=${defaults.voice}@${ttsModel}`,
  );

  resetSessionCost();
  setStatus("preparing", "Hazırlanıyor…");
  let sentences;
  try {
    sentences = await cleanAndSegment(rawText, {
      apiKey,
      model: translationModel,
      onUsage: (u) =>
        addCost(costTranslation(translationModel, u.prompt_tokens || 0, u.completion_tokens || 0)),
    });
  } catch (err) {
    console.error("[SW] cleanAndSegment hatası:", err);
    if (isAuthError(err)) await abortForAuth();
    else setStatus("error", `Hazırlık başarısız: ${err.message}`);
    return;
  }
  console.log(`[SW] Temizleme: ${sentences.length} cümle`);
  setStatus("running", "Çalışıyor");

  const ranges = mapSentencesToTimes(sentences, wordStream);
  // Bitiş başlangıçtan küçükse (haritalama uç durumu) emniyetli aralık üret
  for (const r of ranges) {
    if (r && r.end < r.start) r.end = r.start + 0.5;
  }

  const contextPairs = [];
  const sem = semaphore(MAX_TTS_CONCURRENCY);
  const pending = [];
  let queuedCount = 0;
  let autoPlayed = false;

  for (let i = 0; i < sentences.length; i++) {
    if (dubState.abort) break;

    const range = ranges[i];
    if (!range) continue;

    // Read-ahead throttle: oynatma noktasının çok ilerisindeysek bekle
    while (
      !dubState.abort &&
      range.start > dubState.videoState.currentTime + READ_AHEAD_SEC
    ) {
      await sleep(500);
    }
    if (dubState.abort) break;

    // Yalnızca dublajın BAŞLATILDIĞI noktadan önce biten cümleleri atla
    // (bağlam için çevrilir ama TTS'lenmez). Oynatma başladıktan sonra drift
    // yüzünden cümle atlamayız — yoksa dublajda boşluk/durma olur.
    const tooLate = range.end < dubState.startTime - 1;

    // Çeviri (sıralı; bağlam penceresi için)
    let tr;
    try {
      tr = await translate({
        sentence: sentences[i],
        contextPairs: contextPairs.slice(-4),
        videoContext: videoTitle,
        apiKey,
        model: translationModel,
        onUsage: (u) =>
          addCost(costTranslation(translationModel, u.prompt_tokens || 0, u.completion_tokens || 0)),
      });
    } catch (err) {
      console.error(`[SW] Çeviri ${i + 1}/${sentences.length} hatası:`, err);
      if (isAuthError(err)) {
        await abortForAuth();
        break;
      }
      setStatus("warn", "Bir cümle atlandı (geçici hata).");
      continue;
    }
    contextPairs.push({ en: sentences[i], tr });

    if (tooLate) {
      console.log(`[SW] cümle ${i + 1} geçildi (çok geç), TTS atlandı.`);
      continue;
    }

    // TTS paralel (semaphore-sınırlı)
    const origDur = range.end - range.start;
    const startSec = range.start;
    const endSec = range.end;

    const task = (async () => {
      await sem.acquire();
      try {
        if (dubState.abort) return;
        const speed = chooseSpeed(tr, origDur);
        const audioU8 = await tts({
          text: tr,
          voice: defaults.voice,
          instructions: defaults.tone,
          model: ttsModel,
          speed,
          format: "mp3",
          apiKey,
        });
        if (dubState.abort) return;
        addCost(costTts(ttsModel, tr.length));
        const audioBase64 = uint8ToBase64(audioU8);
        await chrome.runtime
          .sendMessage({
            target: "offscreen",
            type: "queueSegment",
            segment: {
              id: i,
              startSec,
              endSec,
              speed,
              originalText: sentences[i],
              turkishText: tr,
              audioBase64,
            },
          })
          .catch(() => {});
        console.log(
          `[SW] cümle ${i + 1}/${sentences.length} kuyruğa alındı ` +
            `(${startSec.toFixed(1)}-${endSec.toFixed(1)}s, speed=${speed.toFixed(2)})`,
        );
        queuedCount++;
        if (!autoPlayed && queuedCount >= PREBUFFER_SEGMENTS && dubState.tabId) {
          autoPlayed = true;
          console.log(`[SW] ${PREBUFFER_SEGMENTS} segment hazır — video oynatılıyor.`);
          chrome.tabs
            .sendMessage(dubState.tabId, {
              target: "content",
              type: "playVideo",
            })
            .catch(() => {});
        }
      } catch (err) {
        console.error(`[SW] TTS ${i + 1} hatası:`, err);
        if (isAuthError(err)) {
          dubState.abort = true;
          await abortForAuth();
        } else {
          setStatus("warn", "Bir bölüm seslendirilemedi (atlandı).");
        }
      } finally {
        sem.release();
      }
    })();
    pending.push(task);
  }

  await Promise.allSettled(pending);
  console.log("[SW] Pipeline tamamlandı.");
  if (!dubState.abort && dubState.active) {
    setStatus("running", "Çalışıyor (tüm bölümler hazırlandı).");
  }
}

async function runStreamPipeline(captions, defaults, apiKey, videoTitle) {
  const wordStream = buildWordStream(captions);
  const rawText = captions.map((c) => c.text).join(" ");
  const translationModel = defaults.modelTranslation || "gpt-5.4-mini";
  const ttsModel = defaults.modelTts || "gpt-4o-mini-tts";

  console.log(
    `[SW] Akış pipeline başlıyor — ${captions.length} altyazı parçası, ` +
      `çeviri=${translationModel}, ses=${defaults.voice}@${ttsModel}`,
  );

  resetSessionCost();
  setStatus("preparing", "Hazırlanıyor…");

  let sentences;
  try {
    sentences = await cleanAndSegment(rawText, {
      apiKey,
      model: "gpt-5.5", // segmentasyon her zaman gpt-5.5 — çeviri modelinden bağımsız
      onUsage: (u) =>
        addCost(costTranslation("gpt-5.5", u.prompt_tokens || 0, u.completion_tokens || 0)),
    });
  } catch (err) {
    console.error("[SW] Akış cleanAndSegment hatası:", err);
    if (isAuthError(err)) await abortForAuth();
    else setStatus("error", `Hazırlık başarısız: ${err.message}`);
    return;
  }
  console.log(`[SW] Akış: ${sentences.length} cümle bulundu.`);
  setStatus("running", "Çalışıyor");

  const ranges = mapSentencesToTimes(sentences, wordStream);
  for (const r of ranges) {
    if (r && r.end < r.start) r.end = r.start + 0.5;
  }

  // 'idle' | 'processing' | 'done'
  const sentenceStates = new Array(sentences.length).fill("idle");
  const contextPairs = [];
  const sem = semaphore(MAX_TTS_CONCURRENCY);

  async function processSentence(i) {
    const range = ranges[i];
    const sentence = sentences[i];

    let tr;
    try {
      tr = await translate({
        sentence,
        contextPairs: contextPairs.slice(-4),
        videoContext: videoTitle,
        apiKey,
        model: translationModel,
        onUsage: (u) =>
          addCost(costTranslation(translationModel, u.prompt_tokens || 0, u.completion_tokens || 0)),
      });
    } catch (err) {
      console.error(`[SW] Akış çeviri ${i + 1} hatası:`, err);
      if (isAuthError(err)) await abortForAuth();
      else setStatus("warn", "Bir cümle atlandı (geçici hata).");
      sentenceStates[i] = "done";
      return;
    }
    contextPairs.push({ en: sentence, tr });

    await sem.acquire();
    try {
      if (dubState.abort) return;
      const origDur = range.end - range.start;
      const speed = chooseSpeed(tr, origDur);
      const audioU8 = await tts({
        text: tr,
        voice: defaults.voice,
        instructions: defaults.tone,
        model: ttsModel,
        speed,
        format: "mp3",
        apiKey,
      });
      if (dubState.abort) return;
      addCost(costTts(ttsModel, tr.length));
      await chrome.runtime
        .sendMessage({
          target: "offscreen",
          type: "queueSegment",
          segment: {
            id: i,
            startSec: range.start,
            endSec: range.end,
            speed,
            originalText: sentence,
            turkishText: tr,
            audioBase64: uint8ToBase64(audioU8),
          },
        })
        .catch(() => {});
      console.log(
        `[SW] Akış cümle ${i + 1}/${sentences.length} kuyruğa alındı ` +
          `(${range.start.toFixed(1)}-${range.end.toFixed(1)}s, speed=${speed.toFixed(2)})`,
      );
    } catch (err) {
      console.error(`[SW] Akış TTS ${i + 1} hatası:`, err);
      if (isAuthError(err)) {
        dubState.abort = true;
        await abortForAuth();
      } else {
        setStatus("warn", "Bir bölüm seslendirilemedi (atlandı).");
      }
    } finally {
      sem.release();
      sentenceStates[i] = "done";
    }
  }

  const scheduler = setInterval(() => {
    if (dubState.abort || !dubState.active) {
      clearInterval(scheduler);
      return;
    }
    const estNow = dubState.videoState.currentTime;
    // İlk videoState henüz gelmeden işlem başlatma
    if (estNow === 0 && dubState.videoState.paused) return;
    for (let i = 0; i < sentences.length; i++) {
      if (sentenceStates[i] !== "idle") continue;
      const range = ranges[i];
      if (!range) { sentenceStates[i] = "done"; continue; }
      // Geçmişte kalmış cümleleri atla
      if (range.end < estNow - 2) { sentenceStates[i] = "done"; continue; }
      // Lookahead penceresine giren cümleleri işle
      if (range.start - LOOKAHEAD_SEC <= estNow) {
        sentenceStates[i] = "processing";
        processSentence(i).catch((err) =>
          console.error(`[SW] processSentence ${i} beklenmedik hata:`, err),
        );
      }
    }
    if (sentenceStates.every((s) => s !== "idle")) {
      clearInterval(scheduler);
      console.log("[SW] Akış scheduler tamamlandı.");
      if (!dubState.abort && dubState.active) {
        setStatus("running", "Çalışıyor (tüm bölümler hazırlandı).");
      }
    }
  }, 300);
}
