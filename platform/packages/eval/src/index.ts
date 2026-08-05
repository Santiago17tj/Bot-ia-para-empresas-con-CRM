export {
  computeMetrics,
  evaluateGate,
  assessSuiteComposition,
  DEFAULT_THRESHOLDS,
} from "./metrics.js";
export type {
  CaseKind,
  CaseOutcome,
  EvalCase,
  GateResult,
  Metrics,
  Thresholds,
} from "./metrics.js";

export { runSuite, formatReport } from "./runner.js";
export type { EvalMode, GenerateFn, RunOptions, RunReport } from "./runner.js";

export { createGenerator } from "./generator.js";
export type { GeneratorOptions } from "./generator.js";

export { CUSTOMER_SUPPORT_CORPUS, CUSTOMER_SUPPORT_CASES } from "./fixtures.js";
