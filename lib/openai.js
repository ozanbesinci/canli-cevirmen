// OpenAI sarmalayıcıları: temizleme/segmentasyon + çeviri + TTS.
// Hem Node (m1/m2 scriptleri) hem Chrome eklentisi (SW) tarafında kullanılır.
// apiKey her çağrıya parametre olarak verilebilir; Node'da boşsa OPENAI_API_KEY env'ine düşülür.

const BASE = "https://api.openai.com/v1";

// Hata sınıflandırması: kind ∈ auth | rate | server | network | client
export class ApiError extends Error {
  constructor(message, { status, kind } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt, slow = false) {
  // üstel: 0.5s, 1s, 2s, 4s... + jitter; rate/server için biraz daha uzun
  const base = slow ? 1000 : 500;
  const ms = Math.min(base * 2 ** (attempt - 1), 12000);
  return ms + Math.floor(Math.random() * 250);
}

function parseRetryAfter(res) {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const sec = parseFloat(h);
  return Number.isFinite(sec) ? Math.min(sec * 1000, 20000) : null;
}

/**
 * fetch + üstel geri çekilmeli yeniden deneme + hata sınıflandırması.
 * - 401/403 → ApiError(auth), yeniden deneme YOK
 * - 429 / 5xx → yeniden dene (Retry-After'a saygı)
 * - ağ hatası → yeniden dene
 * - diğer 4xx → ApiError(client), yeniden deneme YOK
 */
async function fetchWithRetry(url, options, { retries = 4, label = "istek" } = {}) {
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      attempt++;
      if (attempt > retries) {
        throw new ApiError(`Ağ hatası (${label}): ${err.message}`, { kind: "network" });
      }
      await sleep(backoffMs(attempt, true));
      continue;
    }

    if (res.ok) return res;

    const status = res.status;
    if (status === 401 || status === 403) {
      throw new ApiError(`Yetki hatası (${status})`, { status, kind: "auth" });
    }
    if (status === 429 || status >= 500) {
      attempt++;
      if (attempt > retries) {
        throw new ApiError(
          `${status === 429 ? "Hız sınırı" : "Sunucu hatası"} (${status})`,
          { status, kind: status === 429 ? "rate" : "server" },
        );
      }
      const wait = parseRetryAfter(res) ?? backoffMs(attempt, true);
      await sleep(wait);
      continue;
    }
    // Diğer 4xx → kalıcı istemci hatası
    const txt = await res.text().catch(() => "");
    throw new ApiError(`İstek hatası (${status}): ${txt.slice(0, 150)}`, {
      status,
      kind: "client",
    });
  }
}

function resolveKey(apiKey) {
  if (apiKey) return apiKey;
  if (typeof process !== "undefined" && process.env?.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  throw new Error("apiKey verilmedi ve OPENAI_API_KEY env yok.");
}

// Anahtarda HTTP başlığına konamayacak karakter varsa (Türkçe harf, boşluk,
// satır sonu vb.) fetch hiç gönderilmeden patlar ve "ağ hatası" gibi görünür.
// Bunu önceden yakalayıp net bir "auth" hatası veriyoruz.
function assertHeaderSafe(key) {
  if (/[^\x21-\x7E]/.test(key)) {
    throw new ApiError(
      "API anahtarı geçersiz karakter içeriyor (boşluk/Türkçe harf olabilir).",
      { kind: "auth" },
    );
  }
}

function authHeaders(apiKey) {
  const key = resolveKey(apiKey);
  assertHeaderSafe(key);
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
}

async function chatText(model, messages, apiKey, opts = {}) {
  const { onUsage, ...bodyOpts } = opts;
  const yanit = await fetchWithRetry(
    `${BASE}/chat/completions`,
    {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ model, messages, ...bodyOpts }),
    },
    { label: "çeviri" },
  );
  const veri = await yanit.json();
  if (onUsage && veri.usage) onUsage(veri.usage);
  return veri.choices[0].message.content.trim();
}

/**
 * Bir ses parçasını metne çevirir (gpt-4o-transcribe). Düz metin döndürür.
 * @param {Uint8Array} bytes - ses verisi
 */
export async function transcribe({
  bytes,
  mimeType = "audio/webm",
  fileName = "audio.webm",
  model = "gpt-4o-transcribe",
  language,
  apiKey,
}) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), fileName);
  form.append("model", model);
  form.append("response_format", "json");
  if (language) form.append("language", language);

  const key = resolveKey(apiKey);
  assertHeaderSafe(key);
  const res = await fetchWithRetry(
    `${BASE}/audio/transcriptions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    },
    { label: "transkripsiyon" },
  );
  const data = await res.json();
  return data.text || "";
}

export async function cleanAndSegment(
  rawText,
  { model = "gpt-5.5", apiKey, onUsage } = {},
) {
  const text = await chatText(
    model,
    [
      {
        role: "system",
        content:
          "You receive raw auto-caption text from a video (no punctuation, mid-sentence breaks, all lowercase). " +
          "Your job: (1) add correct punctuation and capitalization, (2) fix obvious recognition errors, " +
          "(3) split into individual sentences. " +
          "DO NOT change the content, word order, or add/remove information. Keep every original word in order. " +
          'Return ONLY a JSON object in this exact form: { "sentences": ["...", "..."] } ' +
          "with no surrounding markdown fences or commentary.",
      },
      { role: "user", content: rawText },
    ],
    apiKey,
    { onUsage },
  );

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    if (!Array.isArray(obj.sentences))
      throw new Error("`sentences` alanı dizi değil.");
    return obj.sentences;
  } catch (err) {
    throw new Error(
      `Temizleme yanıtı JSON olarak ayrıştırılamadı: ${err.message}\nHam yanıt:\n${text}`,
    );
  }
}

export async function translate({
  sentence,
  contextPairs = [],
  videoContext = "",
  model = "gpt-5.5",
  apiKey,
  onUsage,
}) {
  const messages = [
    {
      role: "system",
      content:
        "Sen profesyonel bir çevirmensin. Verilen İngilizce cümleyi anlamı bozmadan akıcı ve doğal Türkçeye çevir. " +
        "Terimler ve özel isimler önceki cümlelerle tutarlı kalsın. " +
        "Sadece çeviriyi döndür; açıklama, tırnak, ön/son metin ekleme." +
        (videoContext ? `\nVideo bağlamı: ${videoContext}` : ""),
    },
    ...contextPairs.flatMap((p) => [
      { role: "user", content: p.en },
      { role: "assistant", content: p.tr },
    ]),
    { role: "user", content: sentence },
  ];
  return await chatText(model, messages, apiKey, { onUsage });
}

/**
 * Türkçe metni gpt-4o-mini-tts ile sentezler.
 * Dönüş: Uint8Array (mp3 verisi).
 */
export async function tts({
  text,
  voice,
  instructions,
  speed = 1.0,
  format = "mp3",
  model = "gpt-4o-mini-tts",
  apiKey,
}) {
  // instructions yalnızca gpt-4o-mini-tts'te desteklenir; tts-1/tts-1-hd'de gönderme.
  const supportsInstructions = model === "gpt-4o-mini-tts";
  const body = {
    model,
    voice,
    input: text,
    response_format: format,
    speed,
  };
  if (supportsInstructions && instructions) body.instructions = instructions;

  const yanit = await fetchWithRetry(
    `${BASE}/audio/speech`,
    {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
    },
    { label: "seslendirme" },
  );
  return new Uint8Array(await yanit.arrayBuffer());
}
