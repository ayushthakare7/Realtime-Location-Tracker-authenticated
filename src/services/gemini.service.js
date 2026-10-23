// REVA LLM generation and natural-language query understanding use Groq's OpenAI-compatible API.
async function groqChat(messages, { temperature = 0.2, max_tokens = 450 } = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is missing");

  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens }),
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

async function askGemini(prompt) {
  return groqChat([
    {
      role: "system",
      content: "You are Reva, a privacy-aware location-history assistant. Answer only from the authorized context supplied by the application. Never invent locations, times, events, distances, routes, or people. If the supplied evidence is insufficient, say so clearly."
    },
    { role: "user", content: String(prompt || "") }
  ]);
}

async function understandLocationQuestion(question) {
  const raw = await groqChat([
    {
      role: "system",
      content: `You are Reva's location-query parser. Your job is ONLY to identify what a user is asking so the application can perform deterministic location calculations with authorized database coordinates. Do not answer the question and do not calculate anything.

Return ONLY valid JSON with exactly these keys:
{
  "intent": "distance" | "current_location" | "history" | "other",
  "origin": "me" | "friend" | "unknown",
  "originPerson": string | null,
  "destination": string | null,
  "destinationType": "place" | "person" | "unknown"
}

Interpret the meaning of the whole question, not a fixed list of phrases. Equivalent wording and endpoint order must map to the same intent. For any distance/separation/travel-time question, identify both endpoints and classify each as the current user, another person, or a geographic place. If one endpoint is a city/place and the other is a named friend, set origin="friend", originPerson to that person's username/name, destination to the place, destinationType="place". If one endpoint is the current user, set origin="me" and put the other endpoint in destination. If both endpoints are people, set origin="friend", originPerson to the first person and destination to the second person, destinationType="person". Distance is symmetric, so endpoint order may be preserved from the question. Preserve person names/usernames and place names exactly as written when possible. Do not answer or invent coordinates. If the intent or endpoint type is genuinely ambiguous, return intent="other" rather than guessing.

Examples:
"how far is Raipur from my friend Siddhant" -> {"intent":"distance","origin":"friend","originPerson":"Siddhant","destination":"Raipur","destinationType":"place"}
"what is the distance from user2 to Nagpur" -> {"intent":"distance","origin":"friend","originPerson":"user2","destination":"Nagpur","destinationType":"place"}
"how much distance is Nagpur from user2" -> {"intent":"distance","origin":"friend","originPerson":"user2","destination":"Nagpur","destinationType":"place"}
"how far am I from Mumbai" -> {"intent":"distance","origin":"me","originPerson":null,"destination":"Mumbai","destinationType":"place"}
"how far is Siddhant from me" -> {"intent":"distance","origin":"me","originPerson":null,"destination":"Siddhant","destinationType":"person"}
"where was I yesterday" -> {"intent":"history","origin":"unknown","originPerson":null,"destination":null,"destinationType":"unknown"}`
    },
    { role: "user", content: String(question || "") }
  ], { temperature: 0, max_tokens: 180 });

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(cleaned);
  return parsed;
}

module.exports = { askGemini, understandLocationQuestion };
