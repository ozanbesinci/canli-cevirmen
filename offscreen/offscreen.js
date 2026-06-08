// Offscreen document.
// - tabCapture stream'ini Web Audio'ya bağlar (orijinal kanal).
// - SW'tan gelen Türkçe ses segmentlerini decode edip zaman damgalarına göre
//   dublaj kanalında çalar (AudioBufferSourceNode).
// - Otomatik ducking: dublaj çalarken originalGain düşer, susunca geri çıkar.
// - Slider girişleri (setGain) duck'ın taban/tavan değerini günceller.

let audioContext = null;
let stream = null;
let mediaSource = null;
let originalGain = null;
let dubGain = null;

// Kullanıcı slider seviyeleri (0..1)
let userOrigLevel = 0.25; // CLAUDE.md §6
let userDubLevel = 1.0;
const DUCK_RATIO = 0.2; // dub çalarken orig şuna iner: userOrigLevel * 0.2

// Video durumu
let videoState = { currentTime: 0, paused: true, ended: false };
let lastVideoStateAt = 0;

// Zaman eşlemesi (oynatma sırasında audioContext.currentTime ↔ video.currentTime)
let timeMap = null;

// Segmentler (startSec'e göre sıralı): { id, startSec, endSec, audioBuffer, state, src, duckStartTid, duckEndTid, turkishText }
const segments = [];

// Dublaj kanalı seri çalışır: aynı anda yalnızca tek bir Türkçe ses çalar.
// Aşağıdaki referans şu an çalan segmenti tutar.
let currentPlaying = null;
let dubActive = false;
const pendingDuckTimers = new Set();

// Senkron: dublaj video'nun bu kadar saniyesinden fazla geride kalırsa,
// aradaki segmentler atlanıp video'nun bulunduğu noktaya yetişilir.
const DRIFT_MAX = 4;
let pollTid = null; // sıradaki segmentin zamanını beklerken kullanılan zamanlayıcı
let keepaliveTid = null; // SW'ı MV3 uykusundan uzak tutan ping zamanlayıcısı

// Transkripsiyon modu (altyazısız video): sekme sesini parçalar halinde kaydet.
let transcribeOn = false;
let mediaRecorder = null;
let transcribeChunkIndex = 0;
const TRANSCRIBE_CHUNK_SEC = 20;

// Canlı mod (gpt-realtime-translate, WebRTC)
let livePc = null;
let liveRemoteEl = null;
let liveAnalyser = null;
let liveDuckTid = null;
let liveSilenceSince = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  handle(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case "startCapture":
      return await startCapture(msg.streamId);
    case "stopCapture":
      return await stopCapture();
    case "queueSegment":
      return await queueSegment(msg.segment);
    case "startTranscribe":
      return await startTranscribe(msg.streamId);
    case "stopTranscribe":
      return stopTranscribe();
    case "startLive":
      return await startLive(msg.streamId, msg.clientSecret);
    case "stopLive":
      return stopLive();
    case "reconnectLive":
      return await reconnectLive(msg.clientSecret);
    case "videoState":
      return updateVideoState(msg.state);
    case "resetDub":
      return resetDub();
    case "setGain":
      return setGain(msg.channel, msg.value);
    case "getState":
      return {
        ok: true,
        capturing: !!stream,
        original: userOrigLevel,
        dub: userDubLevel,
        segmentCount: segments.length,
        playing: !!currentPlaying,
        videoState,
      };
    default:
      return { ok: false, error: `Bilinmeyen mesaj türü: ${msg.type}` };
  }
}

// --- Capture --------------------------------------------------------------

async function startCapture(streamId) {
  if (stream) return { ok: true, alreadyRunning: true };
  if (!streamId) return { ok: false, error: "streamId boş." };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (err) {
    return { ok: false, error: `getUserMedia hatası: ${err.message}` };
  }

  audioContext = new AudioContext();
  audioContext.resume().catch(() => {});

  mediaSource = audioContext.createMediaStreamSource(stream);
  originalGain = audioContext.createGain();
  originalGain.gain.value = userOrigLevel;
  mediaSource.connect(originalGain).connect(audioContext.destination);

  dubGain = audioContext.createGain();
  dubGain.gain.value = userDubLevel;
  dubGain.connect(audioContext.destination);

  // SW'ı MV3 uykusundan uzak tut: pipeline (uzun videoda) çalışmaya devam etsin.
  if (keepaliveTid) clearInterval(keepaliveTid);
  keepaliveTid = setInterval(() => {
    chrome.runtime
      .sendMessage({ target: "background", type: "keepalive" })
      .catch(() => {});
  }, 20000);

  return { ok: true };
}

