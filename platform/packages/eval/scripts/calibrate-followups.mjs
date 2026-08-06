import "@platform/env/load";

import { randomUUID } from "node:crypto";

import { runWithTenant, systemPrisma, withRlsTransaction } from "@platform/db";
import { embedQuery, hybridSearch, ingestDocument } from "@platform/knowledge";
import { LocalEmbeddingProvider } from "@platform/providers";

import { CONVERSATIONAL_CASES, CUSTOMER_SUPPORT_CORPUS } from "@platform/eval";

/**
 * ¿Cuánto de la reescritura de seguimientos se ve en la RECUPERACIÓN?
 *
 *   node packages/eval/scripts/calibrate-followups.mjs
 *
 * Se escribió para justificar un test que decía «un seguimiento sin reescribir
 * no recupera la respuesta», y lo desmintió: sobre este corpus, la recupera
 * igual. El motivo no es que la reescritura sobre —lo es— sino que el corpus de
 * referencia tiene CINCO fragmentos, y pedir los tres primeros devuelve el 60%
 * de todo lo que hay. Con un corpus así, el ganador está en la lista pase lo
 * que pase.
 *
 * La consecuencia para el arnés es concreta: el valor de la reescritura en este
 * conjunto se mide **en modo `full`**, en lo que el generador hace con el texto
 * de la pregunta, no en qué fragmentos llegan. Y la consecuencia para el futuro
 * también: el día que el corpus crezca, esta medida empezará a separar, y este
 * script es cómo se comprueba.
 *
 * Sirve además para ver de dónde viene cada resultado. «¿Y a Canarias?» puntúa
 * RRF 0,0328 —el doble del techo de una rama— porque «Canarias» es un término
 * literal del fragmento y entra por las DOS ramas. Un seguimiento sin una
 * palabra distintiva, como «¿y si ya lo he usado?», no tiene esa suerte.
 */

const TENANT = `tnt_calfup_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const LIMIT = 3;

const ctx = {
  tenantId: TENANT,
  actor: { type: "system", id: "calibrate-followups", scopes: [] },
  requestId: `req_${TENANT}`,
};

/**
 * Las reescrituras canónicas, a mano.
 *
 * A mano y no pidiéndoselas al modelo porque lo que se calibra aquí es el
 * BUSCADOR: con un modelo de por medio, un número raro no distinguiría entre
 * "la recuperación no separa" y "la reescritura de aquel día fue mala".
 */
const REESCRITURAS = {
  "hilo-canarias": "¿Cuánto tarda un envío a Canarias?",
  "hilo-usado": "¿Puedo devolver un producto que ya he usado?",
  "hilo-autonoma": "¿Qué garantía tienen los productos?",
  "hilo-sin-reembolso":
    "¿Cuántos días tardáis en reembolsar el dinero de una devolución?",
};

const embedder = new LocalEmbeddingProvider();

async function buscar(query) {
  const queryEmbedding = await embedQuery(embedder, query);
  return runWithTenant(ctx, () =>
    withRlsTransaction((tx) =>
      hybridSearch(tx, {
        tenantId: TENANT,
        queryText: query,
        queryEmbedding,
        limit: LIMIT,
      }),
    ),
  );
}

function resumir(hits, esperado) {
  return hits.map((hit, index) => ({
    posicion: index + 1,
    acierto: esperado !== undefined && hit.content.includes(esperado),
    similitud: hit.vectorSimilarity,
    score: hit.score,
    ramas: hit.matchedBy.join("+"),
    texto: hit.content.replace(/\s+/g, " ").slice(0, 62),
  }));
}

async function main() {
  await systemPrisma.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, slug: TENANT, name: "Calibrate Follow-ups" },
  });

  try {
    await runWithTenant(ctx, () =>
      ingestDocument(
        {
          tenantId: TENANT,
          bytes: Buffer.from(CUSTOMER_SUPPORT_CORPUS, "utf8"),
          filename: "manual.md",
          mimeType: "text/markdown",
          sourceRef: "calibrate-followups",
        },
        { embedder, transaction: withRlsTransaction },
      ),
    );

    const fragmentos = await systemPrisma.chunk.count({ where: { tenantId: TENANT } });
    console.log(
      `\nCorpus: ${fragmentos} fragmentos · se piden ${LIMIT} ` +
        `(${((LIMIT / fragmentos) * 100).toFixed(0)}% de todo lo que hay)\n`,
    );

    let mejoras = 0;
    let medidos = 0;

    for (const testCase of CONVERSATIONAL_CASES) {
      const esperado = testCase.expectedContains?.[0];
      const reescrita = REESCRITURAS[testCase.id] ?? testCase.question;

      console.log(`── ${testCase.id} ──`);
      console.log(`   espera: ${esperado ?? "(sin respuesta en el corpus)"}`);

      for (const [etiqueta, query] of [
        ["seguimiento", testCase.question],
        ["reescrita  ", reescrita],
      ]) {
        const hits = await buscar(query);
        console.log(`   ${etiqueta}  "${query}"`);
        for (const fila of resumir(hits, esperado)) {
          console.log(
            `      ${fila.acierto ? "★" : " "} #${fila.posicion} ` +
              `sim=${fila.similitud === null ? " n/a " : fila.similitud.toFixed(3)} ` +
              `rrf=${fila.score.toFixed(4)} ${fila.ramas.padEnd(14)} ${fila.texto}`,
          );
        }
      }

      if (esperado !== undefined) {
        medidos++;
        const crudo = (await buscar(testCase.question)).some((h) =>
          h.content.includes(esperado),
        );
        const nuevo = (await buscar(reescrita)).some((h) => h.content.includes(esperado));
        if (!crudo && nuevo) mejoras++;
        console.log(
          `   → recuperado sin reescribir: ${crudo ? "sí" : "NO"} · ` +
            `reescrito: ${nuevo ? "sí" : "NO"}`,
        );
      }
      console.log("");
    }

    console.log(
      `Casos donde la reescritura CAMBIA la recuperación: ${mejoras}/${medidos}\n`,
    );
    if (mejoras === 0 && medidos > 0) {
      console.log(
        "Cero, y no significa que la reescritura sobre: significa que con un\n" +
          "corpus de este tamaño la recuperación no puede separar, porque\n" +
          "devuelve más de la mitad del corpus en cada consulta. El valor de la\n" +
          "reescritura en este conjunto se mide en modo `full`, en lo que el\n" +
          "generador hace con el TEXTO de la pregunta.\n",
      );
    }
  } finally {
    await systemPrisma.tenant.delete({ where: { id: TENANT } }).catch(() => {});
    await systemPrisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
