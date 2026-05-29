// Options page — anahtar yönetimi + mod/model/ses/ton seçimleri + maliyet eşiği.
// Anahtarın tam değeri yalnızca service worker'da tutulur; bu sayfa sadece
// kullanıcının yazdığını SW'a iletir ve maskeli versiyonu gösterir.
import {
  voiceGroupsForModel,
  coerceVoice,
  TONE_PRESETS,
  modelsSorted,
} from "../lib/voices.js";

const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => resolve(res));
  });
}

// === API anahtarı ==========================================================

const keyInput = $("api-key");
const keyStatus = $("key-status");

function setKeyStatus(text, kind = "") {
  keyStatus.textContent = text;
  keyStatus.className = "hint" + (kind ? " " + kind : "");
}

async function refreshKeyStatus() {
  const res = await send({ type: "getKeyStatus" });
  if (res?.hasKey) {
    setKeyStatus(`Kayıtlı anahtar: ${res.masked}`, "ok");
    keyInput.value = "";
    keyInput.placeholder = res.masked;
  } else {
    setKeyStatus("Anahtar yüklü değil.");
    keyInput.placeholder = "sk-...";
  }
}

$("toggle-key").addEventListener("click", () => {
  keyInput.type = keyInput.type === "password" ? "text" : "password";
});

$("save-key").addEventListener("click", async () => {
  const value = keyInput.value.trim();
  if (!value) return setKeyStatus("Önce anahtarı yapıştır.", "err");
  setKeyStatus("Kaydediliyor...");
  const res = await send({ type: "saveKey", key: value });
  keyInput.value = "";
  if (res?.ok) {
    setKeyStatus(`Kaydedildi: ${res.masked}`, "ok");
    keyInput.placeholder = res.masked;
  } else {
    setKeyStatus(`Hata: ${res?.error || "bilinmiyor"}`, "err");
  }
});

$("test-key").addEventListener("click", async () => {
  setKeyStatus("Test ediliyor...");
  const res = await send({ type: "testConnection" });
  setKeyStatus(
    res?.ok ? res.message || "Bağlantı başarılı." : `Bağlantı başarısız: ${res?.error || "?"}`,
    res?.ok ? "ok" : "err",
  );
});

$("delete-key").addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirm("Kayıtlı API anahtarı silinsin mi?")) return;
  await send({ type: "deleteKey" });
  await refreshKeyStatus();
});

// === Mod / Model / Ses / Ton (popup'tan taşındı) ===========================

let cfg = {
  mode: "kaliteli",
  voice: "onyx",
  tone: TONE_PRESETS[0].text,
  toneId: "sakin",
  modelTranscription: "gpt-4o-transcribe",
  modelTranslation: "gpt-5.5",
  modelTts: "gpt-4o-mini-tts",
  sortMode: "kalite",
};

const previewAudio = $("preview-audio");

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    send({
      type: "saveDefaults",
      defaults: {
        mode: cfg.mode,
        voice: cfg.voice,
        tone: cfg.tone,
        modelTranscription: cfg.modelTranscription,
        modelTranslation: cfg.modelTranslation,
        modelTts: cfg.modelTts,
        sortMode: cfg.sortMode,
      },
    });
  }, 150);
}

