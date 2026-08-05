import { runWithTenant, systemPrisma, withRlsTransaction } from "@platform/db";
import { embedQuery, hybridSearch, ingestDocument } from "@platform/knowledge";
import { LocalEmbeddingProvider } from "@platform/providers";

const T = "tnt_calib0001";
const embedder = new LocalEmbeddingProvider();
const ctx = { tenantId: T, actor: { type: "system", id: "calib", scopes: [] }, requestId: "r" };

const CORPUS = `# Manual

## Devoluciones
### Plazo de devolución
El plazo para devolver un pedido es de 30 días naturales desde la fecha de entrega.

### Estado del producto
Solo se aceptan devoluciones de productos sin usar, con su embalaje original.

## Envíos
### Plazos de entrega
Los envíos a península tardan entre 24 y 48 horas laborables. Baleares y Canarias entre 3 y 5 días.

### Gastos de envío
El envío es gratuito para pedidos superiores a 50 euros. Por debajo, 4,95 euros.

## Garantía
### Cobertura
Todos los productos tienen dos años de garantía legal contra defectos de fabricación.
`;

await systemPrisma.tenant.upsert({ where: { id: T }, update: {}, create: { id: T, slug: "calib", name: "Calib" } });
await runWithTenant(ctx, () => ingestDocument(
  { tenantId: T, bytes: Buffer.from(CORPUS), filename: "m.md", mimeType: "text/markdown", sourceRef: "calib" },
  { embedder, transaction: withRlsTransaction }));

const RESPONDIBLES = [
  "¿Cuántos días tengo para devolver un pedido?",
  "¿A partir de qué importe el envío es gratis?",
  "¿Cuánto tarda un envío a Canarias?",
  "¿Qué garantía tienen los productos?",
  "¿Puedo devolver algo que ya he usado?",
  "¿Cuánto cuestan los gastos de envío?",
];
const SIN_RESPUESTA = [
  "¿Ofrecéis financiación en 12 meses sin intereses?",
  "¿Cuál es el horario de vuestra tienda física de Valencia?",
  "¿Qué equivalencia hay entre la talla europea y la americana?",
  "¿Cómo se prepara un risotto de setas?",
];

async function best(q) {
  const e = await embedQuery(embedder, q);
  const hits = await runWithTenant(ctx, () => withRlsTransaction((tx) =>
    hybridSearch(tx, { tenantId: T, queryText: q, queryEmbedding: e, limit: 5 })));
  return hits.reduce((m, h) => Math.max(m, h.vectorSimilarity ?? 0), 0);
}

console.log("\n=== RESPONDIBLES (similitud del mejor) ===");
const ok = [];
for (const q of RESPONDIBLES) { const s = await best(q); ok.push(s); console.log(`  ${s.toFixed(4)}  ${q}`); }

console.log("\n=== SIN RESPUESTA ===");
const no = [];
for (const q of SIN_RESPUESTA) { const s = await best(q); no.push(s); console.log(`  ${s.toFixed(4)}  ${q}`); }

console.log(`\nmin respondible: ${Math.min(...ok).toFixed(4)}`);
console.log(`max sin respuesta: ${Math.max(...no).toFixed(4)}`);
console.log(`=> hueco: ${(Math.min(...ok) - Math.max(...no)).toFixed(4)}`);

await systemPrisma.tenant.delete({ where: { id: T } });
await systemPrisma.$disconnect();
