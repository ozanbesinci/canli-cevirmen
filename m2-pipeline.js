// M2 sürücü scripti.
// Çalıştırma: node m2-pipeline.js
// Gerekli ortam değişkeni: OPENAI_API_KEY
// Gerekli kurulum: npm install (music-metadata)

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runPipeline } from "./lib/pipeline.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("HATA: OPENAI_API_KEY ortam değişkeni tanımlı değil.");
  process.exit(1);
}

const VOICE = "onyx";
const INSTRUCTIONS =
  "Sakin, net ve açıklayıcı bir tonla, bir eğitmen gibi anlat.";
const VIDEO_CONTEXT =
  "Derin deniz keşfi ve otonom denizaltılar hakkında bilgilendirici bir video.";

function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function main() {
  const dataPath = resolve("data/sample-captions.json");
  const chunks = JSON.parse(await readFile(dataPath, "utf8"));
  console.log(`Yüklendi: ${chunks.length} altyazı parçası.\n`);

  const results = await runPipeline({
    chunks,
    videoContext: VIDEO_CONTEXT,
    voice: VOICE,
    instructions: INSTRUCTIONS,
    onProgress: ({ step, index, total, ratio, newSpeed, count }) => {
      if (step === "clean-segment") {
        console.log("Temizleme ve cümleleme (gpt-5.5)...");
      } else if (step === "segmented") {
        console.log(`  → ${count} cümle bulundu.\n`);
      } else if (step === "translate") {
        process.stdout.write(`[${index + 1}/${total}] çeviri... `);
      } else if (step === "tts") {
        process.stdout.write("seslendirme... ");
      } else if (step === "tts-retry") {
        process.stdout.write(
          `\n    ↻ TR/orig oranı ${ratio.toFixed(2)} > eşik. ` +
            `Hız ${newSpeed.toFixed(2)} ile yeniden seslendiriliyor... `,
        );
      }
    },
  });
  console.log("\n");

  // Tablo
  console.log("=== Özet tablo ===");
  console.table(
    results.map((r) => ({
      "#": r.index + 1,
      "Zaman (s)": `${r.start.toFixed(2)}–${r.end.toFixed(2)}`,
      "Orig (s)": r.origDur.toFixed(2),
      "TR (s)": r.ttsDur.toFixed(2),
      "Oran": r.finalRatio.toFixed(2),
      "Hız": r.speedUsed.toFixed(2),
      "Orijinal": trunc(r.originalText, 50),
      "Türkçe": trunc(r.turkishText, 50),
    })),
  );

  // Cümle cümle detay
  console.log("\n=== Cümle cümle detay ===");
  for (const r of results) {
    console.log(
      `\n[${r.index + 1}] ${r.start.toFixed(2)}–${r.end.toFixed(2)}s  ` +
        `(orig ${r.origDur.toFixed(2)}s, TR ${r.ttsDur.toFixed(2)}s, ` +
        `oran ${r.finalRatio.toFixed(2)}, hız ${r.speedUsed.toFixed(2)})`,
    );
    console.log(`  EN: ${r.originalText}`);
    console.log(`  TR: ${r.turkishText}`);
  }

  // mp3'leri birleştir
  const combined = Buffer.concat(results.map((r) => r.audio));
  const outPath = resolve("cikti.mp3");
  await writeFile(outPath, combined);
  console.log(
    `\nMP3 kaydedildi: ${outPath} (${combined.length} bayt, ` +
      `${results.length} cümle peş peşe)`,
  );
  console.log(
    "Not: bu mp3, cümleleri arka arkaya çalar — boşluklar yok. " +
      "Gerçek zaman damgasına yerleştirme M5'te ses katmanında yapılacak.",
  );
}

main().catch((err) => {
  console.error("Hata:", err.message);
  process.exitCode = 1;
});
