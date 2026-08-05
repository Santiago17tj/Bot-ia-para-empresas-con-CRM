export { EVENT_TYPES, EventHandlingError } from "./types.js";
export type {
  DomainEvent,
  EventHandler,
  EventType,
  HandlerRegistration,
} from "./types.js";

export { publish, publishMany, backoffMs } from "./outbox.js";
export type { PublishOptions } from "./outbox.js";

export { EventDispatcher } from "./dispatcher.js";
export type { DispatcherOptions } from "./dispatcher.js";
