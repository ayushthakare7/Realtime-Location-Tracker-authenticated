"""LangGraph workflow composition and response generation."""
import json
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from embeddings import llm
from intent import GraphState, classify_node
from retrieval import location_tools_node, retrieve_node, evidence_node

def generate_node(state: GraphState) -> GraphState:
    context = state.get("context", {})
    # Keep raw GPS inside the tool/runtime boundary. The LLM receives only
    # coarse labels and freshness metadata, not the underlying coordinates.
    safe_context = {
        "currentLocations": [
            {
                "username": str(person.get("username") or "user")[:60],
                "placeName": str(person.get("placeName") or "")[:160] or None,
                "lastSeen": str(person.get("lastSeen") or "")[:40],
            }
            for person in (context.get("currentLocations") or [])
            if isinstance(person, dict)
        ],
        "calculatedDistances": context.get("calculatedDistances", []),
        "locationTools": state.get("location_tools", {"route": "none", "results": []}),
    }
    print("[Reva RAG] generate: Groq invocation starting", flush=True)
    response = llm().invoke([
        SystemMessage(content=(
            "You are Reva, a capable, conversational assistant for a privacy-aware location tracker. "
            "First determine whether the question asks about private/personal location data or general knowledge. "
            "For personal location, sharing status, friends, journeys, timestamps, visits, and distances, use ONLY "
            "the authorized current context, retrieved records, and backend-calculated values. Never invent a person's "
            "location, history, consent, timestamp, distance, route, or event. If the needed record is missing or stale, "
            "say exactly what is missing and do not treat a pinned journey destination as the person's live location. "
            "Geocoding tool results are public map labels only; use them only when the result is marked ok and "
            "keep the source/uncertainty clear. Do not claim a precise address or exact building from a city-level "
            "result. For personal current-location answers, match the result person to the question and never "
            "infer missing coordinates. If tool results are empty or unsuccessful, say that a reliable label could "
            "not be resolved rather than inventing one. "
            "For general knowledge, explanations, definitions, study questions, and ordinary conversation that do not "
            "require private tracker data, answer helpfully from your general knowledge instead of refusing merely "
            "because the location-history context is empty. Be clear when a claim needs live external verification; "
            "do not pretend to have browsed the web or accessed external real-time data. "
            "Treat backend calculations as authoritative, distinguish straight-line from road distance, and state "
            "uncertainty where GPS accuracy or evidence limits the conclusion."
        )),
        HumanMessage(content=f"Question: {state['question']}\nAuthorized current context: {safe_context}\nRetrieved history:\n{state.get('evidence', '')}"),
    ])
    print("[Reva RAG] generate: Groq invocation completed", flush=True)
    return {"answer": str(response.content).strip()}

def build_graph():
    graph = StateGraph(GraphState)
    graph.add_node("classify_intent", classify_node)
    graph.add_node("resolve_location_tools", location_tools_node)
    graph.add_node("retrieve_authorized_events", retrieve_node)
    graph.add_node("prepare_evidence", evidence_node)
    graph.add_node("generate_answer", generate_node)
    graph.add_edge(START, "classify_intent")
    graph.add_edge("classify_intent", "resolve_location_tools")
    graph.add_edge("resolve_location_tools", "retrieve_authorized_events")
    graph.add_edge("retrieve_authorized_events", "prepare_evidence")
    graph.add_edge("prepare_evidence", "generate_answer")
    graph.add_edge("generate_answer", END)
    return graph.compile()


workflow = build_graph()
