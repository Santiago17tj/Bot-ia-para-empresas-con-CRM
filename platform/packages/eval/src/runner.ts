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
  type EvalTurn,
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
 *
 * **Los casos conversacionales necesitan reescritor, y sin él se saltan.** Un
 * caso con hilo mide el camino entero del chat: reescribir el seguimiento,
 * recuperar con lo reescrito, responder. Ejecutarlo sin reescritor buscaría
 * «¿y a Canarias?» literal, que no se parece a ninguna frase de ningún manual;
 * el resultado sería una abstención, y esa abstención entraría en el informe
 * como si describiera el producto. No lo describe: describe el sistema roto que
 * la reescritura existe para evitar. Por eso se saltan y se dice cuántos, en
 * vez de medirlos mal.
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
   * Reescritura de seguimientos. Sin ella, los casos con hilo se saltan.
   *
   * Va aparte de `generate` porque son dos llamadas al modelo distintas y con
   * ritmos distintos: la reescritura la paga cada turno de seguimiento aunque
   * la respuesta salga de caché o el umbral corte antes.
   */
  resolve?: ResolveFn;
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

export type ResolveFn = (
  question: string,
  history: EvalTurn[],
) => Promise<{
  /** Lo que hay que buscar. */
  question: string;
  rewritten: boolean;
  cost: number;
}>;

export interface RunReport {
  mode: EvalMode;
  metrics: Metrics;
  gate: GateResult;
  outcomes: CaseOutcome[];
  /**
   * Casos que no se ejecutaron, y por qué. Hoy solo los conversacionales sin
   * reescritor.
   *
   * Viaja en el informe y no en un `console.log` porque las métricas describen
   * únicamente lo que corrió: sin esta lista, un conjunto de trece casos del
   * que se midieron nueve informaría números perfectos y nadie sabría que
   * cuatro no se miraron.
   */
  skipped: { caseId: string; reason: string }[];
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
  const skipped: { caseId: string; reason: string }[] = [];
  const executed: EvalCase[] = [];

  for (const testCase of options.cases) {
    const history = testCase.history ?? [];
    const conversational = history.length > 0;

    if (conversational && options.resolve === undefined) {
      skipped.push({
        caseId: testCase.id,
        reason:
          "conversacional y no hay reescritor: buscar el seguimiento literal " +
          "mediría el sistema roto, no el producto",
      });
      continue;
    }

    executed.push(testCase);
    const startedAt = performance.now();

    // La reescritura es parte del camino medido: su coste y su latencia son
    // coste y latencia que el cliente paga en cada turno de seguimiento.
    let query = testCase.question;
    let rewritten: boolean | undefined;
    let resolveCost = 0;

    if (conversational && options.resolve !== undefined) {
      const resolved = await options.resolve(testCase.question, history);
      query = resolved.question;
      rewritten = resolved.rewritten;
      resolveCost = resolved.cost;
    }

    // A partir de aquí se busca `query`, no `testCase.question`: es justo la
    // diferencia entre medir el chat y medir el buscador.
    const queryEmbedding = await embedQuery(options.embedder, query);
    const hits = await runWithTenant(ctx, () =>
      withRlsTransaction((tx) =>
        hybridSearch(tx, {
          tenantId: options.tenantId,
          queryText: query,
          queryEmbedding,
          limit,
        }),
      ),
    );

    // Lo que se archiva de un caso conversacional, para que un fallo se pueda
    // leer sin volver a ejecutarlo.
    const conversationFields = conversational
      ? { resolvedQuestion: query, ...(rewritten === undefined ? {} : { rewritten }) }
      : {};

    const retrieved = hits.map((h) => h.chunkId);
    const overThreshold = passesThreshold(hits, threshold);

    // Recall medido sobre CONTENIDO y no sobre ids: los ids de fragmento nacen
    // en la ingesta, así que un conjunto de casos no puede declararlos por
    // adelantado y `expectedSources` se queda vacío siempre. Sin esto, recall y
    // precisión dividen 0 entre 0 y el informe dice 100% sin haber medido nada.
    const sourceFound = expectedSourceFound(testCase, hits);

    // Capa 1 del grounding: si nada supera el umbral, NO se genera. En un caso
    // de un turno eso hace que la abstención salga gratis, que es la propiedad
    // que permite medir sin gastar. En uno conversacional ya no: la reescritura
    // se pagó antes de saber que el umbral iba a cortar, y ese coste es real —
    // el cliente lo paga en cada seguimiento aunque la respuesta sea "no consta".
    if (!overThreshold) {
      outcomes.push({
        caseId: testCase.id,
        kind: testCase.kind,
        answered: false,
        retrieved,
        latencyMs: Math.round(performance.now() - startedAt),
        // Cero no: la reescritura ya se pagó aunque el umbral corte después.
        cost: resolveCost,
        ...(sourceFound === undefined ? {} : { sourceFound }),
        ...conversationFields,
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
        cost: resolveCost,
        ...(sourceFound === undefined ? {} : { sourceFound }),
        ...conversationFields,
      });
      continue;
    }

    const generated = await options.generate(query, hits);

    outcomes.push({
      caseId: testCase.id,
      kind: testCase.kind,
      answered: generated.answered,
      retrieved,
      response: generated.response,
      citations: generated.citations,
      latencyMs: Math.round(performance.now() - startedAt),
      cost: resolveCost + generated.cost,
      ...(sourceFound === undefined ? {} : { sourceFound }),
      ...conversationFields,
      ...(generated.groundingFailures !== undefined
        ? { groundingFailures: generated.groundingFailures }
        : {}),
    });
  }

  // Sobre `executed` y no sobre `options.cases`: las métricas describen lo que
  // corrió. Evaluar la composición de un conjunto del que se saltó un tercio
  // describiría un conjunto que no se midió.
  const metrics = computeMetrics(executed, outcomes);

  return {
    mode,
    metrics,
    gate: evaluateGate(metrics, options.thresholds ?? DEFAULT_THRESHOLDS),
    outcomes,
    skipped,
    suiteWarnings: [
      ...assessSuiteComposition(executed),
      ...(skipped.length === 0
        ? []
        : [
            `${skipped.length} caso(s) conversacional(es) saltado(s) por no haber ` +
              `reescritor: ${skipped.map((s) => s.caseId).join(", ")}. La ` +
              "reescritura de seguimientos NO se midió en esta ejecución.",
          ]),
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
    "── Conversación (lo único del chat que es núcleo) ──",
    `  Reescritura           ${measured(m.followUpResolution, m.followUpCases)}${
      m.followUpFailures.length === 0 ? "" : `  → ${m.followUpFailures.join(", ")}`
    }`,
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

  if (report.skipped.length > 0) {
    lines.push("── Casos no ejecutados ──");
    for (const item of report.skipped) {
      lines.push(`  ⊘ ${item.caseId}: ${item.reason}`);
    }
    lines.push("");
  }

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
