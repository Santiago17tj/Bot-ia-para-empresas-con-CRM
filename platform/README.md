# Enterprise AI OS — el monorepo

Este documento cubre **cómo se trabaja dentro de `platform/`**. Para qué es el
producto, qué hace y qué está medido, ve al [README de la raíz](../README.md).
La arquitectura canónica está en [`../PLAN-TECNICO.md`](../PLAN-TECNICO.md), y
las referencias `§n` de los comentarios del código apuntan a ese documento.

---

## Arranque

Necesitas **Node 22+** y **Docker Desktop**.

```bash
winget install Docker.DockerDesktop
```

Reinicia, abre Docker una vez para que arranque el motor, y comprueba con
`docker -v`. Después:

```bash
npm install
cp .env.example .env
npm run db:up
npm run setup -w @platform/db
npm run prompts:seed
npm test
```

`setup` es `prisma migrate deploy` y **después** el SQL crudo de
`packages/db/sql/`, que contiene lo que Prisma no sabe expresar: columnas de
pgvector, `tsvector`, índices HNSW y GIN, el rol de aplicación y las políticas
RLS.

**No uses `npm run db:migrate` para poner en marcha el entorno.** `prisma
migrate dev` interpreta como deriva justo esas columnas que añade el SQL crudo,
y ofrece resetear la base para "arreglarlo": decir que sí borra los datos de
desarrollo. `db:migrate` sirve para crear una migración nueva cuando cambias el
esquema, no para arrancar. CI usa `setup`.

`prompts:seed` carga el catálogo de prompts en el registro. Sin él, cualquier
cosa que genere texto falla con `PromptNotFoundError` — ningún prompt vive en el
código.

El Postgres local escucha en **5433**, no en 5432, para no chocar con otro que
ya tengas.

## Estructura

| Ruta | |
| --- | --- |
| `packages/env` | Encuentra y carga el único `.env` de la raíz |
| `packages/db` | Esquema Prisma, cliente con filtro de tenant, RLS |
| `packages/providers` | Puertos `AIProvider` y `EmbeddingProvider` |
| `packages/events` | Outbox transaccional y despachador |
| `packages/observability` | Trazas, Prompt Registry, consumo |
| `packages/context` | Context Engine, presupuesto, recetas |
| `packages/knowledge` | Conversión, troceado, recuperación, grounding, huecos |
| `packages/eval` | Arnés de evaluación y su puerta |
| `packages/storage` | Costura de ficheros y driver local |
| `packages/secrets` | Cifrado en reposo AES-256-GCM |
| `packages/connectors` | Web, Notion, Drive, defensa SSRF, cron |
| `apps/api` | Fastify |
| `apps/worker` | Outbox, ingesta, sincronización |

## Las tres capas de aislamiento

Un producto que guarda datos de varias empresas en una base no puede permitirse
una sola defensa. Son tres, y ninguna sobra:

| Capa | Dónde | Qué hace |
| --- | --- | --- |
| 1 | `prisma/schema.prisma` | `tenantId` en cada tabla; unicidades compuestas |
| 2 | `src/client.ts` | Extensión que inyecta el filtro y **falla cerrado** |
| 3 | `sql/002_*.sql` | Políticas RLS de Postgres |

La capa 2 detecta el error en desarrollo con un mensaje que dice qué hacer. La
capa 3 es la que sigue negando el día que la capa 2 tenga un fallo.

`test/isolation.test.ts` verifica que las tres hablan de las **mismas tablas**:
una tabla presente en una lista y ausente de otra es exactamente el conjunto de
tablas con una sola defensa.

### La aplicación no se conecta como propietario

`DATABASE_URL` es del propietario y se reserva a migraciones.
`DATABASE_URL_APP` usa `platform_app`, creado `NOBYPASSRLS`.

Un propietario de tabla **salta las políticas RLS por defecto**. Una aplicación
conectada como propietario tiene la capa 3 desconectada sin que nada lo indique
— y todos los tests de aislamiento siguen pasando, porque la capa 2 funciona. Es
el peor tipo de fallo de seguridad: invisible hasta que hace falta la red.

### Cómo se escribe código que toca datos de un tenant

```ts
import { prisma, runWithTenant } from "@platform/db";

await runWithTenant(ctx, async () => {
  // El filtro por tenantId lo pone la extensión. No se escribe a mano:
  // un tenantId que se pasa a mano es un tenantId que algún día no se pasa.
  const docs = await prisma.document.findMany({ where: { isActive: true } });
});
```

Fuera de `runWithTenant`, cualquier consulta a un modelo con tenant **lanza**.
Es deliberado: sin contexto, la consulta devolvería datos de todos los clientes.

Para trabajo de sistema (despachador del outbox, migraciones) está
`runAsSystem("motivo")`, que exige el motivo por escrito — leerlo en una
revisión obliga a preguntar por qué; una consulta sin contexto no obliga a nada.

## Órdenes

| Orden | |
| --- | --- |
| `npm run db:up` / `db:down` | Postgres en Docker |
| `npm run setup -w @platform/db` | Migraciones + SQL crudo. **Esta es la de arrancar** |
| `npm run db:migrate` | Crea una migración nueva. Solo al cambiar el esquema |
| `npm run db:studio` | Prisma Studio |
| `npm run prompts:seed` | Carga el catálogo de prompts |
| `npm run build` | Compila todo |
| `npm test` | Tests (integración incluida si hay `DATABASE_URL`) |
| `npm run eval` | Arnés completo. Sale con 1 si la puerta bloquea |
| `npm run dev` · `npm run worker` | API · worker, en terminales distintas |

**No corras `npm test` y `npm run eval` a la vez.** El proveedor de embeddings
local bloquea el event loop durante segundos seguidos, y una transacción con un
solo `UPDATE` trivial expira porque, mientras esperaba turno, otro trabajo del
mismo proceso tenía el bucle parado. Además de fallos espurios, la latencia que
informe el arnés no será real. Por lo mismo, los tests corren con
`--test-concurrency=1`.

## Decisiones abiertas

- **Prisma 6.19 frente a 7.x.** Se arrancó en 6.19 por estabilidad. Cuanto más
  código haya encima, más cuesta subir.
- **Proveedor de embeddings definitivo.** Ahora el local gratuito
  (`multilingual-e5-small`, 384 dimensiones), que es sobre el que está calibrado
  todo. Cambiarlo obliga a reindexar, pero la convivencia de dimensiones ya está
  implementada y probada (`packages/knowledge/src/dimensions.ts` y la migración
  003).
- **Enviar datos de tenant a Groq.** El corpus del arnés es sintético, así que
  medir no compromete nada. Servir a un cliente real desde Groq sí exige un DPA;
  para quien no lo acepte, el mismo adaptador apuntado a un servidor propio
  (vLLM, Ollama) es la respuesta, y ya funciona.
