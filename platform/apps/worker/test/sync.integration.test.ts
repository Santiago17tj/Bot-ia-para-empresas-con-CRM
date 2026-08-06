import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { buildServer, generateApiKey } from "@platform/api";
import { systemPrisma } from "@platform/db";
import { EventDispatcher } from "@platform/events";
import { LocalEmbeddingProvider } from "@platform/providers";
import { LocalStorageDriver } from "@platform/storage";

import { createIngestHandler, createSyncHandler } from "../dist/index.js";

/**
 * Una fuente web, de punta a punta.
 *
 * Se crea por la API, se sincroniza, el rastreador descubre las páginas, entran
 * por la MISMA ruta de ingesta que un fichero subido a mano, y acaban
 * respondiendo búsquedas. Es el test que dice si un cliente puede conectar su
 * web y olvidarse.
 *
 * El sitio de prueba está en loopback, así que hace falta el escape de red
 * privada. La defensa SSRF se ejercita en `packages/connectors/test/net.test.ts`.
 */

const TENANT = "tnt_sync_acme01";
const app = buildServer();
const embedder = new LocalEmbeddingProvider();

let root = "";
let storage: LocalStorageDriver;
let dispatcher: EventDispatcher;
let clave = "";
let sitio = "";
let server: Server | undefined;

const PAGINAS: Record<string, { type: string; body: string }> = {
  "/": {
    type: "text/html",
    body: `<html><head><title>Acme</title></head><body>
      <a href="/envios">Envíos</a><a href="/garantia">Garantía</a>
    </body></html>`,
  },
  "/envios": {
    type: "text/html",
    body: `<html><head><title>Condiciones de envío</title></head><body>
      <h1>Condiciones de envío</h1>
      <h2>Gastos</h2>
      <p>El envío es gratuito para pedidos superiores a 50 euros. Por debajo,
      los gastos de envío son de 4,95 euros.</p>
    </body></html>`,
  },
  "/garantia": {
    type: "text/html",
    body: `<html><head><title>Garantía</title></head><body>
      <h1>Garantía</h1>
      <p>Todos los productos tienen dos años de garantía legal.</p>
    </body></html>`,
  },
};

const auth = { get authorization() { return `Bearer ${clave}`; } };

async function procesarCola(): Promise<void> {
  await dispatcher.reclaimExpired();
  await dispatcher.drainAll();
}

