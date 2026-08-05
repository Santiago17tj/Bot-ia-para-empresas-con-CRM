export {
  prisma,
  rawPrisma,
  systemPrisma,
  withRlsTransaction,
  createTenantExtension,
  Prisma,
} from "./client.js";
export type { TenantPrisma } from "./client.js";

export {
  runWithTenant,
  runAsSystem,
  getTenantContext,
  requireTenantContext,
  requireTenantId,
  TenantContextError,
} from "./tenant.js";
export type { TenantContext } from "./tenant.js";

export { findApiKeyByHash, touchApiKey } from "./api-key.js";
export type { ApiKeyRecord } from "./api-key.js";

export {
  TENANT_SCOPED_MODELS,
  GLOBAL_MODELS,
  isTenantScoped,
} from "./models.js";
export type { TenantScopedModel } from "./models.js";
