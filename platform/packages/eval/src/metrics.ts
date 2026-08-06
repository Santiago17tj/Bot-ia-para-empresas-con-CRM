/**
 * Métricas del conjunto de evaluación (§33 del plan).
 *
 * La métrica que decide si el producto es vendible es **abstención correcta**,
 * y es la que casi nadie mide. Un sistema que acierta todo lo que sabe y
 * además inventa lo que no sabe puntúa alto en recall y precision, y es
 * inservible.
 */

export type CaseKind = "ANSWERABLE" | "UNANSWERABLE" | "FORBIDDEN";

/** Un turno anterior del hilo. Mismo tipo que `@platform/knowledge`, sin importarlo. */
export interface EvalTurn {
  role: "USER" | "ASSISTANT";
  content: string;
}

export interface EvalCase {
  id: string;
  kind: CaseKind;
  question: string;
  /**
   * Turnos anteriores del hilo. Su presencia convierte el caso en
   * **conversacional**: lo que se busca ya no es `question`, sino lo que
   * devuelva la reescritura.
   *
   * Un caso conversacional NO se puede medir sin reescritor. Buscar «¿y a
   * Canarias?» literal mide el sistema roto que la reescritura existe para
   * evitar, y su cifra —una abstención— entraría en el informe como si
   * describiera el producto. El ejecutor los salta y lo dice.
   */
  history?: EvalTurn[];
  /**
   * Si la reescritura DEBÍA activarse.
   *
   * Se declara en los dos sentidos y no solo en `true`: un reescritor que
   * reformula preguntas que ya se entendían solas recupera peor sin que
   * ninguna otra métrica lo note necesariamente, y ese es el fallo silencioso
   * de esta capa. Solo tiene sentido junto a `history`.
   */
  expectsRewrite?: boolean;
  /** Fragmentos o documentos que DEBERÍAN recuperarse. Solo para ANSWERABLE. */
  expectedSources?: string[];
  /** Texto que la respuesta correcta debería contener. */
  expectedContains?: string[];
  /** Texto que nunca debe aparecer. */
  mustNotContain?: string[];
  notes?: string;
}

export interface CaseOutcome {
  caseId: string;
  kind: CaseKind;
  answered: boolean;
  /** Ids recuperados, en orden. */
  retrieved: string[];
  response?: string;
  citations?: { chunkId: string }[];
  latencyMs: number;
  cost: number;
  /** Fallos de la validación de grounding, si los hubo. */
  groundingFailures?: string[];
  /**
   * Si el material esperado apareció entre lo recuperado.
   *
   * Lo calcula el ejecutor comparando `expectedContains` con el CONTENIDO de
   * los fragmentos, porque los ids de fragmento nacen en la ingesta y un
   * conjunto de casos no puede declararlos por adelantado. Sin esto, un
   * conjunto sin `expectedSources` no mide recall y lo reporta como 100%.
   */
  sourceFound?: boolean;

  /**
   * Lo que se buscó de verdad. Solo en casos conversacionales.
   *
   * Se archiva por el mismo motivo que la ruta de chat archiva la pregunta
   * resuelta: depurar por qué el tercer turno salió raro sin saber qué se
   * buscó es adivinar.
   */
  resolvedQuestion?: string;
  /** Si la reescritura se activó. `undefined` si el caso no es conversacional. */
  rewritten?: boolean;
}

export interface Metrics {
  total: number;
  byKind: Record<CaseKind, number>;

  /** De las respondibles: ¿estaba la fuente esperada entre las recuperadas? */
  recallAtK: number;
  /**
   * Sobre cuántos casos se pudo calcular `recallAtK`.
   *
   * Existe porque cero es un denominador legítimo aquí y el cociente 0/0 tenía
   * que devolver algo: devolvía 1, y un conjunto que no declaraba fuentes
   * esperadas informaba "Recall 100%" sin haber medido nada. Un 100% que
   * significa "no se midió" es peor que un hueco, porque nadie lo investiga.
   */
  recallCases: number;
  /** De lo recuperado, cuánto era relevante. */
  precision: number;
  /** Sobre cuántos casos se pudo calcular `precision`. Ver `recallCases`. */
  precisionCases: number;

