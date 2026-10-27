"""Validated intent extraction and LangGraph state types."""
import json
from typing import Any, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage

from embeddings import llm

class GraphState(TypedDict, total=False):
    question: str
    authorized_user_ids: list[str]
    context: dict[str, Any]
    intent: str
    events: list[dict[str, Any]]
    evidence: str
    answer: str
    location_tools: dict[str, Any]

def extract_question_intent(question: str) -> dict[str, Any]:
    """Use the configured LLM to map natural language to a small, validated query plan."""
    prompt = (
        "Extract the user's intent from a question to a personal location-history assistant. "
        "Return ONLY one JSON object with keys intent, subject, date_text, time_text, start_time_text, "
        "end_time_text, place, second_place, comparison, and needs_history. "
        "Allowed intent values: location_at_time, closest_people, visit_duration, movement_between_places, "
        "location_timeline, history_summary, current_presence, other. "
        "subject is self, a friend name if explicitly named, or unknown. "
        "Use short natural-language values copied/normalized from the question; do not invent missing dates or times. "
        "For 'last night around one' use date_text='last night', time_text='1 AM'. "
        "For 'when was my friend closest to me today' use intent='closest_people', date_text='today', "
        "subject='friend' unless a name is given, comparison='minimum_distance'. "
        "For 'When was Siddhanth closest to me?' or any closest/nearest question with no date, use "
        "intent='closest_people', preserve the named friend in subject, leave date_text empty, and set "
        "comparison='minimum_distance'; no date means search ALL available recorded history, not today. "
        "Only set date_text when the user explicitly specifies a period. "
        "For 'where was I at 1am' use intent='location_at_time', subject='self', time_text='1 AM'. "
        "needs_history must be true for questions that require saved location records. "
        "Do not answer the question; only extract its meaning.\nQuestion: " + question
    )
    try:
        response = llm().invoke([
            SystemMessage(content="You are a strict intent and slot extractor. Output valid JSON only."),
            HumanMessage(content=prompt),
        ])
        raw = str(response.content).strip()
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(raw)
        allowed = {"location_at_time", "closest_people", "visit_duration", "movement_between_places",
                   "location_timeline", "history_summary", "current_presence", "other"}
        if not isinstance(parsed, dict) or parsed.get("intent") not in allowed:
            return {"intent": "fallback"}
        keys = ("subject", "date_text", "time_text", "start_time_text", "end_time_text",
                "place", "second_place", "comparison")
        result = {"intent": parsed["intent"], "needs_history": bool(parsed.get("needs_history", True))}
        for key in keys:
            value = parsed.get(key)
            result[key] = value.strip()[:100] if isinstance(value, str) else ""
        return result
    except Exception as exc:
        print(f"[Reva RAG] intent extraction unavailable ({type(exc).__name__}); using fallback intent rules", flush=True)
        # Do not lock the workflow into "other" when the LLM emits malformed JSON.
        # classify_node will apply deterministic fallback rules to the original question.
        return {"intent": "fallback"}

def classify_node(state: GraphState) -> GraphState:
    # Prefer the validated LLM-extracted intent, then fall back to keyword rules.
    extracted_intent = state.get("intent")
    allowed_intents = {
        "location_at_time", "closest_people", "visit_duration", "movement_between_places",
        "location_timeline", "history_summary", "current_presence", "other"
    }
    if extracted_intent in allowed_intents:
        return {"intent": extracted_intent}
    question = state["question"].lower()
    if any(term in question for term in ("where was i", "what place was i", "where was my friend")) and any(term in question for term in ("am", "pm", " o'clock")):
        return {"intent": "location_at_time"}
    if (any(term in question for term in ("closest", "nearest", "closer"))
            and any(term in question for term in ("when", "was", "were", "am i", "are we", "to me", "with me"))):
        return {"intent": "closest_people"}
    # Also recognize common concise variants even when they omit "when".
    if any(term in question for term in ("closest to me", "nearest to me", "closest together", "nearest together")):
        return {"intent": "closest_people"}
    if any(term in question for term in ("summarize", "summary", "most visited", "usual", "frequently")):
        return {"intent": "history_summary"}
    if any(term in question for term in ("right now", "currently", "current location", "where is")):
        return {"intent": "current_presence"}
    if any(term in question for term in ("yesterday", "today", "last week", "this week", "visited", "visit", "where did", "how long", "when did", "history", "spent")):
        return {"intent": "history_summary"}
    return {"intent": "other"}

