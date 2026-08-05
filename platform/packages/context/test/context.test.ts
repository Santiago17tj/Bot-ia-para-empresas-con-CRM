import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContextAssemblyError,
  UNTRUNCATABLE,
  allocateChunks,
  allocateConversation,
  assembleContext,
  assertProhibitionsPresent,
  estimateTokens,
  filterByPermissions,
  hashPackage,
  recipeFor,
  shouldRetrieve,
  type AssembleInput,
  type RetrievedChunk,
} from "../dist/index.js";

const DNA_CORE = {
  workspaceName: "Clínica Norte",
  neverDo: ["Nunca dar un diagnóstico médico", "Nunca recomendar dosis"],
  legalBoundaries: ["No procesar datos de salud sin consentimiento"],
};

function chunk(id: string, score: number, tokens: number): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    versionId: `ver-${id}`,
    content: "x".repeat(tokens * 4),
    score,
    tokenCount: tokens,
  };
}

function baseInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    tenantId: "tnt_abc123456",
    actor: { type: "contact", id: "c1", scopes: [] },
    channel: { type: "web", maxLength: 4000 },
    dnaCore: DNA_CORE,
    tokenBudget: 10_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lo intruncable — §6.3
// ---------------------------------------------------------------------------

test("las prohibiciones sobreviven aunque el presupuesto sea mínimo", () => {
  // Si "nunca dar diagnósticos" se cae del contexto por falta de espacio en la
  // conversación número cuarenta, el sistema da un diagnóstico.
  const pkg = assembleContext(
    baseInput({
      tokenBudget: 200,
      retrieved: Array.from({ length: 50 }, (_, i) => chunk(`c${i}`, 1 - i / 100, 200)),
      conversation: Array.from({ length: 40 }, () => ({
        role: "user" as const,
        content: "una pregunta bastante larga sobre cualquier cosa",
      })),
    }),
  );

  assert.deepEqual(pkg.dnaCore.neverDo, DNA_CORE.neverDo);
  assert.deepEqual(pkg.dnaCore.legalBoundaries, DNA_CORE.legalBoundaries);
  assert.ok(pkg.truncated.length > 0, "debería haber declarado recortes");
});

test("si lo intruncable no cabe, se aborta en vez de recortarlo", () => {
  assert.throws(
    () => assembleContext(baseInput({ tokenBudget: 5 })),
    ContextAssemblyError,
    "servir sin las prohibiciones es peor que no servir",
  );
});

test("UNTRUNCATABLE declara exactamente los dos niveles protegidos", () => {
  assert.deepEqual([...UNTRUNCATABLE], ["identity", "dnaCore"]);
});

test("el validador detecta una prohibición perdida por el camino", () => {
  const pkg = assembleContext(baseInput());
  assertProhibitionsPresent(pkg, DNA_CORE);

  const mutilado = {
    ...pkg,
    dnaCore: { ...pkg.dnaCore, neverDo: ["Nunca dar un diagnóstico médico"] },
  };
  assert.throws(() => assertProhibitionsPresent(mutilado, DNA_CORE), ContextAssemblyError);
});

// ---------------------------------------------------------------------------
// Truncado declarado — §6.2
// ---------------------------------------------------------------------------

test("lo que se recorta se declara, con motivo", () => {
  // Un contexto recortado en silencio produce una respuesta peor sin que nadie
  // pueda explicar por qué. Esa es una queja irresoluble.
  const pkg = assembleContext(
    baseInput({
      tokenBudget: 3000,
      retrieved: Array.from({ length: 30 }, (_, i) => chunk(`c${i}`, 1 - i / 100, 300)),
    }),
  );

  const nota = pkg.truncated.find((t) => t.slot === "retrieved");
  assert.ok(nota, "no se declaró el recorte de fragmentos");
  assert.ok(nota.dropped > 0);
  assert.ok(nota.reason.length > 0, "el motivo no puede estar vacío");
  assert.equal(nota.kept + nota.dropped, 30);
});

test("los fragmentos se recortan por puntuación, no por orden de llegada", () => {
  // El fragmento decisivo puede llegar el último; recortar por orden de llegada
  // empeora la respuesta sin motivo aparente.
  const chunks = [chunk("malo", 0.1, 100), chunk("bueno", 0.9, 100)];
  const { kept } = allocateChunks(chunks, 100);

  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.chunkId, "bueno");
});

test("el historial conserva los turnos recientes, no los antiguos", () => {
  // Al revés que los fragmentos: recortar por el final rompe la correferencia
  // — "¿y la roja?" se queda sin antecedente.
  const turns = [
    { role: "user" as const, content: "primera pregunta muy antigua" },
    { role: "assistant" as const, content: "respuesta antigua" },
    { role: "user" as const, content: "¿y la roja?" },
  ];
  const { kept } = allocateConversation(turns, estimateTokens("¿y la roja?") + 1);

  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.content, "¿y la roja?");
});

test("sin presupuesto para un slot se declara, no se falla en silencio", () => {
  const { kept, note } = allocateChunks([chunk("a", 1, 10)], 0);
  assert.equal(kept.length, 0);
  assert.ok(note);
  assert.equal(note.dropped, 1);
});

// ---------------------------------------------------------------------------
// Permisos — punto único de aplicación (§5)
// ---------------------------------------------------------------------------

test("un fragmento sin permisos declarados es visible dentro del tenant", () => {
  const { allowed, denied } = filterByPermissions([chunk("a", 1, 10)], [], () => undefined);
  assert.equal(allowed.length, 1);
  assert.equal(denied, 0);
});

