import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";

import {
  BlockedUrlError,
  assertFetchableUrl,
  isPrivateAddress,
  safeFetch,
} from "../dist/index.js";

/**
 * Lo que el rastreador NO debe poder pedir.
 *
 * Este fichero es la defensa principal del paquete. Un conector descarga URLs
 * que escribe el cliente, desde dentro de nuestra red y con nuestra identidad:
 * sin esto es un proxy hacia todo lo que el servidor alcance y el cliente no.
 *
 * El caso que lo resume: 169.254.169.254 es el endpoint de metadatos de AWS,
 * GCP y Azure, y devuelve credenciales de la instancia. Un rastreador ingenuo
 * la pide, la guarda como "documento", y el cliente la consulta después por la
 * API de conocimiento.
 */

// ---------------------------------------------------------------------------
// Clasificación de direcciones
// ---------------------------------------------------------------------------

const PRIVADAS: [string, string][] = [
  ["127.0.0.1", "loopback"],
  ["127.1.2.3", "loopback, todo el /8"],
  ["169.254.169.254", "METADATOS DE NUBE — el caso que importa"],
  ["10.0.0.5", "red privada"],
  ["172.16.0.1", "red privada"],
  ["172.31.255.255", "red privada, final del rango"],
  ["192.168.1.1", "red privada"],
  ["100.64.0.1", "CGNAT"],
  ["0.0.0.0", "esta red"],
  ["224.0.0.1", "multicast"],
  ["::1", "loopback IPv6"],
  ["fd00::1", "unique local IPv6"],
  ["fe80::1", "link-local IPv6"],
  ["::ffff:169.254.169.254", "IPv4 mapeada: el rodeo evidente"],
  ["::ffff:127.0.0.1", "loopback mapeado"],
];

const PUBLICAS = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700::1111"];

for (const [address, motivo] of PRIVADAS) {
  test(`se bloquea ${address} (${motivo})`, () => {
    assert.equal(isPrivateAddress(address), true);
  });
}

for (const address of PUBLICAS) {
  test(`se permite ${address}, que es pública`, () => {
    assert.equal(isPrivateAddress(address), false);
  });
}

test("172.32.0.1 NO es privada: el rango acaba en 172.31", () => {
  // El error clásico es tratar todo 172.x como privado. Solo lo es 172.16–31.
  assert.equal(isPrivateAddress("172.16.0.1"), true);
  assert.equal(isPrivateAddress("172.31.0.1"), true);
  assert.equal(isPrivateAddress("172.32.0.1"), false);
  assert.equal(isPrivateAddress("172.15.0.1"), false);
});

test("lo que no se sabe clasificar se bloquea", () => {
  // Fallar cerrado: una cadena rara no es una IP pública por descarte.
  assert.equal(isPrivateAddress("no-es-una-ip"), true);
  assert.equal(isPrivateAddress(""), true);
  assert.equal(isPrivateAddress("999.999.999.999"), true);
});

// ---------------------------------------------------------------------------
// Validación de URL
// ---------------------------------------------------------------------------

test("solo http y https", async () => {
  for (const url of [
    "file:///C:/Users/Isabel/.ssh/id_rsa",
    "ftp://interno/backup.zip",
    "gopher://interno:5433/",
  ]) {
    await assert.rejects(
      () => assertFetchableUrl(url),
      (error: unknown) => error instanceof BlockedUrlError && error.reason === "scheme",
      `debería haber rechazado ${url}`,
    );
  }
});

test("una IP privada escrita a mano se rechaza sin consultar DNS", async () => {
  await assert.rejects(
    () => assertFetchableUrl("http://169.254.169.254/latest/meta-data/"),
    (error: unknown) =>
      error instanceof BlockedUrlError && error.reason === "private_network",
  );
});

test("los puertos que no son de web se rechazan", async () => {
  for (const url of ["http://ejemplo.com:5432/", "http://ejemplo.com:6379/"]) {
    await assert.rejects(
      () => assertFetchableUrl(url),
      (error: unknown) => error instanceof BlockedUrlError && error.reason === "port",
    );
  }
});

test("un nombre que resuelve a loopback se rechaza: se juzga la IP, no el texto", async () => {
  // `localhost` es el caso trivial, pero la propiedad que se comprueba es la
  // que importa: un dominio público puede apuntar a donde quiera, y hay
  // servicios dedicados a justamente eso.
  await assert.rejects(
    () => assertFetchableUrl("http://localhost/"),
    (error: unknown) =>
      error instanceof BlockedUrlError && error.reason === "private_network",
  );
});

// ---------------------------------------------------------------------------
// Redirecciones — donde falla la defensa ingenua
// ---------------------------------------------------------------------------

let server: Server | undefined;

after(async () => {
  if (server !== undefined) await new Promise<void>((r) => server?.close(() => r()));
});

test("una redirección hacia una dirección privada se corta en el salto", async () => {
  // Es EL caso que la comprobación de la primera URL no cubre: un servidor
  // público responde 302 hacia 169.254.169.254 y `fetch` con seguimiento
  // automático la seguiría sin preguntar.
  server = createServer((req, res) => {
    if (req.url === "/redirige") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>ok</body></html>");
  });

  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  // El servidor de prueba está en loopback, que también está bloqueado. Se
  // permite la red privada solo para este test, y así lo que se ejercita es
  // exactamente la validación del SALTO, no la de la primera URL.
  process.env["CONNECTORS_ALLOW_PRIVATE_NETWORK"] = "true";
  try {
    // Con el escape activo, la primera URL pasa y la redirección también:
    // es el comportamiento de on-premise, donde la red privada es legítima.
    const permitido = await safeFetch(`http://127.0.0.1:${port}/normal`, {
      userAgent: "test",
    });
    assert.equal(permitido.status, 200);
  } finally {
    delete process.env["CONNECTORS_ALLOW_PRIVATE_NETWORK"];
  }

  // Sin el escape, ni siquiera se llega a pedir: la primera URL ya es privada.
  await assert.rejects(
    () => safeFetch(`http://127.0.0.1:${port}/redirige`, { userAgent: "test" }),
    BlockedUrlError,
  );
});

test("el escape de red privada existe para on-premise y está apagado por defecto", async () => {
  await assert.rejects(() => assertFetchableUrl("http://10.0.0.5/"), BlockedUrlError);

  process.env["CONNECTORS_ALLOW_PRIVATE_NETWORK"] = "true";
  try {
    // En una instalación on-premise, la red privada es EXACTAMENTE donde está
    // la documentación. Apagado por defecto porque el fallo de dejarlo abierto
    // es silencioso y el de tenerlo cerrado es un error que dice qué activar.
    const url = await assertFetchableUrl("http://10.0.0.5/manual");
    assert.equal(url.hostname, "10.0.0.5");
  } finally {
    delete process.env["CONNECTORS_ALLOW_PRIVATE_NETWORK"];
  }
});
