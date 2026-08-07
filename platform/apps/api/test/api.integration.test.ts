import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { runWithTenant, systemPrisma, withRlsTransaction } from "@platform/db";
import { ingestDocument } from "@platform/knowledge";
import { LocalEmbeddingProvider } from "@platform/providers";

import { buildServer, generateApiKey, RateLimiter } from "../dist/index.js";

/**
 * La API, ejercida entera con `app.inject()`: mismo ciclo de vida —hooks,
 * validación, manejador de errores— sin abrir un puerto.
 *
 * El test que importa es el de aislamiento. Todo lo demás de este fichero
 * comprueba que la API hace lo que dice; ese comprueba que no hace lo que
 * arruinaría el producto.
 */

const embedder = new LocalEmbeddingProvider();
const app = buildServer();

const ACME = "tnt_api_acme01";
const RIVAL = "tnt_api_rival1";

const CORPUS_ACME = `# Manual de Acme

## Devoluciones
El plazo para devolver un pedido es de 30 días naturales desde la entrega.
`;

const CORPUS_RIVAL = `# Manual de Rival

## Devoluciones
El plazo para devolver un pedido en Rival es de 90 días naturales.
`;

let claveAcme = "";
let claveSoloLectura = "";
let claveRevocada = "";
let claveCaducada = "";

async function crearTenant(id: string, slug: string, corpus: string): Promise<void> {
  await systemPrisma.tenant.upsert({
    where: { id },
    update: {},
    create: { id, slug, name: slug },
  });

  await runWithTenant(
    {
      tenantId: id,
      actor: { type: "system" as const, id: "api-test", scopes: [] },
      requestId: `req_seed_${slug}`,
    },
    () =>
      ingestDocument(
        {
          tenantId: id,
          bytes: Buffer.from(corpus, "utf8"),
          filename: "manual.md",
          mimeType: "text/markdown",
          sourceRef: `manual-${slug}`,
        },
        { embedder, transaction: withRlsTransaction },
      ),
  );
}

async function emitir(
  tenantId: string,
  scopes: string[],
  extra: { revokedAt?: Date; expiresAt?: Date } = {},
): Promise<string> {
  const issued = generateApiKey();
  await systemPrisma.apiKey.create({
    data: {
      tenantId,
      name: "test",
      keyHash: issued.keyHash,
      last4: issued.last4,
      scopes,
      ...extra,
    },
  });
  return issued.secret;
}

const auth = (clave: string): Record<string, string> => ({
  authorization: `Bearer ${clave}`,
});

