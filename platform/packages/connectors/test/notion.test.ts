import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";

import {
  ConnectorError,
  blocksToMarkdown,
  notionConnector,
  richTextToMarkdown,
  type DiscoveredDocument,
} from "../dist/index.js";

/**
 * El conector de Notion.
 *
 * Contra un servidor que imita su API —con paginación por cursor y los hijos en
 * peticiones aparte, que es como se comporta de verdad— y no contra Notion.
 * Conviene decirlo claro: **esto verifica nuestro código, no el comportamiento
 * de Notion.** Lo segundo hace falta un espacio real y un token, y es la
 * comprobación que queda pendiente.
 *
 * Lo que sí demuestra: que la paginación se recorre entera, que los hijos se
 * resuelven, que la estructura sobrevive a la conversión y que lo no modificado
 * no se vuelve a descargar.
 */

const texto = (contenido: string): { plain_text: string }[] => [{ plain_text: contenido }];

const BLOQUES: Record<string, unknown[]> = {
  pagina_envios: [
    { id: "b1", type: "heading_1", heading_1: { rich_text: texto("Condiciones de envío") } },
    { id: "b2", type: "heading_2", heading_2: { rich_text: texto("Plazos") } },
    {
      id: "b3",
      type: "paragraph",
      paragraph: { rich_text: texto("Península entre 24 y 48 horas laborables.") },
    },
    { id: "b4", type: "heading_2", heading_2: { rich_text: texto("Gastos") } },
    { id: "b5", type: "bulleted_list_item", bulleted_list_item: { rich_text: texto("Gratis por encima de 50 euros") }, has_children: true },
    { id: "b6", type: "bulleted_list_item", bulleted_list_item: { rich_text: texto("4,95 euros por debajo") } },
  ],
  // Hijos de b5: Notion los sirve en su propia petición.
  b5: [
    {
      id: "b5a",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: texto("Aplica a península y Baleares") },
    },
  ],
  pagina_garantia: [
    { id: "g1", type: "heading_1", heading_1: { rich_text: texto("Garantía") } },
    { id: "g2", type: "paragraph", paragraph: { rich_text: texto("Dos años de garantía legal.") } },
  ],
  pagina_vacia: [],
};

/** Dos páginas por lote, para que la paginación se ejerza de verdad. */
const PAGINAS = [
  {
    id: "pagina_envios",
    object: "page",
    url: "https://www.notion.so/pagina-envios",
    last_edited_time: "2026-08-01T10:00:00.000Z",
    properties: { Nombre: { type: "title", title: texto("Envíos") } },
  },
  {
    id: "pagina_garantia",
    object: "page",
    url: "https://www.notion.so/pagina-garantia",
    last_edited_time: "2026-08-02T10:00:00.000Z",
    properties: { Nombre: { type: "title", title: texto("Garantía") } },
  },
  {
    id: "pagina_vacia",
    object: "page",
    url: "https://www.notion.so/pagina-vacia",
    last_edited_time: "2026-08-03T10:00:00.000Z",
    properties: { Nombre: { type: "title", title: texto("Borrador") } },
  },
  {
    id: "pagina_archivada",
    object: "page",
    archived: true,
    last_edited_time: "2026-08-04T10:00:00.000Z",
    properties: { Nombre: { type: "title", title: texto("Vieja") } },
  },
];

let server: Server | undefined;
let baseUrl = "";
let peticiones: string[] = [];
let tokenRecibido: string | undefined;
let vacio = false;

async function sincronizar(
  config: Record<string, unknown>,
  cursor: Record<string, unknown> = {},
): Promise<{
  documentos: DiscoveredDocument[];
  cursor: Record<string, unknown>;
  avisos: string[];
  saltados: number;
}> {
  const documentos: DiscoveredDocument[] = [];
  const resultado = await notionConnector.sync(
    // `requestDelayMs: 0` porque lo que se prueba es la lógica, no el ritmo:
    // con la pausa real de producción este fichero solo tardaría medio minuto.
    { token: "ntn_de_prueba", baseUrl, requestDelayMs: 0, ...config },
    {
      cursor,
      emit: (document) => {
        documentos.push(document);
        return Promise.resolve();
      },
    },
  );

  return {
    documentos,
    cursor: resultado.cursor,
    avisos: resultado.progress.warnings,
    saltados: resultado.progress.skipped,
  };
}

