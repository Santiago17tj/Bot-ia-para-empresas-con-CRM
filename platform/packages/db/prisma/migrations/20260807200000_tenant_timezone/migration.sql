-- AlterTable
--
-- Por defecto 'UTC': es cómo se interpretaban los crones antes de existir esta
-- columna, así que ninguna fuente ya creada cambia de horario al migrar. Un
-- default distinto movería silenciosamente la sincronización de todo el mundo.
ALTER TABLE "tenant" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
--
-- NULL y no 'UTC': null significa "la del tenant", que no es lo mismo que
-- "UTC". Con un default de 'UTC' aquí, cambiar la zona del tenant no tendría
-- efecto sobre ninguna fuente existente — cada una llevaría su propia anulación
-- puesta sin que nadie la hubiera pedido.
ALTER TABLE "knowledgeSource" ADD COLUMN "syncTimezone" TEXT;
