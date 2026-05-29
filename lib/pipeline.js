// M2 pipeline: cümle yeniden birleştirme, zaman eşleme, bağlam penceresi,
// süre eşitleme, tampon.

import { parseBuffer } from "music-metadata";
import { cleanAndSegment, translate, tts } from "./openai.js";
import { buildWordStream, mapSentencesToTimes } from "./captions.js";

export { buildWordStream, mapSentencesToTimes };

async function measureMp3Duration(buffer) {
  const meta = await parseBuffer(buffer, { mimeType: "audio/mpeg" });
  return meta.format.duration ?? 0;
}

/**
 * Ana pipeline. Her cümle için: çevir, seslendir, süreyi karşılaştır, gerekirse
 * konuşma hızını ayarla. Sıralı tampon (results) döner.
 */
export async function runPipeline({
  chunks,
  videoContext = "",
  voice,
  instructions,
  contextWindowSize = 4,
  // Süre eşitleme eşikleri
  ratioThreshold = 1.10, // Türkçe ses orijinalin %10'undan fazla uzunsa hızlandır
  maxSpeed = 1.5,
  onProgress = () => {},
}) {
  const wordStream = buildWordStream(chunks);
  const rawText = chunks.map((c) => c.text).join(" ");

  onProgress({ step: "clean-segment" });
  const sentences = await cleanAndSegment(rawText);
  onProgress({ step: "segmented", count: sentences.length });

  const ranges = mapSentencesToTimes(sentences, wordStream);

  const results = [];
  const contextPairs = [];

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const range = ranges[i];
    if (!range) continue;
    const origDur = range.end - range.start;

    onProgress({ step: "translate", index: i, total: sentences.length });
    const tr = await translate({
      sentence,
      contextPairs: contextPairs.slice(-contextWindowSize),
      videoContext,
    });

    onProgress({ step: "tts", index: i, total: sentences.length, speed: 1.0 });
    let audio = await tts({ text: tr, voice, instructions, speed: 1.0 });
    let ttsDur = await measureMp3Duration(audio);
    let speedUsed = 1.0;
    let ratio = origDur > 0 ? ttsDur / origDur : 1.0;

    if (ratio > ratioThreshold) {
      // Hafif overshoot ile hedef süreyi yakalamaya çalış.
      const newSpeed = Math.min(maxSpeed, Math.max(1.05, ratio * 1.02));
      onProgress({ step: "tts-retry", index: i, ratio, newSpeed });
      audio = await tts({ text: tr, voice, instructions, speed: newSpeed });
      ttsDur = await measureMp3Duration(audio);
      speedUsed = newSpeed;
      ratio = origDur > 0 ? ttsDur / origDur : 1.0;
    }

    results.push({
      index: i,
      originalText: sentence,
      turkishText: tr,
      start: range.start,
      end: range.end,
      origDur,
      ttsDur,
      speedUsed,
      finalRatio: ratio,
      audio,
    });

    contextPairs.push({ en: sentence, tr });
  }

  // Sıralı tampon: zaman damgasına göre. (Halihazırda sırada ama emin olalım.)
  results.sort((a, b) => a.start - b.start);
  return results;
}
