import Fastify, { type FastifyInstance } from "fastify";

import { optional } from "@platform/env";

import { page } from "./pages.js";
import {
  clearCookie,
  openApiKey,
  sealApiKey,
  sessionCookie,
  sessionReady,
} from "./session.js";

/**
 * El panel de operación (§27).
 *
 * **Todo lo que hace el panel se hace por la API.** No es una intención, es una
 * propiedad comprobable: este paquete no depende de `@platform/db` —míralo en su
 * `package.json`— así que no *puede* leer la base aunque alguien quisiera. Hay
 * un test que lo verifica, porque la regla del plan es que si el panel accede a
 * los datos por su cuenta, la API pública queda siempre por detrás y se entera
 * el primer cliente que intente integrarse.
 *
 * La consecuencia práctica es que el panel es un **proxy con sesión**: sirve
 * HTML sin construir nada, y todo lo demás lo reenvía a `/v1/*` poniendo la
 * credencial. Si una pantalla necesita un dato que la API no da, el arreglo es
 * añadirlo a la API, no saltársela.
 */

export interface PanelOptions {
  /** Dónde vive la API. Por defecto, la del `.env`. */
  apiBaseUrl?: string;
  logger?: boolean;
}

export function buildPanel(options: PanelOptions = {}): FastifyInstance {
  const apiBaseUrl = (
    options.apiBaseUrl ??
    optional("PANEL_API_URL") ??
    `http://127.0.0.1:${optional("PORT") ?? 3001}`
  ).replace(/\/+$/, "");

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 26_214_400, // 25 MB: un manual en PDF cabe; un vídeo no.
  });

  // El cuerpo se captura CRUDO y sin interpretar, para CUALQUIER tipo.
  //
  // `removeAllContentTypeParsers` primero, y no solo añadir el comodín: el
  // parser de JSON que Fastify trae de serie tiene prioridad sobre `*`, así que
  // sin quitarlo un `application/json` llegaba ya convertido en objeto y el
  // proxy reenviaba `[object Object]`. Falló primero en el formulario de
  // sesión, que es donde se vio; habría fallado igual en cada pregunta.
  //
  // Y crudo es además lo que permite reenviar un `multipart/form-data` de
  // subida de fichero sin desmontarlo y volverlo a montar, que es donde se
  // pierden los límites de sección y el fichero llega corrupto sin aviso.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/", async (request, reply) => {
    const key = openApiKey(request.headers.cookie);
    return reply
      .type("text/html; charset=utf-8")
      .send(page(key === undefined ? "login" : "app"));
  });

  /**
   * Iniciar sesión = validar la clave contra la API y guardarla cifrada.
   *
   * Se valida ANTES de poner la cookie, y se valida llamando a la API de
   * verdad: aceptar una clave inválida deja al usuario dentro de un panel que
   * falla en cada pantalla, y el mensaje "no autorizado" en el sitio equivocado
   * no dice que lo que está mal es la credencial que pegó hace diez minutos.
   */
  app.post("/session", async (request, reply) => {
    if (!sessionReady()) {
      return reply.code(503).send({
        error: "secrets_not_configured",
        message:
          "Falta SECRETS_ENCRYPTION_KEY. El panel guarda la clave de API " +
          "cifrada en la cookie, así que sin ella no puede iniciar sesión. " +
          "Genérala con: node -e \"console.log(require('crypto')" +
          '.randomBytes(32).toString(\'base64\'))"',
      });
    }

    const apiKey = readApiKey(request.body);
    if (apiKey === undefined) {
      return reply.code(400).send({ error: "missing_key" });
    }

    const probe = await fetch(`${apiBaseUrl}/v1/knowledge/gaps?limit=1`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }).catch(() => undefined);

    if (probe === undefined) {
      return reply.code(502).send({
        error: "api_unreachable",
        message: `No se pudo contactar con la API en ${apiBaseUrl}. ¿Está \`npm run dev\` levantado?`,
      });
    }

    if (!probe.ok) {
      return reply.code(401).send({
        error: "invalid_key",
        message:
          probe.status === 403
            ? "Esa clave existe pero le faltan ámbitos. El panel necesita al menos knowledge:read."
            : "Esa clave no es válida.",
      });
    }

    return reply
      .header("set-cookie", sessionCookie(sealApiKey(apiKey), isHttps(request.headers)))
      .send({ ok: true });
  });

  app.post("/session/end", async (_request, reply) =>
    reply.header("set-cookie", clearCookie()).send({ ok: true }),
  );

  /**
   * El proxy. Todo lo que la interfaz necesita pasa por aquí.
   *
   * Reenvía método, ruta, query y cuerpo tal cual, y añade la credencial. No
   * interpreta ni transforma nada a propósito: el día que una ruta de `/v1`
   * cambie su forma, el panel no tiene que enterarse. Un proxy que "arregla"
   * respuestas es una segunda implementación de la API que se desincroniza.
   */
  app.all("/api/*", async (request, reply) => {
    const apiKey = openApiKey(request.headers.cookie);
    if (apiKey === undefined) {
      return reply.code(401).send({ error: "no_session" });
    }

    const path = (request.params as { "*"?: string })["*"] ?? "";
    const query = request.url.includes("?")
      ? request.url.slice(request.url.indexOf("?"))
      : "";

    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
    const contentType = request.headers["content-type"];
    if (contentType !== undefined) headers["content-type"] = contentType;

    let upstream: Response;
    try {
      upstream = await fetch(`${apiBaseUrl}/v1/${path}${query}`, {
        method: request.method,
        headers,
        ...(request.method === "GET" || request.method === "HEAD"
          ? {}
          : { body: request.body as Buffer }),
      });
    } catch {
      return reply
        .code(502)
        .send({ error: "api_unreachable", message: `Sin respuesta de ${apiBaseUrl}.` });
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    return reply
      .code(upstream.status)
      .type(upstream.headers.get("content-type") ?? "application/json")
      .send(body);
  });

  return app;
}

/** El cuerpo llega crudo por el parser de arriba, así que se interpreta aquí. */
function readApiKey(body: unknown): string | undefined {
  if (!Buffer.isBuffer(body)) return undefined;

  try {
    const parsed = JSON.parse(body.toString("utf8")) as { apiKey?: unknown };
    const key = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    return key === "" ? undefined : key;
  } catch {
    return undefined;
  }
}

/**
 * ¿Se está sirviendo por HTTPS?
 *
 * Detrás de un proxy inverso la conexión hasta el panel es HTTP aunque el
 * cliente venga por HTTPS, y lo único que lo dice es `x-forwarded-proto`. Sin
 * mirarlo, la cookie saldría sin `Secure` en producción.
 */
function isHttps(headers: Record<string, unknown>): boolean {
  const forwarded = headers["x-forwarded-proto"];
  return typeof forwarded === "string" && forwarded.split(",")[0]?.trim() === "https";
}
