import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { runWithTenant, systemPrisma, withRlsTransaction } from "@platform/db";
import { LocalEmbeddingProvider } from "@platform/providers";

import { recordGap, type GapCandidate, type GapMatcher } from "../dist/index.js";

/**
 * Huecos de conocimiento: el registro y el agrupamiento.
 *
 * El decisor es FALSO a propósito. Lo que se comprueba aquí no es si un modelo
 * agrupa bien —eso depende del modelo y se mide aparte— sino la mecánica: que
 * el vector traiga candidatos, que la decisión se respete, que un id inventado
 * se descarte, y que sin decisor no se agrupe nada en vez de agrupar mal.
 *
 * Y hay un caso que solo se puede probar con un decisor controlado: que el
 * agrupamiento NO dependa de la similitud coseno. La calibración demostró que
 * "¿cuánto cuesta el envío?" y "¿cuánto tarda el envío?" puntúan 0,948 siendo
 * preguntas distintas, mientras que "¿ofrecéis financiación?" y "¿puedo pagar a
 * plazos?" puntúan 0,842 siendo la misma. Cualquier umbral se equivoca en uno
 * de los dos.
 */

const TENANT = "tnt_gaps_test01";
const embedder = new LocalEmbeddingProvider();

const ctx = {
  tenantId: TENANT,
  actor: { type: "system" as const, id: "gaps-test", scopes: [] },
  requestId: "req_gaps_test",
};

const deps = (match?: GapMatcher) => ({
  embedder,
  transaction: withRlsTransaction,
  ...(match === undefined ? {} : { match }),
});

const registrar = (question: string, match?: GapMatcher) =>
  runWithTenant(ctx, () =>
    recordGap(
      { tenantId: TENANT, question, reason: "MODEL_ABSTAINED" },
      deps(match),
    ),
  );

/** Decisor que agrupa cuando la pregunta contiene alguna de estas palabras. */
const decisorPorTema =
  (tema: string): GapMatcher =>
  (question, candidates) =>
    Promise.resolve(
      question.toLowerCase().includes(tema)
        ? (candidates.find((c) => c.question.toLowerCase().includes(tema))?.id ?? null)
        : null,
    );

const nuncaAgrupa: GapMatcher = () => Promise.resolve(null);

