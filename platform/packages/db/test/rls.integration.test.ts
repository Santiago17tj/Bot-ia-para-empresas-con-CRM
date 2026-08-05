import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";

/**
 * Aislamiento multi-tenant, capa 3: verifica que las políticas RLS DENIEGAN
 * de verdad.
 *
 * Los tests unitarios de isolation.test.ts comprueban que las tres capas hablan
 * de las mismas tablas. Eso no prueba que la política muerda — una política mal
 * escrita aparece en `pg_policies` exactamente igual que una correcta.
 *
 * Este test se conecta con el rol de la APLICACIÓN (`platform_app`, creado
 * NOBYPASSRLS) y comprueba que no puede ver lo que no es suyo. Con el rol
 * propietario pasaría siempre, porque el propietario se salta las políticas —
 * y ese falso verde es justo el fallo que este fichero existe para evitar.
 */

const OWNER_URL = process.env["DATABASE_URL"];
const APP_URL = process.env["DATABASE_URL_APP"];

const TENANT_A = "tnt_rls_aaaaaaaa";
const TENANT_B = "tnt_rls_bbbbbbbb";

let owner: pg.Client;
let app: pg.Client;

/** Fija el tenant de la sesión igual que hace `withRlsTransaction`. */
async function asTenant<T>(
  tenantId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await app.query("BEGIN");
  try {
    if (tenantId !== null) {
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    return await fn();
  } finally {
    await app.query("ROLLBACK");
  }
}

describe("RLS de Postgres (capa 3)", { skip: OWNER_URL === undefined }, () => {
  before(async () => {
    owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();

    app = new pg.Client({ connectionString: APP_URL });
    await app.connect();

    // Sembrado con el propietario, que sí se salta las políticas.
    for (const [id, slug] of [
      [TENANT_A, "rls-a"],
      [TENANT_B, "rls-b"],
    ]) {
      await owner.query(
        `INSERT INTO "tenant" (id, slug, name, plan, "isActive", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'TRIAL', true, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [id, slug, `Tenant ${slug}`],
      );
      await owner.query(
        `INSERT INTO "auditLog" (id, "tenantId", "actorType", action, resource, "createdAt")
         VALUES ($1, $2, 'system', 'test.seed', 'test', now())
         ON CONFLICT (id) DO NOTHING`,
        [`log_${id}`, id],
      );
    }
  });

  after(async () => {
    await owner.query(`DELETE FROM "tenant" WHERE id = ANY($1)`, [
      [TENANT_A, TENANT_B],
    ]);
    await owner.end();
    await app.end();
  });

  test("el rol de aplicación NO puede saltarse RLS", async () => {
    const { rows } = await app.query(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    assert.equal(rows[0].rolbypassrls, false, "el rol podría saltarse las políticas");
    assert.equal(rows[0].rolsuper, false, "el rol es superusuario: RLS no le aplica");
  });

  test("sin app.tenant_id no se ve NADA (falla cerrado)", async () => {
    // `current_setting('app.tenant_id', true)` devuelve NULL si nadie lo fijó,
    // y comparar con NULL da NULL, que RLS trata como falso.
    await asTenant(null, async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM "auditLog"`);
      assert.equal(
        rows[0].n,
        0,
        "sin tenant en la sesión se vieron filas: la política no está filtrando",
      );
    });
  });

  test("con un tenant fijado solo se ven SUS filas", async () => {
    await asTenant(TENANT_A, async () => {
      const { rows } = await app.query(
        `SELECT "tenantId" FROM "auditLog" WHERE action = 'test.seed'`,
      );
      assert.ok(rows.length > 0, "no se vio ninguna fila propia");
      assert.ok(
        rows.every((r: { tenantId: string }) => r.tenantId === TENANT_A),
        `se filtraron filas de otro tenant: ${JSON.stringify(rows)}`,
      );
    });
  });

  test("las filas del otro tenant son invisibles, no solo inaccesibles", async () => {
    await asTenant(TENANT_A, async () => {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM "auditLog" WHERE "tenantId" = $1`,
        [TENANT_B],
      );
      assert.equal(
        rows[0].n,
        0,
        "preguntar explícitamente por otro tenant devolvió filas",
      );
    });
  });

  test("no se puede escribir una fila de otro tenant (WITH CHECK)", async () => {
    // Sin WITH CHECK, un tenant podría INSERTAR datos atribuidos a otro —
    // invisible para él después, pero contaminando la base del vecino.
    await asTenant(TENANT_A, async () => {
      await assert.rejects(
        () =>
          app.query(
            `INSERT INTO "auditLog" (id, "tenantId", "actorType", action, resource, "createdAt")
             VALUES ($1, $2, 'system', 'test.intruso', 'test', now())`,
            ["log_intruso", TENANT_B],
          ),
        /row-level security|violates/i,
        "se permitió insertar una fila atribuida a otro tenant",
      );
    });
  });

  test("un UPDATE no alcanza las filas de otro tenant", async () => {
    await asTenant(TENANT_A, async () => {
      const result = await app.query(
        `UPDATE "auditLog" SET resource = 'tocado' WHERE "tenantId" = $1`,
        [TENANT_B],
      );
      assert.equal(result.rowCount, 0, "un UPDATE modificó filas de otro tenant");
    });
  });

  test("un DELETE no alcanza las filas de otro tenant", async () => {
    await asTenant(TENANT_A, async () => {
      const result = await app.query(`DELETE FROM "auditLog" WHERE "tenantId" = $1`, [
        TENANT_B,
      ]);
      assert.equal(result.rowCount, 0, "un DELETE borró filas de otro tenant");
    });
  });

  test("la tabla tenant solo deja ver la fila propia", async () => {
    await asTenant(TENANT_A, async () => {
      const { rows } = await app.query(`SELECT id FROM "tenant"`);
      assert.ok(
        rows.every((r: { id: string }) => r.id === TENANT_A),
        `se vieron otros tenants: ${JSON.stringify(rows.map((r) => r.id))}`,
      );
    });
  });

  test("el ajuste es local a la transacción: no se filtra a la siguiente", async () => {
    // `set_config(..., true)` es local. Si fuese global, una conexión devuelta
    // al pool arrastraría el tenant del último uso — y la siguiente petición
    // leería los datos del cliente anterior.
    await asTenant(TENANT_A, async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM "auditLog"`);
      assert.ok(rows[0].n > 0);
    });

    await asTenant(null, async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM "auditLog"`);
      assert.equal(
        rows[0].n,
        0,
        "el tenant de la transacción anterior sobrevivió: la conexión del pool " +
          "arrastraría datos entre clientes",
      );
    });
  });
});
