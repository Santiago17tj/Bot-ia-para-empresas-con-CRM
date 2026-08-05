import assert from "node:assert/strict";
import { test } from "node:test";

import { DeterministicEmbeddingProvider, ProviderError } from "../dist/index.js";
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
