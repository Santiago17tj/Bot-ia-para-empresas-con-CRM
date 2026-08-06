import assert from "node:assert/strict";
import { test } from "node:test";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";

import {
  chunkDocument,
  converterFor,
  distinctHeadingHeights,
  mostFrequentHeight,
  toMarkdown,
} from "../dist/index.js";

/**
 * PDF y DOCX, con ficheros de verdad generados aquí mismo.
 *
 * Se generan en memoria en vez de guardar binarios en el repositorio: un
 * fixture opaco que nadie sabe regenerar es un fixture que nadie se atreve a
 * cambiar el día que hace falta probar otro caso.
 *
 * Lo que se comprueba NO es que se extraigan caracteres. Es que se conserve la
 * ESTRUCTURA, porque el troceador corta por encabezados y las citas se
 * construyen con ellos. Un conversor que devuelve un muro de texto plano pasa
 * cualquier test de "¿hay letras?" y produce justo el fragmento sin procedencia
 * que este pipeline existe para no tener.
 */

// ---------------------------------------------------------------------------
// Generadores
// ---------------------------------------------------------------------------

/** Un PDF de dos páginas con jerarquía tipográfica real. */
async function pdfDeDosPaginas(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);

  const uno = pdf.addPage([600, 800]);
  uno.drawText("Manual de Garantias", { x: 50, y: 740, size: 24, font: negrita });
  uno.drawText("Cobertura", { x: 50, y: 700, size: 16, font: negrita });
  uno.drawText("Todos los productos tienen dos anos de garantia legal contra", {
    x: 50,
    y: 675,
    size: 11,
    font: normal,
  });
  uno.drawText("defectos de fabricacion desde la fecha de compra.", {
    x: 50,
    y: 660,
    size: 11,
    font: normal,
  });

  const dos = pdf.addPage([600, 800]);
  dos.drawText("Exclusiones", { x: 50, y: 740, size: 16, font: negrita });
  dos.drawText("No cubre danos por mal uso, ni el desgaste normal de las piezas", {
    x: 50,
    y: 715,
    size: 11,
    font: normal,
  });
  dos.drawText("consideradas consumibles.", { x: 50, y: 700, size: 11, font: normal });

  return Buffer.from(await pdf.save());
}

async function docxConEncabezados(): Promise<Buffer> {
  const documento = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "Manual de Envios", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: "Plazos", heading: HeadingLevel.HEADING_2 }),
          new Paragraph(
            "Los envios a peninsula tardan entre 24 y 48 horas laborables.",
          ),
          new Paragraph({ text: "Costes", heading: HeadingLevel.HEADING_2 }),
          new Paragraph("El envio es gratuito para pedidos superiores a 50 euros."),
        ],
      },
    ],
  });

  return Packer.toBuffer(documento);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

test("el conversor de PDF está registrado y se resuelve por MIME y por extensión", () => {
  assert.equal(converterFor("manual.pdf", "application/pdf")?.id, "pdf");
  assert.equal(
    converterFor("manual.pdf", "application/octet-stream")?.id,
    "pdf",
    "muchos clientes suben todo como octet-stream: la extensión es el respaldo",
  );
});

