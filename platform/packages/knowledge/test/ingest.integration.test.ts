import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { runWithTenant, systemPrisma, withRlsTransaction } from "@platform/db";
import { DeterministicEmbeddingProvider } from "@platform/providers";

import {
  contentChecksum,
  embedQuery,
  hybridSearch,
  ingestDocument,
  passesThreshold,
} from "../dist/index.js";

/**
 * Ingesta y recuperación contra Postgres real.
 *
 * Usa el proveedor de embeddings DETERMINISTA: prueba que el pipeline recupera,
 * fusiona y ordena, no la calidad semántica de ningún modelo. Esa medición
 * llega con el arnés de evaluación y un proveedor real.
 */

const TENANT = "tnt_ingest_test01";
const embedder = new DeterministicEmbeddingProvider({ dimensions: 1536 });

const ctx = {
  tenantId: TENANT,
  actor: { type: "system" as const, id: "test", scopes: [] },
  requestId: "req_ingest_test",
};

const MANUAL = `# Manual de atención

## Devoluciones

### Plazo
El plazo de devolución es de 30 días naturales desde la entrega del pedido.

### Estado del producto
Se aceptan devoluciones de productos sin usar y con su embalaje original.

## Envíos

### Plazos de entrega
Los envíos peninsulares tardan entre 24 y 48 horas laborables.

### Referencias
El producto con referencia AX-4402 está descatalogado desde enero.
`;

const buf = (s: string): Buffer => Buffer.from(s, "utf8");

async function search(query: string, limit = 5) {
  const queryEmbedding = await embedQuery(embedder, query);
  return runWithTenant(ctx, () =>
    withRlsTransaction((tx) =>
      hybridSearch(tx, { tenantId: TENANT, queryText: query, queryEmbedding, limit }),
    ),
  );
}

