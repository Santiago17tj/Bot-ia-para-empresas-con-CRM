import {
  DRIVE_SCOPE,
  GoogleTokenSource,
  parseServiceAccount,
  type ServiceAccount,
} from "./google-auth.js";
import {
  ConnectorError,
  type DiscoveredDocument,
  type SourceConnector,
  type SyncCursor,
} from "./types.js";

/**
 * Conector de Google Drive.
 *
 * **La parte interesante es lo que NO hay que escribir.** Drive entrega los
 * ficheros ofimáticos tal cual —PDF, DOCX— y esos conversores ya existen y están
 * probados. Así que este conector no convierte nada de eso: descarga bytes y los
 * entrega, igual que si alguien los hubiera subido a mano.
 *
 * Lo único propio es lo nativo de Google, que no se puede descargar sin más:
 * un Documento no es un fichero, es un objeto en su servidor, y hay que pedirle
 * que lo EXPORTE a un formato. De ahí la tabla de exportación de abajo.
 */

const DEFAULT_BASE_URL = "https://www.googleapis.com/drive/v3";

/** 25 MB, igual que la subida manual. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * A qué se exporta cada tipo nativo de Google.
 *
 * `text/markdown` para Documentos porque **conserva los encabezados**, que es el
 * listón de cualquier conversor en este proyecto: el troceador corta por ellos y
 * las citas se construyen con ellos. Exportar a `text/plain` daría un muro de
 * texto y un documento entero como un solo fragmento sin procedencia.
 *
 * Las Hojas de cálculo van a CSV porque ya hay conversor de CSV, y ahí es donde
 * una PYME tiene sus tarifas.
 */
const EXPORT_AS: Record<string, { mimeType: string; extension: string }> = {
  "application/vnd.google-apps.document": {
    mimeType: "text/markdown",
    extension: "md",
  },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "text/csv",
    extension: "csv",
  },
  "application/vnd.google-apps.presentation": {
    mimeType: "text/plain",
    extension: "txt",
  },
};

/** Lo que Drive sirve en crudo y nuestros conversores ya saben abrir. */
const DOWNLOADABLE = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
]);

export interface DriveSourceConfig {
  /** JSON completo de la clave de cuenta de servicio. Secreto. */
  credentials: string;
  /** Carpetas concretas. Vacío = todo lo compartido con la cuenta. */
  folderIds: string[];
  maxFiles: number;
  /** Solo para tests. */
  baseUrl?: string;
}

interface DriveCursor extends SyncCursor {
  /** id de fichero → `modifiedTime` de la última vez que se ingirió. */
  seen?: Record<string, string>;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  trashed?: boolean;
}

