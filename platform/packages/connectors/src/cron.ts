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
 * **Todo se interpreta en UTC.** No en la hora del servidor: la misma expresión
 * tiene que significar lo mismo en el portátil de desarrollo, en CI y en
 * producción, y la hora local del servidor depende de dónde se despliegue. La
 * consecuencia hay que decirla en voz alta: una PYME española que escriba
 * `0 3 * * *` esperando las tres de la madrugada tendrá su sincronización a las
 * 4:00 en verano y a las 3:00 en invierno. Una zona horaria por tenant es el
 * paso siguiente, no un descuido.
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
export function cronMatches(expression: CronExpression, date: Date): boolean {
  if (!expression.minute.values.has(date.getUTCMinutes())) return false;
  if (!expression.hour.values.has(date.getUTCHours())) return false;
  if (!expression.month.values.has(date.getUTCMonth() + 1)) return false;

  const dayOfMonth = expression.dayOfMonth.values.has(date.getUTCDate());
  const dayOfWeek = expression.dayOfWeek.values.has(date.getUTCDay());

  const bothRestricted =
    !expression.dayOfMonth.unrestricted && !expression.dayOfWeek.unrestricted;

  return bothRestricted ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek;
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
