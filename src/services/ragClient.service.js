const RAG_SERVICE_URL = (process.env.RAG_SERVICE_URL || "http://127.0.0.1:8001").replace(/\/$/, "");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  const requestOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      console.info(`[Reva RAG] Sending POST to ${endpoint} (attempt ${attempt + 1}/2, timeout ${timeoutMs}ms)`);
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

    // Retry only likely platform gateway failures, not JSON application errors
    // such as "RAG processing failed", which should be diagnosed rather than replayed.
    const looksLikePlatformGatewayError =
      !payload || Object.keys(payload).length === 0 || !payload.detail && !payload.message;
    const retryable = response.status === 503 || response.status === 504 ||
      (response.status === 502 && looksLikePlatformGatewayError);

    if (retryable && attempt === 0) {
      console.warn(`[Reva RAG] Transient gateway HTTP ${response.status}; retrying once after 1.2 seconds`);
      await delay(1200);
      continue;
    }

    if (!response.ok || payload.success !== true) {
      const error = new Error(payload.detail || payload.message || `RAG service returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  throw new Error("Python RAG service remained unavailable after a retry.");
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
