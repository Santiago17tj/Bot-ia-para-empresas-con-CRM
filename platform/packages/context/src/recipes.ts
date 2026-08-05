import type { BudgetSlot } from "./types.js";

/**
 * Recetas de contexto (§6.1) — la resolución de la tensión entre el Context
 * Engine y el planificador.
 *
 * El Engine dice "reúne todo y entrégalo". El planificador dice "decide qué
 * necesitas y solo entonces búscalo". Combinarlos sin pensarlo hace que se
 * pague dos veces: se recupera todo Y se planifica sobre ello.
 *
 * La resolución: una RECETA declara qué fuentes entran. Para intenciones
 * simples se elige por tabla, sin gastar ni una llamada al modelo. Solo cuando
 * la pregunta no encaja en ninguna interviene el planificador — y entonces el
 * plan ES la receta.
 */

export interface Recipe {
  name: string;
  /** Slots que se rellenan. Los ausentes se dejan vacíos, no se recuperan. */
  slots: BudgetSlot[];
  /** Fragmentos a pedir al recuperador. 0 = no se recupera nada. */
  retrievalDepth: number;
  description: string;
}

/**
 * Recetas por intención. Elegir aquí cuesta cero llamadas al modelo.
 *
 * Sin esta tabla, "¿cuál es el horario?" paga un ciclo de planificación
 * completo —tres o cuatro llamadas y dos segundos— para algo que resuelve una
 * consulta. En un producto que cobra por conversación, eso es la diferencia
 * entre margen y pérdida.
 */
export const RECIPES: Record<string, Recipe> = {
  factual_lookup: {
    name: "factual_lookup",
    slots: ["identity", "dnaCore", "rules", "retrieved"],
    retrievalDepth: 5,
    description:
      "Pregunta directa sobre el conocimiento. Sin historial ni perfil: la " +
      "respuesta no depende de quién pregunta ni de qué se dijo antes.",
  },

  conversational: {
    name: "conversational",
    slots: ["identity", "dnaCore", "rules", "retrieved", "conversation", "dnaVoice"],
    retrievalDepth: 8,
    description:
      "Pregunta con correferencia — '¿y la roja?'. Necesita historial o el " +
      "antecedente se pierde, que es justo lo que la memoria conversacional " +
      "existe para resolver.",
  },

  customer_specific: {
    name: "customer_specific",
    slots: [
      "identity",
      "dnaCore",
      "rules",
      "retrieved",
      "conversation",
      "customer",
      "liveData",
      "dnaVoice",
    ],
    retrievalDepth: 8,
    description:
      "Sobre el pedido, la factura o el historial de quien pregunta. Incluye " +
      "datos en vivo porque stock y estado de pedido no se indexan (§7.2).",
  },

  greeting: {
    name: "greeting",
    slots: ["identity", "dnaCore", "dnaVoice"],
    retrievalDepth: 0,
    description:
      "Saludo o cortesía. No se recupera NADA: buscar en el corpus para " +
      "responder 'hola' es gasto puro.",
  },

  /**
   * Cuando la intención no encaja en ninguna receta.
   *
   * No es un cajón de sastre: es la señal de que hay que planificar. El
   * orquestador la usa para decidir que merece la pena pagar el ciclo.
   */
  needs_planning: {
    name: "needs_planning",
    slots: [
      "identity",
      "dnaCore",
      "rules",
      "retrieved",
      "conversation",
      "customer",
      "liveData",
      "dnaVoice",
    ],
    retrievalDepth: 12,
    description:
      "Pregunta compleja o multi-fuente. El planificador decide qué entra; " +
      "esta receta es solo el techo de lo que puede pedir.",
  },
};

export const DEFAULT_RECIPE = "conversational";

export function recipeFor(intent: string): Recipe {
  return RECIPES[intent] ?? (RECIPES[DEFAULT_RECIPE] as Recipe);
}

/**
 * Si la receta no incluye `retrieved`, no se recupera — y eso ahorra la
 * consulta vectorial entera, no solo tokens de contexto.
 */
export function shouldRetrieve(recipe: Recipe): boolean {
  return recipe.slots.includes("retrieved") && recipe.retrievalDepth > 0;
}
