// Popup — sade kontrol paneli: ses seviyesi, başlat/durdur, durum, maliyet.
// Mod/model/ses/ton seçimi Ayarlar sayfasındadır; popup yalnızca kayıtlı modu
// okuyup ona göre Kaliteli/Canlı akışını başlatır.
import { formatUsd } from "../lib/pricing.js";

const $ = (id) => document.getElementById(id);

let mode = "kaliteli"; // storage'dan yüklenir
let dubbingActive = false;

$("version").textContent = "v" + chrome.runtime.getManifest().version;

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => resolve(res));
  });
}

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "hint center" + (kind ? " " + kind : "");
}

function statusKind(status) {
  if (status === "error") return "err";
  if (status === "running") return "ok";
  return "";
}

function setButton(active) {
  dubbingActive = active;
  const btn = $("start-stop");
  btn.textContent = active ? "Durdur" : "Dublajı başlat";
  btn.classList.toggle("stop", active);
}

function updateModeLine() {
  const label = mode === "canli" ? "Canlı" : "Kaliteli";
  $("mode-line").innerHTML = `Mod: ${label} · ses/ton/model <a href="#" id="open-options">ayarlardan</a>`;
  $("open-options").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

// SW'dan canlı durum güncellemeleri
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "statusUpdate") return;
  setStatus(msg.detail || msg.status, statusKind(msg.status));
  if (msg.status === "error" || msg.status === "idle") setButton(false);
});

// --- Maliyet göstergesi ----------------------------------------------------

async function refreshUsage() {
  const u = await send({ type: "getUsage" });
  if (!u?.ok) return;
  $("usage-video").textContent = "~" + formatUsd(u.videoCost);
  $("usage-month").textContent = "~" + formatUsd(u.monthCost);
  $("usage-ym").textContent = u.ym || "—";
  const warn = $("usage-warn");
  if (u.overThreshold) {
    warn.hidden = false;
    warn.textContent = `Aylık eşik (${formatUsd(u.threshold)}) aşıldı — yalnızca bilgi.`;
  } else {
    warn.hidden = true;
  }
}
const usageTimer = setInterval(refreshUsage, 2000);
window.addEventListener("unload", () => clearInterval(usageTimer));

// --- Ses seviyesi kaydırıcıları (offscreen GainNode'lara canlı bağlı) ------

function wireSlider(channel) {
  const slider = $(channel);
  const valEl = $(`${channel}-val`);
  slider.addEventListener("input", () => {
    const pct = Number(slider.value);
    valEl.textContent = `${pct}%`;
    send({ target: "offscreen", type: "setGain", channel, value: pct / 100 });
  });
}
wireSlider("original");
wireSlider("dub");

// --- Başlat / Durdur -------------------------------------------------------

$("start-stop").addEventListener("click", async () => {
  if (dubbingActive) {
    setStatus("Durduruluyor...");
    const res = await send({
      type: mode === "canli" ? "stopLiveDubbing" : "stopDubbing",
    });
    setButton(false);
    setStatus(res?.ok ? "Durduruldu." : `Hata: ${res?.error || "?"}`, res?.ok ? "" : "err");
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return setStatus("Aktif sekme bulunamadı.", "err");
  if (!/youtube\.com/.test(tab.url || "")) return setStatus("Aktif sekme YouTube değil.", "err");

  if (mode === "canli") {
    setStatus("Canlı çeviri bağlanıyor…");
    const res = await send({ type: "startLiveDubbing", tabId: tab.id });
    if (res?.ok) {
      setButton(true);
      setStatus("Canlı çeviri aktif. Videoyu oynat.", "ok");
    } else {
      setStatus(`Hata: ${res?.error || "bilinmiyor"}`, "err");
    }
    return;
  }

  setStatus("Dublaj başlatılıyor… (altyazı + capture + pipeline)");
  const res = await send({ type: "startDubbing", tabId: tab.id });
  if (res?.ok) {
    setButton(true);
    setStatus(`Dublaj aktif. ${res.sentenceCountPlanned ?? "?"} cümle işlenecek.`, "ok");
  } else {
    setStatus(`Hata: ${res?.error || "bilinmiyor"}`, "err");
  }
});

// --- Açılış ----------------------------------------------------------------

async function init() {
  const dres = await send({ type: "getDefaults" });
  mode = dres?.defaults?.mode || "kaliteli";
  updateModeLine();

  const st = await send({ type: "getStatus" });
  if (st?.ok && st.status && st.status !== "idle") {
    setStatus(st.detail || st.status, statusKind(st.status));
  }

  const state = await send({ type: "getCaptureState" });
  if (state?.capturing) {
    setButton(true);
    if (!st || st.status === "idle") setStatus("Dublaj aktif.", "ok");
    if (typeof state.original === "number") {
      $("original").value = Math.round(state.original * 100);
      $("original-val").textContent = Math.round(state.original * 100) + "%";
    }
    if (typeof state.dub === "number") {
      $("dub").value = Math.round(state.dub * 100);
      $("dub-val").textContent = Math.round(state.dub * 100) + "%";
    }
  }

  refreshUsage();
}

init();
