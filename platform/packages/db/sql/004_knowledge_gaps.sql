-- ===========================================================================
-- 004 — Vectores para los huecos de conocimiento
--
-- Un hueco se agrupa por SIGNIFICADO, no por texto. Nadie pregunta dos veces
-- igual: "¿ofrecéis financiación?" y "¿se puede pagar a plazos?" son el mismo
-- hueco, y una lista de literales distintos no le dice a nadie que treinta
-- clientes quieren saber lo mismo.
--
-- Mismo patrón que `chunk`: una columna por dimensión, porque HNSW exige
-- dimensión fija. `EMBEDDING_COLUMNS` en packages/knowledge/src/dimensions.ts
-- es la tabla que dice cuál toca.
-- ===========================================================================

BEGIN;

ALTER TABLE "knowledgeGap" ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE "knowledgeGap" ADD COLUMN IF NOT EXISTS embedding_384 vector(384);

CREATE INDEX IF NOT EXISTS knowledge_gap_embedding_hnsw
  ON "knowledgeGap" USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS knowledge_gap_embedding_384_hnsw
  ON "knowledgeGap" USING hnsw (embedding_384 vector_cosine_ops);

-- La búsqueda del grupo al que pertenece una pregunta nueva filtra siempre por
-- tenant, estado y proveedor: comparar vectores de proveedores distintos no
-- significa nada, y un hueco ya cerrado no debe absorber preguntas nuevas.
CREATE INDEX IF NOT EXISTS knowledge_gap_grouping
  ON "knowledgeGap" ("tenantId", status, "embeddingProvider", "embeddingDimensions");

COMMIT;
