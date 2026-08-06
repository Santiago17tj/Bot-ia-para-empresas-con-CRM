import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { systemPrisma } from "@platform/db";

import { runDueSyncs } from "../dist/index.js";

/**
 * El planificador.
 *
 * Lo que se comprueba no es que cron funcione —eso está en
 * `packages/connectors/test/cron.test.ts`— sino lo que solo se ve contra la
 * base: que un disparo no se repita treinta veces dentro del mismo minuto, que
 * dos workers no publiquen los dos, y que una sincronización en marcha no
 * acumule otra encima.
 */

const TENANT = "tnt_sched_test1";
const OTRO = "tnt_sched_test2";

/** Las 3:00 UTC de un día cualquiera. */
const TRES = new Date(Date.UTC(2026, 7, 6, 3, 0));

async function crearFuente(
  tenantId: string,
  syncSchedule: string | null,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const source = await systemPrisma.knowledgeSource.create({
    data: {
      tenantId,
      name: "fuente de prueba",
      kind: "URL",
      config: { startUrls: ["https://acme.example"] },
      syncSchedule,
      ...overrides,
    },
    select: { id: true },
  });
  return source.id;
}

const eventosDe = (sourceId: string) =>
  systemPrisma.outboxEvent.count({
    where: { type: "source.sync.requested", payload: { path: ["sourceId"], equals: sourceId } },
  });

describe(
  "planificador de sincronizaciones",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    before(async () => {
      for (const [id, slug] of [
        [TENANT, "sched-1"],
        [OTRO, "sched-2"],
      ] as const) {
        await systemPrisma.tenant.upsert({
          where: { id },
          update: {},
          create: { id, slug, name: slug },
        });
      }
    });

    after(async () => {
      await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTRO] } } });
      await systemPrisma.$disconnect();
    });

    test("dispara la fuente a la que le toca y solo esa", async () => {
      const aLasTres = await crearFuente(TENANT, "0 3 * * *");
      const aLasCuatro = await crearFuente(TENANT, "0 4 * * *");
      const manual = await crearFuente(TENANT, null);

      const resultado = await runDueSyncs(TRES);

      assert.equal(resultado.triggered, 1);
      assert.equal(await eventosDe(aLasTres), 1);
      assert.equal(await eventosDe(aLasCuatro), 0);
      assert.equal(
        await eventosDe(manual),
        0,
        "sin cron, la fuente es solo manual",
      );
    });

    test("no se repite dentro del mismo minuto aunque se sondee treinta veces", async () => {
      const id = await crearFuente(TENANT, "0 5 * * *");
      const cinco = new Date(Date.UTC(2026, 7, 6, 5, 0));

      // El worker sondea cada dos segundos: sin idempotencia, un cron que casa
      // "las 5:00" dispararía treinta veces seguidas.
      for (let i = 0; i < 5; i++) await runDueSyncs(cinco);

      assert.equal(await eventosDe(id), 1);
    });

    test("al minuto siguiente que casa, vuelve a disparar", async () => {
      const id = await crearFuente(TENANT, "0 6,7 * * *");

      await runDueSyncs(new Date(Date.UTC(2026, 7, 6, 6, 0)));
      // Se libera el estado como haría el worker al terminar.
      await systemPrisma.knowledgeSource.update({
        where: { id },
        data: { lastSyncStatus: "READY" },
      });
      await runDueSyncs(new Date(Date.UTC(2026, 7, 6, 7, 0)));

      assert.equal(await eventosDe(id), 2);
    });

    test("dos workers a la vez publican UNA sola vez", async () => {
      const id = await crearFuente(TENANT, "0 8 * * *");
      const ocho = new Date(Date.UTC(2026, 7, 6, 8, 0));

      // Varios workers son correctos por diseño y los dos van a ver que a esta
      // fuente le toca. Leer-entonces-escribir haría que los dos publicaran;
      // la reclamación la decide un UPDATE condicional en la base.
      const [a, b, c] = await Promise.all([
        runDueSyncs(ocho),
        runDueSyncs(ocho),
        runDueSyncs(ocho),
      ]);

      assert.equal(
        a.triggered + b.triggered + c.triggered,
        1,
        "tres planificadores simultáneos, un solo disparo",
      );
      assert.equal(await eventosDe(id), 1);
    });

    test("una sincronización en marcha no acumula otra encima", async () => {
      const id = await crearFuente(TENANT, "0 9 * * *", { lastSyncStatus: "RUNNING" });

      await runDueSyncs(new Date(Date.UTC(2026, 7, 6, 9, 0)));

      // Se comprueba SOBRE ESTA FUENTE y no con el contador global: otras
      // fuentes del mismo conjunto también casan a esa hora, y un contador
      // compartido haría que este test dependiera del orden de los demás.
      const fuente = await systemPrisma.knowledgeSource.findUniqueOrThrow({
        where: { id },
        select: { lastScheduledAt: true },
      });

      assert.equal(
        fuente.lastScheduledAt,
        null,
        "no se reclamó, que es lo correcto: un sitio grande puede tardar más " +
          "que el intervalo de su cron, y sin esto se acumularían rastreos " +
          "pisándose el cursor",
      );
      assert.equal(await eventosDe(id), 0);
    });

    test("una fuente desactivada no se sincroniza aunque tenga horario", async () => {
      const id = await crearFuente(TENANT, "0 10 * * *", { isActive: false });

      await runDueSyncs(new Date(Date.UTC(2026, 7, 6, 10, 0)));
      assert.equal(await eventosDe(id), 0);
    });

    test("un cron inválido se anota y no tumba a las demás fuentes", async () => {
      const roto = await crearFuente(TENANT, "esto no es un cron");
      const bueno = await crearFuente(TENANT, "0 11 * * *");

      const resultado = await runDueSyncs(new Date(Date.UTC(2026, 7, 6, 11, 0)));

      assert.equal(resultado.invalid.length, 1);
      assert.equal(resultado.invalid[0]?.sourceId, roto);
      assert.equal(
        await eventosDe(bueno),
        1,
        "una fuente rota de un cliente no puede dejar sin sincronizar a los demás",
      );
    });

    test("el evento nace en el tenant dueño de la fuente", async () => {
      const ajena = await crearFuente(OTRO, "0 12 * * *");
      await runDueSyncs(new Date(Date.UTC(2026, 7, 6, 12, 0)));

      const evento = await systemPrisma.outboxEvent.findFirstOrThrow({
        where: {
          type: "source.sync.requested",
          payload: { path: ["sourceId"], equals: ajena },
        },
        select: { tenantId: true },
      });

      assert.equal(
        evento.tenantId,
        OTRO,
        "el planificador consulta todos los tenants, pero cada disparo abre el " +
          "contexto del suyo: si el evento naciera sin tenant o con el " +
          "equivocado, el worker ingeriría la web de un cliente en otro",
      );
    });
  },
);
