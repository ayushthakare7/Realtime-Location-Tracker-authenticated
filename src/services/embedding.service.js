const { pipeline } = require("@huggingface/transformers");

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIMENSIONS = 384;

let extractorPromise;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "fp32"
    });
  }
  return extractorPromise;
}

async function embedText(text) {
  const extractor = await getExtractor();
  const output = await extractor(String(text || "").slice(0, 8000), {
    pooling: "mean",
    normalize: true
  });
  const values = Array.from(output.data);

  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Sentence Transformer returned ${values.length} dimensions; expected ${EMBEDDING_DIMENSIONS}.`);
  }
  return values;
}

module.exports = { embedText, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };