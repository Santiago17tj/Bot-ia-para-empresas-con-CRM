import { randomUUID } from "node:crypto";

import { prisma, requireTenantContext, type Prisma } from "@platform/db";
import { optionalNumber } from "@platform/env";

/**
 * Observabilidad de IA (§25 del plan).
 *
 * Cuando un cliente diga "la IA respondió mal", hay que poder reconstruir
 * exactamente qué ocurrió. Sin esto cada queja es irresoluble, y la confianza
 * se pierde una conversación a la vez.
 */

export type TraceStatus = "RUNNING" | "COMPLETED" | "FAILED" | "ABSTAINED";

export interface StepRecord {
  kind: "retrieval" | "generation" | "validation" | "embedding" | "graph" | "action";
  name: string;
  input?: unknown;
  output?: unknown;
  latencyMs?: number;
  cost?: number;
  error?: string;
}

export interface TraceFinish {
  status: TraceStatus;
  answered?: boolean;
  groundingResult?: unknown;
  errors?: unknown;
}

/**
 * Cuánta traza guardar.
 *
 * La estructura (rutas, costes, latencias, ids) se guarda SIEMPRE: es barata,
 * no lleva datos personales y es lo que permite diagnosticar sin leer a nadie.
 * El contenido (prompts renderizados, respuestas, fragmentos) se muestrea,
 * porque lleva datos personales y su volumen supera al del resto del sistema
 * junto.
 *
 * Guardar todo el contenido siempre es la decisión que parece prudente en la
 * primera semana y es insostenible en el tercer mes.
 */
function contentSampleRate(): number {
  const rate = optionalNumber("TRACE_CONTENT_SAMPLE_RATE", 1);
  return Math.min(Math.max(rate, 0), 1);
}

function shouldKeepContent(): boolean {
  const rate = contentSampleRate();
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

/**
 * Acumula la traza en memoria y la escribe al cerrar.
 *
 * Se escribe una vez, al final, en lugar de un UPDATE por paso: la traza es
 * observabilidad, y observabilidad que multiplica por N las escrituras de la
 * ruta caliente acaba desactivada por rendimiento — justo antes del incidente
 * en que hacía falta.
 */
export class Trace {
  readonly id: string;
  readonly operation: string;
  readonly #startedAt: number;
  readonly #steps: (StepRecord & { ordinal: number })[] = [];
  readonly #keepContent: boolean;

  #intent?: string;
  #routing?: unknown;
  #contextPackage?: unknown;
  #truncated: string[] = [];
  #promptRefs: { key: string; version: number }[] = [];
  #flags?: Record<string, unknown>;
  #inputTokens = 0;
  #outputTokens = 0;
  #cachedTokens = 0;
  #cost = 0;
  #closed = false;

  constructor(operation: string) {
    this.id = randomUUID();
    this.operation = operation;
    this.#startedAt = performance.now();
    this.#keepContent = shouldKeepContent();
  }

  setIntent(intent: string): this {
    this.#intent = intent;
    return this;
  }

  /** Proveedor, modelo y por qué se eligió. El motivo se registra siempre. */
  setRouting(routing: {
    provider: string;
    model: string;
    reason: string;
    estimatedCost?: number;
  }): this {
    this.#routing = routing;
    return this;
  }

  /**
   * Archiva el Context Package y, sobre todo, QUÉ SE TRUNCÓ.
   *
   * Un contexto recortado en silencio produce una respuesta peor que nadie
   * puede explicar. La lista de lo truncado es la mitad útil de este campo.
   */
  setContextPackage(pkg: unknown, truncated: string[]): this {
    this.#contextPackage = this.#keepContent ? pkg : { redacted: true };
    this.#truncated = truncated;
    return this;
  }

  /** Sin la versión del prompt, una regresión de calidad es indiagnosticable. */
  usedPrompt(key: string, version: number): this {
    this.#promptRefs.push({ key, version });
    return this;
  }

  setFlags(flags: Record<string, unknown>): this {
    this.#flags = flags;
    return this;
  }

  addUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    cost?: number;
  }): this {
    this.#inputTokens += usage.inputTokens ?? 0;
    this.#outputTokens += usage.outputTokens ?? 0;
    this.#cachedTokens += usage.cachedTokens ?? 0;
    this.#cost += usage.cost ?? 0;
    return this;
  }

  step(record: StepRecord): this {
    this.#steps.push({
      ...record,
      ordinal: this.#steps.length,
      ...(this.#keepContent ? {} : { input: undefined, output: undefined }),
    });
    return this;
  }

  /** Envuelve una operación: la cronometra y registra su fallo si lo hay. */
  async measure<T>(
    kind: StepRecord["kind"],
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await fn();
      this.step({ kind, name, latencyMs: Math.round(performance.now() - startedAt) });
      return result;
    } catch (error) {
      this.step({
        kind,
        name,
        latencyMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  get totals(): { inputTokens: number; outputTokens: number; cost: number } {
    return {
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      cost: this.#cost,
    };
  }

  /**
   * Persiste la traza. Idempotente: cerrar dos veces no duplica.
   *
   * Nunca lanza. Una traza que no se puede guardar es un problema de
   * observabilidad; convertirlo en un fallo de la respuesta convierte un
   * problema de diagnóstico en una caída.
   */
  async close(finish: TraceFinish): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const { tenantId } = requireTenantContext();
    const latencyMs = Math.round(performance.now() - this.#startedAt);

    try {
      await prisma.aITrace.create({
        data: {
          id: this.id,
          tenantId,
          operation: this.operation,
          status: finish.status,
          intent: this.#intent ?? null,
          routing: (this.#routing ?? null) as Prisma.InputJsonValue,
          contextPackage: (this.#contextPackage ?? null) as Prisma.InputJsonValue,
          truncated: this.#truncated,
          promptRefs: (this.#promptRefs.length > 0
            ? this.#promptRefs
            : null) as Prisma.InputJsonValue,
          flags: (this.#flags ?? null) as Prisma.InputJsonValue,
          inputTokens: this.#inputTokens,
          outputTokens: this.#outputTokens,
          cachedTokens: this.#cachedTokens,
          cost: this.#cost,
          latencyMs,
          groundingResult: (finish.groundingResult ?? null) as Prisma.InputJsonValue,
          answered: finish.answered ?? null,
          errors: (finish.errors ?? null) as Prisma.InputJsonValue,
          steps: {
            create: this.#steps.map((s) => ({
              ordinal: s.ordinal,
              kind: s.kind,
              name: s.name,
              input: (s.input ?? null) as Prisma.InputJsonValue,
              output: (s.output ?? null) as Prisma.InputJsonValue,
              latencyMs: s.latencyMs ?? null,
              cost: s.cost ?? 0,
              error: s.error ?? null,
            })),
          },
        },
      });
    } catch (error) {
      console.error(
        `[trace] no se pudo persistir la traza ${this.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
