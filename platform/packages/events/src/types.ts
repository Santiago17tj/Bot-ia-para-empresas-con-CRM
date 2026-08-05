/**
 * Event Bus (§21 del plan).
 *
 * Todo se comunica por eventos, y los eventos se escriben en la MISMA
 * transacción que el cambio que los origina. Sin eso, un fallo entre "guardar
 * documento" y "publicar evento" deja un documento que el panel muestra como
 * listo y que no responde nada, sin log que lo explique. Es el fallo silencioso
 * más caro de diagnosticar del sistema.
 */

/**
 * Catálogo de eventos, en un solo sitio.
 *
 * Un tipo suelto escrito a mano en un `publish` es un evento que nadie
 * consume y que nadie echa de menos.
 */
export const EVENT_TYPES = [
  // Conocimiento
  "document.uploaded",
  "document.version.created",
  "document.ingest.failed",
  "knowledge.indexed",
  "knowledge.reindexed",
  "knowledge.gap", // una pregunta sin respuesta: alimenta Knowledge Health
  // Conversación
  "message.received",
  "message.sent",
  "answer.abstained",
  "answer.reviewed",
  // Consumo y gobierno
  "usage.recorded",
  "action.executed",
  // Aprendizaje
  "learning.signal",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface DomainEvent<TPayload = unknown> {
  id: string;
  type: EventType;
  /** null solo para eventos de sistema que no pertenecen a ningún cliente. */
  tenantId: string | null;
  payload: TPayload;
  attempts: number;
  createdAt: Date;
}

/**
 * Un consumidor DEBE ser idempotente.
 *
 * El despachador garantiza entrega *al menos una vez*, no *exactamente una*:
 * un proceso que muere después de ejecutar el manejador y antes de marcar la
 * fila reintenta al expirar el lease. Un consumidor que no lo sea duplicará
 * trabajo justo cuando algo ya iba mal.
 */
export type EventHandler<TPayload = unknown> = (
  event: DomainEvent<TPayload>,
) => Promise<void>;

export interface HandlerRegistration {
  /** Identifica al consumidor en los logs y en los reintentos. */
  name: string;
  type: EventType;
  handle: EventHandler;
}

export class EventHandlingError extends Error {
  override readonly name = "EventHandlingError";
  constructor(
    message: string,
    /**
     * Un fallo permanente no se reintenta: se manda a `DEAD` de inmediato.
     * Reintentar cinco veces un payload malformado solo retrasa el diagnóstico
     * y llena la cola.
     */
    readonly permanent: boolean = false,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
