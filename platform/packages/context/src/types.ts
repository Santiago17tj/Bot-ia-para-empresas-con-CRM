/**
 * Context Engine (§5–6 del plan).
 *
 * El LLM nunca debería tener que DESCUBRIR qué información necesita. Debe
 * recibir un contexto consistente, verificable y presupuestado.
 *
 * Tres razones por las que esto es un módulo con nombre propio y no código
 * disperso por el orquestador:
 *
 *  1. Punto único de permisos. Si todo el contexto se ensambla aquí, el filtro
 *     se aplica en un sitio en vez de en siete. Un filtro olvidado en uno de
 *     siete caminos es una fuga; en un solo camino es un test.
 *  2. Punto único de presupuesto. La ventana es finita y cara.
 *  3. Punto único de trazabilidad. El paquete archivado es exactamente lo que
 *     hay que mirar para reconstruir una respuesta.
 */

export interface ActorRef {
  type: "contact" | "user" | "system";
  id: string;
  /** Ámbitos de API key o permisos derivados del rol. */
  scopes: readonly string[];
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  versionId: string;
  content: string;
  score: number;
  tokenCount: number;
  title?: string;
  sourceRef?: string;
  breadcrumbs?: string[];
  pageNumber?: number;
}

export interface BusinessRuleRef {
  id: string;
  statement: string;
  category: string;
  priority: number;
}

/**
 * El bloque del ADN que nunca se trunca.
 *
 * Si "nunca dar diagnósticos médicos" se cae del contexto por falta de espacio
 * en la conversación número cuarenta, el sistema da un diagnóstico. Va aparte
 * del resto del ADN precisamente para que el asignador de presupuesto no pueda
 * recortarlo aunque quiera.
 */
export interface DNACore {
  workspaceName: string;
  neverDo: string[];
  legalBoundaries: string[];
}

/** El resto del ADN: identidad y estilo. Esto sí se abrevia si hace falta. */
export interface DNAVoice {
  mission?: string;
  values?: string[];
  tone?: string;
  formality?: string;
  alwaysDo?: string[];
  escalationPhilosophy?: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface TokenBudget {
  total: number;
  used: number;
}

/**
 * Prioridades del presupuesto (§6.2).
 *
 * Cuando el paquete no cabe, se trunca por política DECLARADA, nunca por orden
 * de llegada. Los dos primeros niveles no se truncan jamás: sin permisos se
 * aborta, y sin prohibiciones el producto no es vendible a una clínica.
 */
export const BUDGET_PRIORITIES = [
  "identity", // 1 — permisos e identidad. Nunca se trunca; sin esto se aborta
  "dnaCore", // 2 — prohibiciones y límites legales. Nunca se trunca
  "rules", // 3 — reglas de negocio vigentes. Se filtran, no se recortan a medias
  "liveData", // 4 — datos en vivo. Se reduce el número de acciones
  "retrieved", // 5 — fragmentos. Se recortan por puntuación ascendente
  "customer", // 6 — perfil del cliente. Se resume
  "conversation", // 7 — historial. Se compacta
  "dnaVoice", // 8 — tono y estilo. Se abrevia
] as const;

export type BudgetSlot = (typeof BUDGET_PRIORITIES)[number];

/** Los dos niveles que el asignador tiene prohibido tocar. */
export const UNTRUNCATABLE: readonly BudgetSlot[] = ["identity", "dnaCore"];

export interface TruncationNote {
  slot: BudgetSlot;
  /** Qué se quitó, en unidades del propio slot (fragmentos, turnos…). */
  dropped: number;
  kept: number;
  reason: string;
}

export interface ContextPackage {
  tenantId: string;
  actor: ActorRef;
  channel: { type: string; maxLength: number };

  dnaCore: DNACore;
  dnaVoice?: DNAVoice;
  activeRules: BusinessRuleRef[];
  objectives: string[];

  conversation: ConversationTurn[];
  customerProfile?: Record<string, unknown>;

  retrieved: RetrievedChunk[];
  liveData: { action: string; result: unknown }[];

  budget: TokenBudget;
  /**
   * Lo que se truncó, y por qué.
   *
   * Un contexto recortado en silencio produce una respuesta peor sin que nadie
   * pueda explicar por qué, y esa es una queja irresoluble. Esta lista es la
   * mitad útil del campo `budget`.
   */
  truncated: TruncationNote[];

  /** Para caché y reproducibilidad. */
  packageHash: string;
}

export class ContextAssemblyError extends Error {
  override readonly name = "ContextAssemblyError";
}
