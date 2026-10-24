const RAG_SERVICE_URL = (process.env.RAG_SERVICE_URL || "http://127.0.0.1:8001").replace(/\/$/, "");

async function requestRag(path, body = {}) {
  const token = process.env.RAG_SERVICE_TOKEN;
  if (!token) throw new Error("RAG_SERVICE_TOKEN is missing");
  const endpoint = `${RAG_SERVICE_URL}${path}`;
  console.info(`[Reva RAG] Sending POST to ${endpoint}`);
  let response;
  try {
    response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.RAG_SERVICE_TIMEOUT_MS) || 30000)
    });
  } catch (error) {
    console.error(`[Reva RAG] Request to ${endpoint} failed: ${error.name}: ${error.message}`);
    throw new Error(`Could not reach the Python RAG service (${error.name}). Check RAG_SERVICE_URL and Render service status.`);
  }
  console.info(`[Reva RAG] ${path} returned HTTP ${response.status}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) {
    const error = new Error(payload.detail || payload.message || `RAG service returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
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
