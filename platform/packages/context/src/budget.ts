import {
  ContextAssemblyError,
  UNTRUNCATABLE,
  type BudgetSlot,
  type ConversationTurn,
  type RetrievedChunk,
  type TruncationNote,
} from "./types.js";

/**
 * El asignador de presupuesto (§6.2) — la parte de ingeniería real del
 * Context Engine.
 *
 * "Historial + CRM + RAG + datos en vivo + reglas + ADN" desborda la ventana el
 * día que un cliente sube un manual grande. Y desborda **en producción**, no en
 * pruebas, porque en pruebas el corpus siempre es pequeño.
 */

/**
 * Estimación de tokens sin llamar a un tokenizador remoto.
 *
 * Es deliberadamente CONSERVADORA (sobreestima) y no pretende ser exacta: se
 * usa para decidir qué cabe, y equivocarse por exceso deja hueco libre,
 * mientras que equivocarse por defecto produce un 400 del proveedor a mitad de
 * una respuesta. Para español, ~3,5 caracteres por token es un límite superior
 * razonable; el tokenizador real del proveedor decide la factura.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export interface AllocationInput {
  total: number;
  /** Coste fijo de los bloques que no se truncan nunca. */
  fixedCost: number;
}

export interface AllocationResult<T> {
  kept: T[];
  note?: TruncationNote;
  used: number;
}

/**
 * Recorta fragmentos por puntuación ascendente: se va el peor primero.
 *
 * Recortar por orden de llegada sería más simple y es exactamente el error que
 * hace que la respuesta empeore sin motivo aparente — el fragmento decisivo
 * puede llegar el último.
 */
export function allocateChunks(
  chunks: RetrievedChunk[],
  available: number,
): AllocationResult<RetrievedChunk> {
  if (available <= 0) {
    return chunks.length === 0
      ? { kept: [], used: 0 }
      : {
          kept: [],
          used: 0,
          note: {
            slot: "retrieved",
            dropped: chunks.length,
            kept: 0,
            reason: "sin presupuesto disponible para fragmentos",
          },
        };
  }

  const ranked = [...chunks].sort((a, b) => b.score - a.score);
  const kept: RetrievedChunk[] = [];
  let used = 0;

  for (const chunk of ranked) {
    const cost = chunk.tokenCount > 0 ? chunk.tokenCount : estimateTokens(chunk.content);
    if (used + cost > available) continue;
    kept.push(chunk);
    used += cost;
  }

  const dropped = chunks.length - kept.length;
  if (dropped === 0) return { kept, used };

  return {
    kept,
    used,
    note: {
      slot: "retrieved",
      dropped,
      kept: kept.length,
      reason: `${dropped} fragmento(s) descartados por presupuesto, empezando por la puntuación más baja`,
    },
  };
}

/**
 * Compacta el historial conservando los turnos MÁS RECIENTES.
 *
 * Al revés que los fragmentos: en una conversación lo que importa es el final.
 * Recortar por el final rompe la correferencia — "¿y la roja?" deja de tener
 * antecedente — que es justo lo que la memoria conversacional existe para
 * resolver.
 */
export function allocateConversation(
  turns: ConversationTurn[],
  available: number,
): AllocationResult<ConversationTurn> {
  if (available <= 0) {
    return turns.length === 0
      ? { kept: [], used: 0 }
      : {
          kept: [],
          used: 0,
          note: {
            slot: "conversation",
            dropped: turns.length,
            kept: 0,
            reason: "sin presupuesto disponible para historial",
          },
        };
  }

  const kept: ConversationTurn[] = [];
  let used = 0;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i] as ConversationTurn;
    const cost = estimateTokens(turn.content);
    if (used + cost > available) break;
    kept.unshift(turn);
    used += cost;
  }

  const dropped = turns.length - kept.length;
  if (dropped === 0) return { kept, used };

  return {
    kept,
    used,
    note: {
      slot: "conversation",
      dropped,
      kept: kept.length,
      reason: `${dropped} turno(s) antiguos compactados; se conservan los más recientes`,
    },
  };
}

/**
 * Reparte el presupuesto restante entre los slots truncables.
 *
 * Los pesos no son porcentajes exactos sino un orden de servicio: cada slot
 * toma lo que necesita hasta su tope, y lo que sobra pasa al siguiente. Un
 * reparto rígido dejaría hueco sin usar en una consulta sin historial.
 */
export const SLOT_SHARE: Partial<Record<BudgetSlot, number>> = {
  rules: 0.1,
  liveData: 0.15,
  retrieved: 0.5,
  customer: 0.05,
  conversation: 0.15,
  dnaVoice: 0.05,
};

/**
 * Suelos garantizados, por encima del reparto porcentual.
 *
 * Las reglas de negocio son prioridad 3 pero solo tienen un 10% de cuota, y con
 * presupuesto ajustado se caían enteras. Una regla vigente que desaparece
 * —"envío gratis desde 300 €"— hace que el modelo responda la política ANTERIOR
 * con total seguridad, y eso no se distingue de una respuesta correcta.
 *
 * Las reglas son pocas y cortas por naturaleza (una frase cada una), así que
 * garantizarles un mínimo es barato. El suelo nunca supera lo que queda: si de
 * verdad no hay sitio, se declara el recorte como cualquier otro.
 */
export const SLOT_FLOOR: Partial<Record<BudgetSlot, number>> = {
  rules: 600,
};

export function shareFor(slot: BudgetSlot, remaining: number): number {
  const share = SLOT_SHARE[slot];
  if (share === undefined) {
    throw new ContextAssemblyError(
      `El slot "${slot}" no tiene cuota declarada. Si es truncable, decláralo ` +
        "en SLOT_SHARE; si no lo es, debe estar en UNTRUNCATABLE.",
    );
  }

  const proportional = Math.floor(remaining * share);
  const floor = SLOT_FLOOR[slot] ?? 0;
  return Math.min(Math.max(proportional, floor), Math.max(remaining, 0));
}

/**
 * Verifica que lo intruncable quepa ANTES de repartir nada más.
 *
 * Falla ruidosamente si no cabe. La alternativa —recortar las prohibiciones
 * para que entre el catálogo— es exactamente el fallo que §6.3 existe para
 * impedir, y es un fallo que no se ve: la respuesta sale, simplemente sale sin
 * los límites puestos.
 */
export function assertFixedFits(input: AllocationInput): number {
  const remaining = input.total - input.fixedCost;
  if (remaining < 0) {
    throw new ContextAssemblyError(
      `Los bloques intruncables (${input.fixedCost} tokens) no caben en el ` +
        `presupuesto (${input.total}). Slots protegidos: ${UNTRUNCATABLE.join(", ")}. ` +
        "Se aborta a propósito: servir sin las prohibiciones del ADN es peor " +
        "que no servir.",
    );
  }
  return remaining;
}
