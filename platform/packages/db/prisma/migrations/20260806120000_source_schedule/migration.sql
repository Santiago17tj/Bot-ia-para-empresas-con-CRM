-- AlterTable
ALTER TABLE "knowledgeSource" ADD COLUMN "lastScheduledAt" TIMESTAMP(3);

-- El planificador busca fuentes activas con cron. Sin este índice, cada minuto
-- recorre la tabla entera de todos los tenants.
CREATE INDEX "knowledgeSource_scheduling_idx"
  ON "knowledgeSource" ("isActive", "syncSchedule");