describe(
  "huecos de conocimiento",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    before(async () => {
      await systemPrisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, slug: "gaps-test", name: "Gaps Test" },
      });
    });

    after(async () => {
      await systemPrisma.tenant.delete({ where: { id: TENANT } });
      await systemPrisma.$disconnect();
    });

    test("la primera abstención abre un hueco nuevo", async () => {
      const result = await registrar("¿Ofrecéis financiación?", nuncaAgrupa);

      assert.equal(result.grouped, false);
      assert.equal(result.occurrences, 1);
      assert.equal(result.candidatesConsidered, 0, "no había nada con qué agrupar");
    });

    test("el vector guarda el hueco y lo puede volver a encontrar", async () => {
      // Sin vector escrito, el hueco no aparecería nunca como candidato y cada
      // pregunta abriría fila propia sin que nada fallara.
      const filas = await systemPrisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(embedding_384) AS n FROM "knowledgeGap" WHERE "tenantId" = ${TENANT}
      `;
      assert.ok(Number(filas[0]?.n ?? 0) > 0, "el vector no se escribió");

      let vistos: GapCandidate[] = [];
      await registrar("¿Puedo pagar a plazos?", (_q, candidates) => {
        vistos = candidates;
        return Promise.resolve(null);
      });

      assert.ok(
        vistos.some((c) => c.question.includes("financiación")),
        "el hueco de financiación tenía que llegar como candidato: puntúa 0,842 " +
          "con esta pregunta, y el umbral de candidatos está por debajo justo " +
          "para no dejarlo fuera",
      );
    });

    test("la decisión del generador manda, no la similitud", async () => {
      // 0,842 de similitud —de los más bajos medidos— y sin embargo son la
      // misma pregunta. Un umbral afinado los habría separado.
      const result = await registrar("¿Se puede fraccionar el pago?", decisorPorTema("pago"));

      // El decisor de prueba busca "pago" en el hueco existente; el primero es
      // "¿Ofrecéis financiación?", que no lo contiene. Así que abre uno nuevo.
      assert.equal(result.grouped, false);

      // Y ahora sí: otra con "pago" se agrupa con la anterior.
      const segunda = await registrar("¿Cómo va el pago aplazado?", decisorPorTema("pago"));
      assert.equal(segunda.grouped, true);
      assert.equal(segunda.occurrences, 2);
    });

    test("la formulación nueva se guarda como variante", async () => {
      const gap = await systemPrisma.knowledgeGap.findFirstOrThrow({
        where: { tenantId: TENANT, occurrences: { gt: 1 } },
        select: { question: true, variants: true },
      });

      assert.ok(
        gap.variants.length > 0,
        "sin variantes se pierde CÓMO se lo preguntan, que casi nunca es con " +
          "el vocabulario del manual",
      );
      assert.ok(!gap.variants.includes(gap.question), "la representativa no se duplica");
    });

    test("un id que no estaba entre los candidatos se descarta", async () => {
      const inventado: GapMatcher = () => Promise.resolve("gap_que_no_existe");

      const result = await registrar("¿Tenéis servicio técnico?", inventado);

      assert.equal(
        result.grouped,
        false,
        "un id inventado absorbería un hueco dentro de otro que no le " +
          "corresponde, y desaparecería del informe sin que nadie lo notara",
      );
    });

    test("sin decisor no se agrupa, en vez de agrupar mal", async () => {
      const primera = await registrar("¿Hacéis envíos a Portugal?");
      const segunda = await registrar("¿Enviáis fuera de España?");

      assert.equal(primera.grouped, false);
      assert.equal(
        segunda.grouped,
        false,
        "son la misma pregunta, pero sin quien lo decida NO se agrupa: es peor " +
          "informe y no es un dato perdido, mientras que agrupar por umbral " +
          "sería mentir en la dirección tranquilizadora",
      );
      assert.ok(
        segunda.candidatesConsidered > 0,
        "el vector sí tenía candidatos que ofrecer; lo que falta es quien decida",
      );
    });

    test("un hueco documentado ya no absorbe preguntas nuevas", async () => {
      const abierto = await systemPrisma.knowledgeGap.findFirstOrThrow({
        where: { tenantId: TENANT },
        select: { id: true, question: true },
      });

      await systemPrisma.knowledgeGap.update({
        where: { id: abierto.id },
        data: { status: "DOCUMENTED", resolvedAt: new Date() },
      });

      let candidatos: GapCandidate[] = [];
      await registrar(abierto.question, (_q, c) => {
        candidatos = c;
        return Promise.resolve(null);
      });

      assert.ok(
        !candidatos.some((c) => c.id === abierto.id),
        "si vuelve a preguntarse algo ya documentado, eso es una señal DISTINTA " +
          "—la documentación existe y no se encuentra— y merece fila propia en " +
          "vez de esconderse dentro de la anterior",
      );
    });

    test("los huecos de un tenant no son candidatos para otro", async () => {
      const OTRO = "tnt_gaps_test02";
      await systemPrisma.tenant.upsert({
        where: { id: OTRO },
        update: {},
        create: { id: OTRO, slug: "gaps-test-2", name: "Gaps Test 2" },
      });

      try {
        let candidatos: GapCandidate[] = [];
        await runWithTenant({ ...ctx, tenantId: OTRO }, () =>
          recordGap(
            {
              tenantId: OTRO,
              question: "¿Ofrecéis financiación?",
              reason: "MODEL_ABSTAINED",
            },
            deps((_q, c) => {
              candidatos = c;
              return Promise.resolve(null);
            }),
          ),
        );

        assert.deepEqual(
          candidatos,
          [],
          "FUGA: las preguntas sin responder de un cliente son de las cosas más " +
            "sensibles que guarda el sistema",
        );
      } finally {
        await systemPrisma.tenant.delete({ where: { id: OTRO } });
      }
    });
  },
);
