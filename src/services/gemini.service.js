async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 450 } })
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error("Gemini API request failed");
    error.status = response.status;
    throw error;
  }
  return data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim() || "";
}
module.exports = { askGemini };
