import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import {
  BACKENDS,
  DeterministicEmbeddingProvider,
  OpenAICompatibleProvider,
  ProviderError,
  buildChatParams,
  createAIProvider,
  structuredOutputFor,
  toStrictJsonSchema,
} from "../dist/index.js";
import { buildRequestParams, modelProfile } from "../dist/ai/anthropic.js";

/**
 * Tests sin red ni credenciales: comprueban los invariantes de la costura de
 * proveedores, no la calidad de ningún modelo.
 */

// ---------------------------------------------------------------------------
// Traducción de la petición — el invariante que evita un 400 en producción
// ---------------------------------------------------------------------------

const baseRequest = {
  messages: [{ role: "user" as const, content: "hola" }],
  maxTokens: 1024,
};

test("no se envía temperature a un modelo que la rechaza", () => {
  const profile = modelProfile("claude-opus-5");
  assert.ok(profile, "el perfil del modelo por defecto debe existir");
  assert.equal(
    profile.capabilities.sampling,
    false,
    "este modelo declara que NO admite sampling",
  );

  const params = buildRequestParams(
    { ...baseRequest, temperature: 0.2 },
    "claude-opus-5",
    profile,
  );

  assert.equal(
    "temperature" in params,
    false,
    "TenantAIConfig expone temperature como ajuste del cliente, pero este " +
      "modelo devuelve 400 si se envía. El adaptador debe descartarla: es la " +
      "razón de existir de la capa de proveedores.",
  );
});

test("sí se envía temperature a un modelo que la admite", () => {
  const profile = modelProfile("claude-haiku-4-5");
  assert.ok(profile);
  assert.equal(profile.capabilities.sampling, true);

  const params = buildRequestParams(
    { ...baseRequest, temperature: 0.4 },
    "claude-haiku-4-5",
    profile,
  );

  assert.equal(params["temperature"], 0.4);
});

test("max_tokens nunca supera el techo del modelo", () => {
  const profile = modelProfile("claude-haiku-4-5");
  assert.ok(profile);

  const params = buildRequestParams(
    { ...baseRequest, maxTokens: 999_999 },
    "claude-haiku-4-5",
    profile,
  );

  assert.equal(params["max_tokens"], profile.capabilities.maxOutputTokens);
});

test("el esquema de salida viaja dentro de output_config, junto al effort", () => {
  const profile = modelProfile("claude-opus-5");
  assert.ok(profile);

  const schema = { type: "object", properties: { answered: { type: "boolean" } } };
  const params = buildRequestParams(
    { ...baseRequest, effort: "high", outputSchema: schema },
    "claude-opus-5",
    profile,
  );

  const outputConfig = params["output_config"] as Record<string, unknown>;
  assert.equal(outputConfig["effort"], "high");
  assert.deepEqual(outputConfig["format"], { type: "json_schema", schema });
});

test("marcar el prompt de sistema para caché no altera su texto", () => {
  const profile = modelProfile("claude-opus-5");
  assert.ok(profile);

  const plain = buildRequestParams(
    { ...baseRequest, system: "instrucciones" },
    "claude-opus-5",
    profile,
  );
  assert.equal(plain["system"], "instrucciones");

  const cached = buildRequestParams(
    { ...baseRequest, system: "instrucciones", cacheSystemPrompt: true },
    "claude-opus-5",
    profile,
  );
  assert.deepEqual(cached["system"], [
    {
      type: "text",
      text: "instrucciones",
      cache_control: { type: "ephemeral" },
    },
  ]);
});

// ---------------------------------------------------------------------------
// Backends compatibles con OpenAI — el segundo adaptador del puerto
// ---------------------------------------------------------------------------

/**
 * Réplica reducida de `ANSWER_SCHEMA`: un objeto con una propiedad opcional
 * (`rulesApplied`) y un array de objetos anidados. Se declara aquí en vez de
 * importarlo de `@platform/knowledge` porque este paquete no depende de aquel,
 * y no debe: la costura va en ese sentido.
 */
const answerSchema = {
  type: "object",
  properties: {
    answered: { type: "boolean" },
    response: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chunkId: { type: "string" },
          quote: { type: "string", description: "Texto LITERAL." },
        },
        required: ["chunkId", "quote"],
      },
    },
    rulesApplied: { type: "array", items: { type: "string" } },
  },
  required: ["answered", "response", "citations"],
};

test("el modo estricto exige TODA propiedad en required", () => {
  const strict = toStrictJsonSchema(answerSchema);

  assert.deepEqual(
    strict["required"],
    ["answered", "response", "citations", "rulesApplied"],
    "estos backends rechazan la petición entera si sobra una propiedad fuera " +
      "de required, y ANSWER_SCHEMA declara rulesApplied como opcional",
  );
  assert.equal(strict["additionalProperties"], false);
});

