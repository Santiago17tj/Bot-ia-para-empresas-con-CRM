-- CreateTable
CREATE TABLE "contact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "displayName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "externalId" TEXT,
    "channel" "ConversationChannel",
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "conversation" ADD COLUMN "contactId" TEXT;

-- CreateIndex
--
-- Compuestas con tenantId, siempre. Un `email` único global impide que dos
-- clientes tengan a la misma persona en su agenda, y es el error exacto que
-- hace irreparable el esquema de `crm-main`.
CREATE UNIQUE INDEX "contact_tenantId_email_key" ON "contact"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tenantId_phone_key" ON "contact"("tenantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tenantId_channel_externalId_key" ON "contact"("tenantId", "channel", "externalId");

-- CreateIndex
CREATE INDEX "contact_tenantId_lastSeenAt_idx" ON "contact"("tenantId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "conversation_tenantId_contactId_idx" ON "conversation"("tenantId", "contactId");

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
--
-- SET NULL y no CASCADE: borrar un contacto no puede llevarse por delante el
-- historial de lo que se habló con él. La conversación queda huérfana, que es
-- justo lo que se quiere para poder auditarla y para el borrado por contacto
-- del RGPD (§28).
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
