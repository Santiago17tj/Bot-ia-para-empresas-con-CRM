import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { runWithTenant, systemPrisma, withRlsTransaction } from "@platform/db";
import { ingestDocument } from "@platform/knowledge";
import { LocalEmbeddingProvider } from "@platform/providers";

import {
  CONVERSATIONAL_CASES,
  CUSTOMER_SUPPORT_CASES,
  CUSTOMER_SUPPORT_CORPUS,
  FULL_SUITE_CASES,
  formatReport,
  runSuite,
  type ResolveFn,
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

/**
 * Un reescritor de mentira, con las reescrituras escritas a mano.
 *
 * Sustituye al modelo a propósito: lo que estos tests miden no es si el
 * generador reescribe bien —eso lo mide `npm run eval` contra uno real— sino
 * que el ejecutor BUSCA lo reescrito. Con un modelo de por medio, un fallo aquí
 * no distinguiría entre "el arnés ignora la reescritura" y "el modelo tuvo un
 * mal día", que es justo la ambigüedad que un test de integración existe para
 * eliminar.
 */
const REESCRITURAS: Record<string, { question: string; rewritten: boolean }> = {
  "¿Y a Canarias?": {
    question: "¿Cuánto tarda un envío a Canarias?",
    rewritten: true,
  },
  "¿Y si ya lo he usado?": {
    question: "¿Puedo devolver un producto que ya he usado?",
    rewritten: true,
  },
  "¿Y cuánto tardáis en devolverme el dinero?": {
    question: "¿Cuántos días tardáis en reembolsar el dinero de una devolución?",
    rewritten: true,
  },
};

const stubResolver: ResolveFn = async (question) => {
  const escrita = REESCRITURAS[question];
  return escrita === undefined
    ? { question, rewritten: false, cost: 0 }
    : { ...escrita, cost: 0 };
};

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

    // --- Casos conversacionales (§10) ---------------------------------------

    test("sin reescritor, los casos conversacionales se saltan y se dice cuáles", async () => {
      const report = await runSuite({
        tenantId: TENANT,
        cases: FULL_SUITE_CASES,
        embedder,
      });

      assert.deepEqual(
        report.skipped.map((s) => s.caseId).sort(),
        CONVERSATIONAL_CASES.map((c) => c.id).sort(),
        "los casos con hilo deberían saltarse cuando no hay reescritor",
      );

      // Y las métricas describen solo lo que corrió. Si `total` contara los
      // saltados, el informe diría que midió trece casos habiendo mirado nueve.
      assert.equal(report.metrics.total, CUSTOMER_SUPPORT_CASES.length);
      assert.equal(
        report.metrics.followUpCases,
        0,
        "no se puede medir la reescritura sin reescritor",
      );
      assert.ok(
        report.suiteWarnings.some((w) => w.includes("saltado")),
        "el informe tiene que decir que no midió la reescritura",
      );
      assert.match(formatReport(report), /Casos no ejecutados/);
    });

    test("se busca lo reescrito y no el seguimiento", async () => {
      // La prueba de que la reescritura entra de verdad en la recuperación, y
      // no se limita a archivarse. Se reescribe a propósito hacia OTRO tema:
      // si el ejecutor buscara el texto original, el primer fragmento seguiría
      // siendo el de envíos.
      //
      // Se comprueba así, y no con «el seguimiento crudo no recupera la
      // respuesta», porque eso último es falso sobre este corpus y hubo que
      // medirlo para saberlo: son cinco fragmentos y se piden tres, así que
      // cada consulta devuelve el 60% de todo lo que hay y el fragmento bueno
      // está en la lista se pregunte como se pregunte. Ver
      // `scripts/calibrate-followups.mjs`.
      const desvia: ResolveFn = async () => ({
        question: "¿Puedo devolver un producto que ya he usado?",
        rewritten: true,
        cost: 0,
      });

      const report = await runSuite({
        tenantId: TENANT,
        cases: [CONVERSATIONAL_CASES[0] as (typeof CONVERSATIONAL_CASES)[number]],
        embedder,
        resolve: desvia,
        limit: 1,
      });

      const outcome = report.outcomes[0];
      assert.ok(outcome);
      assert.equal(outcome.resolvedQuestion, "¿Puedo devolver un producto que ya he usado?");

      const contenidos = await systemPrisma.chunk.findMany({
        where: { tenantId: TENANT, id: { in: outcome.retrieved } },
        select: { content: true },
      });

      assert.ok(
        contenidos.every((c) => c.content.includes("sin usar")),
        "el primer fragmento tendría que ser el de la pregunta REESCRITA; si es " +
          "el de envíos, el ejecutor está buscando el seguimiento original",
      );
    });

    test("con reescritor, el seguimiento recupera la respuesta", async () => {
      const report = await runSuite({
        tenantId: TENANT,
        cases: CONVERSATIONAL_CASES,
        embedder,
        resolve: stubResolver,
        limit: 3,
      });

      assert.equal(report.skipped.length, 0, "con reescritor no se salta ninguno");

      const canarias = report.outcomes.find((o) => o.caseId === "hilo-canarias");
      assert.ok(canarias);
      assert.equal(canarias.rewritten, true);
      assert.equal(canarias.resolvedQuestion, "¿Cuánto tarda un envío a Canarias?");

      const contenidos = await systemPrisma.chunk.findMany({
        where: { tenantId: TENANT, id: { in: canarias.retrieved } },
        select: { content: true },
      });

      assert.ok(
        contenidos.some((c) => c.content.includes("3 y 5 días")),
        "con la pregunta reescrita, el fragmento con la respuesta tiene que estar",
      );
      assert.equal(canarias.sourceFound, true);
    });

    test("reescribir de más también cuenta como fallo", async () => {
      // `hilo-autonoma` declara `expectsRewrite: false`: la pregunta ya se
      // entendía sola. Un reescritor que la toca recupera peor sin que ninguna
      // otra métrica lo note necesariamente, así que esta es la única que lo ve.
      const excesivo: ResolveFn = async (question) => ({
        question: `${question} tras haber devuelto un pedido`,
        rewritten: true,
        cost: 0,
      });

      const report = await runSuite({
        tenantId: TENANT,
        cases: CONVERSATIONAL_CASES,
        embedder,
        resolve: excesivo,
      });

      assert.deepEqual(report.metrics.followUpFailures, ["hilo-autonoma"]);
      assert.equal(report.metrics.followUpCases, CONVERSATIONAL_CASES.length);
      assert.ok(
        report.metrics.followUpResolution < 1,
        "un reescritor que reescribe de más no puede puntuar perfecto",
      );
    });

    test("la puerta bloquea si la reescritura falla", async () => {
      // Un reescritor que nunca reescribe: es el chat de antes de §10, y el
      // arnés tiene que decir que no vale.
      const inerte: ResolveFn = async (question) => ({
        question,
        rewritten: false,
        cost: 0,
      });

      const report = await runSuite({
        tenantId: TENANT,
        cases: CONVERSATIONAL_CASES,
        embedder,
        resolve: inerte,
      });

      assert.equal(report.metrics.followUpCases, CONVERSATIONAL_CASES.length);
      assert.equal(report.gate.passed, false);
      assert.ok(
        report.gate.failures.some((f) => f.includes("Reescritura de seguimientos")),
        `la puerta no señaló la reescritura: ${report.gate.failures.join(" | ")}`,
      );
    });

    test("el conjunto completo sigue teniendo un tercio sin respuesta", async () => {
      const report = await runSuite({
        tenantId: TENANT,
        cases: FULL_SUITE_CASES,
        embedder,
        resolve: stubResolver,
      });

      const composicion = report.suiteWarnings.filter(
        (w) => !w.startsWith("Modo retrieval"),
      );
      assert.deepEqual(
        composicion,
        [],
        `el conjunto completo no está bien compuesto: ${composicion.join(" | ")}`,
      );
      assert.equal(report.metrics.total, FULL_SUITE_CASES.length);
      assert.equal(report.metrics.followUpResolution, 1);
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
