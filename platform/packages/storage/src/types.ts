/**
 * Almacenamiento de ficheros (§28).
 *
 * La plataforma nunca sabe dónde viven los bytes. Misma regla de costuras que
 * `AIProvider`: la interfaz existe desde el primer commit con UNA implementación
 * real, y el día que haga falta S3 es un fichero, no un refactor.
 *
 * Existe porque la ingesta es asíncrona: la petición HTTP deja el fichero en
 * algún sitio y responde, y un worker lo recoge después. Sin un sitio, la única
 * alternativa era hacer la ingesta síncrona —y embeber un manual de 200 páginas
 * no cabe en un timeout— o meter los bytes en la base de datos, que convierte
 * cada copia de seguridad en un problema de tamaño.
 */

export interface StorageDriver {
  readonly id: string;

  put(key: string, bytes: Buffer, options?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class StorageError extends Error {
  override readonly name = "StorageError";
  constructor(
    message: string,
    readonly driverId: string,
    readonly code: "not_found" | "invalid_key" | "io",
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Claves válidas: segmentos alfanuméricos separados por `/`.
 *
 * Es una lista blanca y no una lista de caracteres prohibidos a propósito. Una
 * lista negra deja fuera lo que no se pensó, y aquí lo que no se piense acaba
 * siendo una ruta del sistema de ficheros: `..`, rutas absolutas, letras de
 * unidad de Windows, NUL, separadores invertidos. Con lista blanca, lo que no
 * está previsto simplemente no pasa.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertValidKey(key: string, driverId: string): void {
  const invalid = (reason: string): never => {
    throw new StorageError(
      `Clave de almacenamiento inválida (${reason}): ${JSON.stringify(key)}`,
      driverId,
      "invalid_key",
    );
  };

  if (key === "" || key.length > 512) invalid("longitud");
  if (key.includes("\0")) invalid("byte nulo");
  if (key.startsWith("/") || key.includes("\\")) invalid("ruta absoluta o invertida");

  const segments = key.split("/");
  for (const segment of segments) {
    // `.` y `..` los rechaza ya el patrón —empiezan por punto—, pero se
    // nombran aparte porque son el ataque, y un mensaje que los nombre ahorra
    // el rato de mirar la expresión regular.
    if (segment === "." || segment === "..") invalid("segmento relativo");
    if (!SEGMENT.test(segment)) invalid(`segmento "${segment}"`);
  }
}

/**
 * Construye la clave de un documento.
 *
 * El `tenantId` va primero para que el aislamiento sea visible en la ruta y
 * para que un bucket futuro pueda aplicar políticas por prefijo. El nombre de
 * fichero original NO forma parte de la clave: es entrada del usuario, y lo que
 * se conserva de él —el título— vive en la base de datos, donde no puede
 * convertirse en una ruta.
 */
export function documentKey(
  tenantId: string,
  documentId: string,
  extension?: string,
): string {
  const suffix =
    extension === undefined || extension === ""
      ? ""
      : `.${extension.replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;

  return `${tenantId}/documents/${documentId}${suffix}`;
}
