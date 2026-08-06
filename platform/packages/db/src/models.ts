/**
 * Qué modelos están sujetos a tenant, en un solo sitio.
 *
 * Dos cosas leen esta lista: la extensión de cliente que inyecta el filtro
 * (capa 2) y el test que verifica que la migración de RLS cubre exactamente
 * estos modelos (capa 3). Un modelo que se añade al esquema y no aquí es una
 * tabla sin filtro y sin política — es decir, una fuga.
 */

/** Modelos con `tenantId` obligatorio. Toda consulta se filtra por él. */
export const TENANT_SCOPED_MODELS = [
  "Membership",
  "ApiKey",
  "BusinessDNA",
  "TenantAIConfig",
  "FeatureFlagOverride",
  "KnowledgeSource",
  "Document",
  "DocumentVersion",
  "Chunk",
  "KnowledgeGap",
  "Conversation",
  "Message",
  "AITrace",
  "AuditLog",
  "UsageRecord",
  "EvalSuite",
] as const;

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

const scoped = new Set<string>(TENANT_SCOPED_MODELS);

export function isTenantScoped(model: string | undefined): boolean {
  return model !== undefined && scoped.has(model);
}

/**
 * Modelos deliberadamente globales, con el motivo por el que lo son.
 *
 * Está escrito para que añadir algo aquí sea una decisión consciente y no un
 * olvido: la pregunta "¿por qué esta tabla no tiene tenant?" debe tener una
 * respuesta escrita, no una ausencia.
 */
export const GLOBAL_MODELS: Record<string, string> = {
  Tenant: "es la raíz de la tenencia; filtrarlo por sí mismo no tiene sentido",
  User: "una persona puede pertenecer a varios tenants; el vínculo es Membership",
  FeatureFlag: "catálogo de flags; el valor por tenant vive en FeatureFlagOverride",
  Prompt: "catálogo global de prompts; el despliegue por tenant es PromptDeployment",
  PromptVersion: "versión inmutable de un prompt del catálogo global",
  PromptDeployment: "tiene tenantId NULLABLE — null significa despliegue global",
  TraceStep: "hereda el tenant de su AITrace vía cascada; no se consulta suelto",
  OutboxEvent: "tenantId NULLABLE — hay eventos de sistema sin tenant",
  EvalCase: "hereda el tenant de su EvalSuite",
  EvalRun: "hereda el tenant de su EvalSuite",
  EvalResult: "hereda el tenant de su EvalRun",
};
