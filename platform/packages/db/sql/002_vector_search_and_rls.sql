-- ===========================================================================
-- 002 — Columnas vectoriales, búsqueda léxica y Row Level Security
--
-- Se aplica DESPUÉS de la migración inicial de Prisma, y contiene lo que Prisma
-- no sabe expresar: tipos de pgvector, columnas tsvector, índices HNSW/GIN y las
-- políticas RLS.
--
-- Es idempotente a propósito: se ejecuta en cada `db:setup` sin romper nada.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Extensiones
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;


-- ---------------------------------------------------------------------------
-- Columnas que Prisma no modela
--
-- La dimensión 1536 corresponde al proveedor por defecto. Cambiar de proveedor
-- NO es editar este número: se AÑADE una segunda columna y se migra por lotes
-- con doble escritura, comparando contra el conjunto de evaluación antes de
-- conmutar la lectura. Cada fragmento graba con qué proveedor y dimensión fue
-- embebido, que es lo que hace posible esa convivencia.
-- ---------------------------------------------------------------------------
ALTER TABLE "chunk" ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- El tsvector NO es una columna generada, y es deliberado: el regconfig depende
-- del idioma del fragmento ('spanish', 'english', ...), y una columna generada
-- solo admite una configuración fija. Un corpus multilingüe indexado todo como
-- español degrada la búsqueda léxica en silencio. Lo puebla la ingesta.
ALTER TABLE "chunk" ADD COLUMN IF NOT EXISTS search_vector tsvector;


-- ---------------------------------------------------------------------------
-- Índices de recuperación
-- ---------------------------------------------------------------------------

-- HNSW sobre coseno. Se construye sin CONCURRENTLY porque estamos en
-- transacción y la tabla está vacía en la primera aplicación.
CREATE INDEX IF NOT EXISTS chunk_embedding_hnsw
  ON "chunk" USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS chunk_search_vector_gin
  ON "chunk" USING gin (search_vector);

-- La recuperación siempre filtra por tenant y por vigencia antes de puntuar.
CREATE INDEX IF NOT EXISTS chunk_tenant_active
  ON "chunk" ("tenantId", "isActive");

-- Trigrama sobre el título: alcanza referencias y SKUs que ni el vector ni el
-- BM25 resuelven bien cuando la consulta es un fragmento del identificador.
CREATE INDEX IF NOT EXISTS chunk_title_trgm
  ON "chunk" USING gin (title gin_trgm_ops);


-- ---------------------------------------------------------------------------
-- Rol de aplicación
--
-- La aplicación NO se conecta como propietario. Un propietario de tabla salta
-- las políticas RLS por defecto, así que una app conectada como propietario
-- tiene la capa 3 desconectada sin que nada lo indique — el peor tipo de fallo
-- de seguridad, porque todos los tests de aislamiento pasan igualmente si la
-- capa 2 funciona, y la red deja de existir justo cuando hace falta.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app LOGIN PASSWORD 'platform_app' NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO platform_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_app;

-- Las tablas que cree una migración futura heredan estos permisos.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO platform_app;


-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- `current_setting('app.tenant_id', true)` devuelve NULL si nadie lo fijó, y la
-- comparación con NULL es NULL, que RLS trata como falso. Es decir: sin tenant
-- en la sesión no se ve NADA. Falla cerrado, igual que la capa 2.
--
-- La lista de tablas debe coincidir con TENANT_SCOPED_MODELS en
-- packages/db/src/models.ts. Un test verifica que no divergen: una tabla en el
-- esquema y ausente de las dos listas es una fuga silenciosa.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'membership',
    'apiKey',
    'businessDna',
    'tenantAiConfig',
    'featureFlagOverride',
    'knowledgeSource',
    'document',
    'documentVersion',
    'chunk',
    'knowledgeGap',
    'conversation',
    'message',
    'aiTrace',
    'auditLog',
    'usageRecord',
    'evalSuite'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("tenantId" = current_setting(''app.tenant_id'', true))
         WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END
$$;

-- El propio tenant se lee por id: un cliente puede leer su fila y ninguna otra.
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON "tenant";
CREATE POLICY tenant_self ON "tenant"
  USING (id = current_setting('app.tenant_id', true));

COMMIT;


-- ---------------------------------------------------------------------------
-- Nota sobre el propietario
--
-- Estas políticas NO se aplican al propietario de las tablas (el rol
-- `platform`), que es justo lo que permite migrar y sembrar. Para exigirlas
-- también a él haría falta FORCE ROW LEVEL SECURITY, pero entonces las
-- migraciones necesitarían fijar un tenant, que es absurdo para un DDL.
--
-- La separación de roles es lo que resuelve el conflicto: el propietario migra,
-- `platform_app` sirve peticiones. Por eso DATABASE_URL_APP existe y por eso la
-- aplicación se niega a arrancar con el rol equivocado en producción.
-- ---------------------------------------------------------------------------
