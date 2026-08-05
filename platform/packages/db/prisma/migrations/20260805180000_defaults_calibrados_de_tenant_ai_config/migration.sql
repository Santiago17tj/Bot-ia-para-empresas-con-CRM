-- Los valores por defecto de `tenantAiConfig` se escribieron antes de medir
-- nada, y describían un sistema distinto del que acabó existiendo.
--
-- `groundingThreshold` valía 0.35. El valor calibrado sobre
-- multilingual-e5-small es 0.78 (ver DEFAULT_SIMILARITY_THRESHOLD en
-- packages/knowledge/src/retrieval.ts): con 0.35 pasaba el filtro cualquier
-- cosa, incluida una receta de cocina, que puntúa 0,77 contra un manual de
-- atención al cliente. Un tenant recién creado nacía sin la capa 1 del
-- grounding.
--
-- Los de embeddings decían openai/1536 mientras todo el sistema corría con el
-- proveedor local de 384 dimensiones.

ALTER TABLE "tenantAiConfig" ALTER COLUMN "groundingThreshold" SET DEFAULT 0.78;
ALTER TABLE "tenantAiConfig" ALTER COLUMN "embeddingProvider" SET DEFAULT 'local';
ALTER TABLE "tenantAiConfig" ALTER COLUMN "embeddingModel" SET DEFAULT 'Xenova/multilingual-e5-small';
ALTER TABLE "tenantAiConfig" ALTER COLUMN "embeddingDimensions" SET DEFAULT 384;

-- Las filas que aún tienen el umbral viejo se corrigen: 0.35 exacto solo puede
-- venir del valor por defecto anterior, y dejarlas ahí sería dejar tenants
-- servidos sin la primera capa de grounding.
UPDATE "tenantAiConfig" SET "groundingThreshold" = 0.78
 WHERE "groundingThreshold" = 0.35;

-- Las de embeddings NO se tocan, a propósito. Cambiar el proveedor de
-- embeddings de un tenant que ya tiene corpus no es un ajuste: obliga a
-- reindexar (§25). Una fila que diga 1536 describe cómo se embebió ese corpus,
-- y "corregirla" a 384 haría que el sistema buscara en la columna equivocada y
-- no encontrara nada, sin que nada fallara.