describe(
  "sincronización de una fuente web",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    before(async () => {
      process.env["CONNECTORS_ALLOW_PRIVATE_NETWORK"] = "true";

      root = await mkdtemp(join(tmpdir(), "platform-sync-"));
      storage = new LocalStorageDriver({ root });
      process.env["STORAGE_DRIVER"] = "local";
      process.env["STORAGE_LOCAL_PATH"] = root;

      server = createServer((req, res) => {
        const pagina = PAGINAS[req.url ?? "/"];
        if (pagina === undefined) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("no");
          return;
        }
        res.writeHead(200, { "content-type": pagina.type });
        res.end(pagina.body);
      });
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      sitio = `http://127.0.0.1:${port}`;

      dispatcher = new EventDispatcher({ workerId: "test-sync", batchSize: 10 });
      dispatcher.on("source.sync.requested", "sync", createSyncHandler({ storage, log: () => {} }));
      dispatcher.on("document.uploaded", "ingest", createIngestHandler({ storage, embedder, log: () => {} }));

      await systemPrisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, slug: "sync-acme", name: "Sync Acme" },
      });

      const issued = generateApiKey();
      await systemPrisma.apiKey.create({
        data: {
          tenantId: TENANT,
          name: "test",
          keyHash: issued.keyHash,
          last4: issued.last4,
          scopes: ["knowledge:read", "knowledge:write"],
        },
      });
      clave = issued.secret;
    });

    after(async () => {
      delete process.env["CONNECTORS_ALLOW_PRIVATE_NETWORK"];
      await systemPrisma.tenant.delete({ where: { id: TENANT } });
      await systemPrisma.$disconnect();
      await app.close();
      if (server !== undefined) await new Promise<void>((r) => server?.close(() => r()));
      await rm(root, { recursive: true, force: true });
    });

    let sourceId = "";

    test("una configuración inválida se rechaza al crear la fuente", async () => {
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/sources",
        headers: auth,
        payload: { name: "Sin URLs", kind: "URL", config: {} },
      });

      assert.equal(
        respuesta.statusCode,
        400,
        "aceptarla ahora la haría fallar la primera noche que sincroniza, " +
          "cuando nadie está mirando",
      );
      assert.match(
        respuesta.json<{ error: { message: string } }>().error.message,
        /startUrls/,
      );
    });

    test("se crea la fuente con su configuración normalizada", async () => {
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/sources",
        headers: auth,
        payload: {
          name: "Web de Acme",
          kind: "URL",
          config: { startUrls: [sitio], delayMs: 0, respectRobots: false },
        },
      });

      assert.equal(respuesta.statusCode, 201);
      const cuerpo = respuesta.json<{ id: string; config: { maxPages: number } }>();
      sourceId = cuerpo.id;

      // Los valores por defecto se rellenan al validar, no al usar: lo que se
      // guarda es lo que se va a ejecutar.
      assert.equal(cuerpo.config.maxPages, 100);
    });

    test("sincronizar responde 202 y deja la fuente en PENDING", async () => {
      const respuesta = await app.inject({
        method: "POST",
        url: `/v1/sources/${sourceId}/sync`,
        headers: auth,
      });

      assert.equal(respuesta.statusCode, 202);
      assert.equal(respuesta.json<{ status: string }>().status, "PENDING");
    });

    test("el rastreo entra por la ruta de ingesta y acaba siendo buscable", async () => {
      await procesarCola();

      const fuente = await app.inject({
        method: "GET",
        url: `/v1/sources/${sourceId}`,
        headers: auth,
      });
      const estado = fuente.json<{ lastSyncStatus: string; lastSyncError: string | null }>();
      assert.equal(estado.lastSyncStatus, "READY", estado.lastSyncError ?? "");

      const documentos = await app.inject({
        method: "GET",
        url: "/v1/knowledge/documents",
        headers: auth,
      });
      const docs = documentos.json<{ documents: { status: string; title: string }[] }>()
        .documents;

      assert.ok(docs.length >= 2, `esperaba varias páginas, hubo ${docs.length}`);
      assert.ok(
        docs.every((d) => d.status === "READY"),
        "el conector entrega bytes y el pipeline de siempre hace el resto",
      );
      assert.ok(
        docs.some((d) => d.title.includes("Condiciones de envío")),
        "el título sale del <title> de la página",
      );

      const busqueda = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        headers: auth,
        payload: { query: "cuanto cuesta el envio" },
      });

      const { results } = busqueda.json<{ results: { content: string; sourceRef: string }[] }>();
      assert.ok(
        results.some((r) => r.content.includes("4,95")),
        "la web del cliente tiene que acabar respondiendo por la API",
      );
      assert.ok(
        results.some((r) => r.sourceRef?.startsWith("http")),
        "la cita tiene que llevar la URL: es lo que la hace clicable",
      );
    });

    test("la segunda sincronización no reingiere lo que no cambió", async () => {
      const versionesAntes = await systemPrisma.documentVersion.count({
        where: { tenantId: TENANT },
      });

      await app.inject({
        method: "POST",
        url: `/v1/sources/${sourceId}/sync`,
        headers: auth,
      });
      await procesarCola();

      const versionesDespues = await systemPrisma.documentVersion.count({
        where: { tenantId: TENANT },
      });

      assert.equal(
        versionesDespues,
        versionesAntes,
        "sin cursor, cada sincronización nocturna vuelve a pagar troceado y " +
          "embeddings del sitio entero sin que nada haya cambiado",
      );
    });

    test("una página que cambia sí genera versión nueva", async () => {
      PAGINAS["/garantia"] = {
        type: "text/html",
        body: `<html><head><title>Garantía</title></head><body>
          <h1>Garantía</h1>
          <p>Todos los productos tienen TRES años de garantía legal ampliada.</p>
        </body></html>`,
      };

      await app.inject({
        method: "POST",
        url: `/v1/sources/${sourceId}/sync`,
        headers: auth,
      });
      await procesarCola();

      const busqueda = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        headers: auth,
        payload: { query: "cuantos anos de garantia" },
      });

      const { results } = busqueda.json<{ results: { content: string }[] }>();
      assert.ok(
        results.some((r) => r.content.includes("TRES años")),
        "el contenido nuevo tiene que estar",
      );
      assert.ok(
        !results.some((r) => r.content.includes("dos años de garantía legal.")),
        "y el viejo NO: una versión nueva desactiva los fragmentos de la anterior, " +
          "o el sistema respondería con las dos a la vez",
      );
    });

    test("no se encolan dos sincronizaciones de la misma fuente a la vez", async () => {
      await systemPrisma.knowledgeSource.update({
        where: { id: sourceId },
        data: { lastSyncStatus: "RUNNING" },
      });

      const respuesta = await app.inject({
        method: "POST",
        url: `/v1/sources/${sourceId}/sync`,
        headers: auth,
      });

      assert.equal(
        respuesta.statusCode,
        409,
        "dos rastreos del mismo sitio duplican el trabajo, doblan la carga " +
          "sobre el servidor del cliente y compiten por el mismo cursor",
      );

      await systemPrisma.knowledgeSource.update({
        where: { id: sourceId },
        data: { lastSyncStatus: "READY" },
      });
    });

    test("las fuentes de un tenant no se ven desde otro", async () => {
      const OTRO = "tnt_sync_rival1";
      await systemPrisma.tenant.upsert({
        where: { id: OTRO },
        update: {},
        create: { id: OTRO, slug: "sync-rival", name: "Sync Rival" },
      });

      try {
        const issued = generateApiKey();
        await systemPrisma.apiKey.create({
          data: {
            tenantId: OTRO,
            name: "test",
            keyHash: issued.keyHash,
            last4: issued.last4,
            scopes: ["knowledge:read", "knowledge:write"],
          },
        });

        const listado = await app.inject({
          method: "GET",
          url: "/v1/sources",
          headers: { authorization: `Bearer ${issued.secret}` },
        });
        assert.deepEqual(listado.json<{ sources: unknown[] }>().sources, []);

        const ajena = await app.inject({
          method: "GET",
          url: `/v1/sources/${sourceId}`,
          headers: { authorization: `Bearer ${issued.secret}` },
        });
        assert.equal(ajena.statusCode, 404);
      } finally {
        await systemPrisma.tenant.delete({ where: { id: OTRO } });
      }
    });
  },
);