describe(
  "API v1",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    before(async () => {
      await crearTenant(ACME, "acme", CORPUS_ACME);
      await crearTenant(RIVAL, "rival", CORPUS_RIVAL);

      claveAcme = await emitir(ACME, ["knowledge:read", "knowledge:answer"]);
      claveSoloLectura = await emitir(ACME, ["knowledge:read"]);
      claveRevocada = await emitir(ACME, ["knowledge:read"], {
        revokedAt: new Date(),
      });
      claveCaducada = await emitir(ACME, ["knowledge:read"], {
        expiresAt: new Date(Date.now() - 1000),
      });
    });

    after(async () => {
      await systemPrisma.tenant.deleteMany({ where: { id: { in: [ACME, RIVAL] } } });
      await systemPrisma.$disconnect();
      await app.close();
    });

    // -----------------------------------------------------------------------
    // Aislamiento — el test que decide si esto se puede vender
    // -----------------------------------------------------------------------

    test("una búsqueda registra su consumo, y eso no era verdad", async () => {
      // Regresión de un fallo que estuvo vivo toda la vida del proyecto y que
      // nada delataba: `meter()` abría `withRlsTransaction` SIN contexto de
      // tenant, así que lanzaba `TenantContextError` en cada llamada y un
      // `catch {}` mudo se lo tragaba. Ni consumo ni huecos, nunca, desde la
      // API. El síntoma era una lista vacía, que se lee como "no ha pasado
      // nada" en vez de como "no se está midiendo".
      // Se cuenta el EVENTO y no la fila de `usageRecord`: `recordUsage`
      // publica en el outbox y es el worker quien materializa la fila, así que
      // en un test sin worker la fila no llega nunca. Contarla mediría al
      // worker, que no es lo que este test vigila.
      const contar = () =>
        systemPrisma.outboxEvent.count({
          where: { tenantId: ACME, type: "usage.recorded" },
        });
      const antes = await contar();

      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        headers: auth(claveAcme),
        payload: { query: "plazo para devolver un pedido" },
      });
      assert.equal(respuesta.statusCode, 200);

      const despues = await contar();
      assert.ok(
        despues > antes,
        "el consumo pasado no se reconstruye: lo que no se mida hoy se perdió",
      );
    });

    test("la clave de un tenant no ve NADA del otro", async () => {
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        headers: auth(claveAcme),
        payload: { query: "plazo para devolver un pedido" },
      });

      assert.equal(respuesta.statusCode, 200);
      const { results } = respuesta.json<{ results: { content: string }[] }>();

      assert.ok(results.length > 0, "debería encontrar su propio manual");
      assert.ok(
        results.every((r) => r.content.includes("30 días")),
        "encontró el corpus de Acme",
      );
      assert.ok(
        results.every((r) => !r.content.includes("90 días")),
        "FUGA ENTRE TENANTS: la clave de Acme recuperó el manual de Rival. " +
          "Las dos empresas tienen un documento casi idéntico a propósito, " +
          "para que una fuga se vea en el contenido y no solo en un id.",
      );
    });

    test("mandar el tenant ajeno en el cuerpo no cambia NADA", async () => {
      // El ataque obvio contra una API multi-tenant: si el tenant fuera un
      // parámetro, bastaría cambiarlo. Aquí el esquema declara
      // `additionalProperties: false`, así que el campo se descarta antes de
      // llegar al manejador — y aunque llegara, el manejador lee el tenant del
      // contexto de la credencial y no mira el cuerpo.
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        headers: auth(claveAcme),
        payload: { query: "plazo para devolver un pedido", tenantId: RIVAL },
      });

      assert.equal(respuesta.statusCode, 200);
      const { results } = respuesta.json<{ results: { content: string }[] }>();

      assert.ok(results.length > 0);
      assert.ok(
        results.every((r) => !r.content.includes("90 días")),
        "pedir el tenant de otro en el cuerpo devolvió datos de ese tenant",
      );
    });

    // -----------------------------------------------------------------------
    // Credenciales
    // -----------------------------------------------------------------------

    test("sin cabecera de autorización no se pasa", async () => {
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        payload: { query: "plazo" },
      });

      assert.equal(respuesta.statusCode, 401);
    });

    test("una clave inventada, una revocada y una caducada dan el MISMO error", async () => {
      const respuestas = await Promise.all(
        ["sk_" + "a".repeat(43), claveRevocada, claveCaducada].map((clave) =>
          app.inject({
            method: "POST",
            url: "/v1/knowledge/search",
            headers: auth(clave),
            payload: { query: "plazo" },
          }),
        ),
      );

      const cuerpos = respuestas.map((r) => r.json<{ error: { message: string } }>());

      for (const respuesta of respuestas) assert.equal(respuesta.statusCode, 401);
      assert.equal(
        new Set(cuerpos.map((c) => c.error.message)).size,
        1,
        "distinguirlos le diría a quien prueba claves cuáles existieron alguna vez",
      );
    });

    test("un ámbito que falta es 403, no 401", async () => {
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/answer",
        headers: auth(claveSoloLectura),
        payload: { question: "¿Cuántos días tengo?" },
      });

      assert.equal(respuesta.statusCode, 403);
      assert.match(
        respuesta.json<{ error: { message: string } }>().error.message,
        /knowledge:answer/,
      );
    });

    // -----------------------------------------------------------------------
    // Contrato
    // -----------------------------------------------------------------------

    test("una petición sin query se rechaza con el campo que falta", async () => {
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        headers: auth(claveAcme),
        payload: {},
      });

      assert.equal(respuesta.statusCode, 400);
      assert.match(
        respuesta.json<{ error: { message: string } }>().error.message,
        /query/,
      );
    });

    test("toda respuesta lleva el requestId, también las de error", async () => {
      const ok = await app.inject({ method: "GET", url: "/v1/health" });
      assert.ok(ok.headers["x-request-id"]);

      const error = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        payload: { query: "x" },
      });
      assert.ok(error.json<{ error: { requestId: string } }>().error.requestId);
    });

    test("un requestId de aguas arriba se respeta, para poder seguir la llamada", async () => {
      const respuesta = await app.inject({
        method: "GET",
        url: "/v1/health",
        headers: { "x-request-id": "req_del_proxy" },
      });

      assert.equal(respuesta.headers["x-request-id"], "req_del_proxy");
    });

    test("una ruta que no existe es 404 con forma de error, no una página", async () => {
      const respuesta = await app.inject({ method: "GET", url: "/v1/no-existe" });

      assert.equal(respuesta.statusCode, 404);
      assert.equal(respuesta.json<{ error: { code: string } }>().error.code, "not_found");
    });

    test("health comprueba la base de datos, no solo que el proceso responde", async () => {
      const respuesta = await app.inject({ method: "GET", url: "/v1/health" });

      assert.equal(respuesta.statusCode, 200);
      assert.equal(respuesta.json<{ database: string }>().database, "ok");
    });

    test("los resultados no exponen el vector ni los rangos internos", async () => {
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        headers: auth(claveAcme),
        payload: { query: "devoluciones" },
      });

      const [primero] = respuesta.json<{ results: Record<string, unknown>[] }>().results;
      assert.ok(primero);
      assert.equal(primero["vectorRank"], undefined);
      assert.equal(primero["lexicalRank"], undefined);
      assert.equal(primero["versionId"], undefined);
      assert.ok(primero["chunkId"]);
    });
  },
);

