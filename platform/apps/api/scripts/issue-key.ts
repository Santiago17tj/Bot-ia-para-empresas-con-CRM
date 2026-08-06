import "@platform/env/load";

import { rawPrisma, runAsSystem } from "@platform/db";
import { generateApiKey } from "@platform/api";

/**
 * Emite una API key para un tenant.
 *
 *   npm run issue-key -w @platform/api -- <tenantId> [nombre] [ámbitos...]
 *
 * La clave se imprime UNA vez. No se guarda en claro en ningún sitio, así que
 * no hay forma de recuperarla: la base solo tiene el hash y los cuatro últimos
 * caracteres, que es lo único que la interfaz puede enseñar (§28).
 *
 * Requiere `npm run build` antes.
 */

const DEFAULT_SCOPES = [
  "knowledge:read",
  "knowledge:answer",
  "knowledge:write",
  "chat:read",
  "chat:write",
];

async function main(): Promise<void> {
  const [tenantId, name = "clave de desarrollo", ...scopes] = process.argv.slice(2);

  if (tenantId === undefined || tenantId === "") {
    throw new Error(
      "Falta el tenant.\n" +
        "  npm run issue-key -w @platform/api -- <tenantId> [nombre] [ámbitos...]",
    );
  }

  const tenant = await runAsSystem("emitir API key: comprobar el tenant", () =>
    rawPrisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
  );

  // Se comprueba antes de crear nada: una clave apuntando a un tenant que no
  // existe autentica correctamente y luego falla en cada petición, que es la
  // peor forma de descubrir un typo.
  if (tenant === null) {
    throw new Error(`No existe el tenant "${tenantId}".`);
  }

  const issued = generateApiKey();
  const effectiveScopes = scopes.length > 0 ? scopes : DEFAULT_SCOPES;

  await runAsSystem("emitir API key: crear la fila", () =>
    rawPrisma.apiKey.create({
      data: {
        tenantId,
        name,
        keyHash: issued.keyHash,
        last4: issued.last4,
        scopes: effectiveScopes,
      },
    }),
  );

  console.log("");
  console.log(`  Tenant   ${tenantId} (${tenant.slug})`);
  console.log(`  Nombre   ${name}`);
  console.log(`  Ámbitos  ${effectiveScopes.join(", ")}`);
  console.log("");
  console.log(`  ${issued.secret}`);
  console.log("");
  console.log("  Esta clave no se vuelve a mostrar. Guárdala ahora.");
  console.log("");

  await rawPrisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await rawPrisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
