"""Environment-backed settings for the Reva Python RAG service."""
import os
from urllib.parse import urlparse
from dotenv import load_dotenv

load_dotenv()
TOKEN = os.getenv("RAG_SERVICE_TOKEN", "")
MONGO_URI = os.getenv("MONGO_URI", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
_configured_embedding_model = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2").strip()
EMBEDDING_MODEL = ("sentence-transformers/all-MiniLM-L6-v2"
    if _configured_embedding_model.lower() in {"xenova/all-minilm-l6-v2","xenova/all-minilm-l6-v2-quantized","qdrant/all-minilm-l6-v2-onnx"}
    else _configured_embedding_model)
VECTOR_INDEX = os.getenv("RAG_VECTOR_INDEX", "location_event_vector_index_384")
RAG_DISABLE_EMBEDDINGS = os.getenv("RAG_DISABLE_EMBEDDINGS", "false").strip().lower() in {"1","true","yes","on"}
TOP_K = max(1, min(int(os.getenv("RAG_TOP_K", "6")), 8))
DB_NAME = os.getenv("MONGO_DB_NAME", "location_tracker")
if MONGO_URI and not os.getenv("MONGO_DB_NAME"):
    try:
        DB_NAME = urlparse(MONGO_URI).path.lstrip("/").split("/")[0] or DB_NAME
    except Exception:
        pass