// ---------------------------------------------------------------------------
// Límite de tasa — sin base de datos
// ---------------------------------------------------------------------------

test("el límite de tasa cuenta por ventana y dice cuánto esperar", () => {
  const limiter = new RateLimiter();
  const inicio = 1_000_000;

  assert.equal(limiter.check("k", 2, inicio), undefined);
  assert.equal(limiter.check("k", 2, inicio + 100), undefined);

  const espera = limiter.check("k", 2, inicio + 200);
  assert.ok(espera !== undefined && espera > 0, "la tercera debe frenarse");

  // Ventana nueva: vuelve a pasar.
  assert.equal(limiter.check("k", 2, inicio + 60_001), undefined);
});

test("un límite de cero se interpreta como sin límite, no como sin servicio", () => {
  const limiter = new RateLimiter();
  // El caso real que produce un cero es una fila mal migrada. Dejar sin
  // servicio a un cliente por un valor por defecto ausente es peor que no
  // limitarlo.
  for (let i = 0; i < 100; i++) {
    assert.equal(limiter.check("k", 0), undefined);
  }
});

test("las ventanas vencidas se descartan en vez de crecer para siempre", () => {
  const limiter = new RateLimiter();
  const inicio = 1_000_000;

  for (let i = 0; i < 50; i++) limiter.check(`clave_${i}`, 10, inicio);
  assert.equal(limiter.size, 50);

  limiter.sweep(inicio + 60_001);
  assert.equal(
    limiter.size,
    0,
    "en una API pública, las claves que llaman una vez y no vuelven son todas " +
      "las que prueban una credencial robada",
  );
});