test("un fragmento con ámbito exigido se oculta a quien no lo tiene", () => {
  // Un bot interno respondiendo nóminas a quien pregunta es una filtración,
  // no un bug de producto.
  const chunks = [chunk("publico", 1, 10), chunk("nominas", 1, 10)];
  const permisos = (c: RetrievedChunk) =>
    c.chunkId === "nominas" ? { requiredScopes: ["hr:read"] } : undefined;

  const sinAmbito = filterByPermissions(chunks, [], permisos);
  assert.deepEqual(
    sinAmbito.allowed.map((c) => c.chunkId),
    ["publico"],
  );
  assert.equal(sinAmbito.denied, 1);

  const conAmbito = filterByPermissions(chunks, ["hr:read"], permisos);
  assert.equal(conAmbito.allowed.length, 2);
});

test("se exigen TODOS los ámbitos, no basta con uno", () => {
  const chunks = [chunk("confidencial", 1, 10)];
  const permisos = () => ({ requiredScopes: ["hr:read", "finance:read"] });

  assert.equal(filterByPermissions(chunks, ["hr:read"], permisos).allowed.length, 0);
  assert.equal(
    filterByPermissions(chunks, ["hr:read", "finance:read"], permisos).allowed.length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Recetas — §6.1
// ---------------------------------------------------------------------------

test("un saludo no dispara recuperación", () => {
  // Buscar en el corpus para responder "hola" es gasto puro.
  const receta = recipeFor("greeting");
  assert.equal(shouldRetrieve(receta), false);
  assert.equal(receta.retrievalDepth, 0);
});

test("una consulta factual no arrastra historial ni perfil", () => {
  const receta = recipeFor("factual_lookup");
  assert.ok(shouldRetrieve(receta));
  assert.equal(receta.slots.includes("conversation"), false);
  assert.equal(receta.slots.includes("customer"), false);
});

test("una pregunta con correferencia sí lleva historial", () => {
  assert.ok(recipeFor("conversational").slots.includes("conversation"));
});

test("toda receta incluye siempre identidad y núcleo del ADN", () => {
  for (const intent of ["factual_lookup", "conversational", "greeting", "needs_planning"]) {
    const receta = recipeFor(intent);
    for (const slot of UNTRUNCATABLE) {
      assert.ok(
        receta.slots.includes(slot),
        `la receta ${intent} no incluye ${slot}`,
      );
    }
  }
});

test("una intención desconocida cae en la receta por defecto, no falla", () => {
  const receta = recipeFor("intencion-que-no-existe");
  assert.equal(receta.name, "conversational");
});

// ---------------------------------------------------------------------------
// Huella del paquete
// ---------------------------------------------------------------------------

test("dos paquetes con distinto recorte tienen huella distinta", () => {
  // Cachear la respuesta de uno para el otro sería servir algo construido
  // sobre otra base.
  const completo = assembleContext(
    baseInput({ tokenBudget: 10_000, retrieved: [chunk("a", 1, 10), chunk("b", 0.5, 10)] }),
  );
  const recortado = assembleContext(
    baseInput({ tokenBudget: 10_000, retrieved: [chunk("a", 1, 10)] }),
  );

  assert.notEqual(completo.packageHash, recortado.packageHash);
});

test("el mismo contexto produce siempre la misma huella", () => {
  const a = assembleContext(baseInput({ retrieved: [chunk("a", 1, 10)] }));
  const b = assembleContext(baseInput({ retrieved: [chunk("a", 1, 10)] }));
  assert.equal(a.packageHash, b.packageHash);
});

test("la huella no depende de campos irrelevantes", () => {
  const pkg = assembleContext(baseInput());
  const hash = hashPackage({ ...pkg, budget: { total: 999, used: 1 } });
  assert.equal(hash, pkg.packageHash);
});

// ---------------------------------------------------------------------------
// Guardas
// ---------------------------------------------------------------------------

test("no se ensambla contexto sin tenant", () => {
  assert.throws(
    () => assembleContext(baseInput({ tenantId: "" })),
    ContextAssemblyError,
  );
});

test("las reglas de negocio se conservan por prioridad descendente", () => {
  const pkg = assembleContext(
    baseInput({
      tokenBudget: 2000,
      activeRules: [
        { id: "baja", statement: "r".repeat(1200), category: "x", priority: 1 },
        { id: "alta", statement: "R".repeat(1200), category: "x", priority: 100 },
      ],
    }),
  );

  assert.equal(pkg.activeRules.length, 1, "solo cabía una");
  assert.equal(pkg.activeRules[0]?.id, "alta", "se conservó la de menor prioridad");
  assert.ok(pkg.truncated.some((t) => t.slot === "rules"));
});

test("una regla vigente corta sobrevive a un presupuesto ajustado", () => {
  // Sin suelo garantizado, el 10% de cuota dejaba fuera reglas que caben de
  // sobra — y el modelo respondía la política anterior con total seguridad.
  const pkg = assembleContext(
    baseInput({
      tokenBudget: 1500,
      activeRules: [
        {
          id: "envios",
          statement: "Desde hoy, envío gratis en compras superiores a 300 euros.",
          category: "envios",
          priority: 100,
        },
      ],
      retrieved: Array.from({ length: 20 }, (_, i) => chunk(`c${i}`, 1 - i / 100, 200)),
    }),
  );

  assert.equal(
    pkg.activeRules.length,
    1,
    "una regla de una frase debe caber aunque los fragmentos compitan",
  );
});
