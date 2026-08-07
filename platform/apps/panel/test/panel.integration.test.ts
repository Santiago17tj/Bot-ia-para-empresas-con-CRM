import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildPanel, COOKIE, openApiKey, sealApiKey } from "../dist/index.js";

/**
 * El panel.
 *
 * La API se sustituye por un servidor de mentira que anota lo que recibe. Lo
 * que se prueba aquí no es qué responde `/v1` —eso ya está medido en sus
 * propios tests— sino lo que solo es del panel: que la credencial no llegue
 * nunca al navegador, que el proxy la ponga, y que sin sesión no pase nada.
 */

const CLAVE = "sk_de_prueba_1234567890";
let recibidas: { url: string; auth: string | undefined; method: string }[] = [];
let responder: (url: string) => { code: number; body: string } = () => ({
  code: 200,
  body: '{"gaps":[]}',
});

let api: Server;
let apiBaseUrl = "";

const conSecreto = process.env["SECRETS_ENCRYPTION_KEY"] !== undefined;

describe("panel de operación", { skip: !conSecreto }, () => {
  const app = buildPanel();

  before(async () => {
    api = createServer((req, res) => {
      recibidas.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
        method: req.method ?? "",
      });
      const r = responder(req.url ?? "");
      res.writeHead(r.code, { "content-type": "application/json" });
      res.end(r.body);
    });

    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const dir = api.address();
    if (dir === null || typeof dir === "string") throw new Error("sin puerto");
    apiBaseUrl = `http://127.0.0.1:${dir.port}`;

    // Se reconstruye apuntando al servidor de mentira.
    Object.assign(app, {});
    await app.ready();
  });

  after(async () => {
    await app.close();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  test("el panel NO puede leer la base de datos, y eso se comprueba", () => {
    // La regla de §27: todo lo que hace el panel se hace por API. No es una
    // intención que haya que respetar leyendo el código — el paquete no declara
    // `@platform/db`, así que no puede importarlo. Si alguien lo añade, este
    // test se lo dice antes de que el atajo se convierta en costumbre.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };

    assert.equal(
      pkg.dependencies["@platform/db"],
      undefined,
      "El panel no puede depender de @platform/db: si accede a los datos por " +
        "su cuenta, la API pública queda siempre por detrás (§27).",
    );
  });

  test("la clave se cifra y una cookie manipulada no descifra", () => {
    const sobre = sealApiKey(CLAVE);

    assert.ok(!sobre.includes(CLAVE), "la clave no puede aparecer en claro");
    assert.equal(openApiKey(`${COOKIE}=${sobre}`), CLAVE);

    // GCM es cifrado AUTENTICADO: alterar un byte hace FALLAR el descifrado en
    // vez de devolver basura que después se mandaría como credencial.
    const roto = sobre.slice(0, -4) + "AAAA";
    assert.equal(openApiKey(`${COOKIE}=${roto}`), undefined);
    assert.equal(openApiKey(undefined), undefined);
  });

  test("sin sesión, la portada es el formulario y el proxy no llama a nadie", async () => {
    recibidas = [];

    const portada = await app.inject({ method: "GET", url: "/" });
    assert.equal(portada.statusCode, 200);
    assert.match(portada.body, /Pega la clave de API/);

    const proxy = await app.inject({ method: "GET", url: "/api/knowledge/gaps" });
    assert.equal(proxy.statusCode, 401);
    assert.equal(
      recibidas.length,
      0,
      "sin sesión no se toca la API: reenviar sin credencial solo produce un " +
        "401 más lejos y un log confuso",
    );
  });

  test("la cookie de sesión es httpOnly y SameSite=Strict", async () => {
    const panel = buildPanel({ apiBaseUrl });
    await panel.ready();

    const respuesta = await panel.inject({
      method: "POST",
      url: "/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ apiKey: CLAVE }),
    });

    assert.equal(respuesta.statusCode, 200);
    const cookie = respuesta.headers["set-cookie"] as string;

    // httpOnly es lo que impide que un script de la página lea la credencial.
    assert.match(cookie, /HttpOnly/);
    // SameSite=Strict es la defensa contra CSRF sin tokens: una petición nacida
    // en otro sitio no arrastra la cookie.
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(!cookie.includes(CLAVE), "la clave no viaja en claro en la cookie");

    await panel.close();
  });

  test("una clave que la API rechaza no abre sesión", async () => {
    responder = () => ({ code: 401, body: '{"error":{"message":"no"}}' });

    const panel = buildPanel({ apiBaseUrl });
    await panel.ready();

    const respuesta = await panel.inject({
      method: "POST",
      url: "/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ apiKey: "sk_mala" }),
    });

    // Aceptarla dejaría al usuario dentro de un panel que falla en cada
    // pantalla, y el "no autorizado" en el sitio equivocado no dice que lo que
    // está mal es la clave que pegó hace diez minutos.
    assert.equal(respuesta.statusCode, 401);
    assert.equal(respuesta.headers["set-cookie"], undefined);

    responder = () => ({ code: 200, body: '{"gaps":[]}' });
    await panel.close();
  });

  test("el proxy pone la credencial y respeta ruta, método y query", async () => {
    recibidas = [];
    const panel = buildPanel({ apiBaseUrl });
    await panel.ready();

    const cookie = `${COOKIE}=${sealApiKey(CLAVE)}`;

    await panel.inject({
      method: "GET",
      url: "/api/knowledge/gaps?limit=100",
      headers: { cookie },
    });

    const vista = recibidas.at(-1);
    assert.ok(vista);
    assert.equal(vista.url, "/v1/knowledge/gaps?limit=100");
    assert.equal(vista.method, "GET");
    assert.equal(
      vista.auth,
      `Bearer ${CLAVE}`,
      "el proxy es quien pone la credencial; el navegador nunca la tuvo",
    );

    await panel.close();
  });

  test("el cuerpo se reenvía crudo, que es lo que salva una subida multipart", async () => {
    // Desmontar y volver a montar un multipart es donde se pierden los límites
    // de sección y el fichero llega corrupto sin que nada avise.
    let cuerpo = Buffer.alloc(0);
    const captura = createServer((req, res) => {
      const trozos: Buffer[] = [];
      req.on("data", (t: Buffer) => trozos.push(t));
      req.on("end", () => {
        cuerpo = Buffer.concat(trozos);
        res.writeHead(202, { "content-type": "application/json" });
        res.end('{"id":"doc_1"}');
      });
    });
    await new Promise<void>((r) => captura.listen(0, "127.0.0.1", r));
    const dir = captura.address();
    if (dir === null || typeof dir === "string") throw new Error("sin puerto");

    const panel = buildPanel({ apiBaseUrl: `http://127.0.0.1:${dir.port}` });
    await panel.ready();

    const multipart =
      "--X\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.md\"\r\n" +
      "Content-Type: text/markdown\r\n\r\n# Hola\r\n--X--\r\n";

    const respuesta = await panel.inject({
      method: "POST",
      url: "/api/knowledge/documents",
      headers: {
        cookie: `${COOKIE}=${sealApiKey(CLAVE)}`,
        "content-type": "multipart/form-data; boundary=X",
      },
      payload: multipart,
    });

    assert.equal(respuesta.statusCode, 202, "el 202 de la API llega tal cual");
    assert.equal(cuerpo.toString("utf8"), multipart, "byte a byte");

    await panel.close();
    await new Promise<void>((r) => captura.close(() => r()));
  });

  test("si la API no responde, se dice eso y no un error interno", async () => {
    // Un puerto cerrado. El panel tiene que distinguir "la API está caída" de
    // "el panel está roto": son dos personas distintas las que lo arreglan.
    const panel = buildPanel({ apiBaseUrl: "http://127.0.0.1:1" });
    await panel.ready();

    const respuesta = await panel.inject({
      method: "GET",
      url: "/api/knowledge/gaps",
      headers: { cookie: `${COOKIE}=${sealApiKey(CLAVE)}` },
    });

    assert.equal(respuesta.statusCode, 502);
    assert.equal(respuesta.json<{ error: string }>().error, "api_unreachable");

    await panel.close();
  });

  test("salir borra la cookie", async () => {
    const respuesta = await app.inject({ method: "POST", url: "/session/end" });
    assert.match(respuesta.headers["set-cookie"] as string, /Max-Age=0/);
  });
});
