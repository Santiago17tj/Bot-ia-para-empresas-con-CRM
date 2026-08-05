import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PromptNotFoundError,
  pickDeployment,
  renderTemplate,
  usageFromGeneration,
  utcDay,
  type DeploymentCandidate,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Renderizado de plantillas
// ---------------------------------------------------------------------------

test("sustituye las variables presentes", () => {
  const out = renderTemplate("Responde en {{idioma}} con tono {{tono}}.", {
    idioma: "español",
    tono: "cercano",
  });
  assert.equal(out, "Responde en español con tono cercano.");
});

test("una variable sin valor lanza en vez de dejar el marcador", () => {
  // Un `{{fallbackMessage}}` literal llegando al modelo es un prompt roto que
  // produce respuestas plausibles y mal fundadas. No parece un fallo, y esa es
  // exactamente la razón de fallar ruidosamente aquí.
  assert.throws(
    () => renderTemplate("Si no sabes, di: {{fallbackMessage}}", {}),
    PromptNotFoundError,
  );
});

test("el error nombra todas las variables que faltan, no solo la primera", () => {
  try {
    renderTemplate("{{a}} {{b}} {{c}}", { b: "ok" });
    assert.fail("debería haber lanzado");
  } catch (error) {
    assert.ok(error instanceof PromptNotFoundError);
    assert.match(error.message, /a/);
    assert.match(error.message, /c/);
  }
});

test("una plantilla sin variables se devuelve tal cual", () => {
  const text = "No inventes datos. Si no está en los documentos, dilo.";
  assert.equal(renderTemplate(text, {}), text);
});

// ---------------------------------------------------------------------------
// Selección de despliegue
// ---------------------------------------------------------------------------

const globalDeploy: DeploymentCandidate = {
  tenantId: null,
  trafficPercent: 100,
  versionId: "v-global",
  version: 1,
  template: "global",
};

const tenantDeploy: DeploymentCandidate = {
  tenantId: "tnt_abc123456",
  trafficPercent: 100,
  versionId: "v-tenant",
  version: 7,
  template: "tenant",
};

test("sin candidatos no se elige nada", () => {
  assert.equal(pickDeployment([]), undefined);
});

test("el despliegue del tenant gana sobre el global", () => {
  const chosen = pickDeployment([tenantDeploy, globalDeploy]);
  assert.equal(chosen?.versionId, "v-tenant");
});

test("el global no entra en el sorteo si el tenant tiene el suyo", () => {
  // Mezclarlos repartiría tráfico entre el experimento del cliente y el prompt
  // global sin que nadie lo hubiera pedido.
  const experiment: DeploymentCandidate[] = [
    { ...tenantDeploy, trafficPercent: 50, versionId: "v-a" },
    { ...tenantDeploy, trafficPercent: 50, versionId: "v-b" },
    globalDeploy,
  ];

  for (const roll of [0, 25, 49.9, 50, 75, 99.9]) {
    const chosen = pickDeployment(experiment, roll);
    assert.notEqual(chosen?.versionId, "v-global", `roll ${roll} eligió el global`);
  }
});

test("el reparto A/B respeta los porcentajes", () => {
  const experiment: DeploymentCandidate[] = [
    { ...globalDeploy, trafficPercent: 30, versionId: "v-a" },
    { ...globalDeploy, trafficPercent: 70, versionId: "v-b" },
  ];

  assert.equal(pickDeployment(experiment, 0)?.versionId, "v-a");
  assert.equal(pickDeployment(experiment, 29.9)?.versionId, "v-a");
  assert.equal(pickDeployment(experiment, 30)?.versionId, "v-b");
  assert.equal(pickDeployment(experiment, 99.9)?.versionId, "v-b");
});

test("porcentajes que no suman 100 degradan, no dejan sin respuesta", () => {
  // Un experimento mal configurado debe servir algo, no romper el producto.
  const misconfigured: DeploymentCandidate[] = [
    { ...globalDeploy, trafficPercent: 10, versionId: "v-a" },
    { ...globalDeploy, trafficPercent: 10, versionId: "v-b" },
  ];
  assert.equal(pickDeployment(misconfigured, 95)?.versionId, "v-b");
});

// ---------------------------------------------------------------------------
// Consumo
// ---------------------------------------------------------------------------

test("el día UTC ignora la hora local", () => {
  // Si el día se calculara al consumir el evento, un reintento al día
  // siguiente contabilizaría en el período equivocado y los totales dejarían
  // de cuadrar sin que nada avisara.
  assert.equal(
    utcDay(new Date("2026-08-04T23:59:59.999Z")),
    "2026-08-04T00:00:00.000Z",
  );
  assert.equal(
    utcDay(new Date("2026-08-05T00:00:00.001Z")),
    "2026-08-05T00:00:00.000Z",
  );
});

test("el consumo de una generación se desglosa por métrica y guarda el coste", () => {
  const entries = usageFromGeneration({
    usage: { inputTokens: 1200, outputTokens: 340, cachedTokens: 800 },
    cost: 0.0145,
    model: "claude-opus-5",
  });

  const byMetric = new Map(entries.map((e) => [e.metric, e]));
  assert.equal(byMetric.get("INPUT_TOKENS")?.quantity, 1200);
  assert.equal(byMetric.get("OUTPUT_TOKENS")?.quantity, 340);
  assert.equal(byMetric.get("CACHED_TOKENS")?.quantity, 800);

  // Los precios cambian: un informe que recalcula con la tarifa de hoy miente
  // sobre lo que costó entonces.
  assert.equal(byMetric.get("INPUT_TOKENS")?.cost, 0.0145);
  assert.equal(byMetric.get("INPUT_TOKENS")?.meta?.["model"], "claude-opus-5");
});
