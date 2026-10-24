const RAG_SERVICE_URL = (process.env.RAG_SERVICE_URL || "http://127.0.0.1:8001").replace(/\/$/, "");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Render Free services can need around a minute to wake from idle. Retry only
// transient gateway responses long enough for the Python service to start.
const GATEWAY_RETRY_DELAYS_MS = [1500, 2500, 4000, 6000, 8000, 8000, 8000, 8000];

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

  const requestOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  };

  for (let attempt = 0; attempt <= GATEWAY_RETRY_DELAYS_MS.length; attempt += 1) {
    let response;
    try {
      console.info(`[Reva RAG] Sending POST to ${endpoint} (attempt ${attempt + 1}/${GATEWAY_RETRY_DELAYS_MS.length + 1}, timeout ${timeoutMs}ms)`);
      response = await fetch(endpoint, {
        ...requestOptions,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      console.error(`[Reva RAG] Request to ${endpoint} failed: ${error.name}: ${error.message}`);
      throw new Error(
        `Could not reach the Python RAG service (${error.name}). Check RAG_SERVICE_URL and the RAG service logs.`
      );
    }

    console.info(`[Reva RAG] ${path} returned HTTP ${response.status}`);
    const rawBody = await response.text();
    let payload = {};
    try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch {}

    // Don't replay application errors such as the Python service's own
    // "RAG processing failed" response. Retry only transient gateway failures.
    const looksLikePlatformGatewayError =
      !payload || Object.keys(payload).length === 0 || (!payload.detail && !payload.message);
    const retryable = response.status === 503 || response.status === 504 ||
      (response.status === 502 && looksLikePlatformGatewayError);

    if (retryable && attempt < GATEWAY_RETRY_DELAYS_MS.length) {
      const waitMs = GATEWAY_RETRY_DELAYS_MS[attempt];
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

  throw new Error("Python RAG service remained unavailable after gateway retries.");
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
