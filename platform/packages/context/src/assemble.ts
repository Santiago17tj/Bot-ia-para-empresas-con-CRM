import { createHash } from "node:crypto";

import {
  allocateChunks,
  allocateConversation,
  assertFixedFits,
  estimateTokens,
  shareFor,
} from "./budget.js";
import {
  ContextAssemblyError,
  type ActorRef,
  type BusinessRuleRef,
  type ContextPackage,
  type ConversationTurn,
  type DNACore,
  type DNAVoice,
  type RetrievedChunk,
  type TruncationNote,
} from "./types.js";

/**
 * Ensamblador del Context Package (§6).
 *
 * Es el ejecutor del plan, no su competidor: la RECETA dice qué fuentes entran
 * y con qué presupuesto, y esta función las reúne, filtra por permisos, las
 * ajusta al presupuesto y declara lo que tuvo que recortar.
 */

/**
 * Qué puede leer el actor.
 *
 * Un fragmento sin `permissions` es público dentro del tenant. Uno con
 * `requiredScopes` exige que el actor los tenga TODOS.
 */
export interface PermissionScope {
  requiredScopes?: string[];
}

export interface AssembleInput {
  tenantId: string;
  actor: ActorRef;
  channel: { type: string; maxLength: number };

  dnaCore: DNACore;
  dnaVoice?: DNAVoice;
  activeRules?: BusinessRuleRef[];
  objectives?: string[];

  conversation?: ConversationTurn[];
  customerProfile?: Record<string, unknown>;
  retrieved?: RetrievedChunk[];
  liveData?: { action: string; result: unknown }[];

  /** Presupuesto total de tokens para el paquete. */
  tokenBudget: number;
}

/**
 * Filtra fragmentos por permisos. **Punto único de aplicación** (§5).
 *
 * Si todo el contexto se ensambla aquí, el filtro se aplica en un sitio en vez
 * de en siete. Un filtro olvidado en uno de siete caminos es una fuga; en un
 * solo camino es un test — y ese test está en context.test.ts.
 */
export function filterByPermissions(
  chunks: RetrievedChunk[],
  actorScopes: readonly string[],
  permissionsOf: (chunk: RetrievedChunk) => PermissionScope | undefined,
): { allowed: RetrievedChunk[]; denied: number } {
  const scopes = new Set(actorScopes);
  const allowed: RetrievedChunk[] = [];
  let denied = 0;

  for (const chunk of chunks) {
    const required = permissionsOf(chunk)?.requiredScopes;
    if (required === undefined || required.length === 0) {
      allowed.push(chunk);
      continue;
    }
    if (required.every((scope) => scopes.has(scope))) {
      allowed.push(chunk);
    } else {
      denied++;
    }
  }

  return { allowed, denied };
}

/** Coste en tokens del bloque intruncable: identidad + núcleo del ADN. */
export function fixedCost(input: AssembleInput): number {
  const identity = `${input.tenantId}${input.actor.type}${input.actor.id}${input.channel.type}`;
  const core = [
    input.dnaCore.workspaceName,
    ...input.dnaCore.neverDo,
    ...input.dnaCore.legalBoundaries,
  ].join("\n");
  return estimateTokens(identity) + estimateTokens(core);
}

/**
 * Ensambla el paquete.
 *
 * Ninguna fuente se recorta antes de comprobar que lo intruncable cabe: si las
 * prohibiciones del ADN no entran, se aborta. Servir sin ellas es peor que no
 * servir, y es un fallo que no se ve — la respuesta sale, simplemente sale sin
 * los límites puestos.
 */