async function stopCapture() {
  cancelAllSegments();
  teardownLivePc();
  stopTranscribe();
  segments.length = 0;
  if (keepaliveTid) {
    clearInterval(keepaliveTid);
    keepaliveTid = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (audioContext) {
    try {
      await audioContext.close();
    } catch {
      /* yut */
    }
    audioContext = null;
  }
  mediaSource = null;
  originalGain = null;
  dubGain = null;
  timeMap = null;
  return { ok: true };
}

// --- Segment kuyruğu ------------------------------------------------------

async function queueSegment(seg) {
  if (!audioContext || !dubGain) {
    return { ok: false, error: "Yakalama aktif değil." };
  }

  const arrayBuffer = base64ToArrayBuffer(seg.audioBase64);
  let audioBuffer;
  try {
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  } catch (err) {
    return { ok: false, error: `decode hatası: ${err.message}` };
  }

  // Transkripsiyon modunda segmentler doğası gereği gecikmeli gelir; zaman
  // hizalaması yerine "şimdi"ye yerleştirip seri çalıyoruz (drift atlaması olmasın).
  let startSec = seg.startSec;
  let endSec = seg.endSec;
  if (seg.immediate) {
    const estNow = estimatedVideoNow();
    const dur = audioBuffer.duration;
    startSec = estNow;
    endSec = estNow + dur;
  }

  const entry = {
    id: seg.id,
    startSec,
    endSec,
    audioBuffer,
    turkishText: seg.turkishText,
    originalText: seg.originalText,
    state: "idle", // idle | playing | done
    src: null,
    duckStartTid: null,
  };

  segments.push(entry);
  segments.sort((a, b) => a.startSec - b.startSec);

  // Yeni segment geldi; eğer şu an bir şey çalmıyorsa, başlatmayı dene.
  if (timeMap && !videoState.paused && !currentPlaying) {
    startNextSegment();
  }

  return { ok: true, duration: audioBuffer.duration };
}

// --- Zaman eşlemesi + zamanlayıcı -----------------------------------------

function updateVideoState(state) {
  const oldState = videoState;
  videoState = state;
  const wallDtSec = Math.max(0.001, (Date.now() - lastVideoStateAt) / 1000);
  lastVideoStateAt = Date.now();

  const wasPaused = oldState.paused;

  if (state.paused || state.ended) {
    onPause();
    return { ok: true };
  }

  if (wasPaused) {
    onPlay(state.currentTime);
    return { ok: true };
  }

  // Oynatıyorduk, hâlâ oynuyor — seek tespiti
  const dt = Math.abs(state.currentTime - oldState.currentTime);
  if (dt > wallDtSec + 0.5) {
    // büyük zaman zıplaması → seek
    onSeek(state.currentTime);
  } else {
    // Küçük ilerleme: zaman haritasını yeniden senkronla (drift'i önler) ve
    // sıradaki segmentin zamanı geldiyse başlatmayı dene.
    if (audioContext) {
      timeMap = {
        audioBase: audioContext.currentTime,
        videoBase: state.currentTime,
      };
    }
    startNextSegment();
  }

  return { ok: true };
}

// Video'nun şu anki tahmini zamanı (audioContext ile interpolasyon).
function estimatedVideoNow() {
  if (!timeMap || !audioContext) return videoState.currentTime;
  return timeMap.videoBase + (audioContext.currentTime - timeMap.audioBase);
}

function onPlay(currentTime) {
  if (!audioContext) return;
  timeMap = {
    audioBase: audioContext.currentTime,
    videoBase: currentTime,
  };
  rampOrigTo(getDuckTarget(), 0.05);
  startNextSegment();
}

function onPause() {
  cancelAllSegments();
  rampOrigTo(userOrigLevel, 0.1);
  timeMap = null;
}

function onSeek(newTime) {
  cancelAllSegments();
  if (!audioContext) return;
  timeMap = {
    audioBase: audioContext.currentTime,
    videoBase: newTime,
  };
  // Seek noktasından önce biten segmentleri "done" say (ileri sarmada eskiler
  // tekrar çalmasın); o noktada veya ilerisinde olanları yeniden çalınabilir yap.
  for (const seg of segments) {
    seg.src = null;
    seg.state = seg.endSec < newTime - 0.5 ? "done" : "idle";
  }
  rampOrigTo(getDuckTarget(), 0.05);
  startNextSegment();
}

/**
 * Dublaj seri çalışır. Bir segment biter bitmez buradan en uygun bir sonraki
 * (en küçük startSec'li, henüz idle olan) seçilip başlatılır. Aynı anda
 * yalnızca tek bir Türkçe ses kanalda olur — overlap karmaşası yok.
 */
function startNextSegment() {
  if (currentPlaying) return;
  if (!audioContext || !dubGain) return;
  if (videoState.paused || videoState.ended) return;

  const estNow = estimatedVideoNow();

  // Sıradaki çalınacak segmenti bul. Video'nun çok gerisinde kalmış (DRIFT_MAX
  // saniyeden fazla geçmiş) segmentleri atla ki dublaj video'ya yetişsin.
  let next = null;
  for (const s of segments) {
    if (s.state !== "idle") continue;
    if (s.startSec < estNow - DRIFT_MAX) {
      s.state = "done"; // çok geride kaldı, atla
      continue;
    }
    next = s;
    break;
  }
  if (!next) return;

  // Segmentin zamanı henüz gelmediyse (video o noktaya ulaşmadı), bekle ve
  // tekrar dene. Böylece dublaj erken başlamaz; video'yla hizalı kalır.
  if (next.startSec > estNow + 0.2) {
    if (pollTid) clearTimeout(pollTid);
    const waitMs = Math.min((next.startSec - estNow) * 1000, 1000);
    pollTid = setTimeout(startNextSegment, waitMs);
    return;
  }

  // Zamanı geldi → baştan, hemen çal.
  const nowA = audioContext.currentTime;
  const audioWhen = nowA;
  const bufferOffset = 0;

  const src = audioContext.createBufferSource();
  src.buffer = next.audioBuffer;

  // Gerçek TTS süresi slot'tan taşıyorsa oynatma hızını artır (max 1.5x).
  // Bu SW'daki karakter-sayısı tahmininden bağımsız, gerçek AudioBuffer üzerinde
  // çalışır — drift'in birincil kaynağını kapatır.
  const slotDur = next.endSec - next.startSec;
  const rawDur = next.audioBuffer.duration - bufferOffset;
  let playRate = 1.0;
  if (slotDur > 2.0 && rawDur > slotDur * 1.12) {
    playRate = Math.min(1.5, rawDur / slotDur);
  }
  src.playbackRate.value = playRate;

  // Her segmente kendi gain zarfı: baş/son tıklama ("pat") sesini önlemek için
  // 8 ms fade-in ve fade-out. src → segGain → dubGain.
  const segGain = audioContext.createGain();
  src.connect(segGain).connect(dubGain);

  const FADE = 0.008;
  const playDur = rawDur / playRate; // hızlandırılmış gerçek oynatma süresi
  const g = segGain.gain;
  g.setValueAtTime(0, audioWhen);
  g.linearRampToValueAtTime(1, audioWhen + FADE);
  const fadeOutStart = audioWhen + Math.max(FADE, playDur - FADE);
  g.setValueAtTime(1, fadeOutStart);
  g.linearRampToValueAtTime(0, audioWhen + playDur);

  src.onended = () => {
    if (currentPlaying === next) currentPlaying = null;
    next.state = "done";
    next.src = null;
    try {
      segGain.disconnect();
    } catch {
      /* yut */
    }
    if (dubActive) {
      dubActive = false;
      rampOrigTo(getDuckTarget(), 0.2);
    }
    // Bir sonrakine geç
    startNextSegment();
  };
  src.start(audioWhen, bufferOffset);
  next.src = src;
  next.segGain = segGain;
  next.state = "playing";
  currentPlaying = next;

  // Duck'ı segment başında aç
  const startDelayMs = Math.max(0, (audioWhen - nowA) * 1000);
  const startTid = setTimeout(() => {
    pendingDuckTimers.delete(startTid);
    dubActive = true;
    rampOrigTo(getDuckTarget(), 0.1);
  }, startDelayMs);
  pendingDuckTimers.add(startTid);
  next.duckStartTid = startTid;
}

function cancelAllSegments() {
  for (const seg of segments) {
    if (seg.src) {
      try {
        seg.src.onended = null;
        seg.src.stop();
      } catch {
        /* yut */
      }
      try {
        seg.src.disconnect();
      } catch {
        /* yut */
      }
      seg.src = null;
    }
    if (seg.segGain) {
      try {
        seg.segGain.disconnect();
      } catch {
        /* yut */
      }
      seg.segGain = null;
    }
    if (seg.duckStartTid) clearTimeout(seg.duckStartTid);
    seg.duckStartTid = null;
    if (seg.state === "playing") seg.state = "idle";
  }
  for (const tid of pendingDuckTimers) clearTimeout(tid);
  pendingDuckTimers.clear();
  if (pollTid) {
    clearTimeout(pollTid);
    pollTid = null;
  }
  currentPlaying = null;
  dubActive = false;
}

function resetDub() {
  cancelAllSegments();
  segments.length = 0;
  rampOrigTo(userOrigLevel, 0.1);
  return { ok: true };
}

// --- Gain kontrolü --------------------------------------------------------

function getDuckTarget() {
  // Şu an dublaj çalıyorsa taban (userOrigLevel × DUCK_RATIO); değilse tavan.
  return dubActive ? userOrigLevel * DUCK_RATIO : userOrigLevel;
}

function rampOrigTo(value, rampSec) {
  if (!originalGain || !audioContext) return;
  const g = originalGain.gain;
  const now = audioContext.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(Math.max(0, value), now + rampSec);
}

function setGain(channel, value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) {
    return { ok: false, error: `Geçersiz değer: ${value}` };
  }
  if (channel === "original") {
    userOrigLevel = v;
    rampOrigTo(getDuckTarget(), 0.05);
    return { ok: true };
  }
  if (channel === "dub") {
    userDubLevel = v;
    if (dubGain && audioContext) {
      const g = dubGain.gain;
      g.cancelScheduledValues(audioContext.currentTime);
      g.setValueAtTime(g.value, audioContext.currentTime);
      g.linearRampToValueAtTime(v, audioContext.currentTime + 0.05);
    }
    return { ok: true };
  }
  return { ok: false, error: `Bilinmeyen kanal: ${channel}` };
}

