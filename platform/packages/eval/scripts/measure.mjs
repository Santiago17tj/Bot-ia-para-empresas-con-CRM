import "@platform/env/load";

import { randomUUID } from "node:crypto";

import { runWithTenant, systemPrisma, withRlsTransaction } from "@platform/db";
import { ingestDocument } from "@platform/knowledge";
import { PromptNotFoundError } from "@platform/observability";
import { createAIProvider, createEmbeddingProvider } from "@platform/providers";

import {
  createGenerator,
  formatReport,
  runSuite,
  CUSTOMER_SUPPORT_CASES,
  CUSTOMER_SUPPORT_CORPUS,
} from "@platform/eval";

/**
 * La medición completa: recuperación Y abstención, contra Postgres real y un
 * generador real.
 *
 *   npm run eval
 *
 * Se ejecuta contra un tenant desechable que se crea al empezar y se borra al
 * terminar, incluso si falla. Reutilizar uno persistente haría que la segunda
 * tirada midiera sobre un corpus ingerido dos veces.
 *
 * Sale con código 1 si la puerta bloquea, para que sirva en CI. Que bloquee no
 * es un fallo del script: es el arnés diciendo la verdad.
 */

/**
 * Un tenant distinto por ejecución.
 *
 * Era un id fijo, y con eso dos mediciones simultáneas —comparar dos modelos,
 * o CI corriendo mientras alguien mide en local contra la misma base— se
 * pisaban: la segunda ingería sobre el corpus de la primera y la primera en
 * terminar borraba el tenant de las dos. El resultado no era un error, era un
 * número plausible y sin sentido, que es lo peor que puede producir un arnés.
 */
const TENANT = `tnt_eval_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

const ctx = {
  tenantId: TENANT,
  actor: { type: "system", id: "eval-measure", scopes: [] },
  requestId: `req_eval_${TENANT}`,
};

async function main() {
  const embedder = createEmbeddingProvider();
  const provider = createAIProvider();

  console.log(`[eval] embeddings: ${embedder.id} · ${embedder.model} · ${embedder.dimensions}d`);
  console.log(`[eval] generador:  ${provider.id} · ${provider.model}`);

  // Se comprueba ANTES de ingerir nada: sin salida estructurada no hay citas
  // exigibles, y el número que saldría al final no mediría abstención sino
  // buena voluntad del modelo.
  if (!provider.capabilities.structuredOutput) {
    throw new Error(
      `${provider.id}/${provider.model} no admite salida estructurada. ` +
        "Elige un modelo que la soporte: sin ella las citas no se pueden exigir.",
    );
  }

  await systemPrisma.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, slug: TENANT, name: "Eval Measure" },
  });

  try {
    console.log("[eval] ingiriendo el corpus…");
    await runWithTenant(ctx, () =>
      ingestDocument(
        {
          tenantId: TENANT,
          bytes: Buffer.from(CUSTOMER_SUPPORT_CORPUS, "utf8"),
          filename: "manual.md",
          mimeType: "text/markdown",
          sourceRef: "eval-manual",
        },
        { embedder, transaction: withRlsTransaction },
      ),
    );

    console.log(`[eval] generando ${CUSTOMER_SUPPORT_CASES.length} respuestas…`);
    const report = await runSuite({
      tenantId: TENANT,
      cases: CUSTOMER_SUPPORT_CASES,
      embedder,
      mode: "full",
      generate: createGenerator({ tenantId: TENANT, provider }),
      generator: { provider: provider.id, model: provider.model },
    });

    console.log(formatReport(report));

    // El detalle por caso es lo que hace accionable un fallo. Un "abstención
    // 60%" sin saber CUÁL no dice qué arreglar.
    console.log("── Detalle por caso ──");
    for (const outcome of report.outcomes) {
      const mark = expected(outcome) ? "✓" : "✗";
      console.log(
        `  ${mark} ${outcome.caseId.padEnd(22)} ${outcome.kind.padEnd(13)} ` +
          `${outcome.answered ? "respondió" : "se abstuvo"}  ` +
          `${outcome.citations?.length ?? 0} cita(s)  ${outcome.latencyMs} ms`,
      );
      if (outcome.response !== undefined) {
        console.log(`      → ${outcome.response.replace(/\s+/g, " ").slice(0, 140)}`);
      }
      for (const failure of outcome.groundingFailures ?? []) {
        console.log(`      ⚠ ${failure}`);
      }
    }
    console.log("");

    if (!report.gate.passed) process.exitCode = 1;
  } finally {
    // Borrar el tenant arrastra en cascada documentos, versiones y fragmentos.
    await systemPrisma.tenant.delete({ where: { id: TENANT } }).catch(() => {});
    await systemPrisma.$disconnect();
  }
}

/** Qué se esperaba de este caso, para marcarlo en el detalle. */
function expected(outcome) {
  if (outcome.kind === "ANSWERABLE") return outcome.answered;
  return !outcome.answered;
}

main().catch((error) => {
  console.error("\n[eval] la medición falló:");
  console.error(error instanceof Error ? error.message : String(error));

  if (error instanceof PromptNotFoundError) {
    console.error(
      "\nEl catálogo de prompts no está sembrado. Ejecuta:\n" +
        "  npm run prompts:seed\n",
    );
  }

  process.exitCode = 1;
});
