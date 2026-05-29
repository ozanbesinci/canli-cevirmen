// Altyazı parçalarından kelime akışı + cümle→zaman aralığı eşlemesi.
// SW (eklenti) ve Node pipeline ortak kullanır; dış bağımlılığı yoktur.

function normalize(word) {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildWordStream(chunks) {
  const stream = [];
  for (const chunk of chunks) {
    const words = chunk.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const dur = chunk.end - chunk.start;
    const per = dur / words.length;
    words.forEach((w, i) => {
      stream.push({
        word: w,
        normalized: normalize(w),
        start: chunk.start + per * i,
        end: chunk.start + per * (i + 1),
      });
    });
  }
  return stream;
}

export function mapSentencesToTimes(sentences, wordStream) {
  let cursor = 0;
  const ranges = [];
  for (const sentence of sentences) {
    const sentWords = sentence
      .trim()
      .split(/\s+/)
      .map(normalize)
      .filter(Boolean);
    if (sentWords.length === 0) {
      ranges.push(null);
      continue;
    }
    // İlk kelimeyi yalnızca cursor'dan itibaren SINIRLI bir pencerede ara.
    // (cleanAndSegment kelimeleri değiştirdiğinde, sınırsız arama cümleyi
    //  videonun çok ilerisindeki rastgele bir eşleşmeye atlatabiliyordu.)
    let startIdx = -1;
    const searchLimit = Math.min(wordStream.length, cursor + 60);
    for (let i = cursor; i < searchLimit; i++) {
      if (wordStream[i].normalized === sentWords[0]) {
        startIdx = i;
        break;
      }
    }
    if (startIdx === -1) startIdx = Math.min(cursor, wordStream.length - 1);
    const expectedEnd = startIdx + sentWords.length - 1;
    const lastTarget = sentWords[sentWords.length - 1];
    const searchTo = Math.min(expectedEnd + 3, wordStream.length - 1);
    let endIdx = expectedEnd;
    for (let i = searchTo; i >= startIdx; i--) {
      if (wordStream[i].normalized === lastTarget) {
        endIdx = i;
        break;
      }
    }
    if (endIdx > wordStream.length - 1) endIdx = wordStream.length - 1;
    if (endIdx < startIdx) endIdx = startIdx;
    ranges.push({
      start: wordStream[startIdx].start,
      end: wordStream[endIdx].end,
    });
    cursor = endIdx + 1;
  }

  // Güvenlik geçişi: zaman damgaları monotonik artmalı ve makul olmalı.
  // Kelime eşleştirme bozulduğunda (cleanAndSegment kelimeleri değiştirince)
  // anormal büyük start değerleri oluşabiliyor; bunları düzeltiyoruz ki
  // read-ahead throttle kilitlenmesin ve dublaj akışı kesilmesin.
  const MAX_GAP = 15; // önceki cümlenin bitişinden sonra izin verilen en büyük boşluk (sn)
  let lastEnd = 0;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (!r) continue;
    const charLen = (sentences[i] || "").length;
    const estDur = Math.max(1, charLen / 14); // ~14 karakter/sn
    if (r.start < lastEnd) r.start = lastEnd; // geriye gidemez
    if (r.start > lastEnd + MAX_GAP) r.start = lastEnd; // anormal ileri sıçrama
    if (r.end <= r.start || r.end > r.start + 60) r.end = r.start + estDur;
    lastEnd = r.end;
  }
  return ranges;
}
