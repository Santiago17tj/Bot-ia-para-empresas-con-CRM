import "@platform/env/load";

import { rawPrisma } from "@platform/db";
import { seedPrompts } from "@platform/observability";

/**
 * Envoltorio de línea de comandos sobre `seedPrompts()`.
 *
 * La lógica vive en `src/seed.ts` para que los tests puedan sembrar antes de
 * ejercer la ruta de respuesta, en vez de depender de que alguien haya
 * ejecutado esto a mano.
 *
 * Requiere `npm run build` antes: importa el paquete compilado.
 */

seedPrompts()
  .then(async () => {
    await rawPrisma.$disconnect();
    console.log("[prompts] listo");
  })
  .catch(async (error: unknown) => {
    console.error("[prompts] falló la siembra:");
    console.error(error instanceof Error ? error.message : String(error));
    await rawPrisma.$disconnect().catch(() => {});
    process.exitCode = 1;
  });