test("un PDF conserva su jerarquía: los tamaños se vuelven encabezados", async () => {
  const resultado = await toMarkdown(await pdfDeDosPaginas(), "garantias.pdf", "application/pdf");

  // 24 pt → `#`, 16 pt → `##`, 11 pt → cuerpo. Esa es toda la estructura que un
  // PDF contiene, y perderla deja al troceador ciego.
  assert.match(resultado.markdown, /^# Manual de Garantias$/m);
  assert.match(resultado.markdown, /^## Cobertura$/m);
  assert.match(resultado.markdown, /^## Exclusiones$/m);
  assert.equal(resultado.title, "Manual de Garantias");
  assert.equal(resultado.pageCount, 2);
});

test("las líneas partidas por el PDF se recomponen antes de trocear", async () => {
  const resultado = await toMarkdown(await pdfDeDosPaginas(), "garantias.pdf", "application/pdf");

  // pdfjs devuelve trozos, no líneas. Sin reagrupar por coordenada, la frase
  // llegaría partida y la cita literal nunca coincidiría con el texto.
  assert.match(resultado.markdown, /dos anos de garantia legal/);
  assert.match(resultado.markdown, /desgaste normal de las piezas/);
});

test("cada fragmento sabe de qué página salió", async () => {
  const resultado = await toMarkdown(await pdfDeDosPaginas(), "garantias.pdf", "application/pdf");
  const fragmentos = chunkDocument(resultado.markdown);

  const cobertura = fragmentos.find((c) => c.breadcrumbs.includes("Cobertura"));
  const exclusiones = fragmentos.find((c) => c.breadcrumbs.includes("Exclusiones"));

  assert.ok(cobertura, "falta el fragmento de Cobertura");
  assert.ok(exclusiones, "falta el fragmento de Exclusiones");

  // Es el dato con el que una persona comprueba la cita en un manual de 300
  // páginas. `pageNumber` estaba declarado en el tipo desde el primer día y no
  // lo rellenaba nadie.
  assert.equal(cobertura.pageNumber, 1);
  assert.equal(exclusiones.pageNumber, 2);
});

test("el marcador de página no se cuela en el texto que se embebe", async () => {
  const resultado = await toMarkdown(await pdfDeDosPaginas(), "garantias.pdf", "application/pdf");

  for (const fragmento of chunkDocument(resultado.markdown)) {
    assert.doesNotMatch(
      fragmento.content,
      /<!--page:/,
      "el marcador es andamiaje: embeberlo mete ruido en el vector y se lo " +
        "enseña al modelo como si fuera contenido del cliente",
    );
  }
});

test("un PDF sin texto avisa en vez de cargarse en silencio", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  const vacio = Buffer.from(await pdf.save());

  const resultado = await toMarkdown(vacio, "escaneado.pdf", "application/pdf");

  // Es el fallo silencioso clásico: un PDF escaneado sin OCR aparece cargado
  // en el panel y no responde nada, sin que nada diga por qué.
  assert.ok(
    resultado.warnings.some((w) => w.includes("OCR")),
    `debería avisar del OCR; avisos: ${JSON.stringify(resultado.warnings)}`,
  );
});

test("un fichero que no es un PDF falla con un mensaje accionable", async () => {
  await assert.rejects(
    () => toMarkdown(Buffer.from("esto no es un pdf"), "roto.pdf", "application/pdf"),
    (error: unknown) =>
      error instanceof Error && /contraseña|PDF/i.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// La heurística de tamaños, por separado
// ---------------------------------------------------------------------------

test("el cuerpo del texto se decide por caracteres, no por número de líneas", () => {
  // Veinte titulares cortos y tres párrafos largos: por número de líneas
  // ganarían los titulares y la jerarquía saldría invertida.
  const lineas = [
    ...Array.from({ length: 20 }, () => ({ text: "Titular", height: 18 })),
    ...Array.from({ length: 3 }, () => ({ text: "x".repeat(400), height: 11 })),
  ];

  assert.equal(mostFrequentHeight(lineas), 11);
});

test("tamaños casi iguales son el mismo nivel, no dos", () => {
  const lineas = [
    { text: "Titulo", height: 24 },
    { text: "Seccion", height: 16 },
    { text: "Otra seccion", height: 16.2 },
    { text: "cuerpo largo ".repeat(50), height: 11 },
  ];

  assert.deepEqual(
    distinctHeadingHeights(lineas, 11),
    [24, 16],
    "16 y 16,2 son el mismo estilo con ruido de redondeo: tratarlos como dos " +
      "niveles metería un `###` espurio en la ruta de la cita",
  );
});

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

test("el conversor de DOCX está registrado", () => {
  assert.equal(
    converterFor(
      "manual.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )?.id,
    "docx",
  );
  assert.equal(converterFor("manual.docx", "application/octet-stream")?.id, "docx");
});

test("un DOCX conserva encabezados de verdad, sin heurística", async () => {
  const resultado = await toMarkdown(
    await docxConEncabezados(),
    "envios.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  assert.match(resultado.markdown, /^# Manual de Envios$/m);
  assert.match(resultado.markdown, /^## Plazos$/m);
  assert.match(resultado.markdown, /^## Costes$/m);
});

test("las citas de un DOCX salen con su ruta de sección", async () => {
  const resultado = await toMarkdown(
    await docxConEncabezados(),
    "envios.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  const fragmentos = chunkDocument(resultado.markdown);
  const costes = fragmentos.find((c) => c.content.includes("50 euros"));

  assert.ok(costes);
  assert.deepEqual(
    costes.breadcrumbs,
    ["Manual de Envios", "Costes"],
    "es la diferencia entre citar «Manual de Envíos › Costes» y «fragmento 47»",
  );
});

test("un .doc antiguo falla diciendo qué hacer", async () => {
  // Word 97-2003 es un formato binario distinto que mammoth no lee.
  await assert.rejects(
    () =>
      toMarkdown(
        Buffer.from("\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1 contenido antiguo", "binary"),
        "viejo.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    (error: unknown) => error instanceof Error && /\.docx/.test(error.message),
  );
});
