import { createSign } from "node:crypto";

import { ConnectorError } from "./types.js";

/**
 * Autenticación con Google por cuenta de servicio.
 *
 * **Cuenta de servicio y no OAuth de usuario**, por lo mismo que en Notion se
 * eligió el token interno: OAuth exige un proyecto en Google Cloud, una URL de
 * callback alojada y —para los ámbitos de Drive— pasar su verificación.
 *
 * Y el modelo mental le sale gratis al cliente porque ya lo conoce: la cuenta
 * de servicio tiene un correo, y **se comparte la carpeta con ese correo** como
 * se comparte con un compañero. Es la misma operación que compartir una página
 * con una integración de Notion, y no hay que explicarle qué es un `scope`.
 *
 * Se firma el JWT a mano en vez de traer `google-auth-library`: son treinta
 * líneas de `node:crypto` contra una dependencia con su propia superficie y su
 * propio calendario de versiones.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** Solo lectura. Un conector de conocimiento no tiene por qué poder escribir. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/**
 * Valida la clave de servicio.
 *
 * Se comprueba al guardar la fuente, no al sincronizarla: un JSON pegado a
 * medias que se acepta produce una fuente que falla la primera noche, cuando
 * nadie está mirando.
 */
export function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConnectorError(
      "Las credenciales de Google no son un JSON válido. Pega el fichero " +
        "completo que descarga la consola al crear la clave de la cuenta de servicio.",
      "GOOGLE_DRIVE",
      true,
    );
  }

  const account = parsed as Partial<ServiceAccount> & { type?: string };

  if (typeof account.client_email !== "string" || account.client_email === "") {
    throw new ConnectorError(
      "Al JSON le falta `client_email`. ¿Has pegado la clave de una cuenta de " +
        "servicio, y no un client_secret de OAuth?",
      "GOOGLE_DRIVE",
      true,
    );
  }

  if (typeof account.private_key !== "string" || !account.private_key.includes("PRIVATE KEY")) {
    throw new ConnectorError(
      "Al JSON le falta `private_key` o está incompleta.",
      "GOOGLE_DRIVE",
      true,
    );
  }

  return {
    client_email: account.client_email,
    // Al pegar el JSON en un formulario, los saltos de línea de la clave suelen
    // llegar como `\n` literales. Sin esto, la firma falla con un error de
    // OpenSSL que no dice nada de lo que pasó de verdad.
    private_key: account.private_key.replace(/\\n/g, "\n"),
    ...(typeof account.token_uri === "string" ? { token_uri: account.token_uri } : {}),
  };
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/**
 * Construye y firma el JWT de portador.
 *
 * Puro y exportado para poder comprobar la forma sin red: que el `aud` es el
 * endpoint de token, que el `scope` es de solo lectura y que la caducidad no
 * pasa de una hora, que es el máximo que Google acepta.
 */
export function buildAssertion(
  account: ServiceAccount,
  scope: string,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope,
      aud: account.token_uri ?? DEFAULT_TOKEN_URI,
      // Una hora es el techo de Google. Pedir más hace que rechace la
      // aserción entera con `invalid_grant`, que no dice por qué.
      exp: now + 3600,
      iat: now,
    }),
  );

  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(account.private_key);

  return `${header}.${claims}.${base64url(signature)}`;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * Consigue un token de acceso y lo reutiliza mientras valga.
 *
 * El token dura una hora y una sincronización grande son cientos de peticiones.
 * Pedir uno nuevo en cada llamada funcionaría, y sería multiplicar por dos el
 * tráfico contra Google para nada.
 */
export class GoogleTokenSource {
  readonly #account: ServiceAccount;
  readonly #scope: string;
  #cached: CachedToken | undefined;

  constructor(account: ServiceAccount, scope: string = DRIVE_SCOPE) {
    this.#account = account;
    this.#scope = scope;
  }

  async token(): Promise<string> {
    // Margen de 60 s: un token que caduca a mitad de una petición en vuelo
    // devuelve 401 y aborta la sincronización por un problema de relojes.
    if (this.#cached !== undefined && this.#cached.expiresAt > Date.now() + 60_000) {
      return this.#cached.value;
    }

    const tokenUri = this.#account.token_uri ?? DEFAULT_TOKEN_URI;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: buildAssertion(this.#account, this.#scope),
    });

    const response = await fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ConnectorError(
        explainAuth(response.status, detail),
        "GOOGLE_DRIVE",
        // Un rechazo de credenciales no mejora reintentándolo.
        response.status === 400 || response.status === 401,
      );
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (typeof payload.access_token !== "string") {
      throw new ConnectorError(
        "Google no devolvió token de acceso.",
        "GOOGLE_DRIVE",
        false,
      );
    }

    this.#cached = {
      value: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    };

    return this.#cached.value;
  }
}

function explainAuth(status: number, detail: string): string {
  if (detail.includes("invalid_grant")) {
    return (
      "Google rechazó las credenciales (invalid_grant). Suele ser una de tres: " +
      "la clave se ha revocado, el reloj del servidor está desajustado, o el " +
      "JSON pegado está incompleto."
    );
  }
  if (status === 403) {
    return (
      "Google respondió 403. Comprueba que la API de Drive esté habilitada en " +
      "el proyecto de la cuenta de servicio."
    );
  }
  return `Google respondió ${status} al pedir el token: ${detail.slice(0, 300)}`;
}
