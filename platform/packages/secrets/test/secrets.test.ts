import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import {
  REDACTED,
  SecretsError,
  decryptConfigSecrets,
  decryptSecret,
  encryptConfigSecrets,
  encryptSecret,
  isEncrypted,
  redactSecrets,
  secretsReady,
} from "../dist/index.js";

/**
 * El cifrado de secretos, y sobre todo lo que tiene que FALLAR.
 *
 * Un cifrado que funciona es fácil de comprobar; lo que distingue una capa de
 * secretos usable de una decorativa es qué hace cuando algo va mal.
 */

const CLAVE_A = randomBytes(32).toString("base64");
const CLAVE_B = randomBytes(32).toString("base64");

const ACME = { tenantId: "tnt_acme", purpose: "source.config.authToken" };
const RIVAL = { tenantId: "tnt_rival", purpose: "source.config.authToken" };

beforeEach(() => {
  process.env["SECRETS_ENCRYPTION_KEY"] = CLAVE_A;
  delete process.env["SECRETS_ENCRYPTION_KEYS_OLD"];
});

afterEach(() => {
  delete process.env["SECRETS_ENCRYPTION_KEY"];
  delete process.env["SECRETS_ENCRYPTION_KEYS_OLD"];
});

// ---------------------------------------------------------------------------
// Lo básico
// ---------------------------------------------------------------------------

test("lo que se cifra se recupera igual", () => {
  const secreto = "ntn_4f8Xk2LmQpR7vZ9wY3bN6cH1jS5tG0dA";
  const sobre = encryptSecret(secreto, ACME);

  assert.notEqual(sobre, secreto);
  assert.ok(isEncrypted(sobre));
  assert.equal(decryptSecret(sobre, ACME), secreto);
});

test("el texto cifrado no contiene el secreto ni un trozo", () => {
  const secreto = "contraseña-supersecreta-del-cliente";
  const sobre = encryptSecret(secreto, ACME);

  assert.ok(!sobre.includes(secreto));
  assert.ok(!sobre.includes("supersecreta"));
});

test("cifrar dos veces el mismo texto da resultados distintos", () => {
  // Si el IV se reutilizara, dos tokens iguales darían el mismo texto cifrado y
  // se podría saber que dos clientes usan la misma credencial sin descifrar
  // nada. Y con GCM, repetir IV con la misma clave rompe el cifrado entero.
  const a = encryptSecret("mismo-token", ACME);
  const b = encryptSecret("mismo-token", ACME);

  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, ACME), decryptSecret(b, ACME));
});

test("soporta acentos y emoji sin corromperlos", () => {
  const secreto = "contraseña-ñandú-€-🔐";
  assert.equal(decryptSecret(encryptSecret(secreto, ACME), ACME), secreto);
});

// ---------------------------------------------------------------------------
// Lo que tiene que fallar
// ---------------------------------------------------------------------------

test("el secreto de un tenant NO descifra en otro", () => {
  // Es el ataque de intercambio de textos cifrados: copiar el valor cifrado de
  // la fila de un cliente a la de otro. Sin datos autenticados asociados
  // funcionaría — el texto cifrado es válido y descifraría perfectamente.
  const sobre = encryptSecret("token-de-acme", ACME);

  assert.throws(
    () => decryptSecret(sobre, RIVAL),
    (error: unknown) => error instanceof SecretsError && error.code === "tampered",
    "FUGA: el token de un cliente se puede leer desde otro tenant",
  );
});

test("un secreto no descifra en otro campo del mismo tenant", () => {
  const sobre = encryptSecret("token-de-solo-lectura", ACME);

  assert.throws(
    () =>
      decryptSecret(sobre, { tenantId: ACME.tenantId, purpose: "source.config.adminToken" }),
    SecretsError,
    "mover un token de lectura al campo del de escritura no debe funcionar",
  );
});

test("un texto cifrado alterado FALLA, no devuelve basura", () => {
  const sobre = encryptSecret("token-original", ACME);
  const partes = sobre.split(".");

  // Se cambia un byte del texto cifrado. Sin autenticación, el descifrado
  // devolvería bytes distintos y el sistema los usaría como si fueran el token.
  const ct = Buffer.from(partes[4] as string, "base64url");
  ct[0] = (ct[0] ?? 0) ^ 0xff;
  partes[4] = ct.toString("base64url");

  assert.throws(
    () => decryptSecret(partes.join("."), ACME),
    (error: unknown) => error instanceof SecretsError && error.code === "tampered",
  );
});

test("una etiqueta de autenticación alterada también falla", () => {
  const sobre = encryptSecret("token-original", ACME);
  const partes = sobre.split(".");
  partes[5] = Buffer.from(randomBytes(16)).toString("base64url");

  assert.throws(() => decryptSecret(partes.join("."), ACME), SecretsError);
});

test("con otra clave no se descifra: falla por clave desconocida", () => {
  const sobre = encryptSecret("token", ACME);

  process.env["SECRETS_ENCRYPTION_KEY"] = CLAVE_B;
  assert.throws(
    () => decryptSecret(sobre, ACME),
    (error: unknown) => error instanceof SecretsError && error.code === "unknown_key",
  );
});

