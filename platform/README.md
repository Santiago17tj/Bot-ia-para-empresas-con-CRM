# Enterprise AI OS

Motor empresarial de conocimiento, razonamiento, acciones e integraciones.
El chat es una interfaz, no el producto.

La arquitectura canónica está en [`../PLAN-TECNICO.md`](../PLAN-TECNICO.md).
Las referencias `§n` de los comentarios del código apuntan a ese documento.

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
npm run db:migrate
npm run build
npm test
```

`db:migrate` crea las tablas y **después** aplica `packages/db/sql/`, que
contiene lo que Prisma no sabe expresar: columnas de pgvector, `tsvector`,
índices HNSW y GIN, el rol de aplicación y las políticas RLS.

El Postgres local escucha en **5433**, no en 5432, para no chocar con otro que
ya tengas.

## Estructura

| Ruta | |
| --- | --- |
| `packages/env` | Encuentra y carga el único `.env` de la raíz |
| `packages/db` | Esquema Prisma, cliente con filtro de tenant, RLS |

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
| `npm run db:migrate` | Migración + SQL crudo |
| `npm run db:studio` | Prisma Studio |
| `npm run build` | Compila todo |
| `npm test` | Tests |

## Decisiones abiertas

- **Prisma 6.19 frente a 7.x.** Se arrancó en 6.19 por estabilidad. Para un
  proyecto de día uno conviene decidir pronto si se sube a 7, porque cuanto más
  código haya encima más cuesta.
- **Proveedor de embeddings.** `.env.example` trae `text-embedding-3-small`
  (1536 dimensiones) como marcador. Es una decisión con coste de salida real:
  cambiarla obliga a reindexar. Conviene comparar 2–3 sobre documentos reales en
  español antes de fijarla.