export const driveConnector: SourceConnector = {
  kind: "GOOGLE_DRIVE",
  secretFields: ["credentials"],

  validateConfig(raw) {
    const config = (raw ?? {}) as Partial<DriveSourceConfig>;

    if (typeof config.credentials !== "string" || config.credentials.trim() === "") {
      throw new ConnectorError(
        "Faltan las credenciales de Google. Crea una cuenta de servicio, " +
          "descarga su clave JSON, y COMPARTE con su correo " +
          "(…@….iam.gserviceaccount.com) las carpetas que quieras indexar: sin " +
          "compartirlas no ve nada.",
        "GOOGLE_DRIVE",
        true,
      );
    }

    // Si viene en claro se valida ahora; si viene cifrado de una actualización
    // se deja pasar, porque solo el worker puede descifrarlo. Exigir el JSON
    // aquí impediría cambiar `maxFiles` sin volver a pegar la clave entera.
    if (config.credentials.trim().startsWith("{")) {
      parseServiceAccount(config.credentials);
    }

    const folderIds = config.folderIds ?? [];
    if (!Array.isArray(folderIds) || folderIds.some((id) => typeof id !== "string")) {
      throw new ConnectorError("`folderIds` son cadenas.", "GOOGLE_DRIVE", true);
    }

    // Los ids se interpolan en la consulta de Drive, que es un lenguaje propio.
    // Una comilla dentro rompería la consulta o la cambiaría de significado, y
    // ese id lo escribe el cliente.
    for (const id of folderIds) {
      if (!/^[A-Za-z0-9_-]{5,100}$/.test(id)) {
        throw new ConnectorError(
          `Id de carpeta con formato inesperado: ${JSON.stringify(id)}`,
          "GOOGLE_DRIVE",
          true,
        );
      }
    }

    return {
      credentials: config.credentials,
      folderIds,
      maxFiles: clamp(config.maxFiles ?? 500, 1, 5_000),
      ...(typeof config.baseUrl === "string" && config.baseUrl !== ""
        ? { baseUrl: config.baseUrl }
        : {}),
    };
  },

  async sync(rawConfig, context) {
    const config = this.validateConfig(rawConfig) as unknown as DriveSourceConfig;
    const account: ServiceAccount = parseServiceAccount(config.credentials);
    const client = new DriveClient(account, config.baseUrl ?? DEFAULT_BASE_URL);

    const cursor = (context.cursor ?? {}) as DriveCursor;
    const previous = cursor.seen ?? {};
    const seen: Record<string, string> = {};

    const log = context.log ?? (() => {});
    const warnings: string[] = [];
    let discovered = 0;
    let skipped = 0;

    const files = await client.listFiles(config.folderIds, config.maxFiles);

    if (files.length === 0) {
      warnings.push(
        `La cuenta de servicio no ve ningún fichero. Comparte las carpetas con ` +
          `${account.client_email} desde Drive, como compartirías con una persona.`,
      );
    }

    for (const file of files) {
      const modifiedAt = file.modifiedTime ?? "";
      seen[file.id] = modifiedAt;

      // Igual que en Notion: Drive da la fecha de modificación, así que lo no
      // tocado se salta ANTES de descargarlo. En Drive eso pesa más, porque un
      // PDF de veinte megas se descarga entero para nada.
      if (modifiedAt !== "" && previous[file.id] === modifiedAt) {
        skipped++;
        continue;
      }

      const plan = planFor(file);
      if (plan === undefined) {
        // No se avisa de cada imagen y cada vídeo: una carpeta normal tiene
        // cientos y llenarían el informe de ruido.
        continue;
      }

      if (file.size !== undefined && Number(file.size) > MAX_FILE_BYTES) {
        warnings.push(`"${file.name}": más de 25 MB, saltado.`);
        delete seen[file.id];
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = plan.export
          ? await client.exportFile(file.id, plan.mimeType)
          : await client.downloadFile(file.id);
      } catch (error) {
        // Un fichero que falla no aborta la sincronización. No se guarda su
        // marca de tiempo, así que se reintenta la próxima vez.
        warnings.push(
          `"${file.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
        delete seen[file.id];
        continue;
      }

      if (bytes.byteLength === 0) {
        warnings.push(`"${file.name}" está vacío: no se indexa.`);
        continue;
      }

      await context.emit({
        externalId: file.id,
        title: file.name,
        bytes,
        mimeType: plan.mimeType,
        // El enlace de Drive es lo que hace la cita clicable: quien la lea
        // abre el documento en su sitio, con sus permisos.
        sourceRef: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
      } satisfies DiscoveredDocument);

      discovered++;
    }

    log(
      `[drive] ${discovered} ficheros nuevos o cambiados · ${skipped} sin cambios · ` +
        `${warnings.length} avisos`,
    );

    return {
      cursor: { seen } satisfies DriveCursor,
      progress: { discovered, skipped, warnings },
    };
  },
};

/**
 * Qué hacer con este fichero, o nada.
 *
 * Pura y exportada porque es la decisión que define el alcance del conector, y
 * conviene poder comprobarla sin red: qué se exporta, qué se descarga tal cual
 * y qué se ignora.
 */
export function planFor(
  file: Pick<DriveFile, "mimeType" | "name">,
): { export: boolean; mimeType: string } | undefined {
  const exportable = EXPORT_AS[file.mimeType];
  if (exportable !== undefined) {
    return { export: true, mimeType: exportable.mimeType };
  }

  // Lo demás nativo de Google —formularios, dibujos, atajos— no tiene texto
  // que exportar de forma útil.
  if (file.mimeType.startsWith("application/vnd.google-apps")) return undefined;

  if (DOWNLOADABLE.has(file.mimeType)) {
    return { export: false, mimeType: file.mimeType };
  }

  return undefined;
}

class DriveClient {
  readonly #tokens: GoogleTokenSource;
  readonly #baseUrl: string;

  constructor(account: ServiceAccount, baseUrl: string) {
    this.#tokens = new GoogleTokenSource(account, DRIVE_SCOPE);
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async #get(path: string): Promise<Response> {
    const token = await this.#tokens.token();
    const response = await fetch(`${this.#baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ConnectorError(
        explain(response.status, detail),
        "GOOGLE_DRIVE",
        response.status === 401 || response.status === 403,
      );
    }

    return response;
  }

  /**
   * Los ficheros visibles, paginados.
   *
   * Sin carpetas indicadas se listan todos los que la cuenta de servicio pueda
   * ver, que es exactamente lo que le hayan compartido. Con carpetas, se filtra
   * por padre — y como Drive no busca en subcarpetas de forma recursiva, se
   * recorre el árbol.
   */
  async listFiles(folderIds: string[], maxFiles: number): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    // `undefined` significa "sin filtro de carpeta": todo lo que la cuenta de
    // servicio pueda ver. El tipo va explícito porque de otro modo se infiere
    // `undefined[]` cuando no hay carpetas, y luego no admite ids.
    const pending: (string | undefined)[] =
      folderIds.length > 0 ? [...folderIds] : [undefined];
    const visitedFolders = new Set<string>();

    while (pending.length > 0 && files.length < maxFiles) {
      const folder = pending.shift();
      if (folder !== undefined) {
        if (visitedFolders.has(folder)) continue;
        visitedFolders.add(folder);
      }

      let pageToken: string | undefined;

      do {
        const query = new URLSearchParams({
          q:
            folder === undefined
              ? "trashed = false"
              : `'${folder}' in parents and trashed = false`,
          fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink)",
          pageSize: "100",
          // Sin esto no se ven los ficheros de unidades compartidas, que es
          // donde vive la documentación de cualquier empresa con Workspace.
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          ...(pageToken === undefined ? {} : { pageToken }),
        });

        const response = await this.#get(`/files?${query.toString()}`);
        const payload = (await response.json()) as {
          files?: DriveFile[];
          nextPageToken?: string;
        };

        for (const file of payload.files ?? []) {
          if (file.mimeType === "application/vnd.google-apps.folder") {
            // Las subcarpetas se recorren; no son documentos.
            pending.push(file.id);
            continue;
          }
          if (files.length >= maxFiles) break;
          files.push(file);
        }

        pageToken = payload.nextPageToken;
      } while (pageToken !== undefined && files.length < maxFiles);
    }

    return files;
  }

  /** Exporta un nativo de Google al formato pedido. */
  async exportFile(fileId: string, mimeType: string): Promise<Buffer> {
    const query = new URLSearchParams({ mimeType, supportsAllDrives: "true" });
    const response = await this.#get(`/files/${fileId}/export?${query.toString()}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Descarga un fichero tal cual. */
  async downloadFile(fileId: string): Promise<Buffer> {
    const query = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
    const response = await this.#get(`/files/${fileId}?${query.toString()}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

function explain(status: number, detail: string): string {
  if (status === 401) {
    return "Google rechazó el token (401). Revisa las credenciales de la cuenta de servicio.";
  }
  if (status === 403) {
    if (detail.includes("insufficientFilePermissions")) {
      return (
        "La cuenta de servicio no tiene permiso sobre ese fichero. Comparte la " +
        "carpeta con su correo desde Drive."
      );
    }
    return (
      "Google respondió 403. Comprueba que la API de Drive esté habilitada y " +
      "que las carpetas estén compartidas con la cuenta de servicio."
    );
  }
  if (status === 429) {
    return "Google está limitando las peticiones (429). Baja `maxFiles` si se repite.";
  }
  return `Google respondió ${status}: ${detail.slice(0, 300)}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
