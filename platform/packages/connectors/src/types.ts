/**
 * Conectores de origen (§7, §27).
 *
 * Misma regla de costuras que `AIProvider` y `StorageDriver`: la interfaz nace
 * con UNA implementación real, y la segunda es un fichero.
 *
 * El contrato es deliberadamente estrecho. Un conector **descubre documentos y
 * entrega bytes**; no trocea, no embebe, no escribe en la base. Todo eso ya
 * existe, está medido y no debe tener dos caminos: lo que el conector produce
 * entra por la MISMA ruta de ingesta que un fichero subido a mano.
 */

export interface DiscoveredDocument {
  /** Identificador estable en el origen. Para la web, la URL canónica. */
  externalId: string;
  title?: string;
  bytes: Buffer;
  mimeType: string;
  /** Lo que se enseña como cita clicable. */
  sourceRef: string;
  /**
   * Huella del contenido, si el origen la da barata.
   *
   * Permite saltarse lo que no ha cambiado ANTES de descargarlo entero. La
   * ingesta vuelve a comprobar por checksum del texto extraído, pero eso ya es
   * después de gastar la descarga.
   */
  checksum?: string;
}

export interface SyncProgress {
  discovered: number;
  skipped: number;
  warnings: string[];
}

/**
 * Cursor de sincronización.
 *
 * Se guarda en `KnowledgeSource.syncCursor` y su forma la decide cada conector.
 * Existe para que la segunda pasada no vuelva a descargar y re-embeber lo que
 * no ha cambiado — que es la diferencia entre una sincronización nocturna
 * viable y una que cuesta dinero cada noche por nada.
 */
export type SyncCursor = Record<string, unknown>;

export interface SyncContext {
  cursor: SyncCursor;
  /** Se llama por cada documento encontrado. Devuelve si hubo que ingerirlo. */
  emit: (document: DiscoveredDocument) => Promise<void>;
  log?: (message: string) => void;
}

export interface SourceConnector {
  readonly kind: string;
  /**
   * Campos de `config` que son credenciales.
   *
   * Lo declara el conector porque es quien sabe cuáles lo son. La API los cifra
   * al guardar y los redacta al devolver sin saber de qué van; el día que
   * alguien añada un conector con token, declararlo aquí es todo lo que hay que
   * hacer para que no se filtre.
   */
  readonly secretFields: readonly string[];
  /**
   * Valida la configuración ANTES de guardarla.
   *
   * Una fuente mal configurada que se acepta al crearla falla la primera noche
   * que sincroniza, cuando nadie está mirando. Fallar al crearla se lo dice a
   * quien la está creando.
   */
  validateConfig(config: unknown): Record<string, unknown>;
  /** Descubre y entrega. Devuelve el cursor nuevo. */
  sync(
    config: Record<string, unknown>,
    context: SyncContext,
  ): Promise<{ cursor: SyncCursor; progress: SyncProgress }>;
}

export class ConnectorError extends Error {
  override readonly name = "ConnectorError";
  constructor(
    message: string,
    readonly connectorKind: string,
    /** Un fallo de configuración no mejora reintentándolo. */
    readonly permanent = false,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
