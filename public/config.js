window.LIVE_BOT_MAP = {
  feedUrl: "https://vmr0p1is2hn3gcku.public.blob.vercel-storage.com/status.json"
};

// On the Workers trial, use the same-origin feed so cache headers stay short.
// The Vercel site keeps using the public Blob URL above.
(function () {
  var host = (typeof location !== "undefined" && location.hostname) || "";
  if (host && !/\.vercel\.app$/.test(host) && location.protocol !== "file:") {
    window.LIVE_BOT_MAP.feedUrl = new URL("/status.json", location.origin).toString();
  }
})();
