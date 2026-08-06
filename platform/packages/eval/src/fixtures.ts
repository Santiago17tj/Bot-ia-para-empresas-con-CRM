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

/**
 * Los casos con hilo (§10).
 *
 * Miden la única decisión de calidad del chat: que un seguimiento se pueda
 * buscar. Están aparte porque **no se pueden ejecutar sin reescritor** —el
 * ejecutor los salta y lo dice— y porque separarlos deja leer de un vistazo qué
 * parte del conjunto necesita generador conversacional.
 *
 * Los cuatro cubren las cuatro cosas distintas que puede hacer esta capa, y el
 * tercero es tan importante como el primero: un reescritor que reformula
 * preguntas que ya se entendían solas recupera peor sin que salte ninguna otra
 * alarma.
 */
export const CONVERSATIONAL_CASES: EvalCase[] = [
  {
    id: "hilo-canarias",
    kind: "ANSWERABLE",
    question: "¿Y a Canarias?",
    history: [
      { role: "USER", content: "¿Cuánto tarda un envío a península?" },
      {
        role: "ASSISTANT",
        content:
          "Los envíos a península tardan entre 24 y 48 horas laborables.",
      },
    ],
    expectsRewrite: true,
    expectedContains: ["3 y 5 días"],
    notes:
      "El caso canónico. Sin reescritura, «¿Y a Canarias?» no se parece a " +
      "ninguna frase del manual: no recupera, se abstiene, y lo hace justo " +
      "después de haber contestado bien — la peor abstención posible.",
  },
  {
    id: "hilo-usado",
    kind: "ANSWERABLE",
    question: "¿Y si ya lo he usado?",
    history: [
      { role: "USER", content: "¿Cuántos días tengo para devolver un pedido?" },
      {
        role: "ASSISTANT",
        content:
          "El plazo para devolver un pedido es de 30 días naturales desde la " +
          "fecha de entrega.",
      },
    ],
    expectsRewrite: true,
    expectedContains: ["sin usar"],
    notes:
      "El seguimiento cambia de sección dentro del mismo tema: la respuesta " +
      "no está en el fragmento de la respuesta anterior, sino en otro.",
  },
  {
    id: "hilo-autonoma",
    kind: "ANSWERABLE",
    question: "¿Qué garantía tienen los productos?",
    history: [
      { role: "USER", content: "¿Cuántos días tengo para devolver un pedido?" },
      {
        role: "ASSISTANT",
        content:
          "El plazo para devolver un pedido es de 30 días naturales desde la " +
          "fecha de entrega.",
      },
    ],
    expectsRewrite: false,
    expectedContains: ["dos años"],
    notes:
      "Hay hilo pero la pregunta se entiende sola, y además cambia de tema. " +
      "Reescribirla la contaminaría con la conversación anterior —«¿qué " +
      "garantía tienen los productos que he devuelto?»— y recuperaría peor. " +
      "Es el caso que atrapa a un reescritor que reescribe de más.",
  },
  {
    id: "hilo-sin-reembolso",
    kind: "UNANSWERABLE",
    question: "¿Y cuánto tardáis en devolverme el dinero?",
    history: [
      { role: "USER", content: "¿Cuántos días tengo para devolver un pedido?" },
      {
        role: "ASSISTANT",
        content:
          "El plazo para devolver un pedido es de 30 días naturales desde la " +
          "fecha de entrega.",
      },
    ],
    expectsRewrite: true,
    notes:
      "La trampa, en versión conversacional, y es más dura que la de un solo " +
      "turno: la reescritura es correcta y recupera con acierto el fragmento " +
      "de los 30 días, que el modelo acaba de citar bien en el turno " +
      "anterior. Tiene que abstenerse teniendo delante un número plausible y " +
      "su propia respuesta previa empujándole a repetirlo.",
  },
];

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

/**
 * El conjunto entero: un turno y conversación, sobre el mismo corpus.
 *
 * Es lo que mide `npm run eval`. Los dos bloques siguen exportándose por
 * separado porque se ejecutan en condiciones distintas —los conversacionales
 * exigen reescritor— y porque un fallo se lee mejor sabiendo de qué mitad viene.
 *
 * La composición aguanta: 9 respondibles y 5 sin respuesta, un 36%, que es el
 * tercio que pide §33.
 */
export const FULL_SUITE_CASES: EvalCase[] = [
  ...CUSTOMER_SUPPORT_CASES,
  ...CONVERSATIONAL_CASES,
];
