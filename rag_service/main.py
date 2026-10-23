import os
import hmac
from datetime import datetime, timedelta
from typing import Any, TypedDict

from bson import ObjectId
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from pymongo import MongoClient
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_groq import ChatGroq
from langgraph.graph import END, START, StateGraph

load_dotenv()

TOKEN = os.getenv("RAG_SERVICE_TOKEN", "")
MONGO_URI = os.getenv("MONGO_URI", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
VECTOR_INDEX = os.getenv("RAG_VECTOR_INDEX", "location_event_vector_index")
TOP_K = int(os.getenv("RAG_TOP_K", "10"))
DB_NAME = os.getenv("MONGO_DB_NAME", "location_tracker")
if MONGO_URI and not os.getenv("MONGO_DB_NAME"):
    try:
        from urllib.parse import urlparse
        DB_NAME = urlparse(MONGO_URI).path.lstrip("/").split("/")[0] or DB_NAME
    except Exception:
        pass

app = FastAPI(title="Reva Python RAG Microservice", version="1.0.0")
mongo = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000) if MONGO_URI else None
_embeddings = None
_llm = None

class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    authorizedUserIds: list[str] = Field(min_length=1, max_length=100)
    context: dict[str, Any] = Field(default_factory=dict)

class IndexRequest(BaseModel):
    eventId: str

class GraphState(TypedDict, total=False):
    question: str
    authorized_user_ids: list[str]
    context: dict[str, Any]
    intent: str
    events: list[dict[str, Any]]
    evidence: str
    answer: str

def collection():
    if mongo is None:
        raise RuntimeError("MONGO_URI is missing")
    return mongo[DB_NAME]["locationevents"]

def embeddings():
    global _embeddings
    if _embeddings is None:
        _embeddings = HuggingFaceEmbeddings(
            model_name=EMBEDDING_MODEL,
            model_kwargs={"device": "cpu"},
            encode_kwargs={"normalize_embeddings": True},
        )
    return _embeddings

def llm():
    global _llm
    if _llm is None:
        if not GROQ_API_KEY:
            raise RuntimeError("GROQ_API_KEY is missing")
        _llm = ChatGroq(model=GROQ_MODEL, groq_api_key=GROQ_API_KEY, temperature=0)
    return _llm

def event_text(event: dict[str, Any]) -> str:
    return (
        f"Person: {event.get('username', 'unknown')}. Event: {event.get('eventType', 'unknown')}. "
        f"Place: {event.get('placeName', 'unknown')}. Summary: {event.get('summary', '')}. "
        f"Started: {event.get('startAt', '')}. Ended: {event.get('endAt', '')}. "
        f"Duration minutes: {event.get('durationMinutes', 0)}."
    )

def ensure_vector_index() -> str:
    coll = collection()
    try:
        indexes = coll.database.command({"listSearchIndexes": coll.name}).get("cursor", {}).get("firstBatch", [])
    except Exception:
        indexes = []
    existing = next((item for item in indexes if item.get("name") == VECTOR_INDEX), None)
    if existing:
        return "existing"
    coll.database.command({
        "createSearchIndexes": coll.name,
        "indexes": [{
            "name": VECTOR_INDEX,
            "type": "vectorSearch",
            "definition": {
                "fields": [
                    {"type": "vector", "path": "embedding", "numDimensions": 384, "similarity": "cosine"},
                    {"type": "filter", "path": "userId"},
                    {"type": "filter", "path": "recordedAt"}
                ]
            }
        }]
    })
    return "created"

def index_event(event_id: str) -> bool:
    if not ObjectId.is_valid(event_id):
        raise ValueError("Invalid eventId")
    event = collection().find_one({"_id": ObjectId(event_id)})
    if not event:
        return False
    vector = embeddings().embed_query(event_text(event))
    collection().update_one(
        {"_id": event["_id"]},
        {"$set": {"embedding": vector, "embeddingModel": EMBEDDING_MODEL, "embeddingUpdatedAt": datetime.utcnow()}},
    )
    return True

def classify_node(state: GraphState) -> GraphState:
    response = llm().invoke([
        SystemMessage(content=(
            "Classify the location question. Return one word only: history, summary, shared_presence, or other. "
            "Do not answer the question. History means questions about past visits, places, duration, or movement."
        )),
        HumanMessage(content=state["question"]),
    ])
    intent = str(response.content).strip().lower().split()[0].strip(".,:;") if response.content else "other"
    if intent not in {"history", "summary", "shared_presence", "other"}:
        intent = "other"
    return {"intent": intent}

