import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";

import {
  ConnectorError,
  buildAssertion,
  driveConnector,
  parseServiceAccount,
  planFor,
  type DiscoveredDocument,
} from "../dist/index.js";

/**
 * El conector de Google Drive.
 *
 * Con una clave RSA generada aquí mismo y un servidor que imita la API: token,
 * listado paginado, exportación y descarga. Como con Notion, conviene decirlo
 * claro — **esto verifica nuestro código, no el comportamiento de Google.**
 */

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let server: Server | undefined;
let baseUrl = "";
let tokenUri = "";
let peticiones: string[] = [];
let tokensPedidos = 0;
let listaVacia = false;

const credenciales = (): string =>
  JSON.stringify({
    type: "service_account",
    client_email: "indexador@acme-123.iam.gserviceaccount.com",
    private_key: privateKey,
    token_uri: tokenUri,
  });

const FICHEROS: Record<string, unknown[]> = {
  raiz: [
    {
      id: "doc_envios",
      name: "Condiciones de envío",
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: "2026-08-01T10:00:00.000Z",
      webViewLink: "https://docs.google.com/document/d/doc_envios/edit",
    },
    {
      id: "carpeta_legal",
      name: "Legal",
      mimeType: "application/vnd.google-apps.folder",
      modifiedTime: "2026-08-01T10:00:00.000Z",
    },
    {
      id: "hoja_tarifas",
      name: "Tarifas 2026",
      mimeType: "application/vnd.google-apps.spreadsheet",
      modifiedTime: "2026-08-02T10:00:00.000Z",
    },
    {
      id: "foto",
      name: "logo.png",
      mimeType: "image/png",
      modifiedTime: "2026-08-02T10:00:00.000Z",
    },
    {
      id: "formulario",
      name: "Encuesta",
      mimeType: "application/vnd.google-apps.form",
      modifiedTime: "2026-08-02T10:00:00.000Z",
    },
  ],
  // La subcarpeta: Drive NO busca en profundidad, hay que recorrerla.
  carpeta_legal: [
    {
      id: "pdf_garantia",
      name: "Garantia.pdf",
      mimeType: "application/pdf",
      modifiedTime: "2026-08-03T10:00:00.000Z",
      size: "2048",
    },
  ],
};

const CONTENIDO: Record<string, string> = {
  doc_envios: "# Condiciones de envío\n\n## Gastos\n\nGratis por encima de 50 euros.",
  hoja_tarifas: "Destino,Plazo\nPenínsula,24-48 h",
  pdf_garantia: "%PDF-1.4 contenido binario simulado",
};

