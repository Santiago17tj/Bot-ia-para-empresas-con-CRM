import { rawPrisma, runAsSystem } from "@platform/db";

/**
 * Prompt Registry (§24 del plan).
 *
 * NINGÚN prompt vive en el código. Un prompt es código: se versiona, se prueba
 * antes de desplegarse, y toda ejecución registra qué versión usó — sin eso,
 * una regresión de calidad es indiagnosticable porque nadie sabe qué cambió
 * ni cuándo.
 */

export interface ResolvedPrompt {
  key: string;
  versionId: string;
  version: number;
  template: string;
  /** Texto con las variables sustituidas. */
  render(values: Record<string, string>): string;
}

export class PromptNotFoundError extends Error {
  override readonly name = "PromptNotFoundError";
}

/**
 * Sustituye `{{variable}}`.
 *
 * Una variable sin valor LANZA en vez de dejar el marcador en el texto. Un
 * `{{fallbackMessage}}` literal llegando al modelo es un prompt roto que
 * produce respuestas plausibles y mal fundadas — el peor fallo posible aquí,
 * porque no parece un fallo.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  const missing: string[] = [];

  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      missing.push(name);
      return "";
    }
    return value;
  });

  if (missing.length > 0) {
    throw new PromptNotFoundError(
      `Faltan variables al renderizar la plantilla: ${missing.join(", ")}`,
    );
  }

  return rendered;
}

/**
 * Resuelve qué versión de un prompt se aplica a un tenant.
 *
 * Orden de precedencia: despliegue específico del tenant → despliegue global.
 * Un prompt sin despliegue activo es un error, no un silencio: es preferible
 * fallar al arrancar a servir un prompt que nadie desplegó.
 *
 * Corre como sistema porque el catálogo de prompts es global y `Prompt` /
 * `PromptDeployment` no llevan filtro de tenant.
 */
export async function resolvePrompt(
  key: string,
  tenantId: string,
): Promise<ResolvedPrompt> {
  const deployments = await runAsSystem(
    "prompt registry: resolver despliegue activo",
    () =>
      rawPrisma.promptDeployment.findMany({
        where: {
          isActive: true,
          prompt: { key },
          OR: [{ tenantId }, { tenantId: null }],
        },
        include: { promptVer: true },
        // El despliegue del tenant gana sobre el global: Postgres ordena NULL
        // al final con `nulls last`, así que la fila del tenant llega primero.
        orderBy: [{ tenantId: { sort: "asc", nulls: "last" } }, { deployedAt: "desc" }],
      }),
  );

  const chosen = pickDeployment(
    deployments.map((d) => ({
      tenantId: d.tenantId,
      trafficPercent: d.trafficPercent,
      versionId: d.versionId,
      version: d.promptVer.version,
      template: d.promptVer.template,
    })),
  );

  if (chosen === undefined) {
    throw new PromptNotFoundError(
      `No hay despliegue activo para el prompt "${key}" (tenant ${tenantId}). ` +
        "Un prompt sin desplegar es un error deliberado: servir uno que nadie " +
        "desplegó es peor que no responder.",
    );
  }

  return {
    key,
    versionId: chosen.versionId,
    version: chosen.version,
    template: chosen.template,
    render: (values) => renderTemplate(chosen.template, values),
  };
}

export interface DeploymentCandidate {
  tenantId: string | null;
  trafficPercent: number;
  versionId: string;
  version: number;
  template: string;
}

/**
 * Elige entre los despliegues candidatos, incluido el reparto A/B.
 *
 * Pura y exportada para poder testearla sin base de datos: el reparto de
 * tráfico es exactamente el tipo de lógica que falla en silencio y solo se
 * nota semanas después, en una métrica que nadie sabe explicar.
 */
export function pickDeployment(
  candidates: DeploymentCandidate[],
  roll: number = Math.random() * 100,
): DeploymentCandidate | undefined {
  if (candidates.length === 0) return undefined;

  // Solo se considera el ámbito más específico presente: si el tenant tiene
  // despliegue propio, el global no entra en el sorteo. Mezclarlos repartiría
  // tráfico entre un experimento del cliente y el prompt global sin que nadie
  // lo hubiera pedido.
  const scoped = candidates.filter((c) => c.tenantId !== null);
  const pool = scoped.length > 0 ? scoped : candidates;

  if (pool.length === 1) return pool[0];

  let cumulative = 0;
  for (const candidate of pool) {
    cumulative += candidate.trafficPercent;
    if (roll < cumulative) return candidate;
  }

  // Los porcentajes no suman 100: se sirve el último en vez de no servir nada.
  // Un experimento mal configurado debe degradar, no dejar sin respuesta.
  return pool[pool.length - 1];
}
