import "@platform/env/load";

import { systemPrisma } from "@platform/db";
import { issueApiKey } from "@platform/api";

/**
 * Emite una API key para un tenant.
 *
 *   npm run issue-key -w @platform/api -- <tenantId> [nombre] [ámbitos...]
 *
 * La clave se imprime UNA vez. No se guarda en claro en ningún sitio, así que
 * no hay forma de recuperarla: la base solo tiene el hash y los cuatro últimos
 * caracteres.
 *
 * Este fichero es deliberadamente tonto: lee argumentos, llama e imprime. Toda
 * la lógica está en `issueApiKey`, en el paquete, porque mientras vivió aquí
 * ningún test la tocaba — y estuvo rota desde el primer día sin que se notara.
 *
 * Requiere `npm run build` antes.
 */

async function main(): Promise<void> {
  const [tenantId, name = "clave de desarrollo", ...scopes] = process.argv.slice(2);

  if (tenantId === undefined || tenantId === "") {
    throw new Error(
      "Falta el tenant.\n" +
        "  npm run issue-key -w @platform/api -- <tenantId> [nombre] [ámbitos...]",
    );
  }

  const issued = await issueApiKey({ tenantId, name, scopes });

  console.log("");
  console.log(`  Tenant   ${tenantId} (${issued.tenantSlug})`);
  console.log(`  Nombre   ${name}`);
  console.log(`  Ámbitos  ${issued.scopes.join(", ")}`);
  console.log("");
  console.log(`  ${issued.secret}`);
  console.log("");
  console.log("  Esta clave no se vuelve a mostrar. Guárdala ahora.");
  console.log("");

  await systemPrisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await systemPrisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
