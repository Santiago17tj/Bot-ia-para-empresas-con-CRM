import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConversionError,
  assessExtraction,
  chunkDocument,
  converterFor,
  csvToMarkdown,
  decodeEntities,
  htmlToMarkdown,
  parseCsv,
  textToMarkdown,
  toMarkdown,
} from "../dist/index.js";

const buf = (s: string): Buffer => Buffer.from(s, "utf8");

// ---------------------------------------------------------------------------
// Resolución de conversor
// ---------------------------------------------------------------------------

test("el MIME manda sobre la extensión", () => {
  // Un .txt que en realidad es HTML se convierte mejor como HTML.
  assert.equal(converterFor("pagina.txt", "text/html")?.id, "html");
  assert.equal(converterFor("pagina.txt")?.id, "text");
});

test("la extensión es el respaldo cuando el MIME es genérico", () => {
  // Muchos clientes suben todo como application/octet-stream.
  assert.equal(converterFor("datos.csv", "application/octet-stream")?.id, "csv");
});

test("un formato sin conversor falla nombrando los soportados", async () => {
  await assert.rejects(
    () => toMarkdown(buf("x"), "hoja.xlsx", "application/vnd.ms-excel"),
    (error: unknown) => {
      assert.ok(error instanceof ConversionError);
      assert.match(error.message, /\.md/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

test("los encabezados HTML conservan su nivel", async () => {
  // Es el listón real de un conversor: sin jerarquía el troceador queda ciego.
  const { markdown } = await toMarkdown(
    buf("<html><body><h1>Garantías</h1><h2>Plazo</h2><p>30 días.</p></body></html>"),
    "p.html",
  );

  assert.match(markdown, /^# Garantías$/m);
  assert.match(markdown, /^## Plazo$/m);
});

test("se descartan navegación, pie y scripts", async () => {
  // Indexar el menú hace que "política" recupere el enlace del pie en todas las
  // páginas a la vez, en vez de la política.
  const { markdown } = await toMarkdown(
    buf(`<html><body>
      <nav>Inicio Contacto</nav>
      <script>var x = 'no indexar';</script>
      <main><h1>Real</h1><p>Contenido bueno.</p></main>
      <footer>Aviso legal</footer>
    </body></html>`),
    "p.html",
  );

  assert.match(markdown, /Contenido bueno/);
  assert.doesNotMatch(markdown, /Inicio Contacto/);
  assert.doesNotMatch(markdown, /no indexar/);
  assert.doesNotMatch(markdown, /Aviso legal/);
});

test("una tabla HTML se conserva como tabla", async () => {
  // Aplanada a prosa, el fragmento con las cifras pierde qué son.
  const { markdown } = await toMarkdown(
    buf("<table><tr><th>Producto</th><th>Precio</th></tr><tr><td>Camisa</td><td>29€</td></tr></table>"),
    "t.html",
  );

  assert.match(markdown, /\| Producto \| Precio \|/);
  assert.match(markdown, /\| Camisa \| 29€ \|/);
});

test("se decodifican entidades, incluidas las españolas", () => {
  assert.equal(decodeEntities("Garant&iacute;a &amp; devoluci&oacute;n"), "Garantía & devolución");
  assert.equal(decodeEntities("&#241;&#xF1;"), "ññ");
});

test("el título y el idioma se extraen si están", () => {
  const r = htmlToMarkdown('<html lang="es"><head><title>Manual</title></head><body><p>x</p></body></html>');
  assert.equal(r.title, "Manual");
  assert.equal(r.language, "es");
});

// ---------------------------------------------------------------------------
// Texto plano
// ---------------------------------------------------------------------------

test("el subrayado con === y --- se convierte en encabezado", () => {
  const { markdown } = textToMarkdown("Garantías\n=========\n\nTexto.\n\nPlazos\n------\n\nMás.");
  assert.match(markdown, /^# Garantías$/m);
  assert.match(markdown, /^## Plazos$/m);
});

test("la numeración jerárquica marca el nivel", () => {
  const { markdown } = textToMarkdown("1. Introducción\n\nTexto.\n\n1.2 Alcance\n\nMás texto.");
  assert.match(markdown, /^## Introducción$/m);
  assert.match(markdown, /^### Alcance$/m);
});

test("una línea aislada en mayúsculas se toma como sección", () => {
  const { markdown } = textToMarkdown("Intro.\n\nCONDICIONES GENERALES\n\nTexto siguiente.");
  assert.match(markdown, /^## Condiciones Generales$/m);
});

test("la heurística de mayúsculas no marca frases largas ni con puntuación", () => {
  // Marcar de más inventa estructura que el documento no tiene, y eso trocea
  // por sitios arbitrarios.
  const { markdown } = textToMarkdown(
    "Intro.\n\nESTA ES UNA LINEA MUY LARGA EN MAYUSCULAS QUE NO ES UN TITULO SINO UN AVISO LEGAL COMPLETO.\n\nFin.",
  );
  assert.doesNotMatch(markdown, /^## /m);
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test("el CSV se convierte en tabla con cabecera", () => {
  const { markdown } = csvToMarkdown("Producto,Precio\nCamisa,29\nPantalón,45");
  assert.match(markdown, /\| Producto \| Precio \|/);
  assert.match(markdown, /\| Pantalón \| 45 \|/);
});

test("el parser respeta comillas, comas internas y saltos de línea", () => {
  const rows = parseCsv('a,"b,con coma",c\n"multi\nlinea",e,f');
  assert.deepEqual(rows[0], ["a", "b,con coma", "c"]);
  assert.deepEqual(rows[1], ["multi\nlinea", "e", "f"]);
});

test("las comillas escapadas se resuelven", () => {
  assert.deepEqual(parseCsv('a,"dice ""hola""",c')[0], ["a", 'dice "hola"', "c"]);
});

test("las filas cortas se rellenan y se avisa", () => {
  const r = csvToMarkdown("a,b,c\n1,2");
  assert.match(r.markdown, /\| 1 \| 2 \|  \|/);
  assert.ok(r.warnings.length > 0);
});

// ---------------------------------------------------------------------------
// La comprobación de extracción vacía — punto único
// ---------------------------------------------------------------------------

test("una extracción vacía avisa de que puede faltar OCR", () => {
  // Es el fallo silencioso clásico: el PDF escaneado aparece cargado y no
  // responde nada, sin que nada diga por qué.
  const r = assessExtraction({ markdown: "  \n\n ", warnings: [] });
  assert.ok(r.warnings.some((w) => /OCR/.test(w)));
});

test("un documento largo sin encabezados avisa de que perderá las rutas", () => {
  const r = assessExtraction({ markdown: "palabra ".repeat(1000), warnings: [] });
  assert.ok(r.warnings.some((w) => /encabezado/i.test(w)));
});

test("un documento normal no genera avisos", () => {
  const r = assessExtraction({
    markdown: "# Título\n\n" + "Contenido suficiente y con estructura. ".repeat(20),
    warnings: [],
  });
  assert.deepEqual(r.warnings, []);
});

// ---------------------------------------------------------------------------
// Integración con el troceador — el porqué de todo esto
// ---------------------------------------------------------------------------

test("un HTML convertido produce fragmentos con ruta de sección", async () => {
  const { markdown } = await toMarkdown(
    buf(`<html><body><main>
      <h1>Manual</h1>
      <h2>Devoluciones</h2>
      <h3>Plazo</h3>
      <p>El plazo es de 30 días naturales desde la entrega del pedido.</p>
    </main></body></html>`),
    "manual.html",
  );

  const chunk = chunkDocument(markdown).find((c) => c.content.includes("30 días"));
  assert.ok(chunk, "no se encontró el fragmento");
  assert.deepEqual(chunk.breadcrumbs, ["Manual", "Devoluciones", "Plazo"]);
  assert.equal(chunk.sectionPath, "Manual › Devoluciones › Plazo");
});
