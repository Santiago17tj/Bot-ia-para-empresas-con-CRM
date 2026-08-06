import {
  cronMatches,
  isValidTimeZone,
  minuteOf,
  parseCron,
} from "@platform/connectors";
import { runWithTenant, systemPrisma, withRlsTransaction } from "@platform/db";
import { publish } from "@platform/events";

/**
 * Planificador de sincronizaciones (§7).
 *
 * Sin esto, `syncSchedule` es una columna con un cron que no lee nadie y "el
 * conocimiento siempre al día" es un botón que alguien tiene que acordarse de
 * pulsar — justo lo que los conectores venían a evitar.
 *
 * Se apoya en el sondeo que el worker ya hace, en vez de montar temporizadores
 * por fuente: un `setTimeout` por cliente no sobrevive a un reinicio, no se
 * reparte entre varios procesos y hay que rehacerlo cada vez que alguien cambia
 * un horario. Mirar quién toca cada minuto es más tonto y no tiene ninguno de
 * esos problemas.
 */

interface ScheduledSource {
  id: string;
  tenantId: string;
  syncSchedule: string;
  syncTimezone: string | null;
  lastScheduledAt: Date | null;
  lastSyncStatus: string | null;
  tenant: { timezone: string };
}

export interface SchedulerResult {
  due: number;
  triggered: number;
  invalid: { sourceId: string; schedule: string; error: string }[];
}

/**
 * Dispara las fuentes a las que les toca.
 *
 * Corre como sistema y consulta TODOS los tenants: un planificador es
 * infraestructura, no la petición de un cliente. El aislamiento no se pierde —
 * cada disparo abre el contexto del tenant al que pertenece la fuente, y el
 * evento nace dentro de él.
 */
export async function runDueSyncs(
  now: Date = new Date(),
  log: (message: string) => void = () => {},
): Promise<SchedulerResult> {
  const minute = minuteOf(now);

  // `systemPrisma` y no `rawPrisma`. Es la segunda excepción sancionada a "el
  // cliente que se salta RLS no aparece en la ruta de una petición", y esto no
  // es una petición: es infraestructura que por definición mira TODOS los
  // tenants para saber a quién le toca.
  //
  // Con `rawPrisma` esto devolvía CERO FILAS EN SILENCIO: se conecta con el rol
  // de aplicación, las políticas RLS leen `app.tenant_id` de la sesión, y sin
  // contexto de tenant no pasa nada. Ningún error, ninguna traza — el
  // planificador simplemente no encontraba nunca una sola fuente. Es
  // exactamente la trampa que este proyecto ya tenía documentada, y aun así
  // costó un rato porque el síntoma es la ausencia de síntoma.
  //
  // El aislamiento no se pierde: cada disparo abre el contexto del tenant dueño
  // de la fuente, y el evento nace dentro de él.
  const candidates = await (async () =>
      systemPrisma.knowledgeSource.findMany({
        where: { isActive: true, syncSchedule: { not: null } },
        select: {
          id: true,
          tenantId: true,
          syncSchedule: true,
          syncTimezone: true,
          lastScheduledAt: true,
          lastSyncStatus: true,
          tenant: { select: { timezone: true } },
        },
      }))();

  const result: SchedulerResult = { due: 0, triggered: 0, invalid: [] };

  for (const raw of candidates) {
    const source = raw as ScheduledSource;

    // La fuente manda sobre el tenant, y el tenant sobre UTC. Una zona que el
    // sistema no conoce se degrada a UTC con aviso en vez de tumbar el
    // planificador: dejar de sincronizar a TODOS los clientes porque uno tiene
    // mal escrita su zona es peor que sincronizar a ese uno a la hora que se
    // usaba antes.
    const declared = source.syncTimezone ?? source.tenant.timezone;
    let timeZone = declared;
    if (!isValidTimeZone(declared)) {
      timeZone = "UTC";
      log(
        `[worker] fuente ${source.id}: zona horaria desconocida "${declared}", ` +
          "se interpreta en UTC",
      );
    }

    let matches: boolean;
    try {
      matches = cronMatches(parseCron(source.syncSchedule), minute, timeZone);
    } catch (error) {
      // Un cron inválido no tumba el planificador: se anota y se sigue con las
      // demás fuentes. La API valida al crear, así que llegar aquí significa
      // que alguien lo escribió directamente en la base.
      result.invalid.push({
        sourceId: source.id,
        schedule: source.syncSchedule,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!matches) continue;
    result.due++;

    if (await claim(source, minute)) result.triggered++;
  }

  if (result.triggered > 0) {
    log(`[worker] planificador: ${result.triggered} sincronización(es) disparadas`);
  }
  for (const invalid of result.invalid) {
    log(`[worker] fuente ${invalid.sourceId} con cron inválido: ${invalid.error}`);
  }

  return result;
}

/**
 * Reclama el disparo, o no.
 *
 * **La reclamación la decide la base con un UPDATE condicional, no el proceso.**
 * Es lo mismo que hace el despachador del outbox con `SKIP LOCKED` y por el
 * mismo motivo: varios workers son correctos por diseño, los dos van a ver que
 * a esta fuente le toca, y leer-entonces-escribir haría que los dos publicaran.
 * Aquí gana quien consiga cambiar la fila, y el otro recibe cero filas
 * afectadas y se calla.
 *
 * El `WHERE` cubre además el otro caso: no se encola nada si ya hay una
 * sincronización en marcha. Un sitio grande puede tardar más que el intervalo
 * de su cron, y sin esto se acumularían rastreos del mismo sitio pisándose el
 * cursor.
 */
async function claim(source: ScheduledSource, minute: Date): Promise<boolean> {
  const affected = await systemPrisma.$executeRaw`
      UPDATE "knowledgeSource"
      SET "lastScheduledAt" = ${minute},
          "lastSyncStatus" = 'PENDING'::"IngestStatus",
          "lastSyncError" = NULL
      WHERE id = ${source.id}
        AND ("lastScheduledAt" IS NULL OR "lastScheduledAt" < ${minute})
        AND ("lastSyncStatus" IS NULL
             OR "lastSyncStatus" NOT IN ('PENDING'::"IngestStatus", 'RUNNING'::"IngestStatus"))
  `;

  if (affected === 0) return false;

  // El evento va DESPUÉS de ganar la reclamación y dentro del contexto del
  // tenant dueño de la fuente. Publicarlo antes dejaría eventos huérfanos de
  // los disparos que no ganaron.
  const ctx = {
    tenantId: source.tenantId,
    actor: { type: "system" as const, id: "worker:scheduler", scopes: [] },
    requestId: `sched_${source.id}_${minute.toISOString()}`,
  };

  await runWithTenant(ctx, () =>
    withRlsTransaction((tx) =>
      publish(tx, {
        type: "source.sync.requested",
        tenantId: source.tenantId,
        payload: { sourceId: source.id, scheduled: true },
      }),
    ),
  );

  return true;
}
