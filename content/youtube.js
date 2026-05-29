// YouTube içerik scripti (izole world).
// 1) MAIN world'deki köprüden ytInitialPlayerResponse'u alır.
// 2) Caption track'leri çözer, en uygun olanı seçer, timedtext'i indirir
//    ve {start, end, text} parçalarına dönüştürür (M2 pipeline formatı).
// 3) Video elementini gözler; oynat/duraklat/sarma olaylarını ve currentTime'ı raporlar.
//
// M4 amacı: veriyi doğru çekebildiğimizi doğrulamak. Henüz worker'a yollamıyoruz.

const PAGE_TAG = "canli-cevirmen-page";
const CONTENT_TAG = "canli-cevirmen-content";
const LOG = "[CC]";

const state = {
  playerResponse: null,
  tracks: [],
  selectedTrack: null,
  captions: null,
  video: null,
  timeTimer: null,
  lastVideoId: null,
  reportTimer: null,
};

// --- SW ↔ content mesajlaşması ---------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "content") return false;
  switch (msg.type) {
    case "getCaptions":
      sendResponse({
        ok: true,
        captions: state.captions || [],
        videoId: state.lastVideoId,
        videoTitle: state.playerResponse?.videoDetails?.title || null,
      });
      return false;
    case "startReporting":
      startReporting();
      sendResponse({ ok: true });
      return false;
    case "stopReporting":
      stopReporting();
      sendResponse({ ok: true });
      return false;
    case "pauseVideo":
      if (state.video) state.video.pause();
      sendResponse({
        ok: true,
        currentTime: state.video ? state.video.currentTime : 0,
      });
      return false;
    case "playVideo":
      if (state.video) {
        state.video.play().catch(() => {});
      }
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

function startReporting() {
  if (state.reportTimer) return;
  state.reportTimer = setInterval(sendVideoState, 300);
  sendVideoState();
}

function stopReporting() {
  if (state.reportTimer) {
    clearInterval(state.reportTimer);
    state.reportTimer = null;
  }
}

function sendVideoState() {
  if (!state.video) return;
  const payload = {
    currentTime: state.video.currentTime,
    paused: state.video.paused,
    ended: state.video.ended,
    duration: state.video.duration || 0,
  };
  // SW'a (pipeline read-ahead için) ve offscreen'e DOĞRUDAN gönder.
  // Doğrudan offscreen iletimi, SW MV3 uykusundan bağımsız olarak dublaj
  // zamanlamasının çalışmaya devam etmesini sağlar.
  chrome.runtime.sendMessage({ type: "videoState", state: payload }).catch(() => {});
  chrome.runtime
    .sendMessage({ target: "offscreen", type: "videoState", state: payload })
    .catch(() => {});
}

console.log(`${LOG} Canlı Çevirmen content script aktif.`);

// --- MAIN world'den gelen mesajlar -----------------------------------------

window.addEventListener("message", async (ev) => {
  if (ev.source !== window) return;
  if (ev.data?.source !== PAGE_TAG) return;

  if (ev.data.type === "playerResponse") {
    await handlePlayerResponse(ev.data.payload);
  } else if (ev.data.type === "capturedCaption") {
    handleCapturedCaption(ev.data.payload);
  }
});

// MAIN world hazır değilse de açıkça iste
window.postMessage({ source: CONTENT_TAG, type: "requestPlayerResponse" }, "*");

function handleCapturedCaption({ url, body }) {
  // İlk başarılı yakalama yeterli; sonrakileri yoksay.
  if (state.captions) return;
  if (!body || body.trim().length < 20) return;

  const captions = parseAuto(body);
  if (captions.length === 0) return;

  // URL'den hangi dil/track yakalandığını çıkar (bizim seçimimizden farklı olabilir).
  let lang = "?", kind = "manual";
  try {
    const u = new URL(url);
    lang = u.searchParams.get("lang") || "?";
    kind = u.searchParams.get("kind") || "manual";
  } catch {}

  state.captions = captions;
  console.log(
    `${LOG} (hook) ${captions.length} altyazı parçası yakalandı ` +
      `(lang=${lang}, kind=${kind}). İlk 10:`,
  );
  console.table(captions.slice(0, 10));

  if (lang.startsWith("tr") && !guessAudioIsTurkish()) {
    console.warn(
      `${LOG} UYARI: Yakalanan track Türkçe ama videonun orijinal dili Türkçe değil — ` +
        `bu büyük olasılıkla YouTube makine çevirisi (düşük kalite). ` +
        `YouTube player'da altyazı dilini orijinaline çevirip sayfayı yenile.`,
    );
  }
}

function parseAuto(text) {
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      return parseJson3(t);
    } catch {
      return [];
    }
  }
  if (t.startsWith("<")) return parseXml(t);
  return [];
}

