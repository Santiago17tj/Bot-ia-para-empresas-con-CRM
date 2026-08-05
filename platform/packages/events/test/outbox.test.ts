import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { EVENT_TYPES, EventHandlingError, backoffMs } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dispatcherSource = readFileSync(
  join(here, "..", "src", "dispatcher.ts"),
  "utf8",
);
const outboxSource = readFileSync(join(here, "..", "src", "outbox.ts"), "utf8");

/**
 * Lo que necesita una base de datos — que dos despachadores concurrentes se
 * repartan trabajo disjunto, que un lease expirado vuelva a la cola — vive en
 * test/dispatcher.integration.test.ts. Aquí van los invariantes que se pueden
 * comprobar sin Postgres.
 */

// ---------------------------------------------------------------------------
// Retroceso exponencial
// ---------------------------------------------------------------------------

test("el retroceso crece con los intentos", () => {
  // Con jitter, comparar dos muestras sueltas es una prueba escamosa.
  // Se comparan medianas de una muestra suficiente.
  const median = (attempts: number): number => {
    const values = Array.from({ length: 101 }, () => backoffMs(attempts)).sort(
      (a, b) => a - b,
    );
    return values[50] as number;
  };

  assert.ok(median(1) < median(3));
  assert.ok(median(3) < median(5));
});

test("el retroceso tiene tope, para que un fallo persistente no se aplace un día", () => {
  const CAP = 5 * 60_000;
  for (let attempts = 0; attempts < 40; attempts++) {
    assert.ok(
      backoffMs(attempts) <= CAP,
      `intento ${attempts} superó el tope: ${backoffMs(attempts)}`,
    );
  }
});

test("el jitter reparte los reintentos en vez de sincronizarlos", () => {
  // Sin jitter, N consumidores que fallan por la misma causa reintentan todos
  // en el mismo instante y tumban de nuevo lo que se acababa de recuperar.
  const samples = new Set(Array.from({ length: 50 }, () => backoffMs(4)));
  assert.ok(
    samples.size > 10,
    `esperaba dispersión, obtuve ${samples.size} valores distintos`,
  );
});

test("el retroceso nunca es negativo ni cero", () => {
  for (let attempts = 0; attempts < 10; attempts++) {
    assert.ok(backoffMs(attempts) > 0);
  }
});

// ---------------------------------------------------------------------------
// Garantías estructurales del outbox
// ---------------------------------------------------------------------------

test("publish exige un cliente de transacción", () => {
  // Es la garantía entera: un publish que abriera su propia conexión podría
  // confirmarse mientras el cambio que lo motivó se revierte. Si alguien
  // relaja esta firma, el outbox deja de ser una garantía.
  assert.match(
    outboxSource,
    /export async function publish\(\s*tx: Prisma\.TransactionClient,/,
    "publish debe recibir la transacción del llamante como primer argumento",
  );
  // Se inspeccionan las importaciones, no el fichero entero: el JSDoc de
  // `publish` menciona `prisma.$transaction` en su ejemplo, que es correcto.
  const imports = outboxSource
    .split("\n")
    .filter((line) => line.startsWith("import "));

  assert.ok(
    imports.every((line) => !/\b(rawPrisma|prisma)\b/.test(line)),
    `outbox.ts no debe importar un cliente propio. Importaciones:\n${imports.join("\n")}`,
  );
});

test("el reclamo usa FOR UPDATE SKIP LOCKED", () => {
  // Es lo que permite varios despachadores a la vez sin repartirse el mismo
  // trabajo ni bloquearse. Sin esto, dos procesos entregan el mismo evento.
  assert.match(dispatcherSource, /FOR UPDATE SKIP LOCKED/);
});

test("el despachador recupera leases expirados", () => {
  // Sin esto, una fila reclamada por un worker que murió se queda en
  // PROCESSING para siempre y nadie lo nota: la cola no crece, simplemente ese
  // evento no ocurre.
  assert.match(dispatcherSource, /reclaimExpired/);
  assert.match(dispatcherSource, /status = 'PENDING'::"OutboxStatus"/);
});

test("el despachador corre fuera de contexto de tenant, con motivo escrito", () => {
  assert.match(dispatcherSource, /runAsSystem\("despachador del outbox: /);
  assert.doesNotMatch(
    dispatcherSource,
    /\bimport \{[^}]*\bprisma\b[^}]*\} from "@platform\/db"/,
    "debe usar rawPrisma: el cliente con filtro exigiría elegir un tenant, " +
      "y el despachador atiende a todos",
  );
});

test("drainAll tiene tope de pasadas", () => {
  // Un consumidor que publica un evento del mismo tipo que consume es un bucle
  // que gasta dinero real.
  assert.match(dispatcherSource, /drainAll\(maxPasses = \d+\)/);
});

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

test("el catálogo de eventos no tiene duplicados", () => {
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
});

test("un fallo permanente se distingue de uno reintentable", () => {
  // Reintentar cinco veces un payload malformado solo retrasa el diagnóstico.
  assert.equal(new EventHandlingError("x").permanent, false);
  assert.equal(new EventHandlingError("x", true).permanent, true);
});
