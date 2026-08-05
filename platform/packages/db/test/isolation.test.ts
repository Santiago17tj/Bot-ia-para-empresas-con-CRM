import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GLOBAL_MODELS,
  TENANT_SCOPED_MODELS,
  isTenantScoped,
  requireTenantContext,
  runAsSystem,
  runWithTenant,
  TenantContextError,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

const schema = readFileSync(join(pkgRoot, "prisma", "schema.prisma"), "utf8");
const rlsSql = readFileSync(
  join(pkgRoot, "sql", "002_vector_search_and_rls.sql"),
  "utf8",
);

/**
 * Estos tests cubren la parte del aislamiento que no necesita una base de datos:
 * que las tres capas hablen de las MISMAS tablas y que el contexto falle cerrado.
 *
 * La verificación de que RLS niega de verdad exige Postgres y vive en
 * test/rls.integration.test.ts.
 */

// ---------------------------------------------------------------------------
// Paridad entre las tres capas
// ---------------------------------------------------------------------------

/** Nombres de modelo declarados en el esquema. */
function modelsInSchema(): string[] {
  return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1] as string);
}

/** El valor de `@@map` de un modelo: el nombre real de la tabla. */
function tableNameOf(model: string): string {
  const block = schema.match(
    new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, "m"),
  );
  const mapped = block?.[1]?.match(/@@map\("([^"]+)"\)/);
  return mapped?.[1] ?? model;
}

/** Tablas que la migración cubre con una política de aislamiento. */
function tablesWithRlsPolicy(): string[] {
  const arrayBlock = rlsSql.match(/tables text\[\] := ARRAY\[([\s\S]*?)\]/);
  assert.ok(arrayBlock, "no se encontró la lista de tablas en el SQL de RLS");
  return [...(arrayBlock[1] as string).matchAll(/'([^']+)'/g)].map(
    (m) => m[1] as string,
  );
}

test("todo modelo del esquema está clasificado como con tenant o global", () => {
  const unclassified = modelsInSchema().filter(
    (m) =>
      !(TENANT_SCOPED_MODELS as readonly string[]).includes(m) &&
      GLOBAL_MODELS[m] === undefined,
  );

  assert.deepEqual(
    unclassified,
    [],
    "Modelos sin clasificar: una tabla que no está en TENANT_SCOPED_MODELS ni en " +
      "GLOBAL_MODELS no lleva filtro de tenant ni política RLS. Es una fuga. " +
      "Clasifícalos en packages/db/src/models.ts.",
  );
});

test("cada modelo con tenant declara el campo tenantId en el esquema", () => {
  for (const model of TENANT_SCOPED_MODELS) {
    const block = schema.match(
      new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, "m"),
    );
    assert.ok(block, `el modelo ${model} no existe en el esquema`);
    assert.match(
      block[1] as string,
      /\btenantId\s+String\b/,
      `${model} está en TENANT_SCOPED_MODELS pero no declara tenantId`,
    );
  }
});

test("la migración de RLS cubre exactamente los modelos con tenant", () => {
  const expected = TENANT_SCOPED_MODELS.map(tableNameOf).sort();
  const actual = [...tablesWithRlsPolicy()].sort();

  assert.deepEqual(
    actual,
    expected,
    "La capa 2 (extensión de Prisma) y la capa 3 (políticas RLS) protegen " +
      "conjuntos distintos de tablas. La diferencia es exactamente el conjunto " +
      "de tablas con una sola defensa.",
  );
});

test("las políticas RLS comparan contra el ajuste de sesión, no contra un literal", () => {
  // `current_setting(..., true)` devuelve NULL cuando nadie lo fijó, y comparar
  // con NULL da NULL, que RLS trata como falso: sin tenant no se ve nada.
  // Un `USING (true)` colado aquí desactivaría el aislamiento en silencio.
  assert.match(rlsSql, /current_setting\('app\.tenant_id', true\)/);
  assert.doesNotMatch(rlsSql, /CREATE POLICY[\s\S]{0,200}?USING\s*\(\s*true\s*\)/i);
});

test("el rol de aplicación no puede saltarse RLS", () => {
  assert.match(
    rlsSql,
    /CREATE ROLE platform_app[^;]*NOBYPASSRLS/,
    "El rol con el que se conecta la aplicación debe declarar NOBYPASSRLS: " +
      "un rol que salta las políticas deja la capa 3 desconectada sin avisar.",
  );
});

test("ninguna unicidad de un modelo con tenant es global", () => {
  // Un `@unique` a secas sobre un campo de negocio es el error que impide
  // multi-tenant: dos clientes no podrían tener el mismo correo o el mismo
  // nombre de fuente. Las unicidades deben ser compuestas con tenantId.
  const offenders: string[] = [];

  for (const model of TENANT_SCOPED_MODELS) {
    const block = schema.match(
      new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, "m"),
    );
    const body = (block?.[1] ?? "") as string;

    for (const line of body.split("\n")) {
      if (!line.includes("@unique")) continue;
      if (line.includes("@@unique")) continue;

      const field = line.trim().split(/\s+/)[0] ?? "";
      // keyHash es un secreto con entropía criptográfica: su unicidad global es
      // correcta y deliberada, porque la clave se busca sin conocer el tenant.
      if (model === "ApiKey" && field === "keyHash") continue;

      offenders.push(`${model}.${field}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "Unicidad global en un modelo con tenant. Debe ser @@unique([tenantId, campo]).",
  );
});

// ---------------------------------------------------------------------------
// El contexto falla cerrado
// ---------------------------------------------------------------------------

test("sin contexto, pedir el tenant es un error y no un filtro vacío", () => {
  assert.throws(() => requireTenantContext(), TenantContextError);
});

test("runWithTenant expone el contexto dentro de su ámbito", () => {
  const ctx = {
    tenantId: "tnt_abc123456",
    actor: { type: "system" as const, id: "test", scopes: [] },
    requestId: "req_1",
  };

  runWithTenant(ctx, () => {
    assert.equal(requireTenantContext().tenantId, "tnt_abc123456");
  });

  // Y fuera vuelve a fallar: el contexto no se filtra al ámbito exterior.
  assert.throws(() => requireTenantContext(), TenantContextError);
});

test("un tenantId vacío se rechaza al abrir el contexto", () => {
  assert.throws(
    () =>
      runWithTenant(
        {
          tenantId: "",
          actor: { type: "system", id: "test", scopes: [] },
          requestId: "req_2",
        },
        () => undefined,
      ),
    TenantContextError,
  );
});

test("runAsSystem sale del contexto y exige un motivo escrito", () => {
  const ctx = {
    tenantId: "tnt_abc123456",
    actor: { type: "system" as const, id: "test", scopes: [] },
    requestId: "req_3",
  };

  runWithTenant(ctx, () => {
    runAsSystem("despachador del outbox", () => {
      assert.throws(() => requireTenantContext(), TenantContextError);
    });
    // Al volver, el contexto sigue intacto.
    assert.equal(requireTenantContext().tenantId, "tnt_abc123456");
  });

  assert.throws(() => runAsSystem("", () => undefined), TenantContextError);
});

test("isTenantScoped no clasifica de más", () => {
  assert.equal(isTenantScoped("Chunk"), true);
  assert.equal(isTenantScoped("Tenant"), false);
  assert.equal(isTenantScoped("Prompt"), false);
  assert.equal(isTenantScoped(undefined), false);
});
