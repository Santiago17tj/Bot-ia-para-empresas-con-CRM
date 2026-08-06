import { resolveQuestion } from "@platform/knowledge";
import type { AIProvider } from "@platform/providers";

import type { ResolveFn } from "./runner.js";

/**
 * Conecta el arnés con la reescritura de seguimientos de producción.
 *
 * Igual de delgado que `createGenerator`, y por el mismo motivo: `resolveQuestion`
 * vive en `@platform/knowledge` porque es una decisión que cambia lo que se
 * recupera, y una decisión tomada fuera del código medido es una decisión sin
 * medir sirviéndose en producción. Si este adaptador tuviera lógica propia
 * —recortar el hilo de otra forma, decidir él cuándo reescribir— el arnés
 * mediría un chat que no existe.
 */

export interface ResolverOptions {
  tenantId: string;
  provider: AIProvider;
  /** Cuántos turnos anteriores se le enseñan. Por defecto, los de producción. */
  maxTurns?: number;
}

export function createResolver(options: ResolverOptions): ResolveFn {
  return async (question, history) => {
    const resolved = await resolveQuestion({
      tenantId: options.tenantId,
      question,
      history,
      provider: options.provider,
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    });

    return {
      question: resolved.question,
      rewritten: resolved.rewritten,
      cost: resolved.cost,
    };
  };
}