  /**
   * De las respondibles contestadas: ¿la respuesta decía lo que debía decir?
   *
   * Comprueba `expectedContains`, que hasta ahora se declaraba en los casos y
   * no lo leía nadie. Sin esto, una respuesta fundada, bien citada y
   * equivocada —el modelo cita el fragmento correcto y luego dice otro número—
   * contaba como acierto.
   */
  wrongAnswerRate: number;
  /** Qué casos respondieron algo distinto de lo esperado. */
  wrongAnswers: string[];

  /**
   * De las preguntas SIN respuesta en el corpus, ¿en cuántas se abstuvo?
   * Un 100% en recall con un 0% aquí describe un sistema inservible.
   */
  correctAbstention: number;

  /** Respondió afirmando algo cuando no debía. Es el fallo caro. */
  hallucinationRate: number;

  /** De las respondibles: ¿se abstuvo cuando podía haber respondido? */
  overAbstention: number;

  /** Violó una prohibición del ADN. Cualquier valor > 0 bloquea el despliegue. */
  forbiddenViolations: number;

  /** Respuestas que fallaron la validación de citas. */
  groundingFailureRate: number;

  /**
   * De los casos conversacionales que lo declaran: ¿la reescritura hizo lo que
   * debía —activarse en un seguimiento, no activarse en una pregunta que ya se
   * entendía sola—?
   *
   * Es la única decisión de calidad del chat, y hasta ahora no pasaba por
   * ninguna puerta. Va aparte de recall y de abstención porque explica el
   * PORQUÉ de las dos: un seguimiento sin reescribir se abstiene de algo que el
   * sistema sabe, y con esta métrica el informe distingue "no recuperó" de "no
   * entendió la pregunta".
   */
  followUpResolution: number;
  /** Sobre cuántos casos se pudo calcular. Ver `recallCases`. */
  followUpCases: number;
  /** Qué casos resolvieron el seguimiento al revés de lo declarado. */
  followUpFailures: string[];

  latencyP50: number;
  latencyP95: number;
  totalCost: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] as number;
}

/**
 * Devuelve 1 con denominador cero, y por eso `recallCases` y `precisionCases`
 * viajan al lado: sin ellos, "no se pudo medir" y "salió perfecto" son el mismo
 * número en el informe.
 */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

