import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";

import {
  ConnectorError,
  extractLinks,
  parseRobots,
  parseSitemap,
  webConnector,
  type DiscoveredDocument,
} from "../dist/index.js";

/**
 * El rastreador, contra un servidor de verdad.
 *
 * El servidor está en loopback, así que hace falta el escape de red privada —
 * el mismo que usa una instalación on-premise. La defensa SSRF se ejercita
 * aparte, en `net.test.ts`; aquí lo que se prueba es el rastreo.
 */

let server: Server | undefined;
let base = "";

const PAGINAS: Record<string, { type: string; body: string }> = {
  "/": {
    type: "text/html",
    body: `<html><head><title>Inicio</title></head><body>
      <h1>Acme</h1>
      <a href="/envios">Envíos</a>
      <a href="/devoluciones">Devoluciones</a>
      <a href="/privado/interno">Interno</a>
      <a href="https://www.wikipedia.org/">Wikipedia</a>
      <a href="mailto:hola@acme.example">Escríbenos</a>
    </body></html>`,
  },
  "/envios": {
    type: "text/html",
    body: `<html><head><title>Envíos</title></head><body>
      <h2>Plazos</h2><p>Península entre 24 y 48 horas laborables.</p>
      <a href="/envios#plazos">Ancla a sí misma</a>
    </body></html>`,
  },
  "/devoluciones": {
    type: "text/html",
    body: `<html><head><title>Devoluciones</title></head><body>
      <h2>Plazo</h2><p>Treinta días naturales desde la entrega.</p>
    </body></html>`,
  },
  "/privado/interno": {
    type: "text/html",
    body: "<html><body>No deberías estar aquí</body></html>",
  },
  "/garantia": {
    type: "text/html",
    body: `<html><head><title>Garantía</title></head><body>
      <p>Dos años de garantía legal.</p></body></html>`,
  },
  "/sitemap.xml": {
    type: "application/xml",
    body: `<?xml version="1.0"?><urlset><url><loc>__BASE__/garantia</loc></url></urlset>`,
  },
  "/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /privado" },
};

async function sincronizar(
  config: Record<string, unknown>,
  cursor: Record<string, unknown> = {},
): Promise<{
  documentos: DiscoveredDocument[];
  cursor: Record<string, unknown>;
  avisos: string[];
  saltados: number;
}> {
  const documentos: DiscoveredDocument[] = [];

  const resultado = await webConnector.sync(config, {
    cursor,
    emit: (document) => {
      documentos.push(document);
      return Promise.resolve();
    },
  });

  return {
    documentos,
    cursor: resultado.cursor,
    avisos: resultado.progress.warnings,
    saltados: resultado.progress.skipped,
  };
}

