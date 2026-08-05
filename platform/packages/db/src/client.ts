import "@platform/env/load";

import { optional, required } from "@platform/env";
import { Prisma, PrismaClient } from "../generated/client/index.js";
import { isTenantScoped } from "./models.js";
import { requireTenantContext, TenantContextError } from "./tenant.js";

/**
 * Aislamiento multi-tenant, capa 2 de 3.
 *
 *   1. `tenantId` obligatorio en cada tabla ............ el esquema
 *   2. esta extensión, que inyecta el filtro ........... aquí
 *   3. RLS de Postgres ................................. la migración
 *
 * Las tres son necesarias y ninguna sobra. La capa 2 detecta el error en
 * desarrollo con un mensaje que dice qué hacer; la capa 3 es la que sigue
 * negando el día que la capa 2 tenga un fallo. Un producto que guarda datos de
 * varias empresas en una base no puede permitirse una sola defensa.
 */

/** Operaciones cuyo `where` hay que estrechar. */
const READ_OPS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

/** `findUnique` no admite campos no únicos en el `where`, así que se reescribe. */
const UNIQUE_READ_OPS = new Set(["findUnique", "findUniqueOrThrow"]);

/** Operaciones que escriben y necesitan el `tenantId` en los datos. */
const SINGLE_WRITE_OPS = new Set(["create", "update", "upsert", "delete"]);

type AnyArgs = Record<string, unknown>;

function withTenantWhere(args: AnyArgs, tenantId: string): AnyArgs {
  const where = (args["where"] ?? {}) as AnyArgs;
  return { ...args, where: { ...where, tenantId } };
}

function withTenantData(args: AnyArgs, tenantId: string): AnyArgs {
  const data = args["data"];
  if (Array.isArray(data)) {
    return {
      ...args,
      data: data.map((row) => ({ ...(row as AnyArgs), tenantId })),
    };
  }
  if (data !== undefined && typeof data === "object") {
    return { ...args, data: { ...(data as AnyArgs), tenantId } };
  }
  return args;
}

export function createTenantExtension() {
  return Prisma.defineExtension({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isTenantScoped(model)) return query(args);

          // Falla cerrado: sin contexto no se relaja el filtro, se aborta.
          const { tenantId } = requireTenantContext();
          const a = (args ?? {}) as AnyArgs;

          if (READ_OPS.has(operation)) {
            return query(withTenantWhere(a, tenantId));
          }

          if (UNIQUE_READ_OPS.has(operation)) {
            // findUnique -> findFirst. Prisma rechaza un campo no único en el
            // `where` de findUnique, así que estrecharlo exige degradar la
            // operación. El índice sigue sirviendo la consulta.
            const target = operation === "findUnique" ? "findFirst" : "findFirstOrThrow";
            const delegate = (
              (this as unknown as Record<string, unknown>)[
                model.charAt(0).toLowerCase() + model.slice(1)
              ] ?? {}
            ) as Record<string, (x: unknown) => unknown>;
            const fn = delegate[target];
            if (typeof fn === "function") {
              const where = (a["where"] ?? {}) as AnyArgs;
              return fn.call(delegate, { ...a, where: { ...where, tenantId } });
            }
            return query(a);
          }

          if (operation === "createMany" || operation === "createManyAndReturn") {
            return query(withTenantData(a, tenantId));
          }

          if (SINGLE_WRITE_OPS.has(operation)) {
            let next = a;
            if (operation === "create") {
              next = withTenantData(next, tenantId);
            } else if (operation === "upsert") {
              const create = (next["create"] ?? {}) as AnyArgs;
              next = {
                ...next,
                create: { ...create, tenantId },
                where: { ...((next["where"] ?? {}) as AnyArgs), tenantId },
              };
            } else {
              // update y delete: el where debe llevar el tenant, o un id ajeno
              // adivinado modificaría datos de otro cliente.
              next = withTenantWhere(next, tenantId);
            }
            return query(next);
          }

          return query(a);
        },
      },
    },
  });
}

function buildClient(): PrismaClient {
  // La app se conecta con un rol SIN privilegio de saltar RLS. DATABASE_URL es
  // del propietario y se reserva a migraciones: si la aplicación corriese como
  // propietario, las políticas de la capa 3 no se le aplicarían y la red de
  // seguridad estaría desconectada sin que nada lo indicase.
  const url = optional("DATABASE_URL_APP") ?? required("DATABASE_URL");

  return new PrismaClient({
    datasources: { db: { url } },
    log:
      process.env["NODE_ENV"] === "production"
        ? ["warn", "error"]
        : ["warn", "error"],
  });
}

const globalRef = globalThis as {
  __platformPrisma?: PrismaClient;
  __platformSystemPrisma?: PrismaClient;
};

/**
 * Conexión de PROPIETARIO. Se salta RLS.
 *
 * Existe para la única operación que por definición no puede ocurrir dentro de
 * un tenant: **crear el tenant**. El alta de un cliente sucede antes de que
 * exista contexto, así que ninguna política puede autorizarla — no hay
 * `app.tenant_id` que fijar todavía.
 *
 * Usos legítimos, y no hay más:
 *   - Aprovisionar y eliminar tenants
 *   - Migraciones y sembrado
 *   - Preparación y limpieza en tests
 *
 * NUNCA en la ruta de una petición. Un handler que llegue aquí ha desactivado
 * las tres capas de aislamiento de golpe, y lo habrá hecho en silencio: las
 * consultas devuelven datos correctos, solo que de todos los clientes.
 * Si lo que necesitas es trabajo de sistema *dentro* de un tenant, lo que
 * quieres es `runAsSystem` con el cliente normal.
 */
export const systemPrisma: PrismaClient =
  globalRef.__platformSystemPrisma ??
  new PrismaClient({
    datasources: { db: { url: required("DATABASE_URL") } },
    log: ["warn", "error"],
  });
if (process.env["NODE_ENV"] !== "production") {
  globalRef.__platformSystemPrisma = systemPrisma;
}

/** Cliente crudo, sin filtro de tenant. Migraciones y tareas de sistema. */
export const rawPrisma: PrismaClient = globalRef.__platformPrisma ?? buildClient();
if (process.env["NODE_ENV"] !== "production") globalRef.__platformPrisma = rawPrisma;

/** El cliente que usa la aplicación. Filtrado por tenant, siempre. */
export const prisma = rawPrisma.$extends(createTenantExtension());

export type TenantPrisma = typeof prisma;

const CUID_OR_UUID = /^[a-z0-9_-]{8,64}$/i;

/**
 * Aislamiento multi-tenant, capa 3: fija el tenant en la sesión de Postgres
 * para que las políticas RLS lo lean, y ejecuta dentro de una transacción.
 *
 * `set_config(..., true)` es local a la transacción, así que la conexión vuelve
 * limpia al pool. Se usa `set_config` con parámetro y no `SET LOCAL` porque
 * `SET` no admite parámetros — habría que interpolar el valor en el SQL, y ese
 * valor decide qué filas ve la consulta.
 */
export async function withRlsTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const { tenantId } = requireTenantContext();

  if (!CUID_OR_UUID.test(tenantId)) {
    throw new TenantContextError(
      `tenantId con formato inesperado: ${JSON.stringify(tenantId)}`,
    );
  }

  return rawPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

export { Prisma };
export * from "../generated/client/index.js";
