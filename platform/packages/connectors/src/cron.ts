/**
 * Expresiones cron para la sincronización de fuentes.
 *
 * Vive aquí porque `KnowledgeSource.syncSchedule` es su único caso. El día que
 * haya un segundo —informes programados, limpiezas— se promueve a paquete
 * propio; hoy sería una carpeta con un fichero.
 *
 * **Se resuelve "¿casa este minuto?", no "¿cuándo toca la próxima vez?".** Es
 * lo único que necesita un planificador que ya está sondeando, y evita traer
 * una librería cuyo valor principal —iterar ejecuciones futuras— no se usa. El
 * cálculo de la próxima ejecución es la parte difícil de cron; la coincidencia
 * es una comparación de cinco campos.
 *
 * **Se interpreta en la zona del TENANT, nunca en la del servidor.** Son cosas
 * distintas y la diferencia importa: la zona del servidor depende de dónde se
 * despliegue, así que la misma expresión significaría una cosa en el portátil y
 * otra en producción. La del tenant es un dato del negocio, viaja con él y no
 * cambia al mover el despliegue. Por defecto `UTC`, que es lo que había antes y
 * sigue siendo la respuesta correcta cuando nadie ha dicho otra cosa.
 *
 * Antes se interpretaba todo en UTC sin más, y la consecuencia era que una PYME
 * española que escribía `0 3 * * *` esperando las tres de la madrugada tenía su
 * sincronización a las 4:00 en verano.
 */

export class CronError extends Error {
  override readonly name = "CronError";
}

interface CronField {
  /** Valores permitidos. */
  values: Set<number>;
  /** `*` sin restringir. Importa para la regla de día del mes / día de semana. */
  unrestricted: boolean;
}

export interface CronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  source: string;
}

const RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  // Hasta 7 y no 6: domingo se escribe 0 y también 7, según de dónde venga
  // quien lo escribe. El 7 se normaliza a 0 al final. Rechazarlo produce una
  // expresión perfectamente razonable que no se ejecuta nunca.
  dayOfWeek: [0, 7],
} as const;

/**
 * Atajos habituales.
 *
 * `@hourly` y `@daily` cubren casi todo lo que un cliente va a querer, y
 * escribirlos así es mucho más difícil de equivocar que `0 * * * *`.
 */
const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

/**
 * Compila la expresión. Lanza si no es válida.
 *
 * Se valida al CREAR la fuente, no al ejecutarla: una expresión mal escrita que
 * se acepta produce una fuente que nunca sincroniza y nadie sabe por qué, y el
 * síntoma —"mi web no se actualiza"— aparece días después.
 */
export function parseCron(raw: string): CronExpression {
  const normalized = (ALIASES[raw.trim().toLowerCase()] ?? raw).trim();
  const parts = normalized.split(/\s+/);

  if (parts.length !== 5) {
    throw new CronError(
      `Un cron son 5 campos (minuto hora día mes día-semana), no ${parts.length}: ` +
        `"${raw}". También valen @hourly, @daily, @weekly y @monthly.`,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  return {
    minute: parseField(minute, "minute"),
    hour: parseField(hour, "hour"),
    dayOfMonth: parseField(dayOfMonth, "dayOfMonth"),
    month: parseField(month, "month"),
    dayOfWeek: parseField(dayOfWeek, "dayOfWeek"),
    source: raw,
  };
}

function parseField(raw: string, name: keyof typeof RANGES): CronField {
  const [min, max] = RANGES[name];
  const values = new Set<number>();
  let unrestricted = false;

  for (const part of raw.split(",")) {
    const item = part.trim();
    if (item === "") throw new CronError(`Campo ${name} vacío en "${raw}"`);

    const [spec = "", stepRaw] = item.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);

    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`Paso inválido en ${name}: "${item}"`);
    }

    let from: number;
    let to: number;

    if (spec === "*") {
      from = min;
      to = max;
      // `*/2` SÍ restringe aunque empiece por `*`: solo `*` a secas es libre.
      if (stepRaw === undefined) unrestricted = true;
    } else if (spec.includes("-")) {
      const [a = "", b = ""] = spec.split("-");
      from = Number(a);
      to = Number(b);
    } else {
      from = Number(spec);
      to = from;
    }

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new CronError(`Valor no numérico en ${name}: "${item}"`);
    }
    if (from < min || to > max || from > to) {
      throw new CronError(
        `${name} fuera de rango en "${item}": se admite ${min}-${max}`,
      );
    }

    for (let value = from; value <= to; value += step) values.add(value);
  }

  // `getUTCDay()` devuelve 0–6, así que el 7 tiene que convertirse en 0 o no
  // casaría con ningún domingo.
  if (name === "dayOfWeek" && values.delete(7)) values.add(0);

  return { values, unrestricted };
}