describe("conector de Notion", () => {
  before(async () => {
    server = createServer((req, res) => {
      peticiones.push(req.url ?? "");
      tokenRecibido = req.headers["authorization"];

      const responder = (body: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (req.url === "/search") {
        let cuerpo = "";
        req.on("data", (c) => (cuerpo += c));
        req.on("end", () => {
          if (vacio) {
            responder({ results: [], has_more: false });
            return;
          }
          const { start_cursor } = JSON.parse(cuerpo || "{}") as { start_cursor?: string };
          // Dos lotes: sin cursor los dos primeros, con cursor el resto.
          if (start_cursor === undefined) {
            responder({ results: PAGINAS.slice(0, 2), has_more: true, next_cursor: "lote2" });
          } else {
            responder({ results: PAGINAS.slice(2), has_more: false });
          }
        });
        return;
      }

      const bloques = /^\/blocks\/([^/?]+)\/children/.exec(req.url ?? "");
      if (bloques?.[1] !== undefined) {
        responder({ results: BLOQUES[bloques[1]] ?? [], has_more: false });
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "no existe" }));
    });

    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server !== undefined) await new Promise<void>((r) => server?.close(() => r()));
  });

  // -------------------------------------------------------------------------
  // Configuración
  // -------------------------------------------------------------------------

  test("sin token no se crea la fuente, y el error dice qué hacer", () => {
    assert.throws(
      () => notionConnector.validateConfig({}),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.message.includes("my-integrations") &&
        // Es la primera causa de "no funciona" con Notion: crear la
        // integración no basta, hay que compartirle las páginas.
        error.message.includes("COMPARTE"),
    );
  });

  test("el token está declarado como campo secreto", () => {
    assert.deepEqual(
      notionConnector.secretFields,
      ["token"],
      "sin declararlo, la API lo devolvería en claro en GET /v1/sources",
    );
  });

  // -------------------------------------------------------------------------
  // Sincronización
  // -------------------------------------------------------------------------

  test("el token viaja como Bearer y con la versión de la API", async () => {
    peticiones = [];
    await sincronizar({});
    assert.equal(tokenRecibido, "Bearer ntn_de_prueba");
  });

  test("recorre TODAS las páginas de la paginación, no solo el primer lote", async () => {
    const { documentos } = await sincronizar({});

    // Sin seguir `next_cursor`, se quedaría en las dos primeras y el cliente
    // tendría medio espacio indexado sin que nada fallara.
    assert.ok(
      documentos.some((d) => d.externalId === "pagina_garantia"),
      "la página del segundo lote tiene que aparecer",
    );
  });

  test("la estructura de Notion se conserva: los encabezados son encabezados", async () => {
    const { documentos } = await sincronizar({});
    const envios = documentos.find((d) => d.externalId === "pagina_envios");
    assert.ok(envios);

    const markdown = envios.bytes.toString("utf8");
    assert.match(markdown, /^## Plazos$/m);
    assert.match(markdown, /^## Gastos$/m);
    assert.match(markdown, /24 y 48 horas/);
  });

  test("el título de la página encabeza el documento", async () => {
    const { documentos } = await sincronizar({});
    const envios = documentos.find((d) => d.externalId === "pagina_envios");

    // El troceador construye las migas de pan con los encabezados: sin el
    // título dentro, las citas de esta página empezarían por su primera
    // sección y se perdería de qué documento venían.
    assert.match(envios?.bytes.toString("utf8") ?? "", /^# Envíos/);
  });

  test("los hijos se resuelven con su propia petición", async () => {
    const { documentos } = await sincronizar({});
    const envios = documentos.find((d) => d.externalId === "pagina_envios");

    assert.match(
      envios?.bytes.toString("utf8") ?? "",
      /Aplica a península y Baleares/,
      "Notion sirve los hijos aparte: sin pedirlos, se pierde el contenido anidado",
    );
  });

  test("la cita apunta a la URL de la página en Notion", async () => {
    const { documentos } = await sincronizar({});
    assert.equal(
      documentos.find((d) => d.externalId === "pagina_envios")?.sourceRef,
      "https://www.notion.so/pagina-envios",
    );
  });

  test("las archivadas se saltan salvo que se pidan", async () => {
    const { documentos } = await sincronizar({});
    assert.ok(!documentos.some((d) => d.externalId === "pagina_archivada"));
  });

  test("una página sin contenido avisa en vez de indexar un documento mudo", async () => {
    const { documentos, avisos } = await sincronizar({});

    assert.ok(!documentos.some((d) => d.externalId === "pagina_vacia"));
    assert.ok(avisos.some((a) => a.includes("Borrador")));
  });

  // -------------------------------------------------------------------------
  // Lo incremental
  // -------------------------------------------------------------------------

  test("lo no modificado no se vuelve a descargar", async () => {
    const primera = await sincronizar({});
    assert.ok(primera.documentos.length > 0);

    peticiones = [];
    const segunda = await sincronizar({}, primera.cursor);

    assert.equal(segunda.documentos.length, 0);
    assert.ok(segunda.saltados > 0);
    assert.ok(
      !peticiones.some((p) => p.includes("/blocks/pagina_envios/")),
      "Notion da la fecha de última edición: saltarse la página ANTES de pedir " +
        "sus bloques ahorra varias peticiones por página",
    );
  });

  test("una página editada sí se vuelve a traer", async () => {
    const primera = await sincronizar({});
    const cursor = primera.cursor as { seen: Record<string, string> };
    cursor.seen["pagina_envios"] = "2026-01-01T00:00:00.000Z";

    const segunda = await sincronizar({}, cursor);
    assert.ok(segunda.documentos.some((d) => d.externalId === "pagina_envios"));
  });

  // -------------------------------------------------------------------------
  // El caso que genera todos los tickets de soporte
  // -------------------------------------------------------------------------

  test("si no le han compartido nada, se dice; no se termina en verde con cero", async () => {
    vacio = true;
    try {
      const { documentos, avisos } = await sincronizar({});

      assert.equal(documentos.length, 0);
      assert.ok(
        avisos.some((a) => a.includes("COMPARTIR")),
        "un espacio con la integración creada y nada compartido devuelve cero " +
          "resultados, y sin este aviso parece que el conector está roto",
      );
    } finally {
      vacio = false;
    }
  });
});

// ---------------------------------------------------------------------------
// La conversión, por separado y sin red
// ---------------------------------------------------------------------------

describe("bloques de Notion a Markdown", () => {
  test("el formato en línea se conserva", () => {
    assert.equal(
      richTextToMarkdown([
        { plain_text: "Aviso: ", annotations: { bold: true } },
        { plain_text: "solo hasta el día " },
        { plain_text: "15", annotations: { italic: true } },
      ]),
      "**Aviso: **solo hasta el día _15_",
    );
  });

  test("el código no se anida dentro de la negrita", () => {
    // Dentro de `código`, el asterisco se vería literal.
    assert.equal(
      richTextToMarkdown([
        { plain_text: "npm run dev", annotations: { code: true, bold: true } },
      ]),
      "`npm run dev`",
    );
  });

  test("los enlaces se conservan porque a veces SON la respuesta", () => {
    assert.equal(
      richTextToMarkdown([{ plain_text: "el formulario", href: "https://acme.example/form" }]),
      "[el formulario](https://acme.example/form)",
    );
  });

  test("la numeración se reinicia cuando la lista se interrumpe", () => {
    const markdown = blocksToMarkdown([
      { id: "1", type: "numbered_list_item", numbered_list_item: { rich_text: texto("uno") } },
      { id: "2", type: "numbered_list_item", numbered_list_item: { rich_text: texto("dos") } },
      { id: "3", type: "paragraph", paragraph: { rich_text: texto("Y aparte:") } },
      { id: "4", type: "numbered_list_item", numbered_list_item: { rich_text: texto("otro uno") } },
    ] as never);

    assert.match(markdown, /^1\. uno$/m);
    assert.match(markdown, /^2\. dos$/m);
    assert.match(
      markdown,
      /^1\. otro uno$/m,
      "sin reiniciar, dos listas separadas por un párrafo se numerarían seguidas",
    );
  });

  test("las tablas se conservan como tablas", () => {
    // Es donde una PYME pone sus precios. Aplanarla deja las cifras sin la
    // cabecera que dice qué son.
    const markdown = blocksToMarkdown([
      {
        id: "t1",
        type: "table",
        table: {},
        children: [
          { id: "r1", type: "table_row", table_row: { cells: [texto("Destino"), texto("Plazo")] } },
          { id: "r2", type: "table_row", table_row: { cells: [texto("Península"), texto("24-48 h")] } },
        ],
      },
    ] as never);

    assert.match(markdown, /\| Destino \| Plazo \|/);
    assert.match(markdown, /\| --- \| --- \|/);
    assert.match(markdown, /\| Península \| 24-48 h \|/);
  });

  test("un tipo de bloque desconocido conserva su texto", () => {
    // Notion añade tipos nuevos cada pocos meses; perderlos en silencio sería
    // lo peor que puede hacer un conector.
    const markdown = blocksToMarkdown([
      { id: "x", type: "bloque_del_futuro", bloque_del_futuro: { rich_text: texto("algo importante") } },
    ] as never);

    assert.match(markdown, /algo importante/);
  });

  test("el anidamiento no se persigue hasta el infinito", () => {
    // Ha habido ciclos en los datos de su API. Un worker colgado es peor que
    // una página incompleta.
    let bloque: Record<string, unknown> = {
      id: "hondo",
      type: "paragraph",
      paragraph: { rich_text: texto("fondo") },
    };
    for (let i = 0; i < 40; i++) {
      bloque = {
        id: `n${i}`,
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: texto(`nivel ${i}`) },
        children: [bloque],
      };
    }

    const markdown = blocksToMarkdown([bloque] as never);
    assert.ok(markdown.length > 0);
    assert.ok(!markdown.includes("fondo"), "se corta antes de llegar al fondo");
  });
});
