import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { rawPrisma } from "@platform/db";
import { answerFromKnowledge, renderContext } from "@platform/knowledge";
import { seedPrompts } from "@platform/observability";
import { ProviderError } from "@platform/providers";
import type {
  AIProvider,
  GenerationRequest,
  GenerationResult,
} from "@platform/providers";
import type { RetrievalHit } from "@platform/knowledge";

/**
 * Las capas 4–6 del grounding, ejercidas enteras.
 *
 * Con un generador FALSO a propósito. Lo que se comprueba aquí no es si un
 * modelo abstiene bien —eso lo mide `npm run eval` contra uno de verdad— sino
 * que la red de debajo hace su trabajo: que una cita inventada no llega al
 * usuario, que una abstención limpia no se cuenta como fallo, y que el prompt
 * viene del registro y no del código.
 *
 * Un modelo real no puede probar esto, porque para probar que rechazamos una
 * cita fabricada hace falta fabricar una a voluntad.
 */

const TENANT = "tnt_answer_test01";
const FALLBACK = "Eso no consta en la documentación disponible.";

const HITS: RetrievalHit[] = [
  {
    chunkId: "chk_devoluciones",
    documentId: "doc_1",
    versionId: "ver_1",
    content:
      "El plazo para devolver un pedido es de 30 días naturales desde la fecha " +
      "de entrega. Pasado ese plazo no se admiten devoluciones.",
    title: "Manual de atención al cliente",
    sourceRef: "manual.md",
    breadcrumbs: ["Devoluciones", "Plazo de devolución"],
    pageNumber: null,
    tokenCount: 32,
    score: 0.9,
    matchedBy: ["vector"],
    vectorRank: 1,
    lexicalRank: null,
  },
];

/** Un `AIProvider` que devuelve lo que se le diga. Sin red y sin coste. */
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

  lastRequest: GenerationRequest | undefined;

  // Campo explícito y no propiedad de parámetro: Node ejecuta estos tests
  // borrando tipos, y una propiedad de parámetro genera código en vez de
  // desaparecer.
  readonly canned: string;

  constructor(canned: string) {
    this.canned = canned;
  }

  generate(req: GenerationRequest): Promise<GenerationResult> {
    this.lastRequest = req;

    const result: GenerationResult = {
      text: this.canned,
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
      cost: 0,
      model: this.model,
      latencyMs: 1,
    };

    try {
      return Promise.resolve({ ...result, parsed: JSON.parse(this.canned) as unknown });
    } catch {
      return Promise.resolve(result);
    }
  }
}

const answerWith = (canned: string, provider = new FakeProvider(canned)) =>
  answerFromKnowledge({
    tenantId: TENANT,
    question: "¿Cuántos días tengo para devolver un pedido?",
    hits: HITS,
    provider,
    fallbackMessage: FALLBACK,
  });

