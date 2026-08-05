export {
  BUDGET_PRIORITIES,
  UNTRUNCATABLE,
  ContextAssemblyError,
} from "./types.js";
export type {
  ActorRef,
  BudgetSlot,
  BusinessRuleRef,
  ContextPackage,
  ConversationTurn,
  DNACore,
  DNAVoice,
  RetrievedChunk,
  TokenBudget,
  TruncationNote,
} from "./types.js";

export {
  estimateTokens,
  allocateChunks,
  allocateConversation,
  assertFixedFits,
  shareFor,
  SLOT_SHARE,
} from "./budget.js";
export type { AllocationInput, AllocationResult } from "./budget.js";

export {
  assembleContext,
  filterByPermissions,
  fixedCost,
  hashPackage,
  assertProhibitionsPresent,
} from "./assemble.js";
export type { AssembleInput, PermissionScope } from "./assemble.js";

export { RECIPES, DEFAULT_RECIPE, recipeFor, shouldRetrieve } from "./recipes.js";
export type { Recipe } from "./recipes.js";
