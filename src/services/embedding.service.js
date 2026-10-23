const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || 768;

async function embedText(text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing");

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      content: { parts: [{ text: String(text || "").slice(0, 8000) }] },
      outputDimensionality: EMBEDDING_DIMENSIONS
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || "Embedding API request failed");
    error.status = response.status;
    throw error;
  }

  const values = data.embedding?.values;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding API returned ${values?.length || 0} dimensions; expected ${EMBEDDING_DIMENSIONS}.`);
  }
  return values;
}

module.exports = { embedText, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