describe(
  "respuesta fundada",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    before(async () => {
      // El test siembra su propio catálogo. Depender de que alguien haya
      // ejecutado `npm run prompts:seed` a mano sería un test que falla en CI
      // por el motivo equivocado.
      await seedPrompts({ silent: true });
    });

    test("una respuesta bien citada pasa entera", async () => {
      const result = await answerWith(
        JSON.stringify({
          answered: true,
          response: "Tienes 30 días naturales desde la entrega.",
          citations: [
            { chunkId: "chk_devoluciones", quote: "30 días naturales desde la fecha" },
          ],
          rulesApplied: null,
        }),
      );

      assert.equal(result.answer.answered, true);
      assert.equal(result.degraded, false);
      assert.deepEqual(result.failures, []);
      assert.equal(result.answer.citations.length, 1);
    });

    test("el prompt viene del registro, con su versión archivada", async () => {
      const provider = new FakeProvider(
        JSON.stringify({ answered: false, response: "No consta.", citations: [] }),
      );
      const result = await answerWith("", provider);

      assert.deepEqual(
        result.promptVersions.map((p) => p.key).sort(),
        ["knowledge.answer.system", "knowledge.answer.user"],
      );
      for (const version of result.promptVersions) {
        assert.ok(version.versionId.length > 0, "sin versionId no se diagnostica nada");
      }

      // Y el texto renderizado no lleva marcadores sin sustituir: un
      // `{{reglas}}` literal llegando al modelo es un prompt roto que produce
      // respuestas plausibles y mal fundadas.
      assert.doesNotMatch(provider.lastRequest?.system ?? "", /\{\{\w+\}\}/);
      assert.doesNotMatch(
        provider.lastRequest?.messages[0]?.content ?? "",
        /\{\{\w+\}\}/,
      );
    });

    test("abstenerse es un resultado correcto, no un fallo que contar", async () => {
      const result = await answerWith(
        JSON.stringify({
          answered: false,
          response: "Eso no consta en la documentación.",
          citations: [],
          rulesApplied: null,
        }),
      );

      assert.equal(result.answer.answered, false);
      assert.equal(
        result.degraded,
        false,
        "una abstención limpia NO es una degradación: contarla como fallo " +
          "haría parecer roto justo el comportamiento que queremos",
      );
      assert.deepEqual(result.failures, []);
    });

    test("una cita que no aparece en su fragmento tumba la respuesta entera", async () => {
      const result = await answerWith(
        JSON.stringify({
          answered: true,
          response: "Tienes 60 días para devolver.",
          citations: [
            { chunkId: "chk_devoluciones", quote: "60 días naturales desde la entrega" },
          ],
          rulesApplied: null,
        }),
      );

      assert.equal(result.degraded, true);
      assert.equal(
        result.answer.response,
        FALLBACK,
        "se sirve el mensaje de reserva, NO la respuesta del modelo: una " +
          "respuesta con una cita inventada es peor que una abstención porque " +
          "parece fundada",
      );
      assert.equal(result.failures[0]?.kind, "quote_not_found");
    });

    test("citar un fragmento que no se le dio es la firma de una cita fabricada", async () => {
      const result = await answerWith(
        JSON.stringify({
          answered: true,
          response: "Consulta la política de financiación.",
          citations: [{ chunkId: "chk_inventado", quote: "financiación a 12 meses" }],
          rulesApplied: null,
        }),
      );

      assert.equal(result.degraded, true);
      assert.equal(result.failures[0]?.kind, "unknown_chunk");
    });

    test("afirmar sin citar ninguna fuente no llega al usuario", async () => {
      const result = await answerWith(
        JSON.stringify({
          answered: true,
          response: "Son 30 días.",
          citations: [],
          rulesApplied: null,
        }),
      );

      assert.equal(result.degraded, true);
      assert.equal(result.failures[0]?.kind, "answered_without_citations");
      assert.equal(result.answer.response, FALLBACK);
    });

    test("una salida ilegible se abstiene en vez de rescatar prosa", async () => {
      const result = await answerWith("esto no es JSON ni lo pretende");

      assert.equal(result.degraded, true);
      assert.equal(result.failures[0]?.kind, "malformed");
      assert.equal(result.answer.response, FALLBACK);
    });

    test("un proveedor sin salida estructurada falla al entrar, no tras gastar la llamada", async () => {
      const provider = new FakeProvider("{}");
      const sinEsquemas: AIProvider = {
        ...provider,
        capabilities: { ...provider.capabilities, structuredOutput: false },
        generate: () => {
          throw new Error("no debería haberse llamado");
        },
      };

      await assert.rejects(
        () =>
          answerFromKnowledge({
            tenantId: TENANT,
            question: "¿Y esto?",
            hits: HITS,
            provider: sinEsquemas,
            fallbackMessage: FALLBACK,
          }),
        ProviderError,
      );
    });

    test("los fragmentos llegan con el id que el modelo debe copiar", () => {
      const rendered = renderContext(HITS);

      assert.match(rendered, /^\[chk_devoluciones\]/);
      assert.match(
        rendered,
        /Devoluciones › Plazo de devolución/,
        "sin las migas de pan un fragmento suelto pierde de qué sección hablaba",
      );
    });

    test("el catálogo se puede sembrar dos veces sin duplicar nada", async () => {
      const segunda = await seedPrompts({ silent: true });

      assert.ok(segunda.length > 0);
      assert.ok(
        segunda.every((r) => r.action === "sin cambios"),
        "la siembra debe ser idempotente",
      );

      const despliegues = await rawPrisma.promptDeployment.count({
        where: { tenantId: null, isActive: true, prompt: { key: "knowledge.answer.system" } },
      });
      assert.equal(despliegues, 1, "solo puede haber un despliegue global activo");
    });
  },
);
