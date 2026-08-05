import { optional } from "@platform/env";

import { LocalStorageDriver } from "./local.js";
import { StorageError, type StorageDriver } from "./types.js";

export { LocalStorageDriver } from "./local.js";
export {
  StorageError,
  assertValidKey,
  documentKey,
  type StorageDriver,
} from "./types.js";

export type StorageDriverId = "local";

/**
 * Resuelve el driver desde la configuración.
 *
 * Añadir S3 es un fichero en este paquete y una entrada en el `switch`. Nada
 * más del sistema cambia — que es lo que la costura compra.
 */
export function createStorage(
  options: { driver?: string; root?: string } = {},
): StorageDriver {
  const id = options.driver ?? optional("STORAGE_DRIVER") ?? "local";

  switch (id) {
    case "local":
      return new LocalStorageDriver({
        root: options.root ?? optional("STORAGE_LOCAL_PATH") ?? "./.storage",
      });
    default:
      throw new StorageError(
        `Driver de almacenamiento no soportado: ${id}. Implementado: local.`,
        id,
        "invalid_key",
      );
  }
}
