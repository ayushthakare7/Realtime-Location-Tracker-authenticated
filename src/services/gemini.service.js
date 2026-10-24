// REVA LLM generation and natural-language query understanding use Groq's OpenAI-compatible API.
async function groqChat(messages, { temperature = 0.2, max_tokens = 450, response_format } = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is missing");

  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens, ...(response_format ? { response_format } : {}) }),
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


function normalizeLocationPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Location planner returned an invalid object");
  const allowedIntents = new Set(["distance", "compare_places", "nearest_person", "history", "other"]);
  if (!allowedIntents.has(plan.intent)) throw new Error("Location planner returned an unsupported intent");
  const textOrNull = value => typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null;
  const allowedTypes = new Set(["person", "place", "unknown", "me", "friend"]);
  const origin = allowedTypes.has(plan.origin) ? plan.origin : "unknown";
  const destinationType = allowedTypes.has(plan.destinationType) ? plan.destinationType : "unknown";
  const targetType = allowedTypes.has(plan.targetType) ? plan.targetType : "unknown";
  const places = Array.isArray(plan.places) ? plan.places.slice(0, 2).map(textOrNull).filter(Boolean) : [];
  const normalized = { intent: plan.intent, origin, originPerson: textOrNull(plan.originPerson), originPlace: textOrNull(plan.originPlace), destination: textOrNull(plan.destination), destinationType, targetType, target: textOrNull(plan.target), places, relation: plan.relation === "farthest" ? "farthest" : "closest" };
  if (normalized.intent === "distance") {
    if (normalized.origin === "friend" && normalized.originPerson) normalized.originType = "person";
    else if (normalized.origin === "me") normalized.originType = "person";
    else if (normalized.origin === "place" && normalized.originPlace) normalized.originType = "place";
    else throw new Error("Location planner could not identify the distance origin");
    if (!normalized.destination || !["person", "place"].includes(normalized.destinationType)) throw new Error("Location planner could not identify the distance destination");
  } else if (normalized.intent === "compare_places") {
    if (normalized.places.length !== 2 || !normalized.target || !["me", "person", "place"].includes(normalized.targetType)) throw new Error("Location planner could not identify the comparison endpoints");
  } else if (normalized.intent === "nearest_person") {
    if (!normalized.target || !["me", "person", "place"].includes(normalized.targetType)) throw new Error("Location planner could not identify the comparison target");
  }
  return normalized;
}

async function understandLocationQuestion(question) {
  const raw = await groqChat([
    { role: "system", content: "You are Reva's semantic query planner. Interpret meaning, not exact keywords or sentence templates. Do not answer, calculate distances, invent coordinates, or access private data. Return ONLY JSON with keys:\n{\"intent\":\"distance|compare_places|nearest_person|history|other\",\"origin\":\"me|friend|place|unknown\",\"originPerson\":string|null,\"originPlace\":string|null,\"destination\":string|null,\"destinationType\":\"place|person|unknown\",\"targetType\":\"me|person|place|unknown\",\"target\":string|null,\"places\":string[],\"relation\":\"closest|farthest\"|null}\nInterpret unusual, ungrammatical, or repeated phrasing semantically:\n- \"Nagpur is away, how many kilometers Nagpur is away from me\" => distance from me to place Nagpur.\n- \"What is the distance between me and Nagpur?\" => distance from me to place Nagpur.\n- \"How far would I need to drive to reach Nagpur?\" => distance from me to place Nagpur.\n- \"How far is Raipur from my friend Siddhant?\" => distance from friend Siddhant to place Raipur.\n- \"How far is Siddhant from me?\" => distance from me to person Siddhant.\n- \"Distance between Nagpur and Raipur\" => distance between places; origin=\"place\", originPlace=\"Nagpur\", destination=\"Raipur\", destinationType=\"place\".\n- \"Which is closer to me, Nagpur or Raipur?\" => compare_places, targetType=\"me\", target=\"me\", places=[\"Nagpur\",\"Raipur\"].\n- \"Which friend is farthest from Nagpur?\" => nearest_person, relation=\"farthest\", targetType=\"place\", target=\"Nagpur\".\n- Past location/event questions => history. Unrelated questions => other.\nFor distance, identify origin and destination. A friend origin requires originPerson; a place origin requires originPlace. destinationType distinguishes person from geocodable place. compare_places requires exactly two places and a target. nearest_person requires target and relation. Never assume a named person is authorized; the application enforces permissions." },
    { role: "user", content: String(question || "").slice(0, 500) }
  ], { temperature: 0, max_tokens: 300, response_format: { type: "json_object" } });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return normalizeLocationPlan(JSON.parse(cleaned));
}

module.exports = { understandLocationQuestion, groqChat, normalizeLocationPlan };
