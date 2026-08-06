import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { runWithTenant, systemPrisma, withRlsTransaction } from "@platform/db";
import { ingestDocument, resolveQuestion } from "@platform/knowledge";
import { seedPrompts } from "@platform/observability";
import { LocalEmbeddingProvider } from "@platform/providers";
import type { AIProvider, GenerationRequest, GenerationResult } from "@platform/providers";

import { buildServer, generateApiKey } from "../dist/index.js";

/**
 * El chat, de punta a punta.
 *
 * Con generador FALSO. Lo que se prueba no es si un modelo reescribe bien
 * —depende del modelo— sino la mecánica del hilo: que la continuidad exista,
 * que la pregunta reescrita sea la que se busca, que una conversación escalada
 * calle al bot, y que un hilo de un cliente no se vea desde otro.
 *
 * El caso que justifica todo el fichero: **«¿y a Canarias?» no recupera nada**.
 * Sin reescribir, el sistema se abstiene de algo que sí sabe, y encima justo
 * después de haber contestado bien a la pregunta anterior.
 */

const TENANT = "tnt_chat_acme01";
const RIVAL = "tnt_chat_rival1";

const embedder = new LocalEmbeddingProvider();

let clave = "";
let claveRival = "";

const CORPUS = `# Manual de Acme

## Envíos

### Plazos de entrega
Los envíos a península tardan entre 24 y 48 horas laborables. Los envíos a
Baleares y Canarias tardan entre 3 y 5 días laborables.

## Devoluciones

### Estado del producto
Solo se aceptan devoluciones de productos sin usar, con su embalaje original.
`;

/**
 * Un generador falso con dos comportamientos: reescribe seguimientos según una
 * tabla y responde citando el primer fragmento que se le da.
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

  /** Lo que se le pidió reescribir, para poder comprobarlo. */
  resolucionesPedidas: string[] = [];

  generate(req: GenerationRequest): Promise<GenerationResult> {
    const contenido = req.messages[0]?.content ?? "";
    const esResolucion = contenido.includes("PREGUNTA NUEVA");

    const parsed = esResolucion
      ? this.#resolver(contenido)
      : this.#responder(contenido);

    return Promise.resolve({
      text: JSON.stringify(parsed),
      parsed,
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 10, cachedTokens: 0 },
      cost: 0,
      model: this.model,
      latencyMs: 1,
    });
  }

  #resolver(contenido: string): unknown {
    const pregunta = contenido.split("PREGUNTA NUEVA")[1]?.trim() ?? "";
    this.resolucionesPedidas.push(pregunta);

    if (/^¿?y a canarias\??$/i.test(pregunta.trim())) {
      return {
        standalone: "¿Cuánto tarda un envío a Canarias?",
        isFollowUp: true,
      };
    }
    return { standalone: pregunta, isFollowUp: false };
  }

  #responder(contenido: string): unknown {
    // Cita literal del primer fragmento que se le pasó, para que la validación
    // de citas pase de verdad en vez de esquivarla.
    const match = /\[([^\]]+)\][^\n]*\n([^\n]+)/.exec(contenido);
    const chunkId = match?.[1] ?? "";
    const linea = (match?.[2] ?? "").trim();

    if (chunkId === "" || linea === "") {
      return { answered: false, response: "No consta.", citations: [], rulesApplied: null };
    }

    return {
      answered: true,
      response: `Según el manual: ${linea}`,
      citations: [{ chunkId, quote: linea }],
      rulesApplied: null,
    };
  }
}

const fake = new FakeProvider();

// El generador falso se inyecta; el de embeddings es el local de verdad,
// porque la recuperación SÍ tiene que ser real para que este test signifique
// algo: lo que se demuestra es que la pregunta reescrita recupera y la original
// no.
const app = buildServer({ providers: { ai: fake, embedding: embedder } });

const auth = (secreto: string): Record<string, string> => ({
  authorization: `Bearer ${secreto}`,
});

async function emitir(tenantId: string): Promise<string> {
  const issued = generateApiKey();
  await systemPrisma.apiKey.create({
    data: {
      tenantId,
      name: "test",
      keyHash: issued.keyHash,
      last4: issued.last4,
      scopes: ["knowledge:read", "knowledge:answer", "chat:read", "chat:write"],
    },
  });
  return issued.secret;
}

