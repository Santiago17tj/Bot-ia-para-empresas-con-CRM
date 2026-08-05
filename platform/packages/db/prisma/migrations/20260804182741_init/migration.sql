-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "TenantPlan" AS ENUM ('TRIAL', 'STARTER', 'GROWTH', 'BUSINESS', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('PDF', 'DOCX', 'XLSX', 'CSV', 'TXT', 'MARKDOWN', 'URL', 'SITEMAP', 'NOTION', 'CONFLUENCE', 'GOOGLE_DRIVE', 'SHAREPOINT', 'DROPBOX', 'ONEDRIVE', 'SQL_QUERY', 'REST_API', 'PRODUCTS', 'INVENTORY', 'PRICING', 'ORDERS', 'CUSTOMERS', 'MANUAL_ENTRY', 'FAQ');

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TraceStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'ABSTAINED');

-- CreateEnum
CREATE TYPE "UsageMetric" AS ENUM ('INPUT_TOKENS', 'OUTPUT_TOKENS', 'CACHED_TOKENS', 'EMBEDDINGS', 'STORAGE_BYTES', 'DOCUMENTS', 'CHUNKS', 'API_CALLS', 'SEARCHES', 'ANSWERS');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "EvalCaseKind" AS ENUM ('ANSWERABLE', 'UNANSWERABLE', 'FORBIDDEN');