test("lo que era opcional se vuelve obligatorio-pero-anulable", () => {
  const strict = toStrictJsonSchema(answerSchema);
  const properties = strict["properties"] as Record<string, Record<string, unknown>>;

  assert.deepEqual(
    properties["rulesApplied"]?.["type"],
    ["array", "null"],
    "es la única forma que tiene este protocolo de expresar opcionalidad",
  );
  assert.equal(
    properties["answered"]?.["type"],
    "boolean",
    "lo que ya era obligatorio no se toca",
  );
});

test("el modo estricto baja hasta los objetos anidados", () => {
  const strict = toStrictJsonSchema(answerSchema);
  const properties = strict["properties"] as Record<string, Record<string, unknown>>;
  const items = properties["citations"]?.["items"] as Record<string, unknown>;

  assert.equal(items["additionalProperties"], false);
  assert.deepEqual(items["required"], ["chunkId", "quote"]);

  const itemProps = items["properties"] as Record<string, Record<string, unknown>>;
  assert.equal(
    itemProps["quote"]?.["description"],
    "Texto LITERAL.",
    "la descripción es lo que le dice al modelo qué se le pide: no se pierde",
  );
});

test("el prompt de sistema viaja como un mensaje más en este protocolo", () => {
  const capabilities = {
    toolCalling: true,
    structuredOutput: true,
    promptCaching: false,
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    sampling: true,
  };

  const params = buildChatParams(
    { ...baseRequest, system: "instrucciones" },
    "llama-3.3-70b-versatile",
    capabilities,
  );

  assert.deepEqual(params["messages"], [
    { role: "system", content: "instrucciones" },
    { role: "user", content: "hola" },
  ]);
  assert.equal(params["max_tokens"], 1024);
});

test("el esquema viaja con strict: true, que es lo que lo convierte en obligación", () => {
  const capabilities = {
    toolCalling: true,
    structuredOutput: true,
    promptCaching: false,
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    sampling: true,
  };

  const params = buildChatParams(
    { ...baseRequest, outputSchema: answerSchema, temperature: 0 },
    "llama-3.3-70b-versatile",
    capabilities,
  );

  const format = params["response_format"] as Record<string, unknown>;
  assert.equal(format["type"], "json_schema");

  const jsonSchema = format["json_schema"] as Record<string, unknown>;
  assert.equal(
    jsonSchema["strict"],
    true,
    "sin strict el esquema es una sugerencia y volvemos a confiar en que cite",
  );

  // Al contrario que los Claude de última generación, estos modelos sí la aceptan.
  assert.equal(params["temperature"], 0);
});

test("pedir citas a un backend que no puede exigirlas falla, no lo intenta", async () => {
  const provider = new OpenAICompatibleProvider({
    id: "backend-flojo",
    baseUrl: "http://localhost:9/v1",
    model: "modelo-sin-esquemas",
    structuredOutput: "json_object",
  });

  assert.equal(
    provider.capabilities.structuredOutput,
    false,
    "json_object garantiza JSON válido y NADA sobre su forma: eso no es " +
      "salida estructurada a efectos de exigir citas",
  );

  // Falla antes de tocar la red: la URL apunta a un puerto muerto y aun así no
  // hay timeout, porque ni llega a intentarlo.
  await assert.rejects(
    () => provider.generate({ ...baseRequest, outputSchema: answerSchema }),
    ProviderError,
  );
});

test("en Groq la salida estructurada es del modelo, no del backend", () => {
  const groq = BACKENDS["groq"];
  assert.ok(groq);

  // Medido contra la API real: `llama-3.3-70b-versatile` responde 400 con
  // "This model does not support response format json_schema". Elegirlo por
  // tamaño, que es lo obvio, deja el sistema sin poder exigir una sola cita.
  assert.equal(
    structuredOutputFor(groq, "llama-3.3-70b-versatile"),
    "none",
    "un modelo fuera de la lista debe fallar cerrado, no suponerse capaz",
  );
  assert.equal(structuredOutputFor(groq, "openai/gpt-oss-120b"), "json_schema");
  assert.equal(
    structuredOutputFor(groq, "modelo-que-groq-saque-mañana"),
    "none",
    "lista blanca, no lista negra: lo desconocido no se supone capaz",
  );

  // Se construye a mano y no por registro para no exigir GROQ_API_KEY: lo que
  // se comprueba es la capacidad declarada, no la configuración de la máquina.
  const provider = new OpenAICompatibleProvider({
    id: "groq",
    baseUrl: groq.baseUrl,
    model: "llama-3.3-70b-versatile",
    structuredOutput: structuredOutputFor(groq, "llama-3.3-70b-versatile"),
  });
  assert.equal(provider.capabilities.structuredOutput, false);
});