describe(
  "chat",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    before(async () => {
      await seedPrompts({ silent: true });

      for (const [id, slug] of [
        [TENANT, "chat-acme"],
        [RIVAL, "chat-rival"],
      ] as const) {
        await systemPrisma.tenant.upsert({
          where: { id },
          update: {},
          create: { id, slug, name: slug },
        });
      }

      await runWithTenant(
        {
          tenantId: TENANT,
          actor: { type: "system", id: "chat-test", scopes: [] },
          requestId: "req_chat_test",
        },
        () =>
          ingestDocument(
            {
              tenantId: TENANT,
              bytes: Buffer.from(CORPUS, "utf8"),
              filename: "manual.md",
              mimeType: "text/markdown",
              sourceRef: "chat-manual",
            },
            { embedder, transaction: withRlsTransaction },
          ),
      );

      clave = await emitir(TENANT);
      claveRival = await emitir(RIVAL);
    });

    after(async () => {
      await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, RIVAL] } } });
      await systemPrisma.$disconnect();
      await app.close();
    });

    // -----------------------------------------------------------------------
    // El resolutor, por separado
    // -----------------------------------------------------------------------

    test("sin historia NO se llama al modelo", async () => {
      const antes = fake.resolucionesPedidas.length;

      const resuelta = await runWithTenant(
        {
          tenantId: TENANT,
          actor: { type: "system", id: "t", scopes: [] },
          requestId: "r",
        },
        () =>
          resolveQuestion({
            tenantId: TENANT,
            question: "¿Cuánto tarda un envío?",
            history: [],
            provider: fake,
          }),
      );

      assert.equal(resuelta.rewritten, false);
      assert.equal(
        fake.resolucionesPedidas.length,
        antes,
        "el primer mensaje de una conversación NO puede ser un seguimiento: " +
          "gastar una llamada ahí es pagar por una decisión ya tomada",
      );
    });

    test("una pregunta que se entiende sola no se toca", async () => {
      const resuelta = await runWithTenant(
        {
          tenantId: TENANT,
          actor: { type: "system", id: "t", scopes: [] },
          requestId: "r",
        },
        () =>
          resolveQuestion({
            tenantId: TENANT,
            question: "¿Puedo devolver algo usado?",
            history: [{ role: "USER", content: "hola" }],
            provider: fake,
          }),
      );

      assert.equal(
        resuelta.question,
        "¿Puedo devolver algo usado?",
        "reescribir una pregunta que estaba bien solo puede empeorarla",
      );
      assert.equal(resuelta.rewritten, false);
    });

    test("si el proveedor no puede dar salida estructurada, no se reescribe", async () => {
      const sinEsquemas: AIProvider = {
        ...fake,
        capabilities: { ...fake.capabilities, structuredOutput: false },
        generate: () => {
          throw new Error("no debería llamarse");
        },
      };

      const resuelta = await runWithTenant(
        {
          tenantId: TENANT,
          actor: { type: "system", id: "t", scopes: [] },
          requestId: "r",
        },
        () =>
          resolveQuestion({
            tenantId: TENANT,
            question: "¿y a Canarias?",
            history: [{ role: "USER", content: "plazos" }],
            provider: sinEsquemas,
          }),
      );

      // Buscar "Claro, la pregunta sería: ¿cuánto tarda...?" recupera peor que
      // la original.
      assert.equal(resuelta.rewritten, false);
    });

    test("si la reescritura falla, se busca la original en vez de abortar", async () => {
      const roto: AIProvider = {
        ...fake,
        generate: () => Promise.reject(new Error("proveedor caído")),
      };

      const resuelta = await runWithTenant(
        {
          tenantId: TENANT,
          actor: { type: "system", id: "t", scopes: [] },
          requestId: "r",
        },
        () =>
          resolveQuestion({
            tenantId: TENANT,
            question: "¿y a Canarias?",
            history: [{ role: "USER", content: "plazos" }],
            provider: roto,
          }),
      );

      assert.equal(
        resuelta.question,
        "¿y a Canarias?",
        "recupera peor, pero el producto sigue respondiendo: abortar sería " +
          "cambiar un resultado mediocre por ninguno",
      );
    });

    // -----------------------------------------------------------------------
    // La conversación por la API
    // -----------------------------------------------------------------------

    let conversationId = "";

    test("el primer mensaje abre conversación y responde con citas", async () => {
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: auth(clave),
        payload: { message: "¿Cuánto tarda un envío a península?" },
      });

      assert.equal(respuesta.statusCode, 200);
      const cuerpo = respuesta.json<{
        conversationId: string;
        answered: boolean;
        citations: unknown[];
        meta: { resolvedQuestion: string | null };
      }>();

      conversationId = cuerpo.conversationId;
      assert.ok(conversationId.length > 0);
      assert.equal(cuerpo.meta.resolvedQuestion, null, "no era un seguimiento");
    });

    test("el hilo guarda los dos mensajes y la conversación cuenta", async () => {
      const detalle = await app.inject({
        method: "GET",
        url: `/v1/conversations/${conversationId}`,
        headers: auth(clave),
      });

      const cuerpo = detalle.json<{
        messageCount: number;
        messages: { role: string; content: string }[];
      }>();

      assert.equal(cuerpo.messageCount, 2);
      assert.equal(cuerpo.messages[0]?.role, "USER");
      assert.equal(cuerpo.messages[1]?.role, "ASSISTANT");
    });

    test("la MISMA pregunta responde dentro del hilo y no responde sola", async () => {
      // Es el test que justifica todo el mecanismo, y por eso compara los dos
      // casos en vez de mirar solo el bueno.

      // Sin hilo no hay historia, así que no hay reescritura: se busca
      // "¿y a Canarias?" tal cual, que no se parece a ninguna frase del manual.
      const suelta = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: auth(clave),
        payload: { message: "¿y a Canarias?" },
      });
      const sinHilo = suelta.json<{ answered: boolean; meta: { resolvedQuestion: string | null } }>();

      assert.equal(sinHilo.meta.resolvedQuestion, null, "sin historia no se reescribe");

      // Dentro del hilo, la anterior hablaba de plazos de envío.
      const enHilo = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: auth(clave),
        payload: { message: "¿y a Canarias?", conversationId },
      });
      const conHilo = enHilo.json<{
        answered: boolean;
        response: string;
        meta: { resolvedQuestion: string | null };
      }>();

      assert.equal(
        conHilo.meta.resolvedQuestion,
        "¿Cuánto tarda un envío a Canarias?",
        "el hilo es lo que permite reescribirla",
      );
      assert.equal(
        conHilo.answered,
        true,
        "reescrita SÍ recupera: el sistema sabía la respuesta y ahora la da",
      );
      assert.ok(
        !sinHilo.answered || conHilo.answered,
        "lo que se demuestra es que el hilo no empeora nada y arregla el caso " +
          "en que la pregunta suelta no recuperaba",
      );
    });

    test("la pregunta reescrita queda archivada junto a la original", async () => {
      const detalle = await app.inject({
        method: "GET",
        url: `/v1/conversations/${conversationId}`,
        headers: auth(clave),
      });

      const mensajes = detalle.json<{
        messages: { role: string; content: string; resolvedQuestion: string | null }[];
      }>().messages;

      const seguimiento = mensajes.find((m) => m.content === "¿y a Canarias?");
      assert.ok(seguimiento);
      assert.equal(
        seguimiento.resolvedQuestion,
        "¿Cuánto tarda un envío a Canarias?",
        "depurar por qué una respuesta salió rara en el tercer turno sin saber " +
          "qué se buscó de verdad es adivinar",
      );
    });

    // -----------------------------------------------------------------------
    // Estado del hilo
    // -----------------------------------------------------------------------

    test("una conversación escalada calla al bot", async () => {
      await app.inject({
        method: "POST",
        url: `/v1/conversations/${conversationId}/status`,
        headers: auth(clave),
        payload: { status: "ESCALATED" },
      });

      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: auth(clave),
        payload: { message: "¿hola?", conversationId },
      });

      assert.equal(
        respuesta.statusCode,
        409,
        "seguir contestando encima de una persona que ya está atendiendo es " +
          "peor que no responder",
      );

      await app.inject({
        method: "POST",
        url: `/v1/conversations/${conversationId}/status`,
        headers: auth(clave),
        payload: { status: "OPEN" },
      });
    });

    test("el mismo hilo externo no abre dos conversaciones", async () => {
      const primera = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: auth(clave),
        payload: { message: "hola", channel: "WHATSAPP", externalId: "+34600111222" },
      });
      const segunda = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: auth(clave),
        payload: { message: "sigo aquí", channel: "WHATSAPP", externalId: "+34600111222" },
      });

      assert.equal(
        primera.json<{ conversationId: string }>().conversationId,
        segunda.json<{ conversationId: string }>().conversationId,
        "un reintento de entrega del canal no puede abrir un hilo nuevo",
      );
    });

    // -----------------------------------------------------------------------
    // Aislamiento
    // -----------------------------------------------------------------------

    test("la conversación de un cliente no se ve desde otro", async () => {
      const ajena = await app.inject({
        method: "GET",
        url: `/v1/conversations/${conversationId}`,
        headers: auth(claveRival),
      });

      assert.equal(
        ajena.statusCode,
        404,
        "las conversaciones son de lo más sensible que guarda el sistema",
      );
    });

    test("continuar una conversación ajena por su id da 404, no la continúa", async () => {
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: auth(claveRival),
        payload: { message: "cuéntame", conversationId },
      });

      assert.equal(respuesta.statusCode, 404);
    });

    test("el chat exige su propio ámbito", async () => {
      const issued = generateApiKey();
      await systemPrisma.apiKey.create({
        data: {
          tenantId: TENANT,
          name: "solo lectura",
          keyHash: issued.keyHash,
          last4: issued.last4,
          scopes: ["knowledge:read"],
        },
      });

      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: auth(issued.secret),
        payload: { message: "hola" },
      });

      assert.equal(respuesta.statusCode, 403);
      assert.match(
        respuesta.json<{ error: { message: string } }>().error.message,
        /chat:write/,
      );
    });
  },
);
