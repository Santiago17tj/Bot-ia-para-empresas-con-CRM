import "@platform/env/load";

import { LocalEmbeddingProvider } from "@platform/providers";
import { embedQuery } from "@platform/knowledge";

/**
 * Calibra el umbral de agrupamiento de huecos.
 *
 *   node packages/eval/scripts/calibrate-gaps.mjs
 *
 * La pregunta que responde: **a partir de qué similitud dos preguntas son el
 * mismo hueco.** No se puede reutilizar el umbral de recuperación (0,78), que
 * separa "este fragmento habla del tema" de "no habla". Aquí hay que separar
 * "es la misma pregunta escrita de otra forma" de "es otra pregunta del mismo
 * tema", que es una distinción mucho más fina y mucho más arriba en la escala.
 *
 * Equivocarse tiene coste en las dos direcciones y no simétrico:
 *
 *  - Umbral bajo: huecos distintos se funden. El informe dice "solo tienes
 *    tres huecos" y miente en la dirección tranquilizadora, que es la peor.
 *  - Umbral alto: cien filas que son la misma pregunta. Nadie mira la lista.
 */

/** Pares que DEBEN agruparse: la misma pregunta con otras palabras. */
const EQUIVALENTES = [
  ["¿Ofrecéis financiación?", "¿Puedo pagar a plazos?"],
  ["¿Ofrecéis financiación en 12 meses sin intereses?", "¿Se puede fraccionar el pago sin intereses?"],
  ["¿Cuál es el horario de vuestra tienda de Valencia?", "¿A qué hora abre la tienda física de Valencia?"],
  ["¿Cuánto tardáis en devolverme el dinero?", "¿En cuántos días recibo el reembolso?"],
  ["¿Qué talla americana equivale a una 42 europea?", "¿Cómo convierto tallas europeas a americanas?"],
  ["¿Hacéis envíos a Portugal?", "¿Enviáis fuera de España?"],
];

/** Pares que NO deben agruparse: mismo tema, pregunta distinta. */
const DISTINTOS = [
  ["¿Cuántos días tengo para devolver?", "¿Cuánto tardáis en devolverme el dinero?"],
  ["¿Cuánto cuesta el envío?", "¿Cuánto tarda el envío?"],
  ["¿Ofrecéis financiación?", "¿Aceptáis pago con tarjeta?"],
  ["¿Qué garantía tienen los productos?", "¿Cómo tramito una garantía?"],
  ["¿Hacéis envíos a Canarias?", "¿Cuánto cuesta enviar a Canarias?"],
  ["¿Puedo devolver algo usado?", "¿Puedo cambiar la talla de algo usado?"],
];

const coseno = (a, b) => a.reduce((acc, v, i) => acc + v * b[i], 0);

async function main() {
  const embedder = new LocalEmbeddingProvider();
  console.log(`[calibrar] ${embedder.model} · ${embedder.dimensions}d\n`);

  const medir = async (pares) => {
    const filas = [];
    for (const [a, b] of pares) {
      const [va, vb] = [await embedQuery(embedder, a), await embedQuery(embedder, b)];
      filas.push({ a, b, sim: coseno(va, vb) });
    }
    return filas;
  };

  const iguales = await medir(EQUIVALENTES);
  const otros = await medir(DISTINTOS);

  console.log("── Deben agruparse (misma pregunta, otras palabras) ──");
  for (const f of iguales) console.log(`  ${f.sim.toFixed(4)}  ${f.a}  ≈  ${f.b}`);

  console.log("\n── NO deben agruparse (mismo tema, otra pregunta) ──");
  for (const f of otros) console.log(`  ${f.sim.toFixed(4)}  ${f.a}  ≠  ${f.b}`);

  const minIgual = Math.min(...iguales.map((f) => f.sim));
  const maxOtro = Math.max(...otros.map((f) => f.sim));

  console.log("\n── Resumen ──");
  console.log(`  Equivalentes: ${minIgual.toFixed(4)} – ${Math.max(...iguales.map((f) => f.sim)).toFixed(4)}`);
  console.log(`  Distintos:    ${Math.min(...otros.map((f) => f.sim)).toFixed(4)} – ${maxOtro.toFixed(4)}`);
  console.log(`  Hueco:        ${(minIgual - maxOtro).toFixed(4)}`);

  if (minIgual > maxOtro) {
    // El punto medio maximiza el margen a los dos lados, que es lo que hace que
    // el umbral aguante la pregunta siguiente y no solo estas doce.
    console.log(`\n  Umbral sugerido: ${((minIgual + maxOtro) / 2).toFixed(3)}`);
  } else {
    console.log(
      "\n  SE SOLAPAN. No hay umbral que separe estos dos conjuntos: con este\n" +
        "  modelo, agrupar por similitud coseno funde huecos distintos o parte\n" +
        "  equivalentes, elijas el número que elijas.",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
