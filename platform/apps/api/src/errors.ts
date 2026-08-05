import { TenantContextError } from "@platform/db";
import { PromptNotFoundError } from "@platform/observability";
import { ProviderError } from "@platform/providers";

/**
 * Errores que la API sabe explicar.
 *
 * Todo lo demás es un 500 con un `requestId` y nada más. Un mensaje de error
 * que revela la consulta, el nombre de la tabla o la ruta del fichero es
 * información que el atacante no tenía y ahora tiene; el que la necesita para
 * diagnosticar es quien lee los logs, y ahí sí va entero.
 */

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const unauthorized = (message: string): ApiError =>
  new ApiError(401, "unauthorized", message);

export const forbidden = (message: string): ApiError =>
  new ApiError(403, "forbidden", message);

export interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

/**
 * Traduce cualquier error a una respuesta.
 *
 * Los errores del dominio que YA están escritos para ser leídos por una persona
 * se dejan pasar con su texto: `TenantContextError`, `ProviderError` y
 * `PromptNotFoundError` explican qué falta y cómo arreglarlo, y ocultarlos
 * detrás de "error interno" convierte un problema de configuración de dos
 * minutos en una tarde de depuración.
 *
 * `TenantContextError` es un 500 a propósito, no un 403: significa que una ruta
 * tocó datos sin abrir contexto de tenant. Eso es un fallo NUESTRO —la tercera
 * capa de aislamiento haciendo su trabajo— y llamarlo "prohibido" sugeriría que
 * el cliente hizo algo mal.
 */
export function toErrorResponse(
  error: unknown,
  requestId: string,
): { statusCode: number; body: ErrorBody } {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      body: { error: { code: error.code, message: error.message, requestId } },
    };
  }

  if (error instanceof TenantContextError) {
    return {
      statusCode: 500,
      body: {
        error: {
          code: "tenant_context_missing",
          message: error.message,
          requestId,
        },
      },
    };
  }

  if (error instanceof PromptNotFoundError) {
    return {
      statusCode: 503,
      body: {
        error: { code: "prompt_not_deployed", message: error.message, requestId },
      },
    };
  }

  if (error instanceof ProviderError) {
    // 502 y no 500: el fallo es de un servicio de aguas arriba, y quien lo lea
    // en una gráfica necesita distinguir "nuestro código está roto" de "el
    // proveedor no responde".
    return {
      statusCode: error.retryable ? 503 : 502,
      body: {
        error: { code: "provider_error", message: error.message, requestId },
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: {
        code: "internal_error",
        message: "Error interno. Cita el requestId al reportarlo.",
        requestId,
      },
    },
  };
}
