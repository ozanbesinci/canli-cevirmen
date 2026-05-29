// Sayfa (MAIN) world'de çalışan minik köprü.
// İzole world'de çalışan içerik scriptinin erişemediği
// window.ytInitialPlayerResponse'u okuyup mesajla geçirir.
//
// İzole content script ile sadece postMessage üzerinden konuşur; başka hiçbir
// etkisi yoktur. (Anahtar veya hassas veri buraya gelmez.)

(() => {
  const PAGE_TAG = "canli-cevirmen-page";
  const CONTENT_TAG = "canli-cevirmen-content";

  function post(type, payload) {
    window.postMessage({ source: PAGE_TAG, type, payload }, "*");
  }

  // Fetch hook: YouTube player'ın kendi timedtext isteklerini yakala.
  // ASR caption'larında POT zorunluluğu yüzünden bizim baseUrl fetch'imiz
  // boş döner. CC açıldığında YouTube doğru POT'lu istek yapar; cevabı
  // klonlayıp content script'e iletiyoruz.
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url =
      typeof args[0] === "string"
        ? args[0]
        : args[0] instanceof Request
          ? args[0].url
          : args[0]?.url || "";
    const res = await origFetch.apply(this, args);
    if (typeof url === "string" && url.includes("/api/timedtext")) {
      try {
        const body = await res.clone().text();
        post("capturedCaption", { url, body });
      } catch {
        /* yut */
      }
    }
    return res;
  };

  function readPlayerResponse() {
    // İlk yüklemede en güvenilir yer.
    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    // SPA navigasyonunda YouTube bu globali güncellemiyor; ytd-watch-flexy
    // elementinde güncel oyuncu verisi bulunur (YouTube internal alanı).
    const watch = document.querySelector("ytd-watch-flexy");
    return (
      watch?.__data?.playerData ??
      watch?.data?.playerData ??
      null
    );
  }

  function publish() {
    const pr = readPlayerResponse();
    post("playerResponse", pr || null);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(publish, 0));
  } else {
    setTimeout(publish, 0);
  }

  // SPA navigasyonu: yeni video açıldığında.
  window.addEventListener("yt-navigate-finish", () => {
    setTimeout(publish, 200);
  });

  // İzole content script açıkça isterse de gönder.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    if (ev.data?.source !== CONTENT_TAG) return;
    if (ev.data?.type === "requestPlayerResponse") publish();
  });
})();