function fillModelSelect(selectId, fn, selected) {
  const sel = $(selectId);
  sel.innerHTML = "";
  for (const m of modelsSorted(fn, cfg.sortMode)) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderModels() {
  fillModelSelect("model-transcription", "transcription", cfg.modelTranscription);
  fillModelSelect("model-translation", "translation", cfg.modelTranslation);
  fillModelSelect("model-tts", "tts", cfg.modelTts);
}

function renderVoices() {
  const container = $("voice-groups");
  container.innerHTML = "";
  cfg.voice = coerceVoice(cfg.voice, cfg.modelTts);
  for (const group of voiceGroupsForModel(cfg.modelTts)) {
    const g = document.createElement("div");
    g.className = "voice-group";
    const gl = document.createElement("div");
    gl.className = "voice-group-label";
    gl.textContent = group.label;
    g.appendChild(gl);

    const list = document.createElement("div");
    list.className = "voice-list";
    for (const v of group.voices) {
      const item = document.createElement("div");
      item.className = "voice-item" + (v === cfg.voice ? " active" : "");

      const name = document.createElement("button");
      name.type = "button";
      name.className = "voice-name";
      name.textContent = v;
      name.addEventListener("click", () => {
        cfg.voice = v;
        persist();
        renderVoices();
      });

      const prev = document.createElement("button");
      prev.type = "button";
      prev.className = "voice-preview";
      prev.textContent = "▶";
      prev.title = "Önizle";
      prev.addEventListener("click", (e) => {
        e.stopPropagation();
        previewVoice(v, prev);
      });

      item.appendChild(name);
      item.appendChild(prev);
      list.appendChild(item);
    }
    g.appendChild(list);
    container.appendChild(g);
  }
}

function renderTones() {
  const wrap = $("tone-chips");
  wrap.innerHTML = "";
  for (const t of TONE_PRESETS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (cfg.toneId === t.id ? " active" : "");
    chip.textContent = t.label;
    chip.addEventListener("click", () => {
      cfg.toneId = t.id;
      cfg.tone = t.text;
      $("custom-tone-wrap").classList.add("hidden");
      persist();
      renderTones();
    });
    wrap.appendChild(chip);
  }
  const custom = document.createElement("button");
  custom.type = "button";
  custom.className = "chip" + (cfg.toneId === "ozel" ? " active" : "");
  custom.textContent = "Özel…";
  custom.addEventListener("click", () => {
    cfg.toneId = "ozel";
    const ta = $("custom-tone");
    if (!ta.value) ta.value = cfg.tone;
    cfg.tone = ta.value;
    $("custom-tone-wrap").classList.remove("hidden");
    persist();
    renderTones();
  });
  wrap.appendChild(custom);
}

$("custom-tone").addEventListener("input", (e) => {
  cfg.tone = e.target.value;
  cfg.toneId = "ozel";
  persist();
});

let previewing = false;
async function previewVoice(voice, btn) {
  if (previewing) return;
  previewing = true;
  btn.classList.add("playing");
  const prevText = btn.textContent;
  btn.textContent = "…";
  try {
    const res = await send({
      type: "previewVoice",
      voice,
      tone: cfg.tone,
      ttsModel: cfg.modelTts,
    });
    if (res?.ok && res.audioBase64) {
      previewAudio.src = "data:audio/mp3;base64," + res.audioBase64;
      await previewAudio.play().catch(() => {});
      await new Promise((r) => {
        previewAudio.onended = r;
        previewAudio.onerror = r;
      });
    } else {
      setKeyStatus(`Önizleme hatası: ${res?.error || "bilinmiyor"}`, "err");
    }
  } finally {
    previewing = false;
    btn.classList.remove("playing");
    btn.textContent = prevText;
  }
}

// Canlı modda ses/ton/model seçicileri pasif (model otomatik ayarlıyor).
function applyMode() {
  const live = cfg.mode === "canli";
  $("models-block").classList.toggle("disabled-block", live);
  $("voice-block").classList.toggle("disabled-block", live);
  $("tone-block").classList.toggle("disabled-block", live);
  $("live-note").hidden = !live;
  $("mode-hint").textContent = live
    ? "Canlı: gpt-realtime-translate ile düşük gecikmeli, anlık çeviri."
    : "Çeviri-önce: tam bağlamla doğal Türkçe dublaj.";
}

$("mode-seg").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn || btn.disabled) return;
  cfg.mode = btn.dataset.mode;
  for (const b of $("mode-seg").querySelectorAll(".seg-btn"))
    b.classList.toggle("active", b === btn);
  applyMode();
  persist();
});

$("sort-seg").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  cfg.sortMode = btn.dataset.sort;
  for (const b of $("sort-seg").querySelectorAll(".seg-btn"))
    b.classList.toggle("active", b === btn);
  cfg.modelTranscription = modelsSorted("transcription", cfg.sortMode)[0].id;
  cfg.modelTranslation = modelsSorted("translation", cfg.sortMode)[0].id;
  cfg.modelTts = modelsSorted("tts", cfg.sortMode)[0].id;
  renderModels();
  renderVoices();
  persist();
});

$("model-transcription").addEventListener("change", (e) => {
  cfg.modelTranscription = e.target.value;
  persist();
});
$("model-translation").addEventListener("change", (e) => {
  cfg.modelTranslation = e.target.value;
  persist();
});
$("model-tts").addEventListener("change", (e) => {
  cfg.modelTts = e.target.value;
  renderVoices();
  persist();
});

async function loadDefaults() {
  const res = await send({ type: "getDefaults" });
  const d = res?.defaults || {};
  cfg.mode = d.mode || cfg.mode;
  cfg.voice = d.voice || cfg.voice;
  cfg.tone = typeof d.tone === "string" ? d.tone : cfg.tone;
  cfg.modelTranscription = d.modelTranscription || cfg.modelTranscription;
  cfg.modelTranslation = d.modelTranslation || cfg.modelTranslation;
  cfg.modelTts = d.modelTts || cfg.modelTts;
  cfg.sortMode = d.sortMode || cfg.sortMode;
  const match = TONE_PRESETS.find((t) => t.text === cfg.tone);
  cfg.toneId = match ? match.id : "ozel";

  for (const b of $("mode-seg").querySelectorAll(".seg-btn"))
    b.classList.toggle("active", b.dataset.mode === cfg.mode);
  for (const b of $("sort-seg").querySelectorAll(".seg-btn"))
    b.classList.toggle("active", b.dataset.sort === cfg.sortMode);

  renderModels();
  renderVoices();
  renderTones();
  applyMode();
  if (cfg.toneId === "ozel") {
    $("custom-tone").value = cfg.tone;
    $("custom-tone-wrap").classList.remove("hidden");
  }
}

// === Aylık maliyet eşiği ===================================================

const thresholdInput = $("threshold");

async function loadThreshold() {
  const { usage_threshold } = await chrome.storage.local.get("usage_threshold");
  if (typeof usage_threshold === "number" && usage_threshold > 0) {
    thresholdInput.value = String(usage_threshold);
  }
}

$("save-threshold").addEventListener("click", async () => {
  const v = Number(thresholdInput.value) || 0;
  await chrome.storage.local.set({ usage_threshold: v });
  setKeyStatus(
    v > 0 ? `Aylık uyarı eşiği: $${v}` : "Aylık uyarı eşiği kapatıldı.",
    "ok",
  );
});

// === Açılış ================================================================

$("version").textContent = "v" + chrome.runtime.getManifest().version;
refreshKeyStatus();
loadDefaults();
loadThreshold();
