"""Download and smoke-test Reva's ONNX embedding model during the Render build."""
import os

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from fastembed import TextEmbedding

MODEL_NAME = os.getenv(
    "EMBEDDING_MODEL",
    "sentence-transformers/all-MiniLM-L6-v2",
)

print(f"[Reva RAG build] Downloading/loading ONNX embedding model: {MODEL_NAME}", flush=True)
model = TextEmbedding(model_name=MODEL_NAME)
vector = next(model.query_embed("Reva embedding model deployment smoke test"))
if len(vector) != 384:
    raise RuntimeError(f"Unexpected embedding dimension: {len(vector)}")
print(f"[Reva RAG build] ONNX model ready; embedding dimension={len(vector)}", flush=True)
