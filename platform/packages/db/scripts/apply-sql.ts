import "@platform/env/load";

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Aplica los ficheros de packages/db/sql/ en orden.
 *
 * Contienen lo que Prisma no sabe expresar: tipos de pgvector, columnas
 * tsvector, índices HNSW/GIN, el rol de aplicación y las políticas RLS. Todos
 * son idempotentes, así que ejecutarlo de más no rompe nada.
 *
 * Usa el driver `pg` en vez de `$executeRawUnsafe` de Prisma porque este
 * último manda la consulta por el protocolo EXTENDIDO, que admite una sola
 * sentencia por llamada. Estos ficheros son unidades con BEGIN/COMMIT y
 * bloques DO $$ dentro; partirlos por ';' rompería los bloques. El protocolo
 * simple de `pg` los acepta enteros.
 *
 * Se conecta con DATABASE_URL (el propietario) a propósito: crea roles y
 * políticas, que es DDL, y el rol de aplicación no debe poder hacerlo.
 */

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, "..", "sql");

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    throw new Error(
      "Falta DATABASE_URL. Copia .env.example a .env en la raíz del repo.",
    );
  }

  const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    console.log("[db] no hay ficheros SQL que aplicar");
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    for (const file of files) {
      const sql = await readFile(join(sqlDir, file), "utf8");
      process.stdout.write(`[db] aplicando ${file} ... `);
      await client.query(sql);
      console.log("ok");
    }
  } finally {
    await client.end();
  }

  console.log("[db] listo");
}

main().catch((error: unknown) => {
  console.error("[db] falló la aplicación de SQL:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
