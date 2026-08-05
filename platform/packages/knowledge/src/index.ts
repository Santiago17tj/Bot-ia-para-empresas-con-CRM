export {
  chunkDocument,
  splitByHeadings,
  splitSentences,
  estimateTokens,
} from "./chunking.js";
export type { Chunk, ChunkInput, ChunkOptions } from "./chunking.js";

export { hybridSearch, fuseRRF, passesThreshold } from "./retrieval.js";
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
  Citation,
  GroundedAnswer,
  ValidationFailure,
  ValidationResult,
} from "./grounding.js";