async function handlePlayerResponse(pr) {
  if (!pr) {
    console.warn(`${LOG} ytInitialPlayerResponse boş geldi.`);
    return;
  }

  const videoId =
    pr.videoDetails?.videoId ||
    new URLSearchParams(location.search).get("v") ||
    null;

  // Aynı video için tekrar tetiklenmesin
  if (videoId && videoId === state.lastVideoId) return;
  state.lastVideoId = videoId;
  state.playerResponse = pr;

  const title = pr.videoDetails?.title || "?";
  const author = pr.videoDetails?.author || "?";
  console.log(`${LOG} Video: "${title}" — ${author} (id=${videoId})`);

  const tracks =
    pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  state.tracks = tracks;

  if (tracks.length === 0) {
    console.warn(
      `${LOG} Bu videoda altyazı yok. ` +
        `(Sonraki aşama: sekme sesini gpt-4o-transcribe ile transkribe et — şimdi uygulanmadı.)`,
    );
    return;
  }

  const summary = tracks.map((t) => ({
    languageCode: t.languageCode,
    kind: t.kind || "manual",
    name: t.name?.simpleText || t.name?.runs?.[0]?.text || "?",
  }));
  console.log(`${LOG} Mevcut altyazı parçaları (track):`);
  console.table(summary);

  const selected = pickTrack(tracks);
  state.selectedTrack = selected;
  console.log(
    `${LOG} Seçilen: lang=${selected.languageCode}, kind=${selected.kind || "manual"}`,
  );

  try {
    const captions = await fetchAndParseCaptions(selected.baseUrl);
    state.captions = captions;
    console.log(
      `${LOG} (direct) ${captions.length} altyazı parçası çekildi. İlk 10:`,
    );
    console.table(captions.slice(0, 10));
    return;
  } catch (err) {
    console.warn(`${LOG} Direkt fetch başarısız: ${err.message}`);
  }

  // ASR caption'ları için POT zorunluluğu var; YouTube'un kendi imzalı
  // request'ini tetiklemek için CC butonunu açıyoruz. MAIN world'deki fetch
  // hook cevabı yakalayıp bize iletecek.
  console.log(
    `${LOG} CC butonunu tetikliyoruz — YouTube player'ın caption fetch'ini bekliyoruz...`,
  );
  triggerCaptionFetch();
}

function triggerCaptionFetch() {
  const btn = document.querySelector(".ytp-subtitles-button");
  if (!btn) {
    console.warn(
      `${LOG} CC butonu (.ytp-subtitles-button) bulunamadı. Player henüz yüklenmemiş olabilir; yenile.`,
    );
    return;
  }
  const wasOn = btn.getAttribute("aria-pressed") === "true";
  btn.click();
  if (wasOn) {
    // Kapat-aç döngüsüyle yeniden fetch tetikle.
    setTimeout(() => btn.click(), 400);
    console.log(`${LOG} CC açıktı; kapat-aç ile yeniden fetch tetiklendi.`);
  } else {
    console.log(`${LOG} CC açıldı, fetch tetiklendi.`);
  }
}

// --- Track seçimi ----------------------------------------------------------

function pickTrack(tracks) {
  // captionTracks zaten ORİJİNAL track'lerdir; YouTube'un kullanıcıya sunduğu
  // makine çevirileri buraya gelmez (translationLanguages ayrı listede tutulur).
  // Yine de orijinal videonun audio dili Türkçe değilse Türkçe track'i tercih
  // etmemek için açık bir filtre ekleyelim — çünkü bazen kanal kendi elinde
  // Türkçe altyazı yüklemiş olabilir (orijinali İngilizce video için).
  // Kararı şöyle veriyoruz:
  //   - Eğer audio dili kanıtlanmış olarak Türkçe değilse ve birden çok track varsa
  //     Türkçe'yi son çare olarak bırak.
  //   - Aksi takdirde: manuel > ASR.

  const audioIsTurkish = guessAudioIsTurkish();
  const ranked = [...tracks].sort((a, b) => score(b) - score(a));
  return ranked[0];

  function score(t) {
    let s = 0;
    if (t.kind !== "asr") s += 10; // manuel daha iyi
    if (audioIsTurkish) {
      if (t.languageCode?.startsWith("tr")) s += 5;
    } else {
      if (t.languageCode?.startsWith("tr")) s -= 20; // sondan başa
    }
    // İngilizce orijinal için küçük bir puan (yaygın varsayım)
    if (!audioIsTurkish && t.languageCode?.startsWith("en")) s += 1;
    return s;
  }
}

