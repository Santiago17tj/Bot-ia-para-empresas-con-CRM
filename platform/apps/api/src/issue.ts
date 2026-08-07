import { runAsSystem, systemPrisma } from "@platform/db";

import { generateApiKey } from "./auth.js";

/**
 * Emite una credencial para un tenant.
 *
 * Vive aquí y no dentro del script por un motivo concreto: mientras estuvo en
 * `scripts/issue-key.ts` no había forma de probarla, y **no funcionaba**. Usaba
 * `rawPrisma`, que se conecta con el rol de aplicación y por tanto obedece a
 * las políticas RLS; `tenant` tiene la suya —`tenant_self`, que solo deja ver
 * la fila cuyo id coincide con `app.tenant_id` de la sesión de Postgres— y un
 * proceso de línea de comandos no abre esa sesión. La consulta devolvía cero
 * filas y el script las traducía a "No existe el tenant", de tenants que sí
 * existían. El comando documentado para conseguir una credencial llevaba roto
 * desde que se escribió.
 *
 * La lección no es sobre RLS, que ya estaba documentada. Es que la lógica
 * metida en un script es lógica que ningún test toca.
 */

export const DEFAULT_SCOPES = [
  "knowledge:read",
  "knowledge:answer",
  "knowledge:write",
  "chat:read",
  "chat:write",
  "contacts:read",
  "contacts:write",
] as const;

export class UnknownTenantError extends Error {
  override readonly name = "UnknownTenantError";
  constructor(readonly tenantId: string) {
    super(`No existe el tenant "${tenantId}".`);
  }
}

export interface IssuedApiKey {
  /** Se devuelve UNA vez: la base solo guarda el hash y los cuatro últimos. */
  secret: string;
  last4: string;
  scopes: string[];
  tenantSlug: string;
}

export async function issueApiKey(options: {
  tenantId: string;
  name?: string;
  scopes?: readonly string[];
}): Promise<IssuedApiKey> {
  const { tenantId } = options;

  // `systemPrisma` y no `rawPrisma`: emitir credenciales es administración, no
  // la ruta de una petición. Es el mismo uso sancionado que crear tenants.
  const tenant = await runAsSystem("emitir API key: comprobar el tenant", () =>
    systemPrisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
  );

  // Se comprueba antes de crear nada: una clave apuntando a un tenant que no
  // existe autentica correctamente y luego falla en cada petición, que es la
  // peor forma de descubrir un typo.
  if (tenant === null) throw new UnknownTenantError(tenantId);

  const issued = generateApiKey();
  const scopes = [...(options.scopes ?? [])];
  const effectiveScopes = scopes.length > 0 ? scopes : [...DEFAULT_SCOPES];

  await runAsSystem("emitir API key: crear la fila", () =>
    systemPrisma.apiKey.create({
      data: {
        tenantId,
        name: options.name ?? "clave de desarrollo",
        keyHash: issued.keyHash,
        last4: issued.last4,
        scopes: effectiveScopes,
      },
    }),
  );

  return {
    secret: issued.secret,
    last4: issued.last4,
    scopes: effectiveScopes,
    tenantSlug: tenant.slug,
  };
}
