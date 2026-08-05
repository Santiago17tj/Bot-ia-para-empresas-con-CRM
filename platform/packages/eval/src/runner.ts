import { runWithTenant, withRlsTransaction, type TenantContext } from "@platform/db";
import type { EmbeddingProvider } from "@platform/providers";
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  embedQuery,
  hybridSearch,
  passesThreshold,
  type RetrievalHit,
} from "@platform/knowledge";

import {
  assessSuiteComposition,
  computeMetrics,
  evaluateGate,
  DEFAULT_THRESHOLDS,
  type CaseOutcome,
  type EvalCase,
  type GateResult,
  type Metrics,
  type Thresholds,
} from "./metrics.js";

/**
 * Ejecutor del conjunto de evaluación.
 *
 * Dos modos, y la diferencia entre ellos es más grande de lo que parecía:
 *
 *  - **retrieval**: recupera y aplica el umbral. Sin generador, coste cero.
 *    Mide bien recall, precisión y latencia. **NO mide abstención.**
 *  - **full**: añade generación y validación de citas. Cuesta dinero, y es el
 *    único que mide lo que decide si el producto es vendible.
 *
 * La primera versión de este fichero afirmaba que el modo barato medía la
 * abstención, razonando que la decide el umbral. La medición lo desmintió:
 * sobre multilingual-e5-small, las preguntas respondibles puntúan 0,853–0,927 y
 * las que no tienen respuesta 0,775–0,846. Siete milésimas de separación.
 *
 * Con un umbral conservador, las tres preguntas sin respuesta del conjunto lo
 * superan y se cuentan como respondidas: abstención correcta 0%. Con uno
 * afinado a ese hueco, la sobreabstención se dispara y el sistema se calla
 * cosas que sabe. No hay umbral que resuelva esto porque **la similitud coseno
 * no es una señal de abstención** con estos modelos.
 *
 * Quien abstiene de verdad es la capa 4–6: el generador recibe los fragmentos,
 * ve que no contestan la pregunta y devuelve `answered: false`; la validación
 * en código comprueba que lo que afirma está citado. El umbral solo descarta el
 * disparate — una receta de cocina puntúa 0,77 — y eso también vale, pero es
 * otra cosa.
 */

export type EvalMode = "retrieval" | "full";

export interface RunOptions {
  tenantId: string;
  cases: EvalCase[];
  embedder: EmbeddingProvider;
  mode?: EvalMode;
  /** Umbral de recuperación. Por debajo, se abstiene sin generar. */
  groundingThreshold?: number;
  limit?: number;
  thresholds?: Thresholds;
  /** Solo en modo `full`. Si falta, se fuerza el modo `retrieval`. */
  generate?: GenerateFn;
  /**
   * Quién generó, para el informe.
   *
   * Va aparte del propio `generate` porque una cifra de abstención sin el
   * modelo al lado no es un resultado: no se sabe si mide el pipeline o mide
   * lo tonto que era el generador de aquel día.
   */
  generator?: { provider: string; model: string };
}

export type GenerateFn = (
  question: string,
  hits: RetrievalHit[],
) => Promise<{
  answered: boolean;
  response: string;
  citations: { chunkId: string }[];
  cost: number;
  groundingFailures?: string[];
}>;

export interface RunReport {
  mode: EvalMode;
  metrics: Metrics;
  gate: GateResult;
  outcomes: CaseOutcome[];
  suiteWarnings: string[];
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  generator?: { provider: string; model: string };
}

export async function runSuite(options: RunOptions): Promise<RunReport> {
  const mode: EvalMode =
    options.generate === undefined ? "retrieval" : (options.mode ?? "full");
  const threshold = options.groundingThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const limit = options.limit ?? 8;

  const ctx: TenantContext = {
    tenantId: options.tenantId,
    actor: { type: "system", id: "eval", scopes: [] },
    requestId: `eval_${Date.now().toString(36)}`,
  };

  const outcomes: CaseOutcome[] = [];

  for (const testCase of options.cases) {
    const startedAt = performance.now();

    const queryEmbedding = await embedQuery(options.embedder, testCase.question);
    const hits = await runWithTenant(ctx, () =>
      withRlsTransaction((tx) =>
        hybridSearch(tx, {
          tenantId: options.tenantId,
          queryText: testCase.question,
          queryEmbedding,
          limit,
        }),
      ),
    );

    const retrieved = hits.map((h) => h.chunkId);
    const overThreshold = passesThreshold(hits, threshold);

    // Recall medido sobre CONTENIDO y no sobre ids: los ids de fragmento nacen
    // en la ingesta, así que un conjunto de casos no puede declararlos por
    // adelantado y `expectedSources` se queda vacío siempre. Sin esto, recall y
    // precisión dividen 0 entre 0 y el informe dice 100% sin haber medido nada.
    const sourceFound = expectedSourceFound(testCase, hits);

    // Capa 1 del grounding: si nada supera el umbral, NO se genera. El coste de
    // una abstención es cero, y esa es la propiedad que hace medible el sistema
    // sin gastar.
    if (!overThreshold) {
      outcomes.push({
        caseId: testCase.id,
        kind: testCase.kind,
        answered: false,
        retrieved,
        latencyMs: Math.round(performance.now() - startedAt),
        cost: 0,
        ...(sourceFound === undefined ? {} : { sourceFound }),
      });
      continue;
    }

    if (mode === "retrieval" || options.generate === undefined) {
      // Sin generador, superar el umbral se cuenta como "había material".
      // NO es equivalente a "habría respondido": el generador puede tener los
      // fragmentos delante y abstenerse correctamente porque no contestan. Por
      // eso las métricas de abstención de este modo no son válidas.
      outcomes.push({
        caseId: testCase.id,
        kind: testCase.kind,
        answered: true,
        retrieved,
        latencyMs: Math.round(performance.now() - startedAt),
        cost: 0,
        ...(sourceFound === undefined ? {} : { sourceFound }),
      });
      continue;
    }

    const generated = await options.generate(testCase.question, hits);

    outcomes.push({
      caseId: testCase.id,
      kind: testCase.kind,
      answered: generated.answered,
      retrieved,
      response: generated.response,
      citations: generated.citations,
      latencyMs: Math.round(performance.now() - startedAt),
      cost: generated.cost,
      ...(sourceFound === undefined ? {} : { sourceFound }),
      ...(generated.groundingFailures !== undefined
        ? { groundingFailures: generated.groundingFailures }
        : {}),
    });
  }

  const metrics = computeMetrics(options.cases, outcomes);

  return {
    mode,
    metrics,
    gate: evaluateGate(metrics, options.thresholds ?? DEFAULT_THRESHOLDS),
    outcomes,
    suiteWarnings: [
      ...assessSuiteComposition(options.cases),
      ...(mode === "retrieval"
        ? [
            "Modo retrieval: las cifras de abstención NO son válidas. Sin " +
              "generador, superar el umbral se cuenta como respuesta, y la " +
              "similitud coseno separa respondibles de no respondibles por " +
              "apenas 0,0075 en este modelo. Para medir abstención hace falta " +
              "el modo full.",
          ]
        : []),
    ],
    embeddingProvider: options.embedder.id,
    embeddingModel: options.embedder.model,
    embeddingDimensions: options.embedder.dimensions,
    ...(options.generator === undefined ? {} : { generator: options.generator }),
  };
}