// --- Transkripsiyon modu (altyazısız video) -------------------------------

function pickRecorderMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return "audio/webm";
}

async function startTranscribe(streamId) {
  const cap = await startCapture(streamId);
  if (!cap.ok && !cap.alreadyRunning) return cap;
  transcribeOn = true;
  transcribeChunkIndex = 0;
  recordChunk();
  return { ok: true };
}

function recordChunk() {
  if (!transcribeOn || !stream) return;
  let mr;
  try {
    mr = new MediaRecorder(stream, { mimeType: pickRecorderMime() });
  } catch (err) {
    console.error("[OFF] MediaRecorder kurulamadı:", err);
    return;
  }
  mediaRecorder = mr;
  const blobs = [];
  mr.ondataavailable = (e) => {
    if (e.data && e.data.size) blobs.push(e.data);
  };
  mr.onstop = async () => {
    // Maliyet kontrolü: video duraklıysa kaydedilen sessizliği transkribe etme.
    if (blobs.length && !videoState.paused) {
      try {
        const blob = new Blob(blobs, { type: mr.mimeType });
        const buf = await blob.arrayBuffer();
        const b64 = uint8ToBase64(new Uint8Array(buf));
        chrome.runtime
          .sendMessage({
            target: "background",
            type: "audioChunk",
            index: transcribeChunkIndex++,
            audioBase64: b64,
            durSec: TRANSCRIBE_CHUNK_SEC,
            mimeType: mr.mimeType,
          })
          .catch(() => {});
      } catch (err) {
        console.error("[OFF] chunk gönderme hatası:", err);
      }
    }
    if (transcribeOn) recordChunk(); // bir sonraki parçayı kaydet
  };
  mr.start();
  setTimeout(() => {
    if (mr.state !== "inactive") {
      try {
        mr.stop();
      } catch {
        /* yut */
      }
    }
  }, TRANSCRIBE_CHUNK_SEC * 1000);
}

