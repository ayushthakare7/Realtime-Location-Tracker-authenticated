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

For a distance question, identify the two endpoints. If the user asks how far a city/place is from a named friend, set origin="friend", originPerson to that person's username/name, destination to the place, destinationType="place". If the user asks how far a place is from themselves, set origin="me". If the user asks distance between two people, use origin="friend" and destinationType="person" for the second person. Preserve the person's name/username exactly as written when possible.

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

module.exports = { understandLocationQuestion };
