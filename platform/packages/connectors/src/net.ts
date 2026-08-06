import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { optional } from "@platform/env";

/**
 * Qué URLs se pueden pedir, y cuáles no.
 *
 * **Un conector que descarga URLs elegidas por el cliente es un SSRF por
 * diseño.** El tenant escribe una dirección en un formulario y nuestro servidor
 * la pide, desde dentro de nuestra red, con nuestra identidad. Eso convierte el
 * rastreador en un proxy hacia todo lo que el servidor alcance y el cliente no:
 *
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *   http://localhost:5433                     (la base de datos)
 *   http://10.0.0.5/admin                     (lo que haya en la red interna)
 *
 * La primera es el caso clásico: el endpoint de metadatos de AWS, GCP y Azure
 * vive en esa IP y devuelve credenciales de la instancia. Un rastreador
 * ingenuo la pide, guarda la respuesta como "documento", y el cliente la
 * consulta después por la API de conocimiento.
 *
 * Por eso esto es una lista blanca de lo público, no una lista negra: lo que no
 * se sepa clasificar, no se pide.
 */

export class BlockedUrlError extends Error {
  override readonly name = "BlockedUrlError";
  constructor(
    message: string,
    readonly url: string,
    readonly reason: "scheme" | "private_network" | "unresolvable" | "port",
  ) {
    super(message);
  }
}

/**
 * Puertos que no son de web.
 *
 * No es la defensa principal —la resolución de IP lo es— pero corta el caso de
 * apuntar a un servicio interno que sí está en una IP pública: bases de datos
 * expuestas, SMTP, Redis.
 */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 110, 143, 445, 465, 587, 993, 995, 1433, 1521, 3306, 3389, 5432,
  5433, 5984, 6379, 9200, 11211, 27017,
]);

/**
 * En on-premise, la red privada es EXACTAMENTE donde está la documentación.
 *
 * El escape existe por eso, y está apagado por defecto porque el fallo de
 * dejarlo abierto es silencioso y caro, mientras que el de tenerlo cerrado es
 * un error claro que dice qué activar.
 */
function allowsPrivateNetwork(): boolean {
  return optional("CONNECTORS_ALLOW_PRIVATE_NETWORK") === "true";
}

/**
 * ¿Es una dirección que no debe alcanzarse desde fuera?
 *
 * Pura y exportada para poder probarla contra la lista de direcciones que de
 * verdad importan, sin red y sin DNS.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  // Si no se sabe qué es, se trata como privada. Fallar cerrado.
  return true;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a = 0, b = 0] = parts;

  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  if (a === 0) return true; // "esta red"
  if (a === 10) return true; // privada
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local: METADATOS DE NUBE
  if (a === 172 && b >= 16 && b <= 31) return true; // privada
  if (a === 192 && b === 168) return true; // privada
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast y reservadas

  return false;
}

function isPrivateV6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");

  if (normalized === "::" || normalized === "::1") return true;

  // IPv4 mapeada (::ffff:169.254.169.254) es el rodeo evidente: se desenvuelve
  // y se juzga como lo que es.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1] !== undefined) return isPrivateV4(mapped[1]);

  const prefix = normalized.slice(0, 4);
  if (prefix.startsWith("fc") || prefix.startsWith("fd")) return true; // unique local
  if (prefix.startsWith("fe8") || prefix.startsWith("fe9")) return true; // link-local
  if (prefix.startsWith("fea") || prefix.startsWith("feb")) return true;
  if (normalized.startsWith("ff")) return true; // multicast

  return false;
}

/**
 * Comprueba que una URL se puede pedir. Lanza si no.
 *
 * Resuelve el nombre y juzga **las IPs**, no el texto. Comprobar solo el
 * hostname no sirve de nada: `metadatos.ejemplo.com` puede apuntar a
 * 169.254.169.254, y hay servicios públicos dedicados a justamente eso.
 */
export async function assertFetchableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`URL mal formada: ${raw}`, raw, "scheme");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // `file:` leería el disco del servidor; `gopher:` y `ftp:` son vectores
    // clásicos para hablar con servicios que no son HTTP.
    throw new BlockedUrlError(
      `Solo se admiten http y https, no ${url.protocol}`,
      raw,
      "scheme",
    );
  }

  const port = url.port === "" ? undefined : Number(url.port);
  if (port !== undefined && BLOCKED_PORTS.has(port)) {
    throw new BlockedUrlError(`Puerto ${port} no permitido`, raw, "port");
  }

  if (allowsPrivateNetwork()) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  // Un literal IP no necesita DNS y no debe saltarse la comprobación.
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new BlockedUrlError(
        `${hostname} es una dirección de red privada o reservada`,
        raw,
        "private_network",
      );
    }
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new BlockedUrlError(`No se pudo resolver ${hostname}`, raw, "unresolvable");
  }

  if (addresses.length === 0) {
    throw new BlockedUrlError(`${hostname} no resuelve a ninguna IP`, raw, "unresolvable");
  }

  // TODAS tienen que ser públicas. Basta una privada para rechazar: un nombre
  // con varios registros podría servir la pública en nuestra comprobación y la
  // privada en la petición real.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedUrlError(
        `${hostname} resuelve a ${address}, que es una dirección privada o reservada`,
        raw,
        "private_network",
      );
    }
  }

  return url;
}

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  bytes: Buffer;
}

/**
 * Pide una URL validando **cada salto** de redirección.
 *
 * `redirect: "manual"` no es un detalle: con el seguimiento automático, validar
 * la primera URL no sirve de nada. Un servidor público puede responder 302 hacia
 * 169.254.169.254 y `fetch` la seguiría sin preguntar — la comprobación de
 * arriba habría dado el visto bueno a una dirección que ya no es la que se pide.
 */
export async function safeFetch(
  raw: string,
  options: { timeoutMs?: number; maxRedirects?: number; userAgent: string },
): Promise<FetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  let current = raw;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertFetchableUrl(current);

    const response = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": options.userAgent, accept: "text/html,text/*,*/*" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        throw new Error(`Redirección ${response.status} sin cabecera Location`);
      }
      // Relativa respecto de la actual, como haría un navegador.
      current = new URL(location, url).toString();
      continue;
    }

    return {
      url: url.toString(),
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  }

  throw new Error(`Más de ${maxRedirects} redirecciones desde ${raw}`);
}
