import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { systemPrisma } from "@platform/db";
import { EventDispatcher } from "@platform/events";
import { seedPrompts } from "@platform/observability";
import { LocalEmbeddingProvider } from "@platform/providers";
import type { AIProvider, GenerationRequest, GenerationResult } from "@platform/providers";
import { LocalStorageDriver } from "@platform/storage";
import { buildServer, issueApiKey } from "@platform/api";

import { createGapHandler, createIngestHandler } from "../dist/index.js";

/**
 * El test de humo: el producto entero, una vez, como lo vive un cliente.
 *
 * **Por qué existe.** Este repositorio tiene cuatrocientos tests de piezas y no
 * tenía ninguno del producto. En una sola sesión aparecieron cuatro cosas que
 * la documentación daba por funcionando y no funcionaban:
 *
 *  - la CI llevaba doce ejecuciones sin pasar,
 *  - `issue-key` nunca emitió una credencial,
 *  - ni el consumo ni los huecos se registraban desde la API,
 *  - y el agrupador de huecos no agrupa ni preguntas idénticas.
 *
 * Las cuatro salieron de EJECUTAR el sistema a mano, ninguna de leerlo. Tres de
 * las cuatro las habría cazado este fichero. Esa es su razón de ser: no
 * comprueba ningún componente —cada uno ya tiene los suyos— sino que la cadena
 * completa sigue enganchada.
 *
 * **Con generador falso, a propósito.** Lo que se mide aquí es la fontanería,
 * no la calidad del modelo: eso lo mide `npm run eval` contra uno real y con
 * puerta. Un modelo de verdad haría este test lento, caro y no determinista, y
 * un test de humo que falla a veces no lo mira nadie.
 */

const TENANT = "tnt_humo_acme1";

const CORPUS = `# Manual de Acme

## Devoluciones

### Plazo de devolución
El plazo para devolver un pedido es de 30 días naturales desde la entrega.

## Envíos

### Plazos de entrega
Los envíos a Canarias tardan entre 3 y 5 días laborables.
`;

/** La pregunta cuya respuesta NO está en el corpus. Ver el caso de la trampa. */
const TRAMPA = "Una vez devuelvo el pedido, ¿cuántos días tardáis en reembolsarme?";

/**
 * Un generador de mentira que se comporta como debe: cita literalmente lo que
 * se le da, y se abstiene cuando le preguntan por el reembolso.
 */
class FakeProvider implements AIProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = {
    toolCalling: true,
    structuredOutput: true,
    promptCaching: false,
    contextWindow: 8_192,
    maxOutputTokens: 2_048,
    sampling: true,
  };
  readonly pricing = { inputPerMillion: 0, outputPerMillion: 0 };

  generate(req: GenerationRequest): Promise<GenerationResult> {
    const contenido = req.messages[0]?.content ?? "";

    // Agrupación de huecos: se le pide decidir si dos preguntas son la misma.
    if (contenido.includes("HUECOS CONOCIDOS") || contenido.includes("hueco")) {
      return this.#responder({ matchIndex: null });
    }

    // El corpus no dice nada del plazo de REEMBOLSO. Abstenerse es lo correcto,
    // y es lo que este test viene a comprobar que se registra.
    if (contenido.includes("reembols")) {
      return this.#responder({ answered: false, response: "No consta.", citations: [] });
    }

    // Se cita LITERALMENTE una frase del contexto, y se busca EN QUÉ fragmento
    // está en vez de suponer que es el primero: la validación de grounding
    // comprueba que la cita aparezca en el fragmento que se dice, así que un
    // fake que acierta por orden mediría el orden y no la validación.
    //
    // El contexto llega como `[idDelFragmento]` seguido del encabezado y el
    // contenido del fragmento.
    const cita = "El plazo para devolver un pedido es de 30 días naturales";
    const chunkId =
      contenido
        .split(/(?=\[[\w-]+\])/)
        .filter((bloque) => bloque.includes(cita))
        .map((bloque) => /^\[([\w-]+)\]/.exec(bloque)?.[1] ?? "")
        .find((id) => id !== "") ?? "";

    return this.#responder({
      answered: true,
      response: "El plazo es de 30 días naturales desde la entrega.",
      citations: [{ chunkId, quote: cita }],
    });
  }

  #responder(parsed: unknown): Promise<GenerationResult> {
    return Promise.resolve({
      text: JSON.stringify(parsed),
      parsed,
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 10, cachedTokens: 0 },
      cost: 0,
      model: this.model,
      latencyMs: 1,
    } as GenerationResult);
  }
}

const embedder = new LocalEmbeddingProvider();
const provider = new FakeProvider();
const app = buildServer({ providers: { ai: provider } });

let root = "";
let dispatcher: EventDispatcher;
let clave = "";
const fallosDeConsumidor: string[] = [];

const auth = (): Record<string, string> => ({ authorization: `Bearer ${clave}` });

const eventos = (type: string) =>
  systemPrisma.outboxEvent.count({ where: { tenantId: TENANT, type } });

async function drenar(): Promise<void> {
  await dispatcher.reclaimExpired();
  await dispatcher.drainAll();
}

function multipart(contenido: string, filename: string) {
  const boundary = "----humo";
  const payload =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    "Content-Type: text/markdown\r\n\r\n" +
    `${contenido}\r\n--${boundary}--\r\n`;
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  };
}

