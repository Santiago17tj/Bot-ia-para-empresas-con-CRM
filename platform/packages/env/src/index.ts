import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Un solo `.env`, en la raíz del monorepo, leído por todos los procesos.
 *
 * Ficheros que deben coincidir son ficheros que pueden discrepar: la alternativa
 * (un .env por paquete) obliga a mantener copias idénticas de DATABASE_URL, y el
 * fallo no es un error sino algo peor — dos procesos operando sobre bases
 * distintas sin que nada lo diga.
 */

/**
 * El marcador es un `package.json` que declara `workspaces`: lo único que solo
 * tiene la raíz. Buscar el primer `package.json` no sirve — cada paquete tiene
 * el suyo, y la búsqueda pararía en el equivocado leyendo un fichero inexistente.
 */
export function findWorkspaceRoot(startDir?: string): string | null {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));

  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          workspaces?: unknown;
        };
        if (pkg.workspaces !== undefined) return dir;
      } catch {
        // package.json ilegible: seguimos subiendo.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let loaded = false;

/**
 * Carga `.env` y luego `.env.local` encima.
 *
 * `process.loadEnvFile` no pisa lo que ya existe en `process.env`, así que las
 * variables reales del entorno siempre ganan: en Vercel, Docker o CI se
 * configura allí y el fichero es solo comodidad local.
 *
 * Sin `.env` esto es un no-op — cada consumidor informa por su nombre de lo que
 * le falta, en vez de fallar aquí con un mensaje que no dice quién lo necesitaba.
 */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;

  const root = findWorkspaceRoot();
  if (root === null) return;

  for (const file of [".env", ".env.local"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
    } catch {
      // Fichero malformado: que lo reporte quien eche en falta la variable.
    }
  }
}

/** Lee una variable obligatoria. Falla con el nombre, no con `undefined`. */
export function required(name: string): string {
  loadRootEnv();
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Falta la variable de entorno ${name}. Está documentada en .env.example.`,
    );
  }
  return value;
}

/** Lee una variable opcional. Su ausencia quita una capacidad, nunca lanza. */
export function optional(name: string): string | undefined {
  loadRootEnv();
  const value = process.env[name];
  return value === "" ? undefined : value;
}

export function optionalNumber(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
