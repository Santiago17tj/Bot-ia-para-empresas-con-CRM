import { decryptSecret, encryptSecret, secretsReady } from "@platform/secrets";

/**
 * La sesión del panel: una cookie que lleva la clave de API cifrada.
 *
 * **La clave nunca llega al navegador.** El panel no expone la credencial a su
 * propio JavaScript: se pega una vez en el formulario, viaja al servidor del
 * panel, y de ahí en adelante vive en una cookie `httpOnly` que el JS no puede
 * leer. Todo lo que hace la interfaz pasa por `/api/*` del panel, que reenvía a
 * la API con la credencial descifrada del lado del servidor.
 *
 * La alternativa —guardarla en `localStorage` y mandarla desde el navegador— es
 * lo que se hace por costumbre y significa que cualquier script inyectado en la
 * página se lleva una credencial con todos los ámbitos del tenant. Aquí no hay
 * scripts de terceros, pero el día que alguien meta el primero no debería tener
 * que acordarse de esto.
 *
 * **Cifrada y no firmada.** Firmar bastaría para que nadie la falsifique, pero
 * dejaría la clave legible para cualquiera que mire sus cookies o un volcado de
 * memoria del proxy. Se reutiliza `@platform/secrets`, que es AES-256-GCM
 * autenticado: una cookie manipulada **falla al descifrar** en vez de devolver
 * basura que luego se manda como credencial.
 */

export const COOKIE = "panel_session";

/**
 * El contexto de cifrado. Fijo, y aquí está el motivo.
 *
 * Los datos autenticados asociados de `@platform/secrets` atan un texto cifrado
 * a un tenant, pero aquí el tenant es justo lo que todavía no se sabe: se
 * averigua al descifrar la clave y preguntarle a la API. Se usa un contexto
 * propio del panel para que una cookie de sesión NO se pueda descifrar como si
 * fuera el token de un conector, ni al revés.
 */
const CONTEXT = { tenantId: "panel", purpose: "panel.session" } as const;

export function sessionReady(): boolean {
  return secretsReady();
}

export function sealApiKey(apiKey: string): string {
  return encryptSecret(apiKey, CONTEXT);
}

/** La clave, o `undefined` si no hay cookie o viene manipulada. */
export function openApiKey(cookieHeader: string | undefined): string | undefined {
  const envelope = readCookie(cookieHeader, COOKIE);
  if (envelope === undefined) return undefined;

  try {
    return decryptSecret(envelope, CONTEXT);
  } catch {
    // Una cookie que no descifra es una cookie manipulada o cifrada con una
    // clave que ya no está. En los dos casos la respuesta correcta es "no hay
    // sesión", no un 500: el usuario vuelve a pegar su clave y sigue.
    return undefined;
  }
}

/**
 * La cabecera `Set-Cookie`.
 *
 * `HttpOnly` para que el JS no la lea, `SameSite=Strict` para que una petición
 * nacida en otro sitio no la arrastre —que es la defensa contra CSRF sin
 * necesidad de tokens—, `Path=/` y sin `Max-Age`: es una cookie de sesión y se
 * va al cerrar el navegador. Una credencial de administración que sobrevive
 * semanas en un portátil compartido es una credencial filtrada a plazos.
 *
 * `Secure` solo cuando se sirve por HTTPS: ponerlo siempre haría que el panel
 * no funcionase en `http://localhost`, que es donde se usa para desarrollar, y
 * el síntoma —"inicio sesión y me devuelve al formulario"— no apunta a nada.
 */
export function sessionCookie(envelope: string, secure: boolean): string {
  return [
    `${COOKIE}=${envelope}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * Lee una cookie de la cabecera.
 *
 * A mano y sin `@fastify/cookie` por lo mismo que el matcher de cron es propio:
 * hace falta leer UNA cookie por nombre, y eso son cinco líneas contra una
 * dependencia con su propia superficie y su propio ciclo de versiones.
 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }

  return undefined;
}