async function sincronizar(
  config: Record<string, unknown> = {},
  cursor: Record<string, unknown> = {},
): Promise<{
  documentos: DiscoveredDocument[];
  cursor: Record<string, unknown>;
  avisos: string[];
  saltados: number;
}> {
  const documentos: DiscoveredDocument[] = [];
  const resultado = await driveConnector.sync(
    { credentials: credenciales(), baseUrl, ...config },
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

describe("conector de Google Drive", () => {
  before(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "";
      peticiones.push(url);

      // Endpoint de token (JWT → access_token).
      if (req.method === "POST" && url === "/token") {
        tokensPedidos++;
        let cuerpo = "";
        req.on("data", (c) => (cuerpo += c));
        req.on("end", () => {
          const params = new URLSearchParams(cuerpo);
          // Se comprueba que llega una aserción firmada, no cualquier cosa.
          const assertion = params.get("assertion") ?? "";
          if (assertion.split(".").length !== 3) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "ya29.token", expires_in: 3600 }));
        });
        return;
      }

      if (req.headers["authorization"] !== "Bearer ya29.token") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "sin token" }));
        return;
      }

      if (url.startsWith("/files?")) {
        const q = new URL(url, "http://x").searchParams.get("q") ?? "";
        const padre = /'([^']+)' in parents/.exec(q)?.[1];
        const ficheros = listaVacia ? [] : (FICHEROS[padre ?? "raiz"] ?? []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ files: ficheros }));
        return;
      }

      const exportar = /^\/files\/([^/?]+)\/export/.exec(url);
      if (exportar?.[1] !== undefined) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(CONTENIDO[exportar[1]] ?? "");
        return;
      }

      const descargar = /^\/files\/([^/?]+)\?/.exec(url);
      if (descargar?.[1] !== undefined) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(CONTENIDO[descargar[1]] ?? "");
        return;
      }

      res.writeHead(404);
      res.end("{}");
    });

    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    tokenUri = `${baseUrl}/token`;
  });

  after(async () => {
    if (server !== undefined) await new Promise<void>((r) => server?.close(() => r()));
  });

  // -------------------------------------------------------------------------
  // Credenciales
  // -------------------------------------------------------------------------

  test("sin credenciales el error dice qué hacer, incluido compartir la carpeta", () => {
    assert.throws(
      () => driveConnector.validateConfig({}),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.message.includes("cuenta de servicio") &&
        // Es la primera causa de "no funciona", igual que en Notion.
        error.message.includes("COMPARTE"),
    );
  });

  test("un JSON que no es de cuenta de servicio se distingue", () => {
    assert.throws(
      () => parseServiceAccount(JSON.stringify({ client_id: "x", client_secret: "y" })),
      (error: unknown) =>
        error instanceof ConnectorError && error.message.includes("client_email"),
    );
    assert.throws(() => parseServiceAccount("no es json"), ConnectorError);
  });

  test("los saltos de línea escapados de la clave se restauran", () => {
    // Al pegar el JSON en un formulario, la clave suele llegar con `\\n`
    // literales. Sin esto la firma falla con un error de OpenSSL que no dice
    // nada de lo que pasó.
    const conEscapes = JSON.stringify({
      client_email: "a@b.iam.gserviceaccount.com",
      private_key: privateKey.replace(/\n/g, "\\n"),
    }).replace(/\\\\n/g, "\\\\n");

    const cuenta = parseServiceAccount(conEscapes);
    assert.ok(cuenta.private_key.includes("\n"), "la clave debe tener saltos reales");
  });

  test("las credenciales son campo secreto", () => {
    assert.deepEqual(driveConnector.secretFields, ["credentials"]);
  });

  test("un id de carpeta con comillas se rechaza", () => {
    // Los ids se interpolan en la consulta de Drive, que es un lenguaje propio.
    assert.throws(
      () =>
        driveConnector.validateConfig({
          credentials: credenciales(),
          folderIds: ["abc' or '1'='1"],
        }),
      ConnectorError,
    );
  });

  // -------------------------------------------------------------------------
  // La aserción firmada
  // -------------------------------------------------------------------------

  test("el JWT pide solo lectura y caduca en una hora", () => {
    const cuenta = parseServiceAccount(credenciales());
    const assertion = buildAssertion(cuenta, "https://www.googleapis.com/auth/drive.readonly", 1_000);

    const [, payload] = assertion.split(".");
    const claims = JSON.parse(Buffer.from(payload as string, "base64url").toString("utf8"));

    assert.equal(claims.iss, "indexador@acme-123.iam.gserviceaccount.com");
    assert.match(claims.scope, /drive\.readonly$/, "un conector no necesita escribir");
    assert.equal(claims.aud, tokenUri);
    assert.equal(
      claims.exp - claims.iat,
      3600,
      "una hora es el techo de Google: pedir más devuelve invalid_grant",
    );
  });

  // -------------------------------------------------------------------------
  // Qué se hace con cada tipo
  // -------------------------------------------------------------------------

  test("los nativos de Google se exportan; los ofimáticos se descargan tal cual", () => {
    assert.deepEqual(
      planFor({ mimeType: "application/vnd.google-apps.document", name: "d" }),
      // Markdown y no texto plano: conserva los encabezados, que es el listón.
      { export: true, mimeType: "text/markdown" },
    );
    assert.deepEqual(
      planFor({ mimeType: "application/vnd.google-apps.spreadsheet", name: "h" }),
      { export: true, mimeType: "text/csv" },
    );
    assert.deepEqual(
      planFor({ mimeType: "application/pdf", name: "p.pdf" }),
      // Se descarga sin convertir: el conversor de PDF ya existe y está probado.
      { export: false, mimeType: "application/pdf" },
    );
  });

  test("lo que no tiene texto se ignora sin ruido", () => {
    assert.equal(planFor({ mimeType: "image/png", name: "logo.png" }), undefined);
    assert.equal(planFor({ mimeType: "video/mp4", name: "v.mp4" }), undefined);
    assert.equal(
      planFor({ mimeType: "application/vnd.google-apps.form", name: "f" }),
      undefined,
      "un formulario no tiene texto que exportar de forma útil",
    );
  });

  // -------------------------------------------------------------------------
  // Sincronización
  // -------------------------------------------------------------------------

  test("exporta documentos y hojas, y descarga los PDF", async () => {
    const { documentos } = await sincronizar();
    const porId = new Map(documentos.map((d) => [d.externalId, d]));

    assert.match(
      porId.get("doc_envios")?.bytes.toString("utf8") ?? "",
      /^# Condiciones de envío/,
      "exportar a markdown conserva los encabezados",
    );
    assert.equal(porId.get("hoja_tarifas")?.mimeType, "text/csv");
    assert.equal(porId.get("pdf_garantia")?.mimeType, "application/pdf");
  });

  test("recorre las subcarpetas: Drive no busca en profundidad", async () => {
    const { documentos } = await sincronizar();

    assert.ok(
      documentos.some((d) => d.externalId === "pdf_garantia"),
      "el PDF está dentro de una subcarpeta; sin recorrerla se pierde",
    );
  });

  test("las imágenes y los formularios no se indexan ni llenan de avisos", async () => {
    const { documentos, avisos } = await sincronizar();

    assert.ok(!documentos.some((d) => d.externalId === "foto"));
    assert.ok(!documentos.some((d) => d.externalId === "formulario"));
    assert.ok(
      !avisos.some((a) => a.includes("logo.png")),
      "una carpeta normal tiene cientos de imágenes: avisar de cada una sería ruido",
    );
  });

  test("la cita apunta al enlace de Drive", async () => {
    const { documentos } = await sincronizar();
    assert.equal(
      documentos.find((d) => d.externalId === "doc_envios")?.sourceRef,
      "https://docs.google.com/document/d/doc_envios/edit",
    );
  });

  test("el token se reutiliza en vez de pedirse en cada llamada", async () => {
    tokensPedidos = 0;
    await sincronizar();

    assert.equal(
      tokensPedidos,
      1,
      "el token dura una hora y una sincronización son muchas peticiones: " +
        "pedirlo cada vez duplicaría el tráfico contra Google para nada",
    );
  });

  // -------------------------------------------------------------------------
  // Lo incremental
  // -------------------------------------------------------------------------

  test("lo no modificado no se vuelve a descargar", async () => {
    const primera = await sincronizar();
    assert.ok(primera.documentos.length > 0);

    peticiones = [];
    const segunda = await sincronizar({}, primera.cursor);

    assert.equal(segunda.documentos.length, 0);
    assert.ok(segunda.saltados > 0);
    assert.ok(
      !peticiones.some((p) => p.includes("/files/pdf_garantia")),
      "en Drive esto pesa más que en Notion: un PDF de veinte megas se " +
        "descargaría entero para nada",
    );
  });

  test("un fichero modificado sí se vuelve a traer", async () => {
    const primera = await sincronizar();
    const cursor = primera.cursor as { seen: Record<string, string> };
    cursor.seen["doc_envios"] = "2020-01-01T00:00:00.000Z";

    const segunda = await sincronizar({}, cursor);
    assert.ok(segunda.documentos.some((d) => d.externalId === "doc_envios"));
  });

  // -------------------------------------------------------------------------
  // El caso que genera los tickets
  // -------------------------------------------------------------------------

  test("si no le han compartido nada, el aviso trae el correo al que compartir", async () => {
    listaVacia = true;
    try {
      const { documentos, avisos } = await sincronizar();

      assert.equal(documentos.length, 0);
      assert.ok(
        avisos.some((a) => a.includes("indexador@acme-123.iam.gserviceaccount.com")),
        "decir 'comparte la carpeta' sin decir CON QUIÉN obliga a ir a buscar " +
          "el correo al JSON de credenciales",
      );
    } finally {
      listaVacia = false;
    }
  });
});
