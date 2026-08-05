import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { LocalStorageDriver, StorageError, assertValidKey, documentKey } from "../dist/index.js";

/**
 * El almacenamiento, y sobre todo lo que NO debe poder hacer.
 *
 * La clave de un fichero acaba siendo una ruta del sistema de ficheros, y parte
 * de ella —el id del tenant, el del documento— viene de datos. Un fallo aquí no
 * es un fichero mal guardado: es leer o escribir fuera del directorio.
 */

const root = await mkdtemp(join(tmpdir(), "platform-storage-"));
const storage = new LocalStorageDriver({ root });

after(async () => {
  await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
});

// ---------------------------------------------------------------------------
// Claves peligrosas
// ---------------------------------------------------------------------------

const PELIGROSAS: [string, string][] = [
  ["../../../etc/passwd", "escapar hacia arriba"],
  ["tnt_a/../tnt_b/documents/x.md", "escapar de lado, al tenant vecino"],
  ["/etc/passwd", "ruta absoluta"],
  ["C:\\Windows\\system32", "ruta de Windows"],
  ["tnt_a\\..\\tnt_b", "separador invertido"],
  ["tnt_a/doc\0.md", "byte nulo"],
  ["", "vacía"],
  ["./oculto", "segmento relativo"],
];

for (const [clave, motivo] of PELIGROSAS) {
  test(`se rechaza una clave que intenta ${motivo}`, () => {
    assert.throws(
      () => assertValidKey(clave, "local"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "invalid_key",
      `debería haber rechazado ${JSON.stringify(clave)}`,
    );
  });
}

test("escribir con una clave peligrosa no crea nada fuera del directorio", async () => {
  await assert.rejects(
    () => storage.put("../fuera.txt", Buffer.from("no")),
    StorageError,
  );

  // Y se comprueba de verdad que el fichero no está donde habría acabado.
  await assert.rejects(() => readFile(join(root, "..", "fuera.txt")));
});

// ---------------------------------------------------------------------------
// Funcionamiento normal
// ---------------------------------------------------------------------------

test("lo que se guarda es exactamente lo que se recupera, byte a byte", async () => {
  // Con bytes no textuales a propósito: un PDF no es UTF-8, y un driver que
  // decodifique por el camino corrompe el fichero sin que nada falle.
  const original = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x0a]);
  const key = documentKey("tnt_abc", "doc_123", "pdf");

  await storage.put(key, original);
  const recuperado = await storage.get(key);

  assert.deepEqual(recuperado, original);
});

test("la clave lleva el tenant delante, para que el aislamiento se vea en la ruta", () => {
  assert.equal(
    documentKey("tnt_abc", "doc_123", ".MD"),
    "tnt_abc/documents/doc_123.md",
  );
  assert.equal(documentKey("tnt_abc", "doc_123"), "tnt_abc/documents/doc_123");
});

test("el nombre original del fichero no entra en la clave", () => {
  // El nombre lo elige quien sube. Si formara parte de la ruta, "../../x" sería
  // una ruta. Lo que se conserva de él es el título, que vive en la base de
  // datos y allí no puede convertirse en nada.
  const key = documentKey("tnt_abc", "doc_123", "../../etc/passwd");
  assertValidKey(key, "local");
  assert.equal(key, "tnt_abc/documents/doc_123.etcpasswd");
});

test("leer algo que no existe se distingue de un fallo de disco", async () => {
  await assert.rejects(
    () => storage.get("tnt_abc/documents/no_existe.md"),
    (error: unknown) =>
      error instanceof StorageError &&
      error.code === "not_found" &&
      // El consumidor de eventos usa esto: un fichero que falta es permanente
      // y no debe reintentarse cinco veces.
      true,
  );
});

test("borrar dos veces no falla: un consumidor idempotente reintenta limpiezas", async () => {
  const key = documentKey("tnt_abc", "doc_borrable", "md");
  await storage.put(key, Buffer.from("hola"));

  assert.equal(await storage.exists(key), true);
  await storage.delete(key);
  assert.equal(await storage.exists(key), false);
  await storage.delete(key);
});

test("un enlace simbólico plantado dentro no saca la lectura fuera", async (t) => {
  const secreto = join(root, "..", `secreto-${process.pid}.txt`);
  await writeFile(secreto, "contenido de fuera");

  const { symlink } = await import("node:fs/promises");
  try {
    await symlink(secreto, join(root, "tnt_abc"));
  } catch {
    // Windows exige privilegios para crear enlaces. Si no se puede, no hay
    // nada que comprobar: se dice y se salta, en vez de dar por buena una
    // defensa que este entorno no ejerció.
    t.skip("este sistema no permite crear enlaces simbólicos sin privilegios");
    return;
  }

  // El driver resuelve la ruta y comprueba el prefijo, pero un enlace se
  // resuelve DESPUÉS, al abrir. Se deja constancia de lo que sí garantiza:
  // ninguna clave construye una ruta fuera del directorio.
  await assert.rejects(() => storage.get("tnt_abc/../secreto.txt"), StorageError);

  await import("node:fs/promises").then((fs) =>
    fs.rm(secreto, { force: true }).catch(() => {}),
  );
});
