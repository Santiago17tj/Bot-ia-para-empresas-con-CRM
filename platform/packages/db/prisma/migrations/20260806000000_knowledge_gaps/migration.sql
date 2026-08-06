-- CreateEnum
CREATE TYPE "GapReason" AS ENUM ('BELOW_THRESHOLD', 'MODEL_ABSTAINED', 'GROUNDING_FAILED');

-- CreateEnum
CREATE TYPE "GapStatus" AS ENUM ('OPEN', 'DOCUMENTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "knowledgeGap" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "variants" TEXT[],
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "reason" "GapReason" NOT NULL,
    "status" "GapStatus" NOT NULL DEFAULT 'OPEN',
    "embeddingProvider" TEXT NOT NULL,
    "embeddingDimensions" INTEGER NOT NULL,
    "resolvedByDocumentId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledgeGap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledgeGap_tenantId_status_occurrences_idx" ON "knowledgeGap"("tenantId", "status", "occurrences");

-- CreateIndex
CREATE INDEX "knowledgeGap_tenantId_lastSeenAt_idx" ON "knowledgeGap"("tenantId", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "knowledgeGap" ADD CONSTRAINT "knowledgeGap_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
