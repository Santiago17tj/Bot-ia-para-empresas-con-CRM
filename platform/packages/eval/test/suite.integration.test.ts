import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { runWithTenant, systemPrisma, withRlsTransaction } from "@platform/db";
import { ingestDocument } from "@platform/knowledge";
import { LocalEmbeddingProvider } from "@platform/providers";

import {
  CUSTOMER_SUPPORT_CASES,
  CUSTOMER_SUPPORT_CORPUS,
  formatReport,
  runSuite,
} from "../dist/index.js";

/**
 * El conjunto de evaluación, ejercido de verdad.
 *
 * Usa el proveedor LOCAL: embeddings semánticos reales, sin clave y sin coste.
 * Por primera vez esto mide calidad de recuperación, no solo mecánica.
 *
 * Modo `retrieval`: no se llama a ningún generador, así que mide recall,
 * precisión y latencia, y **no mide abstención**. Este comentario decía lo
 * contrario —que la decidía el umbral, capa 1 del grounding— hasta que la
 * calibración lo desmintió: respondibles 0,853–0,927 frente a 0,775–0,846 de
 * las que no tienen respuesta. Siete milésimas.
 *
 * La abstención la mide `npm run eval`, que corre en modo `full` con generador.
 */

const TENANT = "tnt_eval_suite01";
const embedder = new LocalEmbeddingProvider();

const ctx = {
  tenantId: TENANT,
  actor: { type: "system" as const, id: "eval-test", scopes: [] },
  requestId: "req_eval_test",
};

const CORPUS = CUSTOMER_SUPPORT_CORPUS;
const CASES = CUSTOMER_SUPPORT_CASES;

const buf = (s: string): Buffer => Buffer.from(s, "utf8");

describe(
  "conjunto de evaluación",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    before(async () => {
      await systemPrisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, slug: "eval-suite", name: "Eval Suite" },
      });

      await runWithTenant(ctx, () =>
        ingestDocument(
            {
              tenantId: TENANT,
              bytes: buf(CORPUS),
              filename: "manual.md",
              mimeType: "text/markdown",
              sourceRef: "eval-manual",
            },
            { embedder, transaction: withRlsTransaction },
        ),
      );
    });

    after(async () => {
      await systemPrisma.tenant.delete({ where: { id: TENANT } });
      await systemPrisma.$disconnect();
    });

    test("el corpus se ingirió con embeddings locales de 384 dimensiones", async () => {
      // Es la prueba de que la convivencia de dimensiones funciona: el
      // proveedor local escribe en embedding_384 y el de 1536 sigue existiendo.
      const rows = await systemPrisma.$queryRaw<
        { total: bigint; d384: bigint; d1536: bigint }[]
      >`
        SELECT count(*) AS total,
               count(embedding_384) AS d384,
               count(embedding) AS d1536
        FROM "chunk" WHERE "tenantId" = ${TENANT}
      `;

      const row = rows[0];
      assert.ok(row);
      assert.ok(Number(row.total) > 0);
      assert.equal(Number(row.d384), Number(row.total), "faltan vectores de 384");
      assert.equal(Number(row.d1536), 0, "no debería haber escrito en la de 1536");
    });

    test("el conjunto tiene suficientes preguntas sin respuesta", async () => {
      const report = await runSuite({ tenantId: TENANT, cases: CASES, embedder });

      // Se comprueba la COMPOSICIÓN, no la ausencia de avisos: el modo
      // retrieval añade siempre uno advirtiendo de que sus cifras de abstención
      // no son válidas, y ese aviso debe estar.
      const composicion = report.suiteWarnings.filter(
        (w) => !w.startsWith("Modo retrieval"),
      );

      assert.deepEqual(
        composicion,
        [],
        `el conjunto no está bien compuesto: ${composicion.join(" | ")}`,
      );
      assert.ok(
        report.suiteWarnings.some((w) => w.startsWith("Modo retrieval")),
        "falta el aviso de que este modo no mide abstención",
      );
    });

    test("las preguntas respondibles recuperan material", async () => {
      const report = await runSuite({ tenantId: TENANT, cases: CASES, embedder });

      const fallos = report.outcomes
        .filter((o) => o.kind === "ANSWERABLE" && !o.answered)
        .map((o) => o.caseId);

      assert.deepEqual(
        fallos,
        [],
        `no se recuperó material para: ${fallos.join(", ")}`,
      );
    });

    test("una pregunta respondible recupera el fragmento correcto en el top 3", async () => {
      const report = await runSuite({ tenantId: TENANT, cases: CASES, embedder, limit: 3 });

      const plazo = report.outcomes.find((o) => o.caseId === "plazo-devolucion");
      assert.ok(plazo);

      const contenidos = await systemPrisma.chunk.findMany({
        where: { tenantId: TENANT, id: { in: plazo.retrieved } },
        select: { content: true },
      });

      assert.ok(
        contenidos.some((c) => c.content.includes("30 días naturales")),
        "el fragmento con la respuesta no está entre los tres primeros",
      );
    });

    test("el informe se imprime legible", async () => {
      const report = await runSuite({ tenantId: TENANT, cases: CASES, embedder });
      const texto = formatReport(report);

      assert.match(texto, /Abstención correcta/);
      assert.match(texto, /RESULTADO:/);
      console.log(texto);
    });

    test("las métricas y la puerta son coherentes entre sí", async () => {
      const report = await runSuite({ tenantId: TENANT, cases: CASES, embedder });

      assert.equal(report.metrics.total, CASES.length);
      assert.equal(
        report.metrics.byKind.UNANSWERABLE,
        CASES.filter((c) => c.kind === "UNANSWERABLE").length,
      );
      assert.equal(report.mode, "retrieval");
      assert.equal(report.metrics.totalCost, 0, "el modo retrieval no debe costar");

      // La puerta pasa si y solo si no hay fallos declarados.
      assert.equal(report.gate.passed, report.gate.failures.length === 0);
    });
  },
);
