import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { findApiKeyByHash, touchApiKey, type TenantContext } from "@platform/db";

import { forbidden, unauthorized } from "./errors.js";

/**
 * Autenticación por API key (§28).
 *
 * **La clave resuelve el tenant. El tenant no viaja nunca en la petición.**
 *
 * Es el invariante entero de esta capa. Un `tenantId` en el cuerpo o en la
 * query sería un parámetro que el cliente controla, y bastaría cambiarlo para
 * leer los datos de otra empresa: las políticas RLS obedecen al contexto que
 * abrimos nosotros, no a la verdad. Por eso aquí se deriva de la credencial y
 * la petición no tiene voz en el asunto.
 */

const PREFIX = "sk_";

export interface IssuedKey {
  /** Se muestra UNA vez. No se puede volver a obtener. */
  secret: string;
  keyHash: string;
  last4: string;
}

/**
 * Genera una clave nueva.
 *
 * 32 bytes de aleatoriedad criptográfica: 256 bits. Ese número es la razón por
 * la que el hash es un SHA-256 y no un bcrypt o un argon2 — una KDF lenta
 * existe para frenar la fuerza bruta sobre secretos que las personas eligen y
 * que caben en un diccionario. Contra 256 bits aleatorios no compra nada, y
 * además impediría lo que aquí hace falta: buscar la fila por el hash en una
 * sola consulta indexada en vez de recorrer todas las claves del sistema.
 */
export function generateApiKey(): IssuedKey {
  const secret = PREFIX + randomBytes(32).toString("base64url");
  return { secret, keyHash: hashApiKey(secret), last4: secret.slice(-4) };
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Extrae la credencial de la cabecera.
 *
 * Se acepta `Authorization: Bearer <clave>` y nada más. `x-api-key` sería una
 * segunda forma de hacer lo mismo, y dos caminos de autenticación son dos
 * caminos que auditar.
 */
export function extractBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export interface AuthenticatedKey {
  id: string;
  tenantId: string;
  scopes: string[];
  rateLimitPerMinute: number;
}

/**
 * Resuelve la clave a un tenant, o falla.
 *
 * `findApiKeyByHash` vive en `@platform/db` y es la única excepción sancionada
 * a "el cliente que se salta RLS nunca aparece en la ruta de una petición": la
 * tabla `apiKey` lleva `tenantId` y política RLS, y el tenant es justo lo que
 * esto intenta averiguar. La API no importa `systemPrisma`; llama a una función
 * con nombre que solo sabe buscar por hash.
 */
export async function authenticate(secret: string): Promise<AuthenticatedKey> {
  const record = await findApiKeyByHash(hashApiKey(secret));

  // Mismo mensaje para clave inexistente, revocada y caducada. Distinguirlos
  // le diría a quien prueba claves cuáles existieron alguna vez.
  const invalid = unauthorized("Credencial inválida, revocada o caducada.");
  if (record === null) throw invalid;

  // La búsqueda ya fue por hash, así que esto no decide el acceso; está para
  // que una futura búsqueda por otro criterio no se convierta en comparación
  // sensible al tiempo sin que nadie se dé cuenta.
  const expected = Buffer.from(record.keyHash, "utf8");
  const actual = Buffer.from(hashApiKey(secret), "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw invalid;
  }

  if (record.revokedAt !== null) throw invalid;
  if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) {
    throw invalid;
  }

  void touch(record.id, record.lastUsedAt);

  return {
    id: record.id,
    tenantId: record.tenantId,
    scopes: record.scopes,
    rateLimitPerMinute: record.rateLimitPerMinute,
  };
}

/**
 * Marca la clave como usada, como mucho una vez por minuto.
 *
 * Sin el freno, cada petición añadiría una escritura a una fila caliente y el
 * dato que se gana —"esta clave se usó"— no mejora por registrarlo mil veces
 * por minuto. No se espera al resultado: la contabilidad de uso no debe poder
 * tumbar una respuesta.
 */
async function touch(id: string, lastUsedAt: Date | null): Promise<void> {
  const now = Date.now();
  if (lastUsedAt !== null && now - lastUsedAt.getTime() < 60_000) return;

  try {
    await touchApiKey(id, new Date(now));
  } catch {
    // Da igual. La petición ya se está sirviendo.
  }
}

/**
 * Construye el contexto de tenant a partir de la credencial.
 *
 * Los ámbitos de la clave son los del actor: el filtrado por permisos de
 * fragmento y la auditoría leen de aquí, no de la petición.
 */
export function contextFor(key: AuthenticatedKey, requestId: string): TenantContext {
  return {
    tenantId: key.tenantId,
    actor: { type: "apiKey", id: key.id, scopes: key.scopes },
    requestId,
  };
}

/**
 * Comprueba un ámbito.
 *
 * `*` existe para la clave de administración del propio tenant. No es un
 * comodín entre tenants: por encima de esto sigue estando el `tenantId` de la
 * credencial, que ninguna clave puede cambiar.
 */
export function requireScope(key: AuthenticatedKey, scope: string): void {
  if (key.scopes.includes(scope) || key.scopes.includes("*")) return;
  throw forbidden(
    `Esta credencial no tiene el ámbito "${scope}". Tiene: ${
      key.scopes.length === 0 ? "ninguno" : key.scopes.join(", ")
    }.`,
  );
}
