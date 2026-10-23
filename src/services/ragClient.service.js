const RAG_SERVICE_URL = (process.env.RAG_SERVICE_URL || "http://127.0.0.1:8001").replace(/\/$/, "");

async function askRagService({ question, userIds, context }) {
  const token = process.env.RAG_SERVICE_TOKEN;
  if (!token) throw new Error("RAG_SERVICE_TOKEN is missing");
  const response = await fetch(`${RAG_SERVICE_URL}/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ question, authorizedUserIds: userIds.map(String), context }),
    signal: AbortSignal.timeout(Number(process.env.RAG_SERVICE_TIMEOUT_MS) || 30000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) {
    const error = new Error(payload.detail || payload.message || `RAG service returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

module.exports = { askRagService };
