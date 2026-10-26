const RAG_SERVICE_URL = (process.env.RAG_SERVICE_URL || "http://127.0.0.1:8001").replace(/\/$/, "");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Ask readiness is checked with GET /health first. Do not repeatedly POST /ask
// to a sleeping service: those attempts add load and can obscure the real failure.
const GATEWAY_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000, 12000, 15000, 20000, 20000, 20000, 20000, 20000, 20000];
const ASK_RETRY_WINDOW_MS = 4 * 60 * 1000 + 30 * 1000;
const OTHER_RETRY_WINDOW_MS = 60 * 1000;
const HEALTH_PROBE_TIMEOUT_MS = 10000;

async function waitForRagReady(deadline) {
  const healthUrl = `${RAG_SERVICE_URL}/health`;
  let attempt = 0;
  let lastIssue = "health endpoint has not responded";

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(Math.max(1000, Math.min(HEALTH_PROBE_TIMEOUT_MS, remainingMs)))
      });
      const rawBody = await response.text();
      let health = {};
      try { health = rawBody ? JSON.parse(rawBody) : {}; } catch {}

      if (response.ok && health.success === true && health.embeddingsReady !== false) {
        console.info("[Reva RAG] Health probe ready; submitting one /ask request");
        return;
      }

      lastIssue = response.ok
        ? (health.embeddingsReady === false ? "embedding model is still warming up" : "health response is not ready")
        : `health endpoint returned HTTP ${response.status}`;
    } catch (error) {
      lastIssue = `${error.name}: ${error.message}`;
    }

    const waitMs = GATEWAY_RETRY_DELAYS_MS[Math.min(attempt, GATEWAY_RETRY_DELAYS_MS.length - 1)];
    if (Date.now() + waitMs >= deadline) break;
    console.warn(`[Reva RAG] Readiness probe not ready (${lastIssue}); retrying health check in ${waitMs}ms`);
    attempt += 1;
    await delay(waitMs);
  }

  const error = new Error(`Python RAG did not become ready before timeout: ${lastIssue}`);
  error.code = "RAG_WAKE_TIMEOUT";
  throw error;
}

async function requestRag(path, body = {}) {
  const token = process.env.RAG_SERVICE_TOKEN;
  if (!token) throw new Error("RAG_SERVICE_TOKEN is missing");

  const endpoint = `${RAG_SERVICE_URL}${path}`;
  const isAsk = path === "/ask";
  const timeoutMs = Number(
    isAsk
      ? (process.env.RAG_ASK_TIMEOUT_MS || process.env.RAG_SERVICE_TIMEOUT_MS)
      : (process.env.RAG_INDEX_TIMEOUT_MS || process.env.RAG_SERVICE_TIMEOUT_MS)
  ) || (isAsk ? 90000 : 30000);
  const retryDeadline = Date.now() + (isAsk ? ASK_RETRY_WINDOW_MS : OTHER_RETRY_WINDOW_MS);

  // Wake the service using cheap GET requests, and only submit the expensive
  // semantic question after the Python service reports readiness.
  if (isAsk) await waitForRagReady(retryDeadline);

  const requestOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  };

  let lastTransportError = null;
  const maxAttempts = isAsk ? 1 : Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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
      if (isAsk) {
        const failed = new Error(`RAG was ready but /ask request failed: ${error.name}: ${error.message}`);
        failed.code = "RAG_ASK_TRANSPORT_ERROR";
        throw failed;
      }
      const waitMs = GATEWAY_RETRY_DELAYS_MS[Math.min(attempt, GATEWAY_RETRY_DELAYS_MS.length - 1)];
      if (Date.now() + waitMs >= retryDeadline) break;
      console.warn(`[Reva RAG] Connection/timeout error (${error.name}: ${error.message}); retrying in ${waitMs}ms`);
      await delay(waitMs);
      continue;
    }

    console.info(`[Reva RAG] ${path} returned HTTP ${response.status}`);
    const rawBody = await response.text();
    let payload = {};
    try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch {}

    const looksLikePlatformGatewayError =
      !payload || Object.keys(payload).length === 0 || (!payload.detail && !payload.message);
    const retryable = response.status === 502 || response.status === 503 || response.status === 504
      ? (response.status !== 502 || looksLikePlatformGatewayError)
      : false;

    if (retryable) {
      if (isAsk) {
        const failed = new Error(`RAG readiness passed, but /ask returned HTTP ${response.status}. Check Python RAG logs; the request was not repeated to avoid duplicate LLM calls.`);
        failed.status = response.status;
        failed.code = "RAG_ASK_UPSTREAM_ERROR";
        throw failed;
      }
      const waitMs = GATEWAY_RETRY_DELAYS_MS[Math.min(attempt, GATEWAY_RETRY_DELAYS_MS.length - 1)];
      if (Date.now() + waitMs >= retryDeadline) break;
      console.warn(`[Reva RAG] Transient gateway HTTP ${response.status}; retrying in ${waitMs}ms`);
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

  const exhausted = new Error("The Python RAG service is unavailable after the retry window.");
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