test("en Ollama la gramática la impone el servidor, así que vale cualquier modelo", () => {
  const ollama = BACKENDS["ollama"];
  assert.ok(ollama);
  assert.equal(ollama.structuredOutputModels, undefined);
  assert.equal(structuredOutputFor(ollama, "el-modelo-que-sea"), "json_schema");
});

test("un backend sin autenticación se construye sin credencial ninguna", () => {
  assert.equal(
    BACKENDS["ollama"]?.apiKeyEnv,
    undefined,
    "Ollama no autentica; exigirle una clave rompería el único camino que " +
      "funciona sin registrarse en ningún sitio",
  );

  const provider = createAIProvider({ provider: "ollama" });
  assert.equal(provider.id, "ollama");
  assert.equal(provider.capabilities.structuredOutput, true);
});

test("apuntar el mismo adaptador a otra URL base es un parámetro, no un fichero", () => {
  const propio = createAIProvider({
    provider: "ollama",
    baseUrl: "https://vllm.interno.example/v1",
    model: "modelo-del-cliente",
  });

  // Es el argumento entero de por qué el segundo adaptador habla este
  // protocolo: el despliegue on-premise de un cliente no cuesta código.
  assert.equal(propio.model, "modelo-del-cliente");
});

// ---------------------------------------------------------------------------
// El adaptador contra un servidor de verdad
//
// Los tests de arriba comprueban la traducción; estos comprueban que lo
// traducido sale por el cable como debe. Es la diferencia entre "el objeto
// tiene los campos correctos" y "el servidor recibe lo que espera recibir", y
// solo la segunda evita el 400 el día que alguien pone una clave.
// ---------------------------------------------------------------------------