function guessAudioIsTurkish() {
  // Heuristic: playerResponse'da audioTracks varsa orada displayName/dil bakılır.
  const audio =
    state.playerResponse?.streamingData?.adaptiveFormats?.find(
      (f) => f.audioTrack,
    );
  const lang = audio?.audioTrack?.id || "";
  if (lang.startsWith("tr")) return true;
  // Başka bir sinyal yok; sayfa dili ile karıştırmamak için varsayılan: false.
  return false;
}

// --- Caption indir + parse -------------------------------------------------
// YouTube'un timedtext endpoint'i bazı (özellikle ASR) track'ler için json3'ü
// boş döndürebiliyor; XML formatları daha güvenilir. Sırayla dener.

async function fetchAndParseCaptions(baseUrl) {
  const attempts = [
    { name: "baseUrl as-is (varsayılan srv3 XML)", url: baseUrl, parser: parseXml },
    { name: "srv1 (eski XML)", url: withFmt(baseUrl, "srv1"), parser: parseXml },
    { name: "srv3 (TTML XML)", url: withFmt(baseUrl, "srv3"), parser: parseXml },
    { name: "json3", url: withFmt(baseUrl, "json3"), parser: parseJson3 },
  ];

  for (const att of attempts) {
    try {
      const res = await fetch(att.url, { credentials: "include" });
      const text = await res.text();
      console.log(
        `${LOG}   denendi: ${att.name} → HTTP ${res.status}, ${text.length} bayt`,
      );
      if (!res.ok || text.trim().length < 20) continue;
      const parsed = att.parser(text);
      if (parsed.length > 0) {
        console.log(`${LOG} kullanılan format: ${att.name}`);
        return parsed;
      }
    } catch (err) {
      console.warn(`${LOG}   ${att.name} hatası:`, err.message);
    }
  }
  throw new Error("Hiçbir caption format'ı geçerli veri döndürmedi.");
}

function withFmt(url, fmt) {
  const u = new URL(url, location.origin);
  u.searchParams.set("fmt", fmt);
  return u.toString();
}

function parseJson3(text) {
  const data = JSON.parse(text);
  const out = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const t = ev.segs
      .map((s) => s.utf8 || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) continue;
    const start = (ev.tStartMs || 0) / 1000;
    const end = start + (ev.dDurationMs || 0) / 1000;
    out.push({ start, end, text: t });
  }
  return out;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) return [];
  const out = [];

  // srv3 / TTML benzeri: <timedtext><body><p t="ms" d="ms">...</p>
  for (const p of doc.querySelectorAll("p")) {
    const start = parseInt(p.getAttribute("t") || "0", 10) / 1000;
    const dur = parseInt(p.getAttribute("d") || "0", 10) / 1000;
    const t = (p.textContent || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    out.push({ start, end: start + dur, text: t });
  }
  if (out.length > 0) return out;

  // srv1 eski format: <transcript><text start="sec" dur="sec">...</text>
  for (const node of doc.querySelectorAll("text")) {
    const start = parseFloat(node.getAttribute("start") || "0");
    const dur = parseFloat(node.getAttribute("dur") || "0");
    // srv1 metni HTML escape edilmiş halde; textContent zaten çözer.
    const t = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    out.push({ start, end: start + dur, text: t });
  }
  return out;
}

// --- Video elementi izleme -------------------------------------------------

function findVideo() {
  return document.querySelector("video.html5-main-video, video");
}

function attachVideoListeners() {
  const v = findVideo();
  if (!v || state.video === v) return;
  state.video = v;

  v.addEventListener("play", () => {
    console.log(`${LOG} ▶ play @ ${v.currentTime.toFixed(2)}s`);
    sendVideoState();
  });
  v.addEventListener("pause", () => {
    console.log(`${LOG} ❚❚ pause @ ${v.currentTime.toFixed(2)}s`);
    sendVideoState();
  });
  v.addEventListener("seeked", () => {
    console.log(`${LOG} ⇆ seek → ${v.currentTime.toFixed(2)}s`);
    sendVideoState();
  });
  v.addEventListener("ended", () => {
    console.log(`${LOG} ⏹ ended`);
    sendVideoState();
  });
  v.addEventListener("ratechange", () =>
    console.log(`${LOG} hız: ${v.playbackRate}x`),
  );

  if (state.timeTimer) clearInterval(state.timeTimer);
  state.timeTimer = setInterval(() => {
    if (state.video && !state.video.paused && !state.video.ended) {
      console.log(`${LOG} t = ${state.video.currentTime.toFixed(2)}s`);
    }
  }, 1000);

  console.log(`${LOG} Video element bağlandı.`);
}

const videoObserver = new MutationObserver(() => attachVideoListeners());
videoObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});
attachVideoListeners();
