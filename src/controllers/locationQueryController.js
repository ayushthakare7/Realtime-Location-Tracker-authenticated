const { askMap } = require("./mapAssistantController");
const { answerDistanceQuestion, answerPlaceComparison, answerNearestPerson, fallbackParseDistanceQuestion } = require("../services/locationQueryExecution.service");
const { understandLocationQuestion } = require("../services/gemini.service");

exports.ask = async (req, res) => {
  const question = String(req.body.question || "").trim();
  if (!question || question.length > 500) {
    return res.status(400).json({ success: false, message: "Question must be 1-500 characters." });
  }
  if (req.body.aiConsent !== true) {
    return res.status(400).json({ success: false, message: "Consent is required before sending location records to the assistant." });
  }

  // The semantic planner is the primary router for every question. It interprets
  // intent and entities; only this controller executes trusted tools or invokes RAG.
  let parsed = null;
  try {
    parsed = await understandLocationQuestion(question);
  } catch (error) {
    console.error("Semantic query planning failed:", error.message);
  }

  // Keep a deterministic fallback for distance questions if the LLM is unavailable.
  if (!parsed) {
    try {
      parsed = await fallbackParseDistanceQuestion(req, question);
    } catch (error) {
      console.error("Fallback location-question planning failed:", error.message);
    }
  }

  if (parsed?.intent === "compare_places") {
    try {
      const answer = await answerPlaceComparison(req, parsed);
      return res.json({ success: true, answer });
    } catch (error) {
      console.error("Place comparison failed:", error.message);
      return res.status(502).json({ success: false, message: "I understood the comparison, but couldn't calculate it right now. Please try again." });
    }
  }

  if (parsed?.intent === "nearest_person") {
    try {
      const answer = await answerNearestPerson(req, parsed);
      return res.json({ success: true, answer });
    } catch (error) {
      console.error("Nearest-person query failed:", error.message);
      return res.status(502).json({ success: false, message: "I understood the comparison, but couldn't calculate it right now. Please try again." });
    }
  }

  if (parsed?.intent === "distance") {
    try {
      const answer = await answerDistanceQuestion(req, parsed);
      if (answer) return res.json({ success: true, answer });
    } catch (error) {
      console.error("Distance execution failed:", error.message);
      return res.status(502).json({ success: false, message: "I understood this as a distance question, but couldn't calculate it right now. Please try again." });
    }
  }

  // History, events, and ordinary conversational questions are delegated to Python RAG.
  return askMap(req, res);
};