/**
 * ¿Casa la expresión con este instante, al minuto?
 *
 * La regla del día del mes y el día de la semana es la trampa clásica de cron y
 * la fuente de la mitad de los "no se ejecutó cuando debía": si LOS DOS están
 * restringidos, la coincidencia es un **O**, no un **Y**. `0 0 1 * 1` es "el
 * día 1 y ADEMÁS todos los lunes", no "los lunes que caigan en día 1".
 *
 * Es contraintuitivo y está en el POSIX. Implementarlo como Y hace que una
 * expresión perfectamente válida no se dispare casi nunca.
 */
export function cronMatches(
  expression: CronExpression,
  date: Date,
  timeZone: string = "UTC",
): boolean {
  const wall = wallClockIn(date, timeZone);

  if (!expression.minute.values.has(wall.minute)) return false;
  if (!expression.hour.values.has(wall.hour)) return false;
  if (!expression.month.values.has(wall.month)) return false;

  const dayOfMonth = expression.dayOfMonth.values.has(wall.dayOfMonth);
  const dayOfWeek = expression.dayOfWeek.values.has(wall.dayOfWeek);

  const bothRestricted =
    !expression.dayOfMonth.unrestricted && !expression.dayOfWeek.unrestricted;

  return bothRestricted ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek;
}

export interface WallClock {
  minute: number;
  hour: number;
  /** 1–12, como en cron. `Date` los da 0–11. */
  month: number;
  dayOfMonth: number;
  /** 0 = domingo, como `getUTCDay()`. */
  dayOfWeek: number;
}

/**
 * La hora de pared de un instante en una zona.
 *
 * Con `Intl` y no con una librería de zonas horarias por el mismo motivo que el
 * matcher es propio: lo único que hace falta es descomponer un instante en
 * campos, y eso lo hace la plataforma con los datos de zonas del sistema — que
 * además se actualizan con Node en vez de con un `npm update` que alguien tiene
 * que acordarse de hacer cuando un país cambia su horario de verano.
 *
 * `en-CA` da ISO (`2026-08-06`), que es el único formato que se puede trocear
 * sin ambigüedad. Con `en-US` habría que adivinar si `06/08` es junio o agosto.
 */
export function wallClockIn(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  // `hour12: false` produce 24 a medianoche en algunos entornos, no 0. Sin este
  // módulo, un `0 0 * * *` no se dispararía nunca en esos entornos y el síntoma
  // sería "el cron de medianoche no va", que es de los peores de diagnosticar.
  const hour = Number(get("hour")) % 24;

  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayOfWeek = WEEKDAYS.indexOf(get("weekday"));

  return {
    minute: Number(get("minute")),
    hour,
    month: Number(get("month")),
    dayOfMonth: Number(get("day")),
    dayOfWeek: dayOfWeek === -1 ? date.getUTCDay() : dayOfWeek,
  };
}

/**
 * ¿Es un nombre de zona que el sistema conoce?
 *
 * Se valida al ESCRIBIR, igual que el cron. Una zona mal escrita —`Europe/Madird`—
 * aceptada en silencio deja una fuente que se sincroniza a una hora que no es la
 * que su dueño pidió, y eso no produce ningún error: produce un horario
 * equivocado, que es mucho peor porque nadie lo mira.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Valida sin quedarse la expresión. Para el formulario de creación. */
export function isValidCron(raw: string): boolean {
  try {
    parseCron(raw);
    return true;
  } catch {
    return false;
  }
}

/** El minuto al que pertenece un instante, en UTC. Segundos y ms a cero. */
export function minuteOf(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
    ),
  );
}
