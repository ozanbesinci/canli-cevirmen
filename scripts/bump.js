// manifest.json'daki sürümün son hanesini bir artırır.
// (Her Edit/Write sonrası PostToolUse hook'u tarafından otomatik çağrılır.)
// Chrome MV3 sürüm formatı: 1-4 nokta ayrılmış tamsayı. Biz 4 hane kullanıyoruz: major.minor.patch.build
// Kullanım: npm run bump   (veya: node scripts/bump.js)

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve("manifest.json");
const data = JSON.parse(await readFile(path, "utf8"));

const parts = String(data.version || "0.0.0.0").split(".").map((s) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
});
while (parts.length < 4) parts.push(0);

const oldVersion = data.version;
parts[3] = parts[3] + 1;
data.version = parts.join(".");

await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`Sürüm: ${oldVersion} → ${data.version}`);
console.log("Şimdi chrome://extensions sayfasında eklentiyi yenile.");
