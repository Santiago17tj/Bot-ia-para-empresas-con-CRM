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
export type { EvalMode, RunOptions, RunReport } from "./runner.js";