function stopTranscribe() {
  transcribeOn = false;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch {
      /* yut */
    }
  }
  mediaRecorder = null;
  return { ok: true };
}

function uint8ToBase64(u8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// --- Canlı mod (WebRTC) ---------------------------------------------------

async function startLive(streamId, clientSecret) {
  // Ortak capture altyapısını kur (originalGain, dubGain, keepalive).
  const cap = await startCapture(streamId);
  if (!cap.ok && !cap.alreadyRunning) return cap;
  return await connectLive(clientSecret);
}

async function connectLive(clientSecret) {
  if (!audioContext || !dubGain || !stream) {
    return { ok: false, error: "Capture aktif değil." };
  }

  const pc = new RTCPeerConnection();
  livePc = pc;

  // Kaynak (sekme) sesini gönder
  const track = stream.getAudioTracks()[0];
  if (!track) return { ok: false, error: "Sekme ses track'i yok." };
  pc.addTrack(track, stream);
  // Çevrilmiş sesi alabilmek için bir alıcı transceiver hazırla
  try {
    pc.addTransceiver("audio", { direction: "sendrecv" });
  } catch {
    /* bazı sürümlerde addTrack yeterli */
  }

  pc.ontrack = (e) => {
    const remoteStream = e.streams[0] || new MediaStream([e.track]);
    // Chrome'da remote track'i Web Audio'ya bağlamadan önce bir media element'e
    // bağlamak gerekir (yoksa ses akmaz). Sessize alıyoruz; gerçek çıkış dubGain'den.
    liveRemoteEl = new Audio();
    liveRemoteEl.srcObject = remoteStream;
    liveRemoteEl.muted = true;
    liveRemoteEl.play().catch(() => {});

    const srcNode = audioContext.createMediaStreamSource(remoteStream);
    liveAnalyser = audioContext.createAnalyser();
    liveAnalyser.fftSize = 512;
    srcNode.connect(liveAnalyser).connect(dubGain);
    startLiveDucking();
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "failed" || st === "disconnected") {
      // Yalnızca aktif pc için bildir (eski/kapanmış pc'leri yoksay)
      if (livePc === pc) {
        chrome.runtime
          .sendMessage({ target: "background", type: "liveConnectionFailed" })
          .catch(() => {});
      }
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch(
      "https://api.openai.com/v1/realtime/translations/calls",
      {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
      },
    );
    if (!sdpRes.ok) {
      return { ok: false, error: `SDP hatası (${sdpRes.status}): ${await sdpRes.text()}` };
    }
    const answer = await sdpRes.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (err) {
    return { ok: false, error: `WebRTC kurulum hatası: ${err.message}` };
  }
  return { ok: true };
}

// Canlı modda ducking: çevrilmiş sesin seviyesini izleyip orijinali kıs/aç.
function startLiveDucking() {
  stopLiveDucking();
  if (!liveAnalyser) return;
  const buf = new Uint8Array(liveAnalyser.fftSize);
  const THRESH = 0.02; // RMS eşiği (konuşma var/yok)
  const HOLD_MS = 400; // sessizlik bu kadar sürerse orijinali aç
  liveDuckTid = setInterval(() => {
    if (!liveAnalyser) return;
    liveAnalyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const nowMs = (audioContext?.currentTime || 0) * 1000;
    if (rms > THRESH) {
      liveSilenceSince = 0;
      if (!dubActive) {
        dubActive = true;
        rampOrigTo(getDuckTarget(), 0.1);
      }
    } else {
      if (!liveSilenceSince) liveSilenceSince = nowMs;
      else if (nowMs - liveSilenceSince > HOLD_MS && dubActive) {
        dubActive = false;
        rampOrigTo(getDuckTarget(), 0.25);
      }
    }
  }, 50);
}

function stopLiveDucking() {
  if (liveDuckTid) {
    clearInterval(liveDuckTid);
    liveDuckTid = null;
  }
  liveSilenceSince = 0;
}

function teardownLivePc() {
  stopLiveDucking();
  if (liveAnalyser) {
    try {
      liveAnalyser.disconnect();
    } catch {
      /* yut */
    }
    liveAnalyser = null;
  }
  if (liveRemoteEl) {
    try {
      liveRemoteEl.pause();
      liveRemoteEl.srcObject = null;
    } catch {
      /* yut */
    }
    liveRemoteEl = null;
  }
  if (livePc) {
    try {
      livePc.close();
    } catch {
      /* yut */
    }
    livePc = null;
  }
}

function stopLive() {
  teardownLivePc();
  dubActive = false;
  if (originalGain) rampOrigTo(userOrigLevel, 0.1);
  return { ok: true };
}

async function reconnectLive(clientSecret) {
  teardownLivePc();
  return await connectLive(clientSecret);
}

// --- base64 ↔ ArrayBuffer -------------------------------------------------

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i++) u8[i] = binary.charCodeAt(i);
  return u8.buffer;
}
