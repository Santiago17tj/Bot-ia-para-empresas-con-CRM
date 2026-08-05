import { systemPrisma } from "./client.js";

/**
 * La ÚNICA excepción sancionada a "systemPrisma nunca en la ruta de una
 * petición".
 *
 * Es el huevo antes que la gallina del aislamiento: `apiKey` es una tabla con
 * `tenantId` y con política RLS, así que leerla exige contexto de tenant — y el
 * tenant es exactamente lo que esta consulta existe para averiguar. Con el
 * cliente normal la búsqueda devuelve cero filas y toda credencial válida es un
 * 401.
 *
 * Vive aquí y no en `apps/api` a propósito. Si la API importara `systemPrisma`
 * para resolver esto, tendría el cliente que se salta RLS a mano dentro de la
 * capa que atiende peticiones, y la siguiente consulta "solo esta vez" ya no
 * tendría que justificar nada. Así hay **una** función, con nombre, que se
 * puede auditar leyendo quién la llama.
 *
 * Lo que la hace segura no es la intención: es la forma. Solo busca por hash,
 * solo devuelve una fila, y los campos que devuelve son los de la credencial
 * —nunca datos del tenant—. No hay manera de pedirle otra cosa.
 */
export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  scopes: string[];
  rateLimitPerMinute: number;
  keyHash: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export async function findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
  return systemPrisma.apiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      tenantId: true,
      scopes: true,
      rateLimitPerMinute: true,
      keyHash: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });
}

/**
 * Marca la credencial como usada.
 *
 * Misma excepción y mismo motivo: ocurre antes de que exista contexto. Se
 * limita a una columna que no es de nadie más.
 */
export async function touchApiKey(id: string, at: Date): Promise<void> {
  await systemPrisma.apiKey.update({ where: { id }, data: { lastUsedAt: at } });
}
