// REVA LLM generation now uses Groq's OpenAI-compatible API.
// Gemini remains in use for embeddings in embedding.service.js.
async function askGemini(prompt) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is missing");

  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are Reva, a privacy-aware location-history assistant. Answer only from the authorized context supplied by the application. Never invent locations, times, events, distances, routes, or people. If the supplied evidence is insufficient, say so clearly."
        },
        { role: "user", content: String(prompt || "") }
      ],
      temperature: 0.2,
      max_tokens: 450
    }),
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || "Groq API request failed");
    error.status = response.status;
    throw error;
  }

  return data.choices?.[0]?.message?.content?.trim() || "";
}

module.exports = { askGemini };