export function assembleContext(input: AssembleInput): ContextPackage {
  if (input.tenantId === "") {
    throw new ContextAssemblyError("No se puede ensamblar contexto sin tenant.");
  }

  const truncated: TruncationNote[] = [];
  const fixed = fixedCost(input);
  let remaining = assertFixedFits({ total: input.tokenBudget, fixedCost: fixed });
  let used = fixed;

  // --- Prioridad 3: reglas de negocio vigentes -----------------------------
  // Se filtran por prioridad descendente, no se recortan a medias: media regla
  // es peor que ninguna, porque el modelo la aplica igual.
  const rules = [...(input.activeRules ?? [])].sort((a, b) => b.priority - a.priority);
  const rulesBudget = shareFor("rules", remaining);
  const keptRules: BusinessRuleRef[] = [];
  let rulesUsed = 0;
  for (const rule of rules) {
    const cost = estimateTokens(rule.statement);
    if (rulesUsed + cost > rulesBudget) continue;
    keptRules.push(rule);
    rulesUsed += cost;
  }
  if (keptRules.length < rules.length) {
    truncated.push({
      slot: "rules",
      dropped: rules.length - keptRules.length,
      kept: keptRules.length,
      reason: "reglas de menor prioridad omitidas por presupuesto",
    });
  }
  used += rulesUsed;
  remaining -= rulesUsed;

  // --- Prioridad 4: datos en vivo ------------------------------------------
  const liveData = input.liveData ?? [];
  const liveBudget = shareFor("liveData", remaining);
  const keptLive: typeof liveData = [];
  let liveUsed = 0;
  for (const entry of liveData) {
    const cost = estimateTokens(JSON.stringify(entry.result));
    if (liveUsed + cost > liveBudget) continue;
    keptLive.push(entry);
    liveUsed += cost;
  }
  if (keptLive.length < liveData.length) {
    truncated.push({
      slot: "liveData",
      dropped: liveData.length - keptLive.length,
      kept: keptLive.length,
      reason: "resultados de acciones omitidos por presupuesto",
    });
  }
  used += liveUsed;
  remaining -= liveUsed;

  // --- Prioridad 5: fragmentos recuperados ---------------------------------
  const chunkAllocation = allocateChunks(
    input.retrieved ?? [],
    shareFor("retrieved", remaining),
  );
  if (chunkAllocation.note) truncated.push(chunkAllocation.note);
  used += chunkAllocation.used;
  remaining -= chunkAllocation.used;

  // --- Prioridad 6: perfil del cliente -------------------------------------
  let customerProfile = input.customerProfile;
  if (customerProfile !== undefined) {
    const cost = estimateTokens(JSON.stringify(customerProfile));
    const budget = shareFor("customer", remaining);
    if (cost > budget) {
      customerProfile = undefined;
      truncated.push({
        slot: "customer",
        dropped: 1,
        kept: 0,
        reason: "perfil del cliente omitido por presupuesto",
      });
    } else {
      used += cost;
      remaining -= cost;
    }
  }

  // --- Prioridad 7: historial ----------------------------------------------
  const conversationAllocation = allocateConversation(
    input.conversation ?? [],
    shareFor("conversation", remaining),
  );
  if (conversationAllocation.note) truncated.push(conversationAllocation.note);
  used += conversationAllocation.used;
  remaining -= conversationAllocation.used;

  // --- Prioridad 8: voz del ADN --------------------------------------------
  let dnaVoice = input.dnaVoice;
  if (dnaVoice !== undefined) {
    const cost = estimateTokens(JSON.stringify(dnaVoice));
    const budget = shareFor("dnaVoice", remaining);
    if (cost > budget) {
      dnaVoice = undefined;
      truncated.push({
        slot: "dnaVoice",
        dropped: 1,
        kept: 0,
        reason: "tono y estilo omitidos por presupuesto; las prohibiciones siguen",
      });
    } else {
      used += cost;
    }
  }

  const pkg: Omit<ContextPackage, "packageHash"> = {
    tenantId: input.tenantId,
    actor: input.actor,
    channel: input.channel,
    dnaCore: input.dnaCore,
    ...(dnaVoice !== undefined ? { dnaVoice } : {}),
    activeRules: keptRules,
    objectives: input.objectives ?? [],
    conversation: conversationAllocation.kept,
    ...(customerProfile !== undefined ? { customerProfile } : {}),
    retrieved: chunkAllocation.kept,
    liveData: keptLive,
    budget: { total: input.tokenBudget, used },
    truncated,
  };

  return { ...pkg, packageHash: hashPackage(pkg) };
}

/**
 * Huella del paquete, para caché y reproducibilidad.
 *
 * Incluye deliberadamente lo que se truncó: dos paquetes con los mismos
 * fragmentos pero distinto recorte NO son el mismo contexto, y cachear la
 * respuesta de uno para el otro sería servir algo construido sobre otra base.
 */
export function hashPackage(pkg: Omit<ContextPackage, "packageHash">): string {
  const material = JSON.stringify({
    tenant: pkg.tenantId,
    actor: pkg.actor.id,
    core: pkg.dnaCore,
    rules: pkg.activeRules.map((r) => r.id),
    chunks: pkg.retrieved.map((c) => c.chunkId),
    turns: pkg.conversation.length,
    truncated: pkg.truncated.map((t) => `${t.slot}:${t.dropped}`),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Comprueba que las prohibiciones del ADN llegaron intactas al paquete.
 *
 * Se llama justo antes de generar. Es barato y es la diferencia entre un
 * producto vendible a una clínica y uno que no lo es (§6.3).
 */
export function assertProhibitionsPresent(
  pkg: ContextPackage,
  expected: DNACore,
): void {
  const missing = expected.neverDo.filter((rule) => !pkg.dnaCore.neverDo.includes(rule));
  const missingLegal = expected.legalBoundaries.filter(
    (rule) => !pkg.dnaCore.legalBoundaries.includes(rule),
  );

  if (missing.length > 0 || missingLegal.length > 0) {
    throw new ContextAssemblyError(
      "Faltan prohibiciones del ADN en el contexto ensamblado: " +
        [...missing, ...missingLegal].join(" | ") +
        ". Generar sin ellas produce una respuesta sin los límites puestos, " +
        "y eso no se ve en la respuesta.",
    );
  }
}
