import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig } from "prisma/config";

/**
 * La CLI de Prisma corre como su propio proceso y no pasa por `@platform/env`,
 * así que carga la raíz aquí.
 *
 * La alternativa sería un `.env` dentro de packages/db, y ese es exactamente el
 * fallo que este monorepo evita: dos ficheros con la misma DATABASE_URL que un
 * día dejan de coincidir, y entonces `prisma migrate` opera sobre una base y la
 * aplicación sobre otra sin que nada lo diga.
 */
const root = resolve(import.meta.dirname, "..", "..");

for (const file of [".env", ".env.local"]) {
  const path = join(root, file);
  if (existsSync(path)) process.loadEnvFile(path);
}

export default defineConfig({
  schema: join(import.meta.dirname, "prisma", "schema.prisma"),
});
