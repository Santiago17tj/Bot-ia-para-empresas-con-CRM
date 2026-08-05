export {
  chunkDocument,
  splitByHeadings,
  splitSentences,
  estimateTokens,
} from "./chunking.js";
export type { Chunk, ChunkInput, ChunkOptions } from "./chunking.js";

export { columnForDimensions, supportedDimensions, EMBEDDING_COLUMNS, UnsupportedDimensionError } from "./dimensions.js";

export { ingestDocument, embedQuery, contentChecksum } from "./ingest.js";
export type { IngestInput, IngestResult } from "./ingest.js";

export { hybridSearch, fuseRRF, passesThreshold, DEFAULT_SIMILARITY_THRESHOLD } from "./retrieval.js";
export type { RetrievalHit, RetrievalOptions } from "./retrieval.js";

export {
  toMarkdown,
  converterFor,
  registerConverter,
  availableFormats,
  assessExtraction,
  ConversionError,
  MIN_USEFUL_CHARS,
  htmlToMarkdown,
  textToMarkdown,
  csvToMarkdown,
  parseCsv,
  decodeEntities,
  normalizeBlankLines,
} from "./convert/index.js";
export type { ConversionResult, DocumentConverter } from "./convert/index.js";

export {
  validateGrounding,
  normalizeForComparison,
  fallbackAnswer,
  ANSWER_SCHEMA,
} from "./grounding.js";
export type {
  CitableSource,
  Citation,
  GroundedAnswer,
  ValidationFailure,
  ValidationResult,
} from "./grounding.js";

export { answerFromKnowledge, renderContext } from "./answer.js";
export type { AnswerOptions, AnswerResult } from "./answer.js";
