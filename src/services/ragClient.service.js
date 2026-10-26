const RAG_SERVICE_URL = (process.env.RAG_SERVICE_URL || "http://127.0.0.1:8001").replace(/\/$/, "");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Render Free services may take several minutes to wake. This runs in a background task,
// so the browser-facing request returns immediately instead of hitting a proxy timeout.
const GATEWAY_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000, 12000, 15000, 20000, 20000, 20000, 20000, 20000, 20000];
const ASK_RETRY_WINDOW_MS = 4 * 60 * 1000 + 30 * 1000;
const OTHER_RETRY_WINDOW_MS = 60 * 1000;

async function requestRag(path, body = {}) {
  const token = process.env.RAG_SERVICE_TOKEN;
  if (!token) throw new Error("RAG_SERVICE_TOKEN is missing");

  const endpoint = `${RAG_SERVICE_URL}${path}`;
  const isAsk = path === "/ask";
  const timeoutMs = Number(
    isAsk
      ? (process.env.RAG_ASK_TIMEOUT_MS || process.env.RAG_SERVICE_TIMEOUT_MS)
      : (process.env.RAG_INDEX_TIMEOUT_MS || process.env.RAG_SERVICE_TIMEOUT_MS)
  ) || (isAsk ? 45000 : 30000);
  const retryDeadline = Date.now() + (isAsk ? ASK_RETRY_WINDOW_MS : OTHER_RETRY_WINDOW_MS);

  const requestOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  };

  let lastTransportError = null;
  for (let attempt = 0; ; attempt += 1) {
    const remainingMs = retryDeadline - Date.now();
    if (remainingMs <= 0) break;

    let response;
    try {
      const attemptTimeoutMs = Math.max(1000, Math.min(timeoutMs, remainingMs));
      console.info(`[Reva RAG] Sending POST to ${endpoint} (attempt ${attempt + 1}, timeout ${attemptTimeoutMs}ms, ${Math.ceil(remainingMs / 1000)}s retry budget left)`);
      response = await fetch(endpoint, {
        ...requestOptions,
        signal: AbortSignal.timeout(attemptTimeoutMs)
      });
    } catch (error) {
      lastTransportError = error;
      const waitMs = GATEWAY_RETRY_DELAYS_MS[Math.min(attempt, GATEWAY_RETRY_DELAYS_MS.length - 1)];
      if (Date.now() + waitMs >= retryDeadline) break;
      console.warn(`[Reva RAG] Connection/timeout error (${error.name}: ${error.message}); retrying in ${waitMs}ms while the service wakes`);
      await delay(waitMs);
      continue;
    }

    console.info(`[Reva RAG] ${path} returned HTTP ${response.status}`);
    const rawBody = await response.text();
    let payload = {};
    try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch {}

    // Only retry transient gateway failures, not real Python application errors.
    const looksLikePlatformGatewayError =
      !payload || Object.keys(payload).length === 0 || (!payload.detail && !payload.message);
    const retryable = response.status === 502 || response.status === 503 || response.status === 504
      ? (response.status !== 502 || looksLikePlatformGatewayError)
      : false;

    if (retryable) {
      const waitMs = GATEWAY_RETRY_DELAYS_MS[Math.min(attempt, GATEWAY_RETRY_DELAYS_MS.length - 1)];
      if (Date.now() + waitMs >= retryDeadline) break;
      console.warn(`[Reva RAG] Transient gateway HTTP ${response.status}; retrying in ${waitMs}ms to allow the service to wake`);
      await delay(waitMs);
      continue;
    }

    if (!response.ok || payload.success !== true) {
      const error = new Error(payload.detail || payload.message || `RAG service returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  const exhausted = new Error("The Python RAG service is still waking up or unavailable after the retry window.");
  exhausted.cause = lastTransportError || undefined;
  exhausted.code = "RAG_WAKE_TIMEOUT";
  throw exhausted;
}

async function askRagService({ question, userIds, context }) {
  return requestRag("/ask", { question, authorizedUserIds: userIds.map(String), context });
}

async function indexLocationEvent(eventId) {
  return requestRag("/index-event", { eventId: String(eventId) });
}

async function reindexLocationEvents() {
  return requestRag("/reindex");
}

module.exports = { askRagService, indexLocationEvent, reindexLocationEvents };
