// lib/clients/http.js — opinionated fetch wrapper used by all external API calls.
//
// Rules:
//   - Always sets a timeout (default 15s). External API hangs would otherwise
//     burn the worker's wall-clock budget.
//   - Retries 5xx + 429 with exponential backoff (max 3 attempts).
//   - Never throws on non-2xx; returns { ok, status, data, text, retryable }.
//   - The CALLER decides what's retryable from a domain perspective; this just
//     marks transport-level failures.

export async function httpRequest(url, {
  method = "GET",
  headers = {},
  body,
  timeoutMs = 15000,
  retries = 3,
} = {}) {
  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          "accept": "application/json",
          ...headers,
        },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* leave data null */ }

      // Retry on 5xx and 429
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }

      return {
        ok: res.ok,
        status: res.status,
        data,
        text,
        retryable: !res.ok && (res.status >= 500 || res.status === 429),
      };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      // AbortError or network error → retry
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }

  return {
    ok: false,
    status: 0,
    data: null,
    text: lastErr?.message || "network error",
    retryable: true,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function backoffMs(attempt) { return Math.min(2000, 200 * Math.pow(2, attempt - 1)); }
