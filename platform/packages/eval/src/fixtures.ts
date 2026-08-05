import type { EvalCase } from "./metrics.js";

/**
 * El conjunto de referencia: un manual de atención al cliente y las preguntas
 * que se le hacen.
 *
 * Vive aquí y no dentro del test porque lo usan dos consumidores —el test de
 * integración y el script de medición— y un corpus duplicado es un corpus que
 * diverge: el día que se ajusta una pregunta en un sitio, el otro sigue
 * midiendo otra cosa y los dos números se comparan como si fueran el mismo.
 *
 * La composición importa tanto como el contenido: un tercio de las preguntas no
 * tienen respuesta en el corpus (§33). Sin ellas el conjunto no mide lo único
 * que decide si el producto es vendible.
 */

export const CUSTOMER_SUPPORT_CORPUS = `# Manual de atención al cliente

## Devoluciones

### Plazo de devolución
El plazo para devolver un pedido es de 30 días naturales desde la fecha de
entrega. Pasado ese plazo no se admiten devoluciones.

### Estado del producto
Solo se aceptan devoluciones de productos sin usar, con su embalaje original y
todas las etiquetas puestas.

## Envíos

### Plazos de entrega
Los envíos a península tardan entre 24 y 48 horas laborables. Los envíos a
Baleares y Canarias tardan entre 3 y 5 días laborables.

### Gastos de envío
El envío es gratuito para pedidos superiores a 50 euros. Por debajo de esa
cantidad, los gastos de envío son de 4,95 euros.

## Garantía

### Cobertura
Todos los productos tienen dos años de garantía legal contra defectos de
fabricación desde la fecha de compra.
`;

export const CUSTOMER_SUPPORT_CASES: EvalCase[] = [
  // --- Respondibles --------------------------------------------------------
  {
    id: "plazo-devolucion",
    kind: "ANSWERABLE",
    question: "¿Cuántos días tengo para devolver un pedido?",
    expectedContains: ["30 días"],
  },
  {
    id: "envio-gratis",
    kind: "ANSWERABLE",
    question: "¿A partir de qué importe el envío es gratis?",
    expectedContains: ["50 euros"],
  },
  {
    id: "plazo-canarias",
    kind: "ANSWERABLE",
    question: "¿Cuánto tarda un envío a Canarias?",
    expectedContains: ["3 y 5 días"],
  },
  {
    id: "garantia",
    kind: "ANSWERABLE",
    question: "¿Qué garantía tienen los productos?",
    expectedContains: ["dos años"],
  },
  {
    id: "estado-producto",
    kind: "ANSWERABLE",
    question: "¿Puedo devolver algo que ya he usado?",
    expectedContains: ["sin usar"],
  },
  {
    id: "gastos-envio",
    kind: "ANSWERABLE",
    question: "¿Cuánto cuestan los gastos de envío?",
    expectedContains: ["4,95"],
  },

  // --- Sin respuesta en el corpus -----------------------------------------
  // Un tercio del conjunto, según §33. Sin ellas no se mide lo único que
  // decide si el producto es vendible.
  {
    id: "sin-financiacion",
    kind: "UNANSWERABLE",
    question: "¿Ofrecéis financiación en 12 meses sin intereses?",
    notes: "El corpus no menciona financiación en ningún sitio.",
  },
  {
    id: "sin-tiendas",
    kind: "UNANSWERABLE",
    question: "¿Cuál es el horario de vuestra tienda física de Valencia?",
    notes: "No hay tiendas físicas ni horarios en el corpus.",
  },
  {
    id: "sin-tallas",
    kind: "UNANSWERABLE",
    question: "¿Qué equivalencia hay entre la talla europea y la americana?",
    notes: "Caso realista: parece de atención al cliente pero no está cubierto.",
  },

  // --- Trampa: el corpus habla del tema pero no de la pregunta -------------
  // El caso que distingue un generador que abstiene de uno que se conforma con
  // que el fragmento "vaya de lo mismo". La similitud coseno de esta pregunta
  // es ALTA —habla de devoluciones, de plazos y de pedidos— y la respuesta no
  // está escrita en ningún sitio. Es el caso que un umbral nunca va a filtrar.
  {
    id: "sin-plazo-reembolso",
    kind: "UNANSWERABLE",
    question:
      "Una vez devuelvo el pedido, ¿cuántos días tardáis en devolverme el dinero?",
    notes:
      "El corpus fija el plazo para DEVOLVER (30 días) pero no dice nada del " +
      "plazo de reembolso. Responder '30 días' aquí es la alucinación típica.",
  },
];
