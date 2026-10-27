// Runs in the PAGE's JS world on claude.ai (see "world": "MAIN" in manifest.json).
// Watches Claude's own completion requests so limits are caught even when the UI wording changes.
(() => {
  if (window.__cgHookInstalled) return;
  window.__cgHookInstalled = true;

  const COMPLETION_URL = /\/(?:completion|retry_completion)(?:\?|$)/;
  // Matched against raw SSE JSON. Quotes inside streamed text are escaped (\"), so Claude's
  // prose about "rate_limit_error" will not match these patterns.
  const STREAM_LIMIT = /"type":\s*"exceeded_limit"|"error":\s*\{[^}]*"type":\s*"rate_limit_error"/;

  const notify = (reason) =>
    window.postMessage({ source: "cg-handoff", type: "RATE_LIMIT", reason }, window.location.origin);

  async function watchStream(clone) {
    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    let tail = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const chunk = tail + decoder.decode(value, { stream: true });
        if (STREAM_LIMIT.test(chunk)) {
          notify("stream-limit");
          reader.cancel().catch(() => {});
          return;
        }
        tail = chunk.slice(-80);
      }
    } catch (_) { /* stream aborted by the page; ignore */ }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const first = args[0];
      const url = typeof first === "string" ? first : (first && first.url) || String(first || "");
      if (COMPLETION_URL.test(url)) {
        if (res.status === 429) {
          notify("http-429");
        } else if (res.ok && res.body && /event-stream/i.test(res.headers.get("content-type") || "")) {
          watchStream(res.clone());
        }
      }
    } catch (_) { /* never break the page's fetch */ }
    return res;
  };
})();