/**
 * ¿Apareció el texto esperado en algún fragmento recuperado?
 *
 * `undefined` cuando el caso no declara nada que buscar — que no es lo mismo
 * que `false`, y confundirlos es justo el error que esto viene a arreglar: un
 * caso sin expectativa declarada no debe contar como fallo de recuperación ni
 * como acierto.
 */
function expectedSourceFound(
  testCase: EvalCase,
  hits: RetrievalHit[],
): boolean | undefined {
  if (testCase.kind !== "ANSWERABLE") return undefined;

  const expected = testCase.expectedContains ?? [];
  if (expected.length === 0) return undefined;

  const haystack = hits.map((hit) => normalizeText(hit.content)).join("\n");
  return expected.some((term) => haystack.includes(normalizeText(term)));
}

function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Informe legible para consola y CI. */
export function formatReport(report: RunReport): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  // Un porcentaje sobre cero casos no es un porcentaje. Decir "n/a" y cuántos
  // casos lo midieron es la diferencia entre un informe y un adorno.
  const measured = (value: number, cases: number): string =>
    cases === 0 ? "n/a  (ningún caso lo mide)" : `${pct(value)}  (${cases} casos)`;
  const m = report.metrics;

  const lines = [
    "",
    "══ Conjunto de evaluación ══",
    `Modo:        ${report.mode}${report.mode === "retrieval" ? "  (sin generación: coste cero)" : ""}`,
    `Embeddings:  ${report.embeddingProvider} · ${report.embeddingModel} · ${report.embeddingDimensions}d`,
    ...(report.generator === undefined
      ? []
      : [`Generador:   ${report.generator.provider} · ${report.generator.model}`]),
    `Casos:       ${m.total}  (respondibles ${m.byKind.ANSWERABLE} · sin respuesta ${m.byKind.UNANSWERABLE} · prohibidas ${m.byKind.FORBIDDEN})`,
    "",
    "── Recuperación ──",
    `  Recall@k              ${measured(m.recallAtK, m.recallCases)}`,
    `  Precision             ${measured(m.precision, m.precisionCases)}`,
    "",
    report.mode === "full"
      ? "── Abstención (lo que decide si es vendible) ──"
      : "── Abstención (NO medible sin generador — ver aviso) ──",
    `  Abstención correcta   ${pct(m.correctAbstention)}`,
    `  Tasa de alucinación   ${pct(m.hallucinationRate)}`,
    `  Sobreabstención       ${pct(m.overAbstention)}`,
    "",
    "── Seguridad y coste ──",
    `  Respuestas erróneas   ${pct(m.wrongAnswerRate)}${
      m.wrongAnswers.length === 0 ? "" : `  → ${m.wrongAnswers.join(", ")}`
    }`,
    `  Violaciones del ADN   ${m.forbiddenViolations}`,
    `  Fallos de citación    ${pct(m.groundingFailureRate)}`,
    `  Latencia p50 / p95    ${m.latencyP50} ms / ${m.latencyP95} ms`,
    `  Coste total           $${m.totalCost.toFixed(4)}`,
    "",
  ];

  if (report.suiteWarnings.length > 0) {
    lines.push("── Avisos sobre el conjunto ──");
    for (const warning of report.suiteWarnings) lines.push(`  ⚠ ${warning}`);
    lines.push("");
  }

  lines.push(report.gate.passed ? "RESULTADO: PASA" : "RESULTADO: BLOQUEA");
  for (const failure of report.gate.failures) lines.push(`  ✖ ${failure}`);
  lines.push("");

  return lines.join("\n");
}