describe(
  "ingesta y recuperación",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    before(async () => {
      await systemPrisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, slug: "ingest-test", name: "Ingest Test" },
      });

      await runWithTenant(ctx, () =>
        ingestDocument(
            {
              tenantId: TENANT,
              bytes: buf(MANUAL),
              filename: "manual.md",
              mimeType: "text/markdown",
              sourceRef: "manual-v1",
            },
            { embedder, transaction: withRlsTransaction },
        ),
      );
    });

    after(async () => {
      await systemPrisma.tenant.delete({ where: { id: TENANT } });
      await systemPrisma.$disconnect();
    });

    test("los fragmentos se escribieron con vector y tsvector", async () => {
      const rows = await systemPrisma.$queryRaw<
        { total: bigint; con_vector: bigint; con_texto: bigint }[]
      >`
        SELECT count(*) AS total,
               count(embedding) AS con_vector,
               count(search_vector) AS con_texto
        FROM "chunk" WHERE "tenantId" = ${TENANT}
      `;

      const row = rows[0];
      assert.ok(row);
      assert.ok(Number(row.total) > 0, "no se creó ningún fragmento");
      assert.equal(Number(row.con_vector), Number(row.total), "faltan embeddings");
      assert.equal(Number(row.con_texto), Number(row.total), "faltan tsvectors");
    });

    test("los fragmentos conservan la ruta de sección", async () => {
      const rows = await systemPrisma.chunk.findMany({
        where: { tenantId: TENANT },
        select: { sectionPath: true, breadcrumbs: true, content: true },
      });

      const plazo = rows.find((r) => r.content.includes("30 días naturales"));
      assert.ok(plazo, "no se encontró el fragmento del plazo");
      assert.deepEqual(plazo.breadcrumbs, ["Manual de atención", "Devoluciones", "Plazo"]);
    });

    test("la rama léxica encuentra una referencia exacta", async () => {
      // Es el caso que la búsqueda vectorial falla con seguridad: AX-4402 y
      // AX-4403 son casi idénticos como vectores.
      const hits = await search("AX-4402");
      const encontrado = hits.find((h) => h.content.includes("AX-4402"));

      assert.ok(encontrado, "la referencia exacta no se recuperó");
      assert.ok(
        encontrado.matchedBy.includes("lexical"),
        "debería haber entrado por la rama léxica",
      );
    });

    test("una consulta en lenguaje natural recupera la sección correcta", async () => {
      const hits = await search("cuánto tiempo tengo para devolver un pedido");
      assert.ok(hits.length > 0, "no se recuperó nada");
      assert.ok(
        hits.slice(0, 3).some((h) => h.content.includes("30 días naturales")),
        `el fragmento correcto no está en el top 3: ${hits.map((h) => h.chunkId).join(", ")}`,
      );
    });

    test("los resultados llegan ordenados por puntuación descendente", async () => {
      const hits = await search("devoluciones y envíos");
      for (let i = 1; i < hits.length; i++) {
        assert.ok(
          (hits[i - 1]?.score ?? 0) >= (hits[i]?.score ?? 0),
          "la fusión devolvió resultados desordenados",
        );
      }
    });

    test("el umbral corta antes de generar, sobre la similitud coseno", async () => {
      // Capa 1 del grounding, probada como MECANISMO. La calidad semántica del
      // corte se mide en el arnés de evaluación, que usa embeddings reales:
      // el proveedor determinista es una bolsa de palabras con hash y no
      // promete ordenación semántica, así que pedirle que separe una consulta
      // del dominio de una ajena sería pedirle algo que no hace.
      const hits = await search("plazo para devolver un pedido");
      const mejor = hits.reduce((max, h) => Math.max(max, h.vectorSimilarity ?? 0), 0);

      assert.ok(mejor > 0, "la rama vectorial no devolvió similitud");
      assert.equal(
        passesThreshold(hits, mejor + 0.01),
        false,
        "por encima de la mejor similitud debe abstenerse",
      );
      assert.equal(
        passesThreshold(hits, mejor - 0.01),
        true,
        "por debajo debe dejar pasar",
      );
    });

    test("reingerir el mismo contenido no crea versión nueva", async () => {
      // El mismo PDF re-exportado cambia de bytes sin cambiar de texto:
      // versionar eso repagaría los embeddings sin que nada haya cambiado.
      const antes = await systemPrisma.chunk.count({ where: { tenantId: TENANT } });

      const result = await runWithTenant(ctx, () =>
        ingestDocument(
            {
              tenantId: TENANT,
              bytes: buf(MANUAL),
              filename: "manual.md",
              mimeType: "text/markdown",
              sourceRef: "manual-v1",
            },
            { embedder, transaction: withRlsTransaction },
        ),
      );

      assert.equal(result.unchanged, true);
      assert.equal(result.chunksCreated, 0);
      assert.equal(await systemPrisma.chunk.count({ where: { tenantId: TENANT } }), antes);
    });

    test("una versión nueva desactiva los fragmentos de la anterior", async () => {
      // Si se desactivaran después, habría una ventana en la que el documento
      // respondería con las dos versiones a la vez.
      await runWithTenant(ctx, () =>
        ingestDocument(
            {
              tenantId: TENANT,
              bytes: buf(MANUAL.replace("30 días naturales", "45 días naturales")),
              filename: "manual.md",
              mimeType: "text/markdown",
              sourceRef: "manual-v1",
            },
            { embedder, transaction: withRlsTransaction },
        ),
      );

      const activos = await systemPrisma.chunk.findMany({
        where: { tenantId: TENANT, isActive: true },
        select: { content: true },
      });

      assert.ok(
        activos.some((c) => c.content.includes("45 días")),
        "la versión nueva no está activa",
      );
      assert.ok(
        !activos.some((c) => c.content.includes("30 días")),
        "la versión anterior sigue activa: el documento respondería dos plazos",
      );
    });

    test("la búsqueda solo devuelve la versión vigente", async () => {
      const hits = await search("plazo de devolución");
      assert.ok(
        !hits.some((h) => h.content.includes("30 días")),
        "se recuperó contenido de una versión superada",
      );
    });

    test("el checksum ignora espacios de más pero no cambios reales", () => {
      assert.equal(contentChecksum("  texto  "), contentChecksum("texto"));
      assert.notEqual(contentChecksum("texto"), contentChecksum("texto."));
    });
  },
);