describe("rastreador web", () => {
  before(async () => {
    process.env["CONNECTORS_ALLOW_PRIVATE_NETWORK"] = "true";

    server = createServer((req, res) => {
      const pagina = PAGINAS[(req.url ?? "/").split("#")[0] ?? "/"];
      if (pagina === undefined) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("no está");
        return;
      }
      res.writeHead(200, { "content-type": pagina.type });
      res.end(pagina.body.replaceAll("__BASE__", base));
    });

    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    delete process.env["CONNECTORS_ALLOW_PRIVATE_NETWORK"];
    if (server !== undefined) await new Promise<void>((r) => server?.close(() => r()));
  });

  // -------------------------------------------------------------------------
  // Configuración
  // -------------------------------------------------------------------------

  test("una fuente sin URLs de inicio se rechaza al crearla, no al sincronizar", () => {
    // Fallar la primera noche que sincroniza, cuando nadie mira, es la peor
    // forma de descubrir un formulario mal rellenado.
    assert.throws(() => webConnector.validateConfig({}), ConnectorError);
    assert.throws(() => webConnector.validateConfig({ startUrls: [] }), ConnectorError);
  });

  test("un patrón con regex inválida se rechaza al crearla", () => {
    assert.throws(
      () =>
        webConnector.validateConfig({
          startUrls: ["https://acme.example"],
          excludePatterns: ["("],
        }),
      ConnectorError,
    );
  });

  test("los topes se acotan a un rango sensato", () => {
    const config = webConnector.validateConfig({
      startUrls: ["https://acme.example"],
      maxPages: 999_999,
      maxDepth: -5,
    }) as { maxPages: number; maxDepth: number };

    assert.equal(config.maxPages, 2_000);
    assert.equal(config.maxDepth, 0);
  });

  // -------------------------------------------------------------------------
  // Rastreo
  // -------------------------------------------------------------------------

  test("sigue los enlaces del sitio y trae el contenido", async () => {
    const { documentos } = await sincronizar({ startUrls: [base], delayMs: 0 });

    const urls = documentos.map((d) => d.externalId);
    assert.ok(urls.some((u) => u.endsWith("/envios")), "no encontró /envios");
    assert.ok(urls.some((u) => u.endsWith("/devoluciones")), "no encontró /devoluciones");

    const envios = documentos.find((d) => d.externalId.endsWith("/envios"));
    assert.ok(envios);
    assert.equal(envios.title, "Envíos");
    assert.match(envios.bytes.toString("utf8"), /24 y 48 horas/);
  });

  test("no se sale del origen", async () => {
    const { documentos } = await sincronizar({ startUrls: [base], delayMs: 0 });

    assert.ok(
      documentos.every((d) => d.externalId.startsWith(base)),
      "un enlace a Wikipedia convertiría la sincronización en un rastreo de " +
        "internet entero, y en otro camino para alcanzar lo que no es del cliente",
    );
  });

  test("respeta robots.txt", async () => {
    const { documentos, avisos } = await sincronizar({ startUrls: [base], delayMs: 0 });

    assert.ok(
      !documentos.some((d) => d.externalId.includes("/privado")),
      "el sitio pidió no entrar ahí",
    );
    assert.ok(avisos.some((a) => a.includes("robots.txt")));
  });

  test("un sitemap aporta URLs que no están enlazadas", async () => {
    // /garantia no la enlaza nadie: solo está en el sitemap.
    const { documentos } = await sincronizar({
      startUrls: [`${base}/sitemap.xml`],
      delayMs: 0,
    });

    assert.ok(
      documentos.some((d) => d.externalId.endsWith("/garantia")),
      "el sitemap es justo para las páginas que no cuelgan de la navegación",
    );
  });

  test("los patrones de exclusión filtran antes de pedir la página", async () => {
    const { documentos } = await sincronizar({
      startUrls: [base],
      delayMs: 0,
      excludePatterns: ["/devoluciones"],
    });

    assert.ok(!documentos.some((d) => d.externalId.includes("/devoluciones")));
    assert.ok(documentos.some((d) => d.externalId.includes("/envios")));
  });

  // -------------------------------------------------------------------------
  // Lo incremental — donde está el dinero
  // -------------------------------------------------------------------------

  test("la segunda pasada no reingiere lo que no ha cambiado", async () => {
    const primera = await sincronizar({ startUrls: [base], delayMs: 0 });
    assert.ok(primera.documentos.length > 0);

    const segunda = await sincronizar({ startUrls: [base], delayMs: 0 }, primera.cursor);

    assert.equal(
      segunda.documentos.length,
      0,
      "sin cursor, cada sincronización nocturna vuelve a pagar el troceado y " +
        "los embeddings del sitio entero sin que nada haya cambiado",
    );
    assert.ok(segunda.saltados > 0);
  });

  test("el tope de páginas se dice en voz alta", async () => {
    const { documentos, avisos } = await sincronizar({
      startUrls: [base],
      delayMs: 0,
      maxPages: 2,
    });

    assert.ok(documentos.length <= 2);
    assert.ok(
      avisos.some((a) => a.includes("tope")),
      "un tope silencioso hace creer que el sitio entero está indexado",
    );
  });

  // -------------------------------------------------------------------------
  // Piezas sueltas
  // -------------------------------------------------------------------------

  test("los enlaces se resuelven a absolutos y se ignora lo que no es web", () => {
    const links = extractLinks(
      `<a href="/a">a</a><a href="b">b</a><a href="mailto:x@y.z">m</a>
       <a href="javascript:alert(1)">j</a><a href="#seccion">s</a>`,
      "https://acme.example/docs/",
    );

    assert.ok(links.includes("https://acme.example/a"));
    assert.ok(links.includes("https://acme.example/docs/b"));
    assert.ok(!links.some((l) => l.startsWith("mailto")));
    assert.ok(!links.some((l) => l.startsWith("javascript")));
    // El ancla es la misma página: se normaliza quitando el fragmento.
    assert.ok(links.includes("https://acme.example/docs/"));
  });

  test("el sitemap se lee también cuando es un índice de sitemaps", () => {
    assert.deepEqual(
      parseSitemap(`<sitemapindex>
        <sitemap><loc>https://acme.example/s1.xml</loc></sitemap>
        <sitemap><loc> https://acme.example/s2.xml </loc></sitemap>
      </sitemapindex>`),
      ["https://acme.example/s1.xml", "https://acme.example/s2.xml"],
    );
  });

  test("robots.txt: solo se aplican las reglas de nuestro agente o de todos", () => {
    const reglas = parseRobots(`
      User-agent: Googlebot
      Disallow: /solo-para-google

      User-agent: *
      Disallow: /privado
      Disallow: /admin      # comentario
    `);

    assert.deepEqual(reglas, ["/privado", "/admin"]);
  });
});
