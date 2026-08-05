import { AsyncLocalStorage } from "node:async_hooks";

/**
 * El contexto de tenant de la petición en curso.
 *
 * Viaja por AsyncLocalStorage y no como argumento porque el objetivo es que sea
 * IMPOSIBLE olvidarlo: un `tenantId` que se pasa a mano es un `tenantId` que
 * algún día no se pasa, y esa consulta devuelve los datos de todo el mundo.
 * Aquí, la ausencia de contexto es un error, no un filtro vacío.
 */

export interface TenantContext {
  tenantId: string;
  /** Quién actúa. Alimenta la auditoría y el filtrado de permisos por fragmento. */
  actor: {
    type: "user" | "apiKey" | "system";
    id: string;
    /** Ámbitos de la API key, o permisos derivados del rol. */
    scopes: readonly string[];
  };
  /** Correlaciona todo lo que ocurre durante la petición. */
  requestId: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  if (ctx.tenantId === "") {
    throw new TenantContextError(
      "Se intentó abrir un contexto con tenantId vacío.",
    );
  }
  return storage.run(ctx, fn);
}

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * El contexto o un error. Nunca `undefined` silencioso.
 *
 * Esta es la mitad de "falla cerrado": el código que necesita saber de quién son
 * los datos que está tocando no puede continuar sin saberlo.
 */
export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (ctx === undefined) {
    throw new TenantContextError(
      "Operación sobre datos de tenant sin contexto resuelto. " +
        "Envuélvela en runWithTenant(). Esto es un fallo cerrado deliberado: " +
        "sin tenant, la consulta devolvería datos de todos los clientes.",
    );
  }
  return ctx;
}

export function requireTenantId(): string {
  return requireTenantContext().tenantId;
}

export class TenantContextError extends Error {
  override readonly name = "TenantContextError";
}

/**
 * Ejecuta algo deliberadamente fuera de tenant: migraciones, el despachador del
 * outbox, tareas de sistema.
 *
 * Es explícito y se llama así a propósito. Leer `runAsSystem` en una revisión
 * obliga a preguntar por qué; una consulta sin contexto no obliga a nada.
 */
export function runAsSystem<T>(reason: string, fn: () => T): T {
  if (reason.trim() === "") {
    throw new TenantContextError("runAsSystem exige un motivo escrito.");
  }
  return storage.exit(fn);
}