-- CreateTable
CREATE TABLE "tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" "TenantPlan" NOT NULL DEFAULT 'TRIAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "scopes" TEXT[],
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "apiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businessDna" (
    "tenantId" TEXT NOT NULL,
    "mission" TEXT,
    "values" TEXT[],
    "culture" TEXT,
    "tone" TEXT NOT NULL DEFAULT 'profesional y cercano',
    "formality" TEXT NOT NULL DEFAULT 'neutral',
    "vocabulary" TEXT[],
    "avoidWords" TEXT[],
    "alwaysDo" TEXT[],
    "neverDo" TEXT[],
    "legalBoundaries" TEXT[],
    "escalationPhilosophy" TEXT,
    "crossSell" BOOLEAN NOT NULL DEFAULT false,
    "discountAuthority" TEXT,
    "priceDisclosure" TEXT,
    "priorities" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "businessDna_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "tenantAiConfig" (
    "tenantId" TEXT NOT NULL,
    "languages" TEXT[] DEFAULT ARRAY['es']::TEXT[],
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "groundingThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.35,
    "fallbackMessage" TEXT NOT NULL DEFAULT 'No tengo esa información en la documentación de la empresa.',
    "maxCostPerConversation" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "maxCostPerMonth" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "preferredAiProvider" TEXT,
    "embeddingProvider" TEXT NOT NULL DEFAULT 'openai',
    "embeddingModel" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "embeddingDimensions" INTEGER NOT NULL DEFAULT 1536,
    "contextTokenBudget" INTEGER NOT NULL DEFAULT 24000,
    "humanReviewCategories" TEXT[],
    "dataResidency" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenantAiConfig_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "featureFlag" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "defaultValue" JSONB NOT NULL DEFAULT 'false',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "featureFlag_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "featureFlagOverride" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "flagKey" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "featureFlagOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promptVersion" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "template" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "promptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promptDeployment" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "tenantId" TEXT,
    "trafficPercent" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deployedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deployedBy" TEXT,

    CONSTRAINT "promptDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledgeSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "syncCursor" JSONB,
    "syncSchedule" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" "IngestStatus",
    "lastSyncError" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceId" TEXT,
    "title" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "mimeType" TEXT,
    "storageKey" TEXT,
    "sourceRef" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" "IngestStatus" NOT NULL DEFAULT 'PENDING',
    "statusError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documentVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "byteSize" INTEGER,
    "pageCount" INTEGER,
    "language" TEXT,
    "rawText" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "supersededAt" TIMESTAMP(3),
    "ingestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "title" TEXT,
    "language" TEXT NOT NULL DEFAULT 'es',
    "category" TEXT,
    "tags" TEXT[],
    "department" TEXT,
    "author" TEXT,
    "breadcrumbs" TEXT[],
    "pageNumber" INTEGER,
    "sectionPath" TEXT,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "embeddingProvider" TEXT,
    "embeddingModel" TEXT,
    "embeddingDimensions" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aiTrace" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "TraceStatus" NOT NULL DEFAULT 'RUNNING',
    "intent" TEXT,
    "routing" JSONB,
    "contextPackage" JSONB,
    "truncated" TEXT[],
    "promptRefs" JSONB,
    "flags" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "groundingResult" JSONB,
    "answered" BOOLEAN,
    "errors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aiTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traceStep" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "latencyMs" INTEGER,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usageRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metric" "UsageMetric" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "periodDay" TIMESTAMP(3) NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outboxEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "outboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evalSuite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evalSuite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evalCase" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "kind" "EvalCaseKind" NOT NULL,
    "question" TEXT NOT NULL,
    "expectedAnswer" TEXT,
    "expectedSources" TEXT[],
    "mustNotContain" TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evalCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evalRun" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "label" TEXT,
    "gitRef" TEXT,
    "config" JSONB,
    "totalCases" INTEGER NOT NULL DEFAULT 0,
    "recallAtK" DOUBLE PRECISION,
    "precision" DOUBLE PRECISION,
    "groundingScore" DOUBLE PRECISION,
    "hallucinationRate" DOUBLE PRECISION,
    "correctAbstention" DOUBLE PRECISION,
    "forbiddenViolations" INTEGER NOT NULL DEFAULT 0,
    "avgLatencyMs" INTEGER,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "evalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evalResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "answered" BOOLEAN NOT NULL,
    "response" TEXT,
    "citations" JSONB,
    "retrievedChunks" TEXT[],
    "passed" BOOLEAN NOT NULL,
    "failureReason" TEXT,
    "latencyMs" INTEGER,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evalResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "membership_userId_idx" ON "membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_tenantId_userId_key" ON "membership"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "apiKey_keyHash_key" ON "apiKey"("keyHash");

-- CreateIndex
CREATE INDEX "apiKey_tenantId_idx" ON "apiKey"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "featureFlagOverride_tenantId_flagKey_key" ON "featureFlagOverride"("tenantId", "flagKey");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_key_key" ON "prompt"("key");

-- CreateIndex
CREATE UNIQUE INDEX "promptVersion_promptId_version_key" ON "promptVersion"("promptId", "version");

-- CreateIndex
CREATE INDEX "promptDeployment_promptId_tenantId_isActive_idx" ON "promptDeployment"("promptId", "tenantId", "isActive");

-- CreateIndex
CREATE INDEX "knowledgeSource_tenantId_isActive_idx" ON "knowledgeSource"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "document_tenantId_status_idx" ON "document"("tenantId", "status");

-- CreateIndex
CREATE INDEX "document_tenantId_isActive_idx" ON "document"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "document_sourceId_idx" ON "document"("sourceId");

-- CreateIndex
CREATE INDEX "documentVersion_tenantId_isActive_idx" ON "documentVersion"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "documentVersion_documentId_version_key" ON "documentVersion"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "documentVersion_tenantId_documentId_checksum_key" ON "documentVersion"("tenantId", "documentId", "checksum");

-- CreateIndex
CREATE INDEX "chunk_tenantId_isActive_idx" ON "chunk"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "chunk_versionId_ordinal_idx" ON "chunk"("versionId", "ordinal");

-- CreateIndex
CREATE INDEX "aiTrace_tenantId_createdAt_idx" ON "aiTrace"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "aiTrace_tenantId_operation_createdAt_idx" ON "aiTrace"("tenantId", "operation", "createdAt");

-- CreateIndex
CREATE INDEX "traceStep_traceId_ordinal_idx" ON "traceStep"("traceId", "ordinal");

-- CreateIndex
CREATE INDEX "auditLog_tenantId_createdAt_idx" ON "auditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "auditLog_tenantId_resource_resourceId_idx" ON "auditLog"("tenantId", "resource", "resourceId");

-- CreateIndex
CREATE INDEX "usageRecord_tenantId_periodDay_metric_idx" ON "usageRecord"("tenantId", "periodDay", "metric");

-- CreateIndex
CREATE INDEX "outboxEvent_status_availableAt_idx" ON "outboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "outboxEvent_tenantId_type_createdAt_idx" ON "outboxEvent"("tenantId", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "evalSuite_tenantId_name_key" ON "evalSuite"("tenantId", "name");

-- CreateIndex
CREATE INDEX "evalCase_suiteId_kind_idx" ON "evalCase"("suiteId", "kind");

-- CreateIndex
CREATE INDEX "evalRun_suiteId_startedAt_idx" ON "evalRun"("suiteId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "evalResult_runId_caseId_key" ON "evalResult"("runId", "caseId");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apiKey" ADD CONSTRAINT "apiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businessDna" ADD CONSTRAINT "businessDna_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenantAiConfig" ADD CONSTRAINT "tenantAiConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "featureFlagOverride" ADD CONSTRAINT "featureFlagOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "featureFlagOverride" ADD CONSTRAINT "featureFlagOverride_flagKey_fkey" FOREIGN KEY ("flagKey") REFERENCES "featureFlag"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promptVersion" ADD CONSTRAINT "promptVersion_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promptDeployment" ADD CONSTRAINT "promptDeployment_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promptDeployment" ADD CONSTRAINT "promptDeployment_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "promptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promptDeployment" ADD CONSTRAINT "promptDeployment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledgeSource" ADD CONSTRAINT "knowledgeSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "knowledgeSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentVersion" ADD CONSTRAINT "documentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "documentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aiTrace" ADD CONSTRAINT "aiTrace_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traceStep" ADD CONSTRAINT "traceStep_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "aiTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auditLog" ADD CONSTRAINT "auditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usageRecord" ADD CONSTRAINT "usageRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outboxEvent" ADD CONSTRAINT "outboxEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evalSuite" ADD CONSTRAINT "evalSuite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evalCase" ADD CONSTRAINT "evalCase_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "evalSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evalRun" ADD CONSTRAINT "evalRun_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "evalSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evalResult" ADD CONSTRAINT "evalResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "evalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evalResult" ADD CONSTRAINT "evalResult_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "evalCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
