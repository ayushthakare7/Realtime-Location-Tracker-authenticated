"""Lazy FastEmbed/Groq clients and non-blocking embedding warm-up."""
import threading
from datetime import datetime, timezone
from fastembed import TextEmbedding
from langchain_groq import ChatGroq
from config import EMBEDDING_MODEL, GROQ_API_KEY, GROQ_MODEL, RAG_DISABLE_EMBEDDINGS

_embeddings = None
_llm = None
_embeddings_lock = threading.Lock()
_llm_lock = threading.Lock()
_embedding_warmup_state = {"complete": RAG_DISABLE_EMBEDDINGS, "ok": RAG_DISABLE_EMBEDDINGS, "error": None}
_embedding_warmup_state_lock = threading.Lock()

class FastEmbedAdapter:
    """Small ONNX-based embedding adapter with the interface used by Reva."""
    def __init__(self, model_name: str):
        self.model = TextEmbedding(model_name=model_name)

    def embed_query(self, text: str) -> list[float]:
        return next(self.model.query_embed(text)).tolist()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [vector.tolist() for vector in self.model.passage_embed(texts)]

def embeddings():
    global _embeddings
    if _embeddings is None:
        with _embeddings_lock:
            if _embeddings is None:
                print(f"[Reva RAG] ONNX embedding model initialization started: {EMBEDDING_MODEL}", flush=True)
                try:
                    _embeddings = FastEmbedAdapter(EMBEDDING_MODEL)
                    # Force one inference during startup of the first request so
                    # model/runtime errors are reported before vector search.
                    test_vector = _embeddings.embed_query("Reva embedding smoke test")
                    if len(test_vector) != 384:
                        raise RuntimeError(f"Expected 384-dimensional embeddings, got {len(test_vector)}")
                    print("[Reva RAG] ONNX embedding model initialization completed; dimension=384", flush=True)
                except Exception as exc:
                    print(f"[Reva RAG] ONNX embedding model initialization failed: {type(exc).__name__}: {exc}", flush=True)
                    raise
    return _embeddings

def llm():
    global _llm
    if _llm is None:
        with _llm_lock:
            if _llm is None:
                if not GROQ_API_KEY:
                    raise RuntimeError("GROQ_API_KEY is missing")
                print(f"[Reva RAG] Groq client initialization started: {GROQ_MODEL}", flush=True)
                _llm = ChatGroq(model=GROQ_MODEL, groq_api_key=GROQ_API_KEY, temperature=0)
                print("[Reva RAG] Groq client initialization completed", flush=True)
    return _llm

def embeddings_unavailable() -> bool:
    with _embedding_warmup_state_lock:
        return bool(_embedding_warmup_state["complete"] and not _embedding_warmup_state["ok"])

def warm_embeddings_in_background():
    """Warm the ONNX model after the HTTP server starts so Render health checks can pass.

    Embeddings are optional because retrieve_node has an authorized MongoDB fallback.
    A failed warmup is recorded, but does not prevent the service from serving requests.
    """
    if RAG_DISABLE_EMBEDDINGS:
        print("[Reva RAG] embedding warmup skipped: RAG_DISABLE_EMBEDDINGS is enabled", flush=True)
        return
    started = datetime.now(timezone.utc)
    try:
        embeddings()
        with _embedding_warmup_state_lock:
            _embedding_warmup_state.update({"complete": True, "ok": True, "error": None})
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        print(f"[Reva RAG] background embedding warmup completed in {elapsed:.1f}s", flush=True)
    except Exception as exc:
        with _embedding_warmup_state_lock:
            _embedding_warmup_state.update({
                "complete": True,
                "ok": False,
                "error": f"{type(exc).__name__}: {str(exc)[:240]}",
            })
        print(f"[Reva RAG] background embedding warmup failed; MongoDB fallback remains available: {type(exc).__name__}: {exc}", flush=True)