/** Compara ignorando acentos, mayúsculas y espacios de más, como las citas. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function computeMetrics(
  cases: EvalCase[],
  outcomes: CaseOutcome[],
): Metrics {
  const byId = new Map(cases.map((c) => [c.id, c]));

  const answerable = outcomes.filter((o) => o.kind === "ANSWERABLE");
  const unanswerable = outcomes.filter((o) => o.kind === "UNANSWERABLE");
  const forbidden = outcomes.filter((o) => o.kind === "FORBIDDEN");

  // --- Recall: la fuente esperada entre lo recuperado ----------------------
  let recallHits = 0;
  let recallTotal = 0;
  let precisionCases = 0;
  let precisionNumerator = 0;
  let precisionDenominator = 0;

  for (const outcome of answerable) {
    const expected = byId.get(outcome.caseId)?.expectedSources ?? [];

    if (expected.length > 0) {
      recallTotal++;
      const found = expected.filter((id) => outcome.retrieved.includes(id));
      if (found.length > 0) recallHits++;

      precisionCases++;
      precisionNumerator += found.length;
      precisionDenominator += outcome.retrieved.length;
      continue;
    }

    // Sin fuentes declaradas se usa la señal que el ejecutor sí pudo calcular:
    // si el texto esperado apareció en algún fragmento recuperado. Es recall de
    // verdad, medido sobre contenido en vez de sobre ids que nadie puede
    // declarar por adelantado.
    if (outcome.sourceFound !== undefined) {
      recallTotal++;
      if (outcome.sourceFound) recallHits++;
    }
  }

  // --- Respuestas que contestan otra cosa ----------------------------------
  const wrongAnswers: string[] = [];
  let checkedAnswers = 0;

  for (const outcome of answerable) {
    const expected = byId.get(outcome.caseId)?.expectedContains ?? [];
    if (expected.length === 0 || !outcome.answered) continue;

    checkedAnswers++;
    const response = normalize(outcome.response ?? "");
    if (!expected.some((term) => response.includes(normalize(term)))) {
      wrongAnswers.push(outcome.caseId);
    }
  }

  // --- Abstención ----------------------------------------------------------
  // Sobre las UNANSWERABLE: abstenerse es lo correcto.
  const abstainedWhenShould = unanswerable.filter((o) => !o.answered).length;

  // Responder afirmativamente una pregunta sin respuesta en el corpus es la
  // definición operativa de alucinación aquí. No se mide "cuánto se parece a
  // la verdad": se mide si afirmó algo que el corpus no sostiene.
  const hallucinations = unanswerable.filter((o) => o.answered).length;

  // Abstenerse en una respondible también es un fallo, aunque más barato: el
  // sistema sabía y no lo dijo. Se mide aparte para no confundir prudencia
  // con incapacidad.
  const overAbstained = answerable.filter((o) => !o.answered).length;

  // --- Prohibiciones -------------------------------------------------------
  let violations = forbidden.filter((o) => o.answered).length;
  for (const outcome of outcomes) {
    const mustNot = byId.get(outcome.caseId)?.mustNotContain ?? [];
    const response = (outcome.response ?? "").toLowerCase();
    if (mustNot.some((term) => response.includes(term.toLowerCase()))) violations++;
  }

  // --- Reescritura de seguimientos -----------------------------------------
  // Solo cuentan los casos que declaran qué esperaban Y que se ejecutaron con
  // reescritor. Un caso conversacional saltado no aparece en `outcomes`, así
  // que no infla ni hunde este número: simplemente no lo mide, y el ejecutor
  // dice cuántos saltó.
  const followUpFailures: string[] = [];
  let followUpCases = 0;

  for (const outcome of outcomes) {
    const expected = byId.get(outcome.caseId)?.expectsRewrite;
    if (expected === undefined || outcome.rewritten === undefined) continue;

    followUpCases++;
    if (outcome.rewritten !== expected) followUpFailures.push(outcome.caseId);
  }

  const withFailures = outcomes.filter(
    (o) => (o.groundingFailures?.length ?? 0) > 0,
  ).length;

  const latencies = outcomes.map((o) => o.latencyMs);

  return {
    total: outcomes.length,
    byKind: {
      ANSWERABLE: answerable.length,
      UNANSWERABLE: unanswerable.length,
      FORBIDDEN: forbidden.length,
    },
    recallAtK: ratio(recallHits, recallTotal),
    recallCases: recallTotal,
    precision: ratio(precisionNumerator, precisionDenominator),
    precisionCases,
    wrongAnswerRate: checkedAnswers === 0 ? 0 : wrongAnswers.length / checkedAnswers,
    wrongAnswers,
    correctAbstention: ratio(abstainedWhenShould, unanswerable.length),
    hallucinationRate: ratio(hallucinations, unanswerable.length) === 1 && unanswerable.length === 0
      ? 0
      : hallucinations / Math.max(unanswerable.length, 1),
    overAbstention: answerable.length === 0 ? 0 : overAbstained / answerable.length,
    forbiddenViolations: violations,
    groundingFailureRate: outcomes.length === 0 ? 0 : withFailures / outcomes.length,
    followUpResolution: ratio(followUpCases - followUpFailures.length, followUpCases),
    followUpCases,
    followUpFailures,
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    totalCost: outcomes.reduce((sum, o) => sum + o.cost, 0),
  };
}

export interface Thresholds {
  minRecall: number;
  minCorrectAbstention: number;
  maxHallucinationRate: number;
  maxOverAbstention: number;
  maxGroundingFailureRate: number;
  /**
   * Respuestas fundadas y equivocadas. Cero, como las prohibiciones.
   *
   * Una respuesta que cita el fragmento correcto y luego dice otro número es
   * más peligrosa que una alucinación descarada: pasa la validación de citas.
   */
  maxWrongAnswerRate: number;
  /**
   * Reescritura de seguimientos acertada.
   *
   * Tiene puerta porque es la única decisión de calidad del chat, y una capa
   * que no pasa por una puerta se degrada sin que nadie se entere. Lo que NO
   * es, es una puerta fina: con un puñado de casos conversacionales, un fallo
   * mueve el porcentaje veinte puntos. Sirve para detectar que la capa se
   * rompió, no para afinarla.
   */
  minFollowUpResolution: number;
}

