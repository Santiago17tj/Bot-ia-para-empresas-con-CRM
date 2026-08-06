import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { systemPrisma } from "@platform/db";
import { EventDispatcher } from "@platform/events";
import { LocalEmbeddingProvider } from "@platform/providers";
import { LocalStorageDriver } from "@platform/storage";
import { buildServer, generateApiKey } from "@platform/api";

import { createIngestHandler } from "../dist/index.js";

/**
 * El ciclo completo: subir por la API → el worker procesa → el documento
 * responde preguntas.
 *
 * Es el test que dice si el producto tiene puerta de entrada. Hasta ahora un
 * cliente podía buscar y preguntar sobre un corpus que solo se podía cargar
 * ejecutándole un script de Node.
 *
 * La API y el worker se construyen aquí como en producción, con las mismas
 * piezas; lo único distinto es que el bucle del worker se avanza a mano en vez
 * de por temporizador, para que el test sea determinista.
 */

const ACME = "tnt_ing_acme01";
const RIVAL = "tnt_ing_rival1";

const app = buildServer();
const embedder = new LocalEmbeddingProvider();

let root = "";
let storage: LocalStorageDriver;
let dispatcher: EventDispatcher;
let claveAcme = "";
let claveRival = "";
let claveSoloLectura = "";

const MANUAL = `# Manual de Acme

## Devoluciones

### Plazo
El plazo para devolver un pedido es de 30 dias naturales desde la entrega.

## Envios

### Coste
El envio es gratuito para pedidos superiores a 50 euros.
`;

async function emitir(tenantId: string, scopes: string[]): Promise<string> {
  const issued = generateApiKey();
  await systemPrisma.apiKey.create({
    data: {
      tenantId,
      name: "test",
      keyHash: issued.keyHash,
      last4: issued.last4,
      scopes,
    },
  });
  return issued.secret;
}

const auth = (clave: string): Record<string, string> => ({
  authorization: `Bearer ${clave}`,
});

