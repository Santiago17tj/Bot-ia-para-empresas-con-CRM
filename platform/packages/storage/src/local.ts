import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { assertValidKey, StorageError, type StorageDriver } from "./types.js";

/**
 * Driver local: los ficheros van a disco.
 *
 * Es un driver de VERDAD, no un doble de test: en una instalación on-premise
 * —el caso que este producto tiene que saber servir— es exactamente lo que
 * quiere el cliente que no deja salir sus datos del edificio.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly id = "local";
  readonly #root: string;

  constructor(options: { root: string }) {
    this.#root = resolve(options.root);
  }

  get root(): string {
    return this.#root;
  }

  /**
   * Resuelve la clave a una ruta y comprueba que no se sale.
   *
   * `assertValidKey` ya debería impedirlo, pero esta comprobación se hace
   * igualmente y sobre la ruta YA resuelta. Es la diferencia entre validar la
   * entrada y verificar el resultado: si algún día la lista blanca se relaja
   * por una necesidad razonable, esto sigue en pie. Dos defensas para el mismo
   * fallo, porque el fallo es leer o escribir fuera del directorio.
   */
  #pathFor(key: string): string {
    assertValidKey(key, this.id);

    const full = resolve(join(this.#root, key));
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new StorageError(
        `La clave se resolvió fuera del directorio de almacenamiento: ${key}`,
        this.id,
        "invalid_key",
      );
    }
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.#pathFor(key);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    } catch (error) {
      throw new StorageError(`No se pudo escribir ${key}`, this.id, "io", error);
    }
  }

  async get(key: string): Promise<Buffer> {
    const path = this.#pathFor(key);
    try {
      return await readFile(path);
    } catch (error) {
      // Un fichero que falta y un disco que falla no son lo mismo: el primero
      // es un fallo permanente y no debe reintentarse, el segundo sí.
      if (isNotFound(error)) {
        throw new StorageError(`No existe ${key}`, this.id, "not_found", error);
      }
      throw new StorageError(`No se pudo leer ${key}`, this.id, "io", error);
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.#pathFor(key);
    try {
      // `force` para que borrar lo que ya no está sea un éxito: un consumidor
      // idempotente que reintenta una limpieza no debe fallar por haberla
      // hecho ya.
      await rm(path, { force: true });
    } catch (error) {
      throw new StorageError(`No se pudo borrar ${key}`, this.id, "io", error);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.#pathFor(key));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}
