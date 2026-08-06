import assert from "node:assert/strict";
import { test } from "node:test";

import { CronError, cronMatches, isValidCron, minuteOf, parseCron } from "../dist/index.js";

/**
 * Cron, y sobre todo la parte que se hace mal.
 *
 * Un planificador que no se dispara cuando debe es un fallo silencioso: nadie
 * ve un error, simplemente el conocimiento del cliente deja de actualizarse y
 * se descubre semanas después.
 */

const utc = (iso: string): Date => new Date(`${iso}Z`);

// ---------------------------------------------------------------------------
// Coincidencia básica
// ---------------------------------------------------------------------------

test("casa el minuto exacto y solo ese", () => {
  const cron = parseCron("30 14 * * *");

  assert.equal(cronMatches(cron, utc("2026-08-06T14:30:00")), true);
  assert.equal(cronMatches(cron, utc("2026-08-06T14:29:00")), false);
  assert.equal(cronMatches(cron, utc("2026-08-06T15:30:00")), false);
});

test("los segundos no importan: la unidad es el minuto", () => {
  const cron = parseCron("30 14 * * *");
  assert.equal(cronMatches(cron, utc("2026-08-06T14:30:59")), true);
});

test("listas, rangos y pasos", () => {
  assert.equal(cronMatches(parseCron("0,30 * * * *"), utc("2026-08-06T10:30:00")), true);
  assert.equal(cronMatches(parseCron("0,30 * * * *"), utc("2026-08-06T10:15:00")), false);

  assert.equal(cronMatches(parseCron("0 9-17 * * *"), utc("2026-08-06T13:00:00")), true);
  assert.equal(cronMatches(parseCron("0 9-17 * * *"), utc("2026-08-06T18:00:00")), false);

  assert.equal(cronMatches(parseCron("*/15 * * * *"), utc("2026-08-06T10:45:00")), true);
  assert.equal(cronMatches(parseCron("*/15 * * * *"), utc("2026-08-06T10:46:00")), false);
});

test("los atajos son más difíciles de equivocar que la expresión", () => {
  assert.equal(cronMatches(parseCron("@daily"), utc("2026-08-06T00:00:00")), true);
  assert.equal(cronMatches(parseCron("@daily"), utc("2026-08-06T01:00:00")), false);
  assert.equal(cronMatches(parseCron("@hourly"), utc("2026-08-06T07:00:00")), true);
});

test("domingo se puede escribir 0 o 7", () => {
  // Quien viene de otro sistema escribe 7 y su tarea no correría nunca.
  const domingo = utc("2026-08-09T00:00:00");
  assert.equal(new Date(domingo).getUTCDay(), 0, "el 9 de agosto de 2026 es domingo");

  assert.equal(cronMatches(parseCron("0 0 * * 0"), domingo), true);
  assert.equal(cronMatches(parseCron("0 0 * * 7"), domingo), true);
});

// ---------------------------------------------------------------------------
// La trampa: día del mes contra día de la semana
// ---------------------------------------------------------------------------

test("con AMBOS restringidos, la regla es O y no Y", () => {
  // Está en el POSIX y es contraintuitivo: `0 0 1 * 1` significa "el día 1 Y
  // ADEMÁS todos los lunes", no "los lunes que caigan en día 1". Implementarlo
  // como Y hace que una expresión válida no se dispare casi nunca.
  const cron = parseCron("0 0 1 * 1");

  const dia1NoLunes = utc("2026-08-01T00:00:00");
  assert.notEqual(dia1NoLunes.getUTCDay(), 1);
  assert.equal(cronMatches(cron, dia1NoLunes), true, "el día 1 basta");

  const lunesNoDia1 = utc("2026-08-10T00:00:00");
  assert.equal(lunesNoDia1.getUTCDay(), 1);
  assert.equal(cronMatches(cron, lunesNoDia1), true, "ser lunes basta");

  const niUnoNiOtro = utc("2026-08-11T00:00:00");
  assert.equal(cronMatches(cron, niUnoNiOtro), false);
});

test("con solo UNO restringido, ese manda", () => {
  const soloDia = parseCron("0 0 15 * *");
  assert.equal(cronMatches(soloDia, utc("2026-08-15T00:00:00")), true);
  assert.equal(cronMatches(soloDia, utc("2026-08-16T00:00:00")), false);

  const soloSemana = parseCron("0 0 * * 1");
  assert.equal(cronMatches(soloSemana, utc("2026-08-10T00:00:00")), true);
  assert.equal(cronMatches(soloSemana, utc("2026-08-11T00:00:00")), false);
});

test("`*/2` restringe aunque empiece por asterisco", () => {
  // Sutil: si `*/2` contara como "sin restringir", la regla del O se aplicaría
  // donde no toca y la expresión casaría de más.
  const cron = parseCron("0 0 */2 * 1");

  const lunes = utc("2026-08-10T00:00:00");
  assert.equal(lunes.getUTCDay(), 1);
  assert.equal(lunes.getUTCDate(), 10);
  // Día 10 no está en 1,3,5,7,9,11... pero es lunes, y con los dos
  // restringidos basta uno.
  assert.equal(cronMatches(cron, lunes), true);
});

// ---------------------------------------------------------------------------
// Expresiones inválidas
// ---------------------------------------------------------------------------

const INVALIDAS = [
  ["", "vacía"],
  ["* * * *", "cuatro campos"],
  ["* * * * * *", "seis campos"],
  ["60 * * * *", "minuto 60"],
  ["* 24 * * *", "hora 24"],
  ["* * 0 * *", "día 0"],
  ["* * 32 * *", "día 32"],
  ["* * * 13 *", "mes 13"],
  ["cada-hora * * * *", "texto"],
  ["*/0 * * * *", "paso cero"],
  ["30-10 * * * *", "rango invertido"],
];

for (const [expression, motivo] of INVALIDAS) {
  test(`se rechaza "${expression}" (${motivo})`, () => {
    assert.throws(() => parseCron(expression), CronError);
    assert.equal(isValidCron(expression), false);
  });
}

test("el error dice qué se esperaba, no solo que está mal", () => {
  assert.throws(
    () => parseCron("* * * *"),
    (error: unknown) =>
      error instanceof CronError &&
      error.message.includes("5 campos") &&
      error.message.includes("@daily"),
  );
});

// ---------------------------------------------------------------------------
// Todo en UTC
// ---------------------------------------------------------------------------

test("minuteOf recorta segundos y milisegundos", () => {
  assert.equal(
    minuteOf(utc("2026-08-06T14:30:47.123")).toISOString(),
    "2026-08-06T14:30:00.000Z",
  );
});

test("se interpreta en UTC, no en la hora del servidor", () => {
  // La misma expresión tiene que significar lo mismo en el portátil, en CI y en
  // producción. La consecuencia está documentada: una PYME española que escriba
  // `0 3 * * *` sincroniza a las 4:00 hora local en verano.
  const cron = parseCron("0 3 * * *");
  assert.equal(cronMatches(cron, new Date(Date.UTC(2026, 7, 6, 3, 0))), true);
  assert.equal(cronMatches(cron, new Date(Date.UTC(2026, 7, 6, 1, 0))), false);
});