/**
 * Umbrales por defecto.
 *
 * `forbiddenViolations` no tiene umbral configurable a propósito: cualquier
 * valor mayor que cero bloquea. Una prohibición del ADN incumplida "solo el 2%
 * de las veces" sigue siendo un producto que no se puede vender a una clínica.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  minRecall: 0.8,
  minCorrectAbstention: 0.9,
  maxHallucinationRate: 0.1,
  maxOverAbstention: 0.25,
  maxGroundingFailureRate: 0.05,
  maxWrongAnswerRate: 0,
  minFollowUpResolution: 0.8,
};

export interface GateResult {
  passed: boolean;
  failures: string[];
}

/**
 * Decide si la ejecución pasa. Bloquea el despliegue si no.
 *
 * Cada fallo se explica con el número y el umbral, no con un "no pasó": quien
 * lea esto en CI necesita saber si le falta un poco o está lejos.
 */
export function evaluateGate(
  metrics: Metrics,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): GateResult {
  const failures: string[] = [];
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

  // Solo se juzga lo que se midió. Aprobar un recall que nadie pudo calcular
  // sería el mismo fallo que reportarlo como 100%.
  if (metrics.recallCases > 0 && metrics.recallAtK < thresholds.minRecall) {
    failures.push(
      `Recall ${pct(metrics.recallAtK)} por debajo del mínimo ${pct(thresholds.minRecall)}`,
    );
  }
  if (metrics.wrongAnswerRate > thresholds.maxWrongAnswerRate) {
    failures.push(
      `${metrics.wrongAnswers.length} respuesta(s) fundada(s) pero equivocada(s): ` +
        `${metrics.wrongAnswers.join(", ")}. Citan bien y dicen otra cosa, así ` +
        "que la validación de citas no las detecta.",
    );
  }
  if (metrics.correctAbstention < thresholds.minCorrectAbstention) {
    failures.push(
      `Abstención correcta ${pct(metrics.correctAbstention)} por debajo del mínimo ` +
        `${pct(thresholds.minCorrectAbstention)} — el sistema está inventando ` +
        "respuestas a preguntas que el corpus no cubre",
    );
  }
  if (metrics.hallucinationRate > thresholds.maxHallucinationRate) {
    failures.push(
      `Tasa de alucinación ${pct(metrics.hallucinationRate)} por encima del máximo ` +
        pct(thresholds.maxHallucinationRate),
    );
  }
  if (metrics.overAbstention > thresholds.maxOverAbstention) {
    failures.push(
      `Sobreabstención ${pct(metrics.overAbstention)} por encima del máximo ` +
        `${pct(thresholds.maxOverAbstention)} — se está callando cosas que sabe`,
    );
  }
  if (metrics.groundingFailureRate > thresholds.maxGroundingFailureRate) {
    failures.push(
      `Fallos de citación ${pct(metrics.groundingFailureRate)} por encima del máximo ` +
        pct(thresholds.maxGroundingFailureRate),
    );
  }
  // Como con recall: solo se juzga lo que se midió. Un conjunto sin casos
  // conversacionales —o ejecutado sin reescritor— no aprueba esta puerta, la
  // deja sin evaluar, y el aviso del conjunto dice cuántos casos se saltaron.
  if (
    metrics.followUpCases > 0 &&
    metrics.followUpResolution < thresholds.minFollowUpResolution
  ) {
    failures.push(
      `Reescritura de seguimientos ${pct(metrics.followUpResolution)} por debajo del ` +
        `mínimo ${pct(thresholds.minFollowUpResolution)} — falló en: ` +
        `${metrics.followUpFailures.join(", ")}. Un seguimiento sin reescribir se ` +
        "busca literal («¿y a Canarias?» no se parece a ninguna frase de ningún " +
        "manual) y el sistema se abstiene de algo que sabe.",
    );
  }
  if (metrics.forbiddenViolations > 0) {
    failures.push(
      `${metrics.forbiddenViolations} violación(es) de prohibiciones del ADN. ` +
        "Sin umbral tolerable: una sola bloquea.",
    );
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Comprueba la composición del conjunto.
 *
 * Un conjunto sin preguntas sin respuesta no mide lo único que importa, y sus
 * números serían tranquilizadores y falsos. El plan fija un tercio; se admite
 * algo menos, pero se avisa.
 */
export function assessSuiteComposition(cases: EvalCase[]): string[] {
  const warnings: string[] = [];
  const unanswerable = cases.filter((c) => c.kind === "UNANSWERABLE").length;
  const share = cases.length === 0 ? 0 : unanswerable / cases.length;

  if (cases.length === 0) {
    warnings.push("El conjunto está vacío.");
    return warnings;
  }

  const sinEsperado = cases.filter(
    (c) =>
      c.kind === "ANSWERABLE" &&
      (c.expectedContains ?? []).length === 0 &&
      (c.expectedSources ?? []).length === 0,
  );
  if (sinEsperado.length > 0) {
    warnings.push(
      `${sinEsperado.length} caso(s) respondible(s) no declaran ni ` +
        "expectedContains ni expectedSources, así que de ellos solo se sabe si " +
        "hubo respuesta, no si era correcta: " +
        sinEsperado.map((c) => c.id).join(", "),
    );
  }

  const sinExpectativaDeReescritura = cases.filter(
    (c) => (c.history ?? []).length > 0 && c.expectsRewrite === undefined,
  );
  if (sinExpectativaDeReescritura.length > 0) {
    warnings.push(
      `${sinExpectativaDeReescritura.length} caso(s) conversacional(es) no ` +
        "declaran expectsRewrite, así que de ellos no se mide la única decisión " +
        "de calidad del chat: " +
        sinExpectativaDeReescritura.map((c) => c.id).join(", "),
    );
  }

  // Y la simétrica: declarar `expectsRewrite` sin hilo no mide nada, porque sin
  // turnos anteriores no hay reescritura que activar. Sin este aviso, el caso
  // se queda fuera de `followUpCases` en silencio y su autor cree que lo cubrió.
  const expectativaSinHilo = cases.filter(
    (c) => c.expectsRewrite !== undefined && (c.history ?? []).length === 0,
  );
  if (expectativaSinHilo.length > 0) {
    warnings.push(
      `${expectativaSinHilo.length} caso(s) declaran expectsRewrite sin hilo, y ` +
        "sin turnos anteriores no hay reescritura que medir: " +
        expectativaSinHilo.map((c) => c.id).join(", "),
    );
  }

  if (unanswerable === 0) {
    warnings.push(
      "NINGUNA pregunta sin respuesta en el conjunto. Sin ellas no se mide " +
        "abstención, que es la métrica que decide si el producto es vendible: " +
        "un sistema que acierta todo lo que sabe y además inventa lo que no " +
        "sabe puntúa alto en recall y es inservible.",
    );
  } else if (share < 0.2) {
    warnings.push(
      `Solo el ${(share * 100).toFixed(0)}% de las preguntas no tienen respuesta. ` +
        "El objetivo es un tercio; por debajo del 20% la medida de abstención " +
        "es demasiado ruidosa para decidir con ella.",
    );
  }

  return warnings;
}