def retrieve_node(state: GraphState) -> GraphState:
    ids = [ObjectId(value) for value in state["authorized_user_ids"] if ObjectId.is_valid(value)]
    if not ids:
        return {"events": []}
    query_vector = embeddings().embed_query(state["question"])
    vector_filter: dict[str, Any] = {"userId": {"$in": ids}}
    q = state["question"].lower()
    now = datetime.utcnow()
    if "yesterday" in q:
        end = datetime(now.year, now.month, now.day)
        vector_filter["recordedAt"] = {"$gte": end - timedelta(days=1), "$lt": end}
    elif "today" in q or "tonight" in q:
        start = datetime(now.year, now.month, now.day)
        vector_filter["recordedAt"] = {"$gte": start, "$lte": now}
    elif "this week" in q:
        start = datetime(now.year, now.month, now.day) - timedelta(days=now.weekday())
        vector_filter["recordedAt"] = {"$gte": start, "$lte": now}
    pipeline = [
        {"$vectorSearch": {"index": VECTOR_INDEX, "path": "embedding", "queryVector": query_vector,
                           "numCandidates": max(100, TOP_K * 20), "limit": TOP_K, "filter": vector_filter}},
        {"$project": {"userId": 1, "username": 1, "eventType": 1, "placeName": 1, "summary": 1,
                      "startAt": 1, "endAt": 1, "durationMinutes": 1, "recordedAt": 1,
                      "score": {"$meta": "vectorSearchScore"}}},
    ]
    events = list(collection().aggregate(pipeline))
    for event in events:
        event["_id"] = str(event.get("_id", ""))
        event["userId"] = str(event.get("userId", ""))
        for key in ("startAt", "endAt", "recordedAt"):
            if event.get(key):
                event[key] = event[key].isoformat()
    return {"events": events}

def evidence_node(state: GraphState) -> GraphState:
    events = state.get("events", [])
    if not events:
        return {"evidence": "No matching historical location events were retrieved."}
    lines = []
    for e in events:
        lines.append(
            f"Person={e.get('username')}; event={e.get('eventType')}; place={e.get('placeName')}; "
            f"start={e.get('startAt')}; end={e.get('endAt')}; duration_minutes={e.get('durationMinutes')}; "
            f"summary={e.get('summary')}; relevance={e.get('score')}"
        )
    return {"evidence": "\n".join(lines)}

def generate_node(state: GraphState) -> GraphState:
    context = state.get("context", {})
    safe_context = {
        "currentLocations": context.get("currentLocations", []),
        "calculatedDistances": context.get("calculatedDistances", []),
    }
    response = llm().invoke([
        SystemMessage(content=(
            "You are Reva, a privacy-aware location assistant. Answer only from the authorized current context "
            "and retrieved historical evidence. Never invent people, places, times, durations, distances, routes, "
            "or events. Treat backend calculations as authoritative. If evidence is insufficient, say so clearly."
        )),
        HumanMessage(content=f"Question: {state['question']}\nAuthorized current context: {safe_context}\nRetrieved history:\n{state.get('evidence', '')}"),
    ])
    return {"answer": str(response.content).strip()}

def build_graph():
    graph = StateGraph(GraphState)
    graph.add_node("classify_intent", classify_node)
    graph.add_node("retrieve_authorized_events", retrieve_node)
    graph.add_node("prepare_evidence", evidence_node)
    graph.add_node("generate_answer", generate_node)
    graph.add_edge(START, "classify_intent")
    graph.add_edge("classify_intent", "retrieve_authorized_events")
    graph.add_edge("retrieve_authorized_events", "prepare_evidence")
    graph.add_edge("prepare_evidence", "generate_answer")
    graph.add_edge("generate_answer", END)
    return graph.compile()

workflow = build_graph()

def check_token(authorization: str | None):
    if not TOKEN or not authorization or not hmac.compare_digest(authorization, "Bearer " + TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")

@app.get("/health")
def health():
    return {"success": True, "service": "reva-rag", "configured": bool(TOKEN and MONGO_URI and GROQ_API_KEY)}

@app.post("/index-event")
def index_event_endpoint(payload: IndexRequest, authorization: str | None = Header(default=None)):
    check_token(authorization)
    try:
        return {"success": True, "indexed": index_event(payload.eventId)}
    except Exception as exc:
        print(f"[Reva RAG] indexing failed: {type(exc).__name__}: {exc}", flush=True)
        raise HTTPException(status_code=502, detail="Could not index location event.") from exc

@app.post("/reindex")
def reindex(authorization: str | None = Header(default=None)):
    check_token(authorization)
    try:
        index_status = ensure_vector_index()
        cursor = collection().find(
            {"eventType": {"$in": ["arrival", "stay", "departure"]}},
            {"_id": 1, "embedding": 1},
        )
        total = 0
        for row in cursor:
            if index_event(str(row["_id"])):
                total += 1
        return {"success": True, "vectorIndex": index_status, "indexedEvents": total}
    except Exception as exc:
        print(f"[Reva RAG] reindex failed: {type(exc).__name__}: {exc}", flush=True)
        raise HTTPException(status_code=502, detail="Could not reindex location events.") from exc

@app.post("/ask")
def ask(payload: AskRequest, authorization: str | None = Header(default=None)):
    check_token(authorization)
    try:
        result = workflow.invoke({
            "question": payload.question.strip(),
            "authorized_user_ids": payload.authorizedUserIds,
            "context": payload.context,
        })
        return {"success": True, "answer": result.get("answer", ""),
                "intent": result.get("intent", "other"), "retrievedEvents": len(result.get("events", []))}
    except Exception as exc:
        print(f"[Reva RAG] request failed: {type(exc).__name__}: {exc}", flush=True)
        raise HTTPException(status_code=502, detail="RAG processing failed. Check service logs and configuration.") from exc
