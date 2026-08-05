import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANSWER_SCHEMA,
  chunkDocument,
  fallbackAnswer,
  fuseRRF,
  normalizeForComparison,
  passesThreshold,
  splitByHeadings,
  splitSentences,
  validateGrounding,
  type RetrievalHit,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Troceado
// ---------------------------------------------------------------------------

test("las secciones conservan su ruta de encabezados", () => {
  // Sin breadcrumbs la cita dice "fragmento 47" en vez de
  // "Garantías › Devoluciones › Plazo", y el modelo pierde el contexto que el
  // troceo le quitó.
  const secciones = splitByHeadings(`
# Garantías
Texto de introducción.

## Devoluciones
El plazo general.

### Plazo
Treinta días naturales.
`);

  const plazo = secciones.find((s) => s.text.includes("Treinta días"));
  assert.deepEqual(plazo?.breadcrumbs, ["Garantías", "Devoluciones", "Plazo"]);
});

test("un encabezado del mismo nivel reemplaza al anterior y descarta sus hijos", () => {
  const secciones = splitByHeadings(`
## Envíos
### Plazos
Contenido A.

## Devoluciones
Contenido B.
`);

  const b = secciones.find((s) => s.text.includes("Contenido B"));
  assert.deepEqual(b?.breadcrumbs, ["Devoluciones"]);
});

test("las abreviaturas españolas no parten la frase", () => {
  // "Ref. AX-4402" partido deja la referencia huérfana — justo el
  // identificador que la búsqueda léxica necesitaba entero.
  const frases = splitSentences("Consulte la Ref. AX-4402 para más detalle. Gracias.");
  assert.equal(frases.length, 2);
  assert.ok(frases[0]?.includes("AX-4402"));
});

test("un documento sin encabezados se trocea igualmente", () => {
  const chunks = chunkDocument("Un texto plano sin estructura ninguna.");
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0]?.breadcrumbs, []);
});

test("los fragmentos minúsculos se fusionan con el anterior", () => {
  // Un fragmento de ocho palabras casi nunca contesta nada y ensucia el top-k.
  const chunks = chunkDocument("# T\n\n" + "Párrafo largo. ".repeat(200) + "\n\nCorto.");
  assert.ok(chunks.every((c) => c.tokenCount >= 60 || chunks.length === 1));
});

test("el ordinal es consecutivo y empieza en cero", () => {
  const chunks = chunkDocument("# A\n\n" + "Texto. ".repeat(500) + "\n\n# B\n\nMás.");
  chunks.forEach((c, i) => assert.equal(c.ordinal, i));
});

test("ningún fragmento supera el máximo declarado", () => {
  const chunks = chunkDocument("Palabra ".repeat(4000), { maxTokens: 400 });
  assert.ok(chunks.length > 1, "un texto largo debe partirse");
  assert.ok(
    chunks.every((c) => c.tokenCount <= 400 * 1.5),
    "un fragmento excedió con holgura el máximo",
  );
});

// ---------------------------------------------------------------------------
// Fusión RRF
// ---------------------------------------------------------------------------

function hit(id: string): {
  id: string;
  versionId: string;
  documentId: string;
  content: string;
  title: null;
  sourceRef: null;
  breadcrumbs: string[];
  pageNumber: null;
  tokenCount: number;
  rank: number;
} {
  return {
    id,
    versionId: `v-${id}`,
    documentId: `d-${id}`,
    content: `contenido de ${id}`,
    title: null,
    sourceRef: null,
    breadcrumbs: [],
    pageNumber: null,
    tokenCount: 10,
    rank: 0,
  };
}

test("lo que aparece en ambas ramas gana a lo que solo está en una", () => {
  // Es la propiedad que hace útil el híbrido: coincidir por significado Y por
  // término es una señal más fuerte que cualquiera de las dos sola.
  const fusionado = fuseRRF([hit("ambos"), hit("solo-vector")], [hit("ambos")], 10);

  assert.equal(fusionado[0]?.chunkId, "ambos");
  assert.deepEqual(fusionado[0]?.matchedBy, ["vector", "lexical"]);
});

test("un resultado solo léxico sobrevive a la fusión", () => {
  // El caso del SKU: 'AX-4402' y 'AX-4403' son casi idénticos como vectores.
  // Si la fusión descartara lo que no está en ambas ramas, la referencia exacta
  // se perdería.
  const fusionado = fuseRRF([hit("semantico")], [hit("AX-4402")], 10);
  assert.ok(fusionado.some((h) => h.chunkId === "AX-4402"));
});

test("se registra por qué rama entró cada resultado", () => {
  const fusionado = fuseRRF([hit("v")], [hit("l")], 10);
  const vectorial = fusionado.find((h) => h.chunkId === "v");
  const lexico = fusionado.find((h) => h.chunkId === "l");

  assert.equal(vectorial?.vectorRank, 1);
  assert.equal(vectorial?.lexicalRank, null);
  assert.equal(lexico?.lexicalRank, 1);
  assert.equal(lexico?.vectorRank, null);
});

test("la fusión respeta el límite pedido", () => {
  const muchos = Array.from({ length: 30 }, (_, i) => hit(`c${i}`));
  assert.equal(fuseRRF(muchos, [], 5).length, 5);
});

test("dos ramas vacías no producen resultados ni error", () => {
  assert.deepEqual(fuseRRF([], [], 10), []);
});