describe(
  "humo: el producto de punta a punta",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    before(async () => {
      await seedPrompts({ silent: true });

      root = await mkdtemp(join(tmpdir(), "platform-humo-"));
      process.env["STORAGE_DRIVER"] = "local";
      process.env["STORAGE_LOCAL_PATH"] = root;

      await systemPrisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, slug: "humo-acme", name: "Humo Acme" },
      });

      const storage = new LocalStorageDriver({ root });
      // `onError` no es opcional aquí. Sin él, un consumidor que falla lo hace
      // en silencio y el test dice "el documento sigue en PENDING" sin decir
      // por qué — que es exactamente el modo de fallo que este fichero existe
      // para no repetir.
      dispatcher = new EventDispatcher({
        batchSize: 25,
        onError: (event, handler, error) => {
          fallosDeConsumidor.push(
            `${event.type} → ${handler}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      });
      dispatcher.on("document.uploaded", "ingest", createIngestHandler({ storage, embedder, log: () => {} }));
      dispatcher.on("knowledge.gap", "gaps", createGapHandler({ embedder, provider, log: () => {} }));

      await app.ready();
    });

    after(async () => {
      await app.close();
      await systemPrisma.tenant.delete({ where: { id: TENANT } });
      await systemPrisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    });

    test("un cliente nuevo: credencial, documento, respuesta fundada y hueco", async () => {
      // --- 1. La credencial -------------------------------------------------
      // Por la MISMA función que usa `npm run issue-key`. Estuvo rota desde el
      // primer día porque vivía dentro de un script y ningún test la tocaba.
      const emitida = await issueApiKey({ tenantId: TENANT, name: "humo" });
      clave = emitida.secret;

      assert.ok(clave.startsWith("sk_"), "la clave se devuelve en claro una vez");
      assert.equal(emitida.tenantSlug, "humo-acme");

      // --- 2. Subir documentación ------------------------------------------
      const subida = multipart(CORPUS, "manual.md");
      const aceptado = await app.inject({
        method: "POST",
        url: "/v1/knowledge/documents",
        headers: { ...auth(), ...subida.headers },
        payload: subida.payload,
      });

      // 202 y no 200: indexar no cabe en un timeout HTTP.
      assert.equal(aceptado.statusCode, 202);
      const { id: documentId } = aceptado.json<{ id: string }>();

      // --- 3. El worker lo indexa ------------------------------------------
      await drenar();
      assert.deepEqual(fallosDeConsumidor, [], "un consumidor falló");

      const detalle = await app.inject({
        method: "GET",
        url: `/v1/knowledge/documents/${documentId}`,
        headers: auth(),
      });
      // Si no está READY, se dice POR QUÉ. Un "sigue en PENDING" a secas manda
      // a quien lo lea a adivinar entre el consumidor, el despachador y la
      // visibilidad del evento.
      const estado = detalle.json<{ status: string }>().status;
      if (estado !== "READY") {
        const evento = await systemPrisma.outboxEvent.findFirst({
          where: { tenantId: TENANT, type: "document.uploaded" },
          select: {
            status: true,
            attempts: true,
            lockedBy: true,
            availableAt: true,
            lastError: true,
          },
        });
        const ahora = await systemPrisma.$queryRaw<{ t: Date }[]>`SELECT now() AS t`;
        assert.fail(
          `documento en ${estado}. Evento: ${JSON.stringify(evento)} · ` +
            `now() de Postgres: ${ahora[0]?.t.toISOString()} · ` +
            `consumidores fallidos: ${JSON.stringify(fallosDeConsumidor)}`,
        );
      }

      assert.equal(
        estado,
        "READY",
        "la fila y el evento se confirman juntos: si esto falla, el documento " +
          "se quedó en PENDING y nadie lo va a procesar nunca",
      );

      // --- 4. Responde, con la cita comprobada ------------------------------
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/knowledge/answer",
        headers: auth(),
        payload: { question: "¿Cuántos días tengo para devolver un pedido?" },
      });

      const contestada = respuesta.json<{
        answered: boolean;
        response: string;
        citations: { quote: string }[];
        meta: { degraded: boolean };
      }>();

      assert.equal(contestada.answered, true);
      assert.ok(contestada.citations.length > 0, "una afirmación sin cita no se sirve");
      assert.equal(
        contestada.meta.degraded,
        false,
        "degraded significa que la validación tumbó la respuesta del modelo",
      );

      // --- 5. Se abstiene en lo que no sabe --------------------------------
      const abstenida = await app.inject({
        method: "POST",
        url: "/v1/knowledge/answer",
        headers: auth(),
        payload: { question: TRAMPA },
      });

      assert.equal(
        abstenida.json<{ answered: boolean }>().answered,
        false,
        "el corpus fija el plazo para DEVOLVER y no dice nada del de REEMBOLSO: " +
          "responder aquí es la alucinación que este producto existe para no tener",
      );

      // --- 6. Y esa abstención se convierte en producto ---------------------
      // Este es el tramo que estuvo roto: `meter()` abría transacción sin
      // contexto de tenant, fallaba, y un catch mudo se lo tragaba. Cero
      // consumo y cero huecos, siempre, sin un solo error visible.
      assert.ok(
        (await eventos("usage.recorded")) > 0,
        "el consumo pasado no se reconstruye: lo que no se mide hoy se perdió",
      );
      assert.equal(
        await eventos("knowledge.gap"),
        1,
        "cada abstención es una pregunta que sus clientes hacen y su " +
          "documentación no cubre — es la mitad que convierte abstenerse en valor",
      );

      await drenar();

      const huecos = await app.inject({
        method: "GET",
        url: "/v1/knowledge/gaps",
        headers: auth(),
      });

      const lista = huecos.json<{ gaps: { question: string; reason: string }[] }>().gaps;
      assert.equal(lista.length, 1);
      assert.equal(lista[0]?.reason, "MODEL_ABSTAINED");
      assert.match(lista[0]?.question ?? "", /reembols/i);
    });
  },
);
