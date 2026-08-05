-- ===========================================================================
-- 003 — Convivencia de varias dimensiones de embedding
--
-- El plan (§8.1, §25) dice que cambiar de proveedor de embeddings NO puede ser
-- un apagón: se añade una columna, se migra por lotes con doble escritura, se
-- compara contra el conjunto de evaluación, y se conmuta la lectura.
--
-- Esta migración es la primera vez que ese diseño se ejerce de verdad, y no
-- como afirmación en un documento: el proveedor local (multilingual-e5-small)
-- produce 384 dimensiones frente a las 1536 del proveedor por defecto.
--
-- Cada fragmento ya graba `embeddingProvider` y `embeddingDimensions`, así que
-- se sabe en qué columna vive su vector sin adivinar.
-- ===========================================================================

BEGIN;

ALTER TABLE "chunk" ADD COLUMN IF NOT EXISTS embedding_384 vector(384);

-- Un índice por dimensión. HNSW exige dimensión fija, así que no hay forma de
-- compartirlo — y tampoco haría falta: una consulta solo mira la columna que
-- corresponde a su proveedor.
CREATE INDEX IF NOT EXISTS chunk_embedding_384_hnsw
  ON "chunk" USING hnsw (embedding_384 vector_cosine_ops);

-- Índice parcial por proveedor: durante una migración conviven fragmentos de
-- dos proveedores, y la consulta debe poder quedarse solo con los suyos sin
-- recorrer los del otro.
CREATE INDEX IF NOT EXISTS chunk_embedding_provider
  ON "chunk" ("tenantId", "embeddingProvider", "isActive");

COMMIT;

-- ---------------------------------------------------------------------------
-- Añadir una dimensión nueva en el futuro
--
--   ALTER TABLE "chunk" ADD COLUMN embedding_<N> vector(<N>);
--   CREATE INDEX ... USING hnsw (embedding_<N> vector_cosine_ops);
--
-- y registrarla en EMBEDDING_COLUMNS (packages/knowledge/src/dimensions.ts).
-- Esa constante es la que traduce dimensión → columna en ingesta y búsqueda;
-- añadir la columna sin registrarla escribe vectores que nadie leerá jamás, en
-- silencio.
-- ---------------------------------------------------------------------------
