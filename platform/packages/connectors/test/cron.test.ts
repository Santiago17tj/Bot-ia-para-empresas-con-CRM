import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CronError,
  cronMatches,
  isValidCron,
  isValidTimeZone,
  minuteOf,
  parseCron,
} from "../dist/index.js";

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

test("sin zona se interpreta en UTC, no en la hora del servidor", () => {
  // La misma expresión tiene que significar lo mismo en el portátil, en CI y en
  // producción, y la hora del servidor depende de dónde se despliegue.
  const cron = parseCron("0 3 * * *");
  assert.equal(cronMatches(cron, new Date(Date.UTC(2026, 7, 6, 3, 0))), true);
  assert.equal(cronMatches(cron, new Date(Date.UTC(2026, 7, 6, 1, 0))), false);
});

// ---------------------------------------------------------------------------
// Zona horaria del tenant
// ---------------------------------------------------------------------------

test("`0 3 * * *` en Madrid son las 3 de la madrugada TODO el año", () => {
  // Este es el test que cierra la deuda. Antes, esa expresión se disparaba a
  // las 03:00 UTC — o sea a las 5:00 locales en verano y a las 4:00 en
  // invierno. Ahora se dispara cuando en Madrid son las tres, que es lo que
  // quiso decir quien la escribió.
  const cron = parseCron("0 3 * * *");

  // Verano: Madrid va en UTC+2, así que las 3 locales son las 01:00 UTC.
  assert.equal(cronMatches(cron, utc("2026-07-15T01:00"), "Europe/Madrid"), true);
  assert.equal(cronMatches(cron, utc("2026-07-15T03:00"), "Europe/Madrid"), false);

  // Invierno: UTC+1, las 3 locales son las 02:00 UTC.
  assert.equal(cronMatches(cron, utc("2026-01-15T02:00"), "Europe/Madrid"), true);
  assert.equal(cronMatches(cron, utc("2026-01-15T01:00"), "Europe/Madrid"), false);
});

test("la zona también mueve el día, no solo la hora", () => {
  // A las 23:30 UTC del lunes, en Madrid ya es martes. Un cron de los martes
  // tiene que casar, y uno de los lunes no — mirar solo la hora dejaría este
  // caso mal y solo se notaría una noche a la semana.
  const martes = parseCron("30 1 * * 2");
  const lunes = parseCron("30 1 * * 1");

  // 2026-07-13 es lunes. 23:30 UTC = 01:30 del martes en Madrid.
  assert.equal(cronMatches(martes, utc("2026-07-13T23:30"), "Europe/Madrid"), true);
  assert.equal(cronMatches(lunes, utc("2026-07-13T23:30"), "Europe/Madrid"), false);
});

test("medianoche local casa: la hora 24 no se cuela por 0", () => {
  // `hour12: false` devuelve "24" a medianoche en algunos entornos en vez de
  // "00". Sin normalizar, `0 0 * * *` no se dispararía NUNCA ahí, y el síntoma
  // —"el cron de medianoche no va"— no apunta a nada.
  const cron = parseCron("0 0 * * *");
  // 22:00 UTC en verano = medianoche en Madrid.
  assert.equal(cronMatches(cron, utc("2026-07-15T22:00"), "Europe/Madrid"), true);
});

test("una zona al otro lado del meridiano también funciona", () => {
  // Bogotá es UTC-5 todo el año: sin horario de verano, que es el caso de la
  // mitad del mercado hispanohablante.
  const cron = parseCron("0 3 * * *");
  assert.equal(cronMatches(cron, utc("2026-07-15T08:00"), "America/Bogota"), true);
});

test("una zona desconocida se detecta, no se traga", () => {
  assert.equal(isValidTimeZone("Europe/Madrid"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  // El error real que comete la gente. Aceptarlo no da ningún error: da un
  // horario equivocado, que es peor porque nadie lo mira.
  assert.equal(isValidTimeZone("Europe/Madird"), false);
});

// ---------------------------------------------------------------------------
// Los dos bordes del horario de verano
// ---------------------------------------------------------------------------

test("en el salto de primavera, la hora que no existe no se dispara", () => {
  // El 29 de marzo de 2026, Madrid pasa de las 02:00 a las 03:00. Las 02:30
  // locales NO EXISTEN ese día, así que un `30 2 * * *` se salta esa noche.
  //
  // Es aceptable AQUÍ y conviene decir por qué: esto sincroniza contenido, y
  // saltarse una noche significa que la web del cliente se indexa un día
  // después. En un cron de facturación no sería aceptable, y quien añada el
  // segundo caso de uso de cron tiene que releer esto.
  const cron = parseCron("30 2 * * *");
  const minutos = Array.from({ length: 240 }, (_, i) =>
    new Date(Date.UTC(2026, 2, 29, 0, 0) + i * 60_000),
  );

  const disparos = minutos.filter((m) => cronMatches(cron, m, "Europe/Madrid"));
  assert.equal(disparos.length, 0, "las 02:30 no existen ese día");
});

test("en el salto de otoño, la hora repetida casa dos veces", () => {
  // El 25 de octubre de 2026, Madrid repite la hora de 02:00 a 03:00, así que
  // las 02:30 locales ocurren DOS veces: a las 00:30 y a las 01:30 UTC.
  //
  // También es aceptable aquí, y por un motivo concreto del sistema: el cursor
  // del conector guarda el hash por URL, así que la segunda pasada no vuelve a
  // pagar troceado ni embeddings de lo que no cambió. Repetir sale casi gratis.
  // En un cron que cobrara o enviara correos, no.
  const cron = parseCron("30 2 * * *");
  const minutos = Array.from({ length: 240 }, (_, i) =>
    new Date(Date.UTC(2026, 9, 25, 0, 0) + i * 60_000),
  );

  const disparos = minutos.filter((m) => cronMatches(cron, m, "Europe/Madrid"));
  assert.equal(disparos.length, 2);
  assert.equal(disparos[0]?.toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(disparos[1]?.toISOString(), "2026-10-25T01:30:00.000Z");
});