// ---------------------------------------------------------------------------
// Umbral — capa 1 del grounding
// ---------------------------------------------------------------------------

function retrieved(id: string, content: string, score = 1): RetrievalHit {
  return {
    chunkId: id,
    documentId: `d-${id}`,
    versionId: `v-${id}`,
    content,
    title: null,
    sourceRef: null,
    breadcrumbs: [],
    pageNumber: null,
    tokenCount: 10,
    score,
    matchedBy: ["vector"],
    vectorRank: 1,
    lexicalRank: null,
  };
}

test("sin resultados no se invoca al generador", () => {
  // Es la capa más fuerte de las seis: un modelo que no ve la pregunta no puede
  // inventar la respuesta.
  assert.equal(passesThreshold([], 0.01), false);
});

test("por debajo del umbral no se invoca al generador", () => {
  assert.equal(passesThreshold([retrieved("a", "x", 0.005)], 0.01), false);
  assert.equal(passesThreshold([retrieved("a", "x", 0.02)], 0.01), true);
});

// ---------------------------------------------------------------------------
// Validación de citas — capa 6
// ---------------------------------------------------------------------------

const FRAGMENTOS = [
  retrieved("c1", "El plazo de devolución es de 30 días naturales desde la entrega."),
  retrieved("c2", "Los envíos peninsulares tardan entre 24 y 48 horas."),
];

test("una respuesta bien citada valida", () => {
  const resultado = validateGrounding(
    {
      answered: true,
      response: "El plazo es de 30 días naturales.",
      citations: [{ chunkId: "c1", quote: "30 días naturales" }],
    },
    FRAGMENTOS,
  );

  assert.equal(resultado.valid, true);
  assert.deepEqual(resultado.failures, []);
});

test("un chunkId inventado invalida la respuesta", () => {
  // Un id que no estaba entre los recuperados es la firma de una cita fabricada.
  const resultado = validateGrounding(
    {
      answered: true,
      response: "Dice que sí.",
      citations: [{ chunkId: "c99", quote: "lo que sea" }],
    },
    FRAGMENTOS,
  );

  assert.equal(resultado.valid, false);
  assert.equal(resultado.failures[0]?.kind, "unknown_chunk");
});

test("un id correcto con texto inventado también invalida", () => {
  // Es el caso más peligroso: parece bien fundado porque el id existe.
  const resultado = validateGrounding(
    {
      answered: true,
      response: "El plazo es de 90 días.",
      citations: [{ chunkId: "c1", quote: "90 días naturales" }],
    },
    FRAGMENTOS,
  );

  assert.equal(resultado.valid, false);
  assert.equal(resultado.failures[0]?.kind, "quote_not_found");
});

test("afirmar sin citar invalida", () => {
  const resultado = validateGrounding(
    { answered: true, response: "Sí, claro que sí.", citations: [] },
    FRAGMENTOS,
  );

  assert.equal(resultado.valid, false);
  assert.ok(resultado.failures.some((f) => f.kind === "answered_without_citations"));
});

test("abstenerse es válido y no exige citas", () => {
  // `answered: false` es un resultado CORRECTO, no un fallo.
  const resultado = validateGrounding(
    { answered: false, response: "No tengo esa información.", citations: [] },
    FRAGMENTOS,
  );

  assert.equal(resultado.valid, true);
});

test("la comparación tolera acentos y espacios, pero no texto ausente", () => {
  // Un modelo que copia bien pero pierde una tilde está citando correctamente;
  // rechazarlo convertiría una buena respuesta en una abstención.
  const conVariacion = validateGrounding(
    {
      answered: true,
      response: "30 días.",
      citations: [{ chunkId: "c1", quote: "30  DIAS   naturales" }],
    },
    FRAGMENTOS,
  );
  assert.equal(conVariacion.valid, true);

  const inventado = validateGrounding(
    {
      answered: true,
      response: "x",
      citations: [{ chunkId: "c1", quote: "60 dias naturales" }],
    },
    FRAGMENTOS,
  );
  assert.equal(inventado.valid, false);
});

test("una cita vacía no cuenta como cita", () => {
  const resultado = validateGrounding(
    { answered: true, response: "x", citations: [{ chunkId: "c1", quote: "   " }] },
    FRAGMENTOS,
  );
  assert.equal(resultado.valid, false);
});

test("se detecta contenido que viola una prohibición del ADN", () => {
  const resultado = validateGrounding(
    {
      answered: true,
      response: "Le recomiendo ibuprofeno para eso.",
      citations: [{ chunkId: "c1", quote: "30 días naturales" }],
    },
    FRAGMENTOS,
    ["Nunca menciones ibuprofeno"],
  );

  assert.equal(resultado.valid, false);
  assert.ok(resultado.failures.some((f) => f.kind === "prohibited_content"));
});

test("normalizeForComparison quita acentos, mayúsculas y espacios de más", () => {
  assert.equal(normalizeForComparison("  Días   NATURALES\n"), "dias naturales");
});

test("el fallback es siempre una abstención sin citas", () => {
  const respuesta = fallbackAnswer("No tengo esa información.");
  assert.equal(respuesta.answered, false);
  assert.deepEqual(respuesta.citations, []);
});

test("el esquema exige answered y citations, y prohíbe campos extra", () => {
  assert.deepEqual([...ANSWER_SCHEMA.required], ["answered", "response", "citations"]);
  assert.equal(ANSWER_SCHEMA.additionalProperties, false);
});