interface StubCall {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** Servidor mínimo que imita chat-completions y registra lo que le llega. */
async function withStubServer(
  handler: (call: StubCall, attempt: number) => { status: number; body: unknown; headers?: Record<string, string> },
  run: (baseUrl: string, calls: StubCall[]) => Promise<void>,
): Promise<void> {
  const calls: StubCall[] = [];

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const call: StubCall = {
        path: req.url ?? "",
        authorization: req.headers["authorization"],
        body: JSON.parse(raw || "{}") as Record<string, unknown>,
      };
      calls.push(call);

      const result = handler(call, calls.length);
      res.writeHead(result.status, {
        "content-type": "application/json",
        ...(result.headers ?? {}),
      });
      res.end(JSON.stringify(result.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  try {
    await run(`http://127.0.0.1:${port}/v1`, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const okResponse = (content: string) => ({
  status: 200,
  body: {
    model: "modelo-de-prueba",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
  },
});

test("el cuerpo que sale por el cable es el que espera chat-completions", async () => {
  await withStubServer(
    () => okResponse('{"answered":false}'),
    async (baseUrl, calls) => {
      const provider = new OpenAICompatibleProvider({
        id: "prueba",
        baseUrl,
        model: "modelo-de-prueba",
        apiKey: "clave-secreta",
        pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      });

      const result = await provider.generate({
        system: "instrucciones",
        messages: [{ role: "user", content: "hola" }],
        maxTokens: 512,
        outputSchema: answerSchema,
      });

      const call = calls[0];
      assert.ok(call);
      assert.equal(call.path, "/v1/chat/completions");
      assert.equal(call.authorization, "Bearer clave-secreta");
      assert.equal(call.body["model"], "modelo-de-prueba");
      assert.equal(call.body["max_tokens"], 512);

      const format = call.body["response_format"] as Record<string, unknown>;
      const jsonSchema = format["json_schema"] as Record<string, unknown>;
      const schema = jsonSchema["schema"] as Record<string, unknown>;
      assert.equal(jsonSchema["strict"], true);
      assert.deepEqual(
        schema["required"],
        ["answered", "response", "citations", "rulesApplied"],
        "el esquema tiene que salir ya en modo estricto, no crudo",
      );

      // Un millón de tokens de cada, a 1 y 2 por millón: el coste no es un
      // adorno, es lo que dirá el arnés que costaría esto en producción.
      assert.equal(result.cost, 3);
      assert.equal(result.stopReason, "end_turn");
      assert.deepEqual(result.parsed, { answered: false });
    },
  );
});

test("un backend sin clave no manda cabecera de autorización", async () => {
  await withStubServer(
    () => okResponse("{}"),
    async (baseUrl, calls) => {
      const provider = new OpenAICompatibleProvider({
        id: "ollama",
        baseUrl,
        model: "local",
      });
      await provider.generate({
        messages: [{ role: "user", content: "hola" }],
        maxTokens: 64,
      });

      assert.equal(calls[0]?.authorization, undefined);
    },
  );
});

test("un 429 se reintenta respetando el Retry-After del servidor", async () => {
  await withStubServer(
    (_call, attempt) =>
      attempt === 1
        ? {
            status: 429,
            body: { error: "rate limit" },
            headers: { "retry-after": "0" },
          }
        : okResponse('{"ok":true}'),
    async (baseUrl, calls) => {
      const provider = new OpenAICompatibleProvider({
        id: "prueba",
        baseUrl,
        model: "modelo-de-prueba",
      });

      const startedAt = performance.now();
      const result = await provider.generate({
        messages: [{ role: "user", content: "hola" }],
        maxTokens: 64,
      });
      const elapsed = performance.now() - startedAt;

      assert.equal(calls.length, 2, "debió reintentar exactamente una vez");
      assert.equal(result.text, '{"ok":true}');
      assert.ok(
        elapsed < 400,
        `esperó ${Math.round(elapsed)} ms con Retry-After: 0. Un cero es una ` +
          "instrucción, no un valor ausente: confundirlos añade medio segundo " +
          "a cada reintento de una tirada entera del arnés.",
      );
    },
  );
});

test("un 400 no se reintenta: es culpa nuestra y reintentar solo tarda más", async () => {
  await withStubServer(
    () => ({ status: 400, body: { error: "parámetro inválido" } }),
    async (baseUrl, calls) => {
      const provider = new OpenAICompatibleProvider({
        id: "prueba",
        baseUrl,
        model: "modelo-de-prueba",
      });

      await assert.rejects(
        () =>
          provider.generate({
            messages: [{ role: "user", content: "hola" }],
            maxTokens: 64,
          }),
        (error: unknown) =>
          error instanceof ProviderError &&
          error.retryable === false &&
          error.message.includes("parámetro inválido"),
      );

      assert.equal(calls.length, 1);
    },
  );
});

test("una respuesta cortada por longitud no se hace pasar por completa", async () => {
  await withStubServer(
    () => ({
      status: 200,
      body: {
        choices: [{ message: { content: '{"answered":tr' }, finish_reason: "length" }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      },
    }),
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({
        id: "prueba",
        baseUrl,
        model: "modelo-de-prueba",
      });

      const result = await provider.generate({
        messages: [{ role: "user", content: "hola" }],
        maxTokens: 8,
        outputSchema: answerSchema,
      });

      assert.equal(result.stopReason, "max_tokens");
      assert.equal(
        result.parsed,
        undefined,
        "sin `parsed` el validador la rechaza; inventar aquí sería inventar en " +
          "el sitio donde más caro sale",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Embeddings deterministas — el sustrato del arnés de evaluación
// ---------------------------------------------------------------------------

test("el mismo texto produce siempre el mismo vector", async () => {
  const provider = new DeterministicEmbeddingProvider({ dimensions: 64 });
  const [a] = await provider.embed(["política de devoluciones"], "document");
  const [b] = await provider.embed(["política de devoluciones"], "query");

  assert.ok(a && b);
  assert.deepEqual(a, b);
});

test("los vectores vienen normalizados", async () => {
  const provider = new DeterministicEmbeddingProvider({ dimensions: 64 });
  const [vector] = await provider.embed(["plazo de garantía"], "document");
  assert.ok(vector);
  assert.equal(vector.length, 64);

  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `norma esperada 1, obtenida ${norm}`);
});

test("textos con vocabulario común quedan más cerca que textos sin él", async () => {
  const provider = new DeterministicEmbeddingProvider({ dimensions: 512 });
  const [target, related, unrelated] = await provider.embed(
    [
      "plazo de devolución de productos",
      "plazo de devolución para clientes",
      "horario de las oficinas centrales",
    ],
    "document",
  );

  assert.ok(target && related && unrelated);
  const dot = (x: number[], y: number[]) =>
    x.reduce((acc, v, i) => acc + v * (y[i] as number), 0);

  assert.ok(
    dot(target, related) > dot(target, unrelated),
    "sin esta propiedad el arnés de evaluación no distinguiría una " +
      "recuperación correcta de una aleatoria",
  );
});

test("un texto sin tokens da el vector cero en vez de fingir similitud", async () => {
  const provider = new DeterministicEmbeddingProvider({ dimensions: 32 });
  const [vector] = await provider.embed(["...", ], "document");
  assert.ok(vector);
  assert.ok(vector.every((v) => v === 0));
});

// ---------------------------------------------------------------------------
// Fallo cerrado en configuración
// ---------------------------------------------------------------------------

test("un modelo desconocido falla al construir, no en la primera llamada", async () => {
  const { AnthropicProvider } = await import("../dist/index.js");
  assert.throws(
    () => new AnthropicProvider({ apiKey: "test", model: "modelo-inventado" }),
    ProviderError,
  );
});