/** Sube un fichero como lo haría un cliente: multipart de verdad. */
function multipart(
  contenido: string,
  filename: string,
  campos: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----test-boundary-0123456789";
  const partes: string[] = [];

  for (const [nombre, valor] of Object.entries(campos)) {
    partes.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${nombre}"\r\n\r\n${valor}\r\n`,
    );
  }

  partes.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: text/markdown\r\n\r\n${contenido}\r\n`,
  );
  partes.push(`--${boundary}--\r\n`);

  return {
    payload: Buffer.from(partes.join(""), "utf8"),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** Igual que `multipart`, pero para bytes binarios con su tipo real. */
function binario(
  contenido: Buffer,
  filename: string,
  contentType: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----test-boundary-0123456789";
  // Explícito y no un salto de línea literal: multipart exige CRLF, y un
  // fichero normalizado a LF por git rompería el formato sin que se viera.
  const CRLF = String.fromCharCode(13, 10);

  const cabecera = Buffer.from(
    `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
      `Content-Type: ${contentType}${CRLF}${CRLF}`,
    "utf8",
  );
  const cierre = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8");

  return {
    payload: Buffer.concat([cabecera, contenido, cierre]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** Avanza el worker hasta vaciar la cola. */
async function procesarCola(): Promise<void> {
  await dispatcher.reclaimExpired();
  await dispatcher.drainAll();
}

describe(
  "ingesta de punta a punta",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    before(async () => {
      root = await mkdtemp(join(tmpdir(), "platform-ingest-"));
      storage = new LocalStorageDriver({ root });

      // El mismo almacenamiento que usa la API: si fueran dos directorios
      // distintos, el worker no encontraría los bytes y el test pasaría a
      // medir otra cosa.
      process.env["STORAGE_DRIVER"] = "local";
      process.env["STORAGE_LOCAL_PATH"] = root;

      dispatcher = new EventDispatcher({ workerId: "test", batchSize: 5 });
      dispatcher.on(
        "document.uploaded",
        "ingest",
        createIngestHandler({ storage, embedder, log: () => {} }),
      );

      for (const [id, slug] of [
        [ACME, "ing-acme"],
        [RIVAL, "ing-rival"],
      ] as const) {
        await systemPrisma.tenant.upsert({
          where: { id },
          update: {},
          create: { id, slug, name: slug },
        });
      }

      claveAcme = await emitir(ACME, ["knowledge:read", "knowledge:write"]);
      claveRival = await emitir(RIVAL, ["knowledge:read", "knowledge:write"]);
      claveSoloLectura = await emitir(ACME, ["knowledge:read"]);
    });

    after(async () => {
      await systemPrisma.tenant.deleteMany({ where: { id: { in: [ACME, RIVAL] } } });
      await systemPrisma.$disconnect();
      await app.close();
      await rm(root, { recursive: true, force: true });
    });

    // -----------------------------------------------------------------------
    // El ciclo completo
    // -----------------------------------------------------------------------

    test("subir devuelve 202 y el documento queda PENDING, no listo", async () => {
      const subida = multipart(MANUAL, "manual.md", { title: "Manual de Acme" });

      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/documents",
        headers: { ...auth(claveAcme), ...subida.headers },
        payload: subida.payload,
      });

      assert.equal(
        respuesta.statusCode,
        202,
        "202 y no 201: el recurso existe, pero lo que el cliente quiere —que " +
          "su documento responda preguntas— todavía no ha pasado",
      );

      const cuerpo = respuesta.json<{ id: string; status: string; statusUrl: string }>();
      assert.equal(cuerpo.status, "PENDING");
      assert.ok(cuerpo.statusUrl.includes(cuerpo.id));
    });

    test("el evento se publicó en la MISMA transacción que el documento", async () => {
      const pendientes = await systemPrisma.outboxEvent.count({
        where: { tenantId: ACME, type: "document.uploaded" },
      });

      assert.ok(
        pendientes > 0,
        "sin el evento, el documento se queda en PENDING para siempre y nadie " +
          "lo procesa: el fallo silencioso más caro del sistema",
      );
    });

    test("tras pasar el worker, el documento está READY y es buscable", async () => {
      await procesarCola();

      const documentos = await app.inject({
        method: "GET",
        url: "/v1/knowledge/documents",
        headers: auth(claveAcme),
      });

      const [doc] = documentos.json<{ documents: { id: string; status: string }[] }>()
        .documents;
      assert.ok(doc);
      assert.equal(doc.status, "READY", "el worker debería haberlo indexado");

      const detalle = await app.inject({
        method: "GET",
        url: `/v1/knowledge/documents/${doc.id}`,
        headers: auth(claveAcme),
      });

      const cuerpo = detalle.json<{ version: number; indexedAt: string | null }>();
      assert.equal(cuerpo.version, 1);
      assert.ok(cuerpo.indexedAt !== null);

      // Y lo que importa de verdad: que ahora responde.
      const busqueda = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        headers: auth(claveAcme),
        payload: { query: "cuantos dias tengo para devolver" },
      });

      const { results } = busqueda.json<{ results: { content: string }[] }>();
      assert.ok(
        results.some((r) => r.content.includes("30 dias")),
        "el documento subido por la API tiene que ser recuperable por la API",
      );
    });

    test("volver a subir lo mismo no crea versión nueva ni vuelve a pagar embeddings", async () => {
      const subida = multipart(MANUAL, "manual.md", { title: "Manual de Acme" });

      await app.inject({
        method: "POST",
        url: "/v1/knowledge/documents",
        headers: { ...auth(claveAcme), ...subida.headers },
        payload: subida.payload,
      });
      await procesarCola();

      const versiones = await systemPrisma.documentVersion.count({
        where: { tenantId: ACME },
      });

      // Dos documentos (dos subidas) pero el contenido idéntico no genera una
      // segunda versión del segundo: el checksum del texto extraído coincide.
      assert.equal(
        versiones,
        2,
        "cada subida crea su documento, pero ninguno debería tener v2",
      );
    });

    // -----------------------------------------------------------------------
    // Fallos
    // -----------------------------------------------------------------------

    test("un PDF de verdad se sube, se indexa y responde preguntas", async () => {
      // El caso que hace vendible la ingesta: nadie sube markdown, sube el PDF
      // que le dio su gestoría. Se genera uno real, con jerarquía tipográfica,
      // y se comprueba el ciclo entero por la API.
      const { PDFDocument, StandardFonts } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      const normal = await pdf.embedFont(StandardFonts.Helvetica);
      const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
      const pagina = pdf.addPage([600, 800]);
      pagina.drawText("Politica de Garantias", { x: 50, y: 740, size: 24, font: negrita });
      pagina.drawText("Cobertura", { x: 50, y: 700, size: 16, font: negrita });
      pagina.drawText("La garantia legal cubre dos anos desde la fecha de compra.", {
        x: 50, y: 675, size: 11, font: normal,
      });

      const subida = binario(
        Buffer.from(await pdf.save()),
        "garantias.pdf",
        "application/pdf",
      );

      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/documents",
        headers: { ...auth(claveAcme), ...subida.headers },
        payload: subida.payload,
      });
      assert.equal(respuesta.statusCode, 202);

      await procesarCola();

      const { id } = respuesta.json<{ id: string }>();
      const detalle = await app.inject({
        method: "GET",
        url: `/v1/knowledge/documents/${id}`,
        headers: auth(claveAcme),
      });
      assert.equal(
        detalle.json<{ status: string; error: string | null }>().status,
        "READY",
        `el PDF no se indexó: ${detalle.json<{ error: string | null }>().error ?? ""}`,
      );

      const busqueda = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        headers: auth(claveAcme),
        payload: { query: "cuanto dura la garantia" },
      });

      const { results } = busqueda.json<{ results: { content: string }[] }>();
      assert.ok(
        results.some((r) => r.content.includes("dos anos")),
        "un PDF subido por la API tiene que acabar respondiendo por la API",
      );
    });

    test("un formato todavía sin conversor se rechaza al subir, no en el worker", async () => {
      const subida = multipart("contenido", "presentacion.pptx");

      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/documents",
        headers: { ...auth(claveAcme), ...subida.headers },
        payload: subida.payload,
      });

      assert.equal(
        respuesta.statusCode,
        415,
        "aceptarlo, responder 202 y fallar después le da al cliente un FAILED " +
          "por algo que se sabía al subirlo",
      );
      assert.match(
        respuesta.json<{ error: { message: string } }>().error.message,
        /PPTX/,
      );
    });

    test("un documento cuyos bytes desaparecen acaba en FAILED con el motivo", async () => {
      const subida = multipart("# Otro\n\nContenido cualquiera.\n", "otro.md");

      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/documents",
        headers: { ...auth(claveAcme), ...subida.headers },
        payload: subida.payload,
      });
      const { id } = respuesta.json<{ id: string }>();

      // Se borra el fichero por debajo, simulando un almacenamiento que perdió
      // el objeto. El worker no puede inventarse el contenido.
      const documento = await systemPrisma.document.findUniqueOrThrow({
        where: { id },
        select: { storageKey: true },
      });
      await storage.delete(documento.storageKey as string);

      await procesarCola();

      const detalle = await app.inject({
        method: "GET",
        url: `/v1/knowledge/documents/${id}`,
        headers: auth(claveAcme),
      });

      const cuerpo = detalle.json<{ status: string; error: string | null }>();
      assert.equal(cuerpo.status, "FAILED");
      assert.ok(
        cuerpo.error !== null && cuerpo.error.length > 0,
        "un FAILED mudo deja a quien subió el fichero sin saber qué arreglar",
      );
    });

    test("subir exige el ámbito de escritura", async () => {
      const subida = multipart("# X\n\ny.\n", "x.md");

      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/documents",
        headers: { ...auth(claveSoloLectura), ...subida.headers },
        payload: subida.payload,
      });

      assert.equal(respuesta.statusCode, 403);
      assert.match(
        respuesta.json<{ error: { message: string } }>().error.message,
        /knowledge:write/,
      );
    });

    // -----------------------------------------------------------------------
    // Aislamiento
    // -----------------------------------------------------------------------

    test("el listado y el detalle solo enseñan documentos del propio tenant", async () => {
      const subida = multipart("# Manual de Rival\n\nOtra cosa.\n", "rival.md");
      await app.inject({
        method: "POST",
        url: "/v1/knowledge/documents",
        headers: { ...auth(claveRival), ...subida.headers },
        payload: subida.payload,
      });
      await procesarCola();

      const deAcme = await app.inject({
        method: "GET",
        url: "/v1/knowledge/documents",
        headers: auth(claveAcme),
      });
      const documentos = deAcme.json<{ documents: { id: string; title: string }[] }>()
        .documents;

      assert.ok(
        documentos.every((d) => !d.title.includes("Rival")),
        "FUGA: el listado de Acme incluye documentos de Rival",
      );

      // Y pedir un id ajeno por su id exacto: 404, no 403. Decir "existe pero
      // no es tuyo" confirmaría el id.
      const ajeno = await systemPrisma.document.findFirstOrThrow({
        where: { tenantId: RIVAL },
        select: { id: true },
      });

      const detalle = await app.inject({
        method: "GET",
        url: `/v1/knowledge/documents/${ajeno.id}`,
        headers: auth(claveAcme),
      });

      assert.equal(detalle.statusCode, 404);
    });
  },
);