test("sin clave configurada NO se guarda nada en claro: se lanza", () => {
  delete process.env["SECRETS_ENCRYPTION_KEY"];

  assert.equal(secretsReady(), false);
  assert.throws(
    () => encryptSecret("token", ACME),
    (error: unknown) =>
      error instanceof SecretsError &&
      error.code === "no_key" &&
      error.message.includes("openssl rand -base64 32"),
    "guardarlo en claro sería peor que no guardarlo, y el error debe decir qué hacer",
  );
});

test("una clave que no mide 32 bytes se rechaza al usarla", () => {
  process.env["SECRETS_ENCRYPTION_KEY"] = Buffer.from("corta").toString("base64");

  assert.throws(
    () => encryptSecret("token", ACME),
    (error: unknown) => error instanceof SecretsError && error.code === "bad_key",
  );
});

// ---------------------------------------------------------------------------
// Rotación
// ---------------------------------------------------------------------------

test("tras rotar, lo viejo se sigue leyendo y lo nuevo usa la clave nueva", () => {
  const viejo = encryptSecret("token-de-antes", ACME);

  // Rotación: la nueva pasa a ser la actual, la anterior queda en el llavero.
  process.env["SECRETS_ENCRYPTION_KEY"] = CLAVE_B;
  process.env["SECRETS_ENCRYPTION_KEYS_OLD"] = CLAVE_A;

  assert.equal(
    decryptSecret(viejo, ACME),
    "token-de-antes",
    "sin llavero, rotar obliga a re-cifrar toda la base en una transacción o a " +
      "perder el acceso a lo anterior",
  );

  const nuevo = encryptSecret("token-de-ahora", ACME);
  assert.notEqual(
    nuevo.split(".")[2],
    viejo.split(".")[2],
    "lo nuevo debe cifrarse con la clave nueva, o rotar no sirve de nada",
  );
});

// ---------------------------------------------------------------------------
// Configuraciones: cifrar, redactar, conservar
// ---------------------------------------------------------------------------

const CAMPOS = ["authToken"] as const;
const CTX = { tenantId: "tnt_acme", purposePrefix: "source.config" };

test("el secreto NUNCA sale de la API, ni cifrado", () => {
  // Cifrar no basta: publicar un texto cifrado es publicar algo que solo depende
  // de una clave, y las claves se filtran.
  const guardado = encryptConfigSecrets(
    { startUrls: ["https://acme.example"], authToken: "secreto-real" },
    {},
    CAMPOS,
    CTX,
  );

  const publico = redactSecrets(guardado, CAMPOS);

  assert.equal(publico["authToken"], REDACTED);
  assert.ok(!JSON.stringify(publico).includes("secreto-real"));
  assert.ok(!JSON.stringify(publico).includes("enc.v1."));
  // Lo que NO es secreto sí sale: quien configura la integración lo necesita.
  assert.deepEqual(publico["startUrls"], ["https://acme.example"]);
});

test("se distingue «hay secreto» de «no hay»", () => {
  // Es información legítima: quien configura necesita saber si ya puso el token.
  const sin = redactSecrets({ startUrls: [] }, CAMPOS);
  assert.equal(sin["authToken"], undefined);
});

test("actualizar el resto de la configuración conserva el token", () => {
  const antes = encryptConfigSecrets(
    { startUrls: ["https://a.example"], authToken: "token-bueno" },
    {},
    CAMPOS,
    CTX,
  );

  // El cliente lee la configuración (redactada), cambia una URL y la devuelve.
  const devuelto = { ...redactSecrets(antes, CAMPOS), startUrls: ["https://b.example"] };
  const despues = encryptConfigSecrets(devuelto, antes, CAMPOS, CTX);

  assert.equal(
    decryptConfigSecrets(despues, CAMPOS, CTX)["authToken"],
    "token-bueno",
    'sin esto, el cliente guardaría la palabra "«secreto guardado»" como su credencial',
  );
});

test("un valor nuevo reemplaza al anterior, y null lo borra", () => {
  const antes = encryptConfigSecrets({ authToken: "viejo" }, {}, CAMPOS, CTX);

  const cambiado = encryptConfigSecrets({ authToken: "nuevo" }, antes, CAMPOS, CTX);
  assert.equal(decryptConfigSecrets(cambiado, CAMPOS, CTX)["authToken"], "nuevo");

  const borrado = encryptConfigSecrets({ authToken: null }, antes, CAMPOS, CTX);
  assert.equal(borrado["authToken"], undefined);
});

test("no se cifra dos veces lo que ya está cifrado", () => {
  const antes = encryptConfigSecrets({ authToken: "token" }, {}, CAMPOS, CTX);
  const otra = encryptConfigSecrets(antes, antes, CAMPOS, CTX);

  assert.equal(decryptConfigSecrets(otra, CAMPOS, CTX)["authToken"], "token");
});
