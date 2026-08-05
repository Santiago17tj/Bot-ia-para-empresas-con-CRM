import { createHash, randomUUID } from "node:crypto";

import { Prisma, type Prisma as PrismaNS } from "@platform/db";
import type { EmbeddingProvider } from "@platform/providers";

import { chunkDocument, type Chunk, type ChunkOptions } from "./chunking.js";
import { toMarkdown } from "./convert/index.js";
import { columnForDimensions } from "./dimensions.js";

/**
 * Pipeline de ingesta: convertir → trocear → embeber → indexar.
 *
 * Debe ejecutarse dentro de `withRlsTransaction`, para que las políticas de
 * Postgres filtren por tenant. Nada aquí escribe un `WHERE tenantId` a mano:
 * olvidarlo sería una fuga, mientras que con RLS olvidarlo no devuelve nada.
 */

export interface IngestInput {
  tenantId: string;
  bytes: Buffer;
  filename: string;
  mimeType?: string;
  /**
   * Ingerir DENTRO de un documento que ya existe.
   *
   * Es lo que hace posible la ingesta asíncrona: la API crea la fila en
   * `PENDING` y responde 202, y el worker que recoge el evento dice
   * exactamente en cuál trabaja. Sin esto tendría que adivinarlo por título o
   * por `sourceRef`, y dos ficheros subidos con el mismo nombre se pisarían el
   * uno al otro sin que nada fallara.
   */
  documentId?: string;
  sourceId?: string;
  /** Si no se da, se usa el título detectado o el nombre del fichero. */
  title?: string;
  sourceRef?: string;
  category?: string;
  tags?: string[];
  department?: string;
  effectiveFrom?: Date;
  expiresAt?: Date;
  chunkOptions?: ChunkOptions;
}

export interface IngestResult {
  documentId: string;
  versionId: string | null;
  version: number;
  chunksCreated: number;
  /** El contenido ya estaba indexado: no se creó versión nueva. */
  unchanged: boolean;
  warnings: string[];
  embeddingProvider: string;
  embeddingDimensions: number;
}

/** Cuántos textos se embeben por llamada al proveedor. */
const EMBED_BATCH = 96;

/** Configuración de búsqueda léxica por idioma. */
function tsConfig(language: string): string {
  return language.toLowerCase().startsWith("en") ? "english" : "spanish";
}

/**
 * Huella del contenido EXTRAÍDO, no de los bytes originales.
 *
 * Es deliberado: el mismo PDF re-exportado cambia de bytes sin cambiar de
 * texto, y versionar eso reindexaría el documento entero —y volvería a pagar
 * los embeddings— sin que nada hubiera cambiado para quien pregunta.
 */
export function contentChecksum(markdown: string): string {
  return createHash("sha256").update(markdown.trim()).digest("hex");
}

/**
 * Ingesta completa, en TRES fases.
 *
 * Las fases existen por una razón concreta: **el trabajo lento no puede vivir
 * dentro de una transacción**. Embeber es una llamada de red (o una carga de
 * modelo) que puede tardar segundos o minutos; hacerlo con una transacción
 * abierta la mantiene bloqueando una conexión del pool todo ese tiempo, y con
 * un PDF grande simplemente expira.
 *
 *   1. Convertir y trocear — sin base de datos
 *   2. Transacción corta: ¿ya está este contenido indexado?
 *   3. Embeber — FUERA de transacción, es lo lento
 *   4. Transacción de escritura: versión y fragmentos
 *
 * El orden importa además por dinero: la fase 2 evita pagar los embeddings de
 * un documento que no ha cambiado.
 */
export async function ingestDocument(
  input: IngestInput,
  deps: {
    embedder: EmbeddingProvider;
    /** Normalmente `withRlsTransaction`. Se inyecta para poder testear. */
    transaction: <T>(fn: (tx: PrismaNS.TransactionClient) => Promise<T>) => Promise<T>;
  },
): Promise<IngestResult> {
  // --- Fase 1: conversión y troceado, sin tocar la base --------------------
  const conversion = await toMarkdown(input.bytes, input.filename, input.mimeType);
  const checksum = contentChecksum(conversion.markdown);
  const language = conversion.language ?? "es";
  const title = input.title ?? conversion.title ?? input.filename;
  const chunks = chunkDocument(conversion.markdown, input.chunkOptions);

  // Falla antes de embeber si la dimensión no tiene columna: descubrirlo
  // después habría gastado la llamada al proveedor para nada.
  columnForDimensions(deps.embedder.dimensions);

  // --- Fase 2: ¿hace falta trabajar? ---------------------------------------
  const state = await deps.transaction((tx) =>
    resolveState(tx, input, { title, checksum }),
  );

  if (state.unchanged) {
    return {
      documentId: state.documentId,
      versionId: state.versionId,
      version: state.version,
      chunksCreated: 0,
      unchanged: true,
      warnings: conversion.warnings,
      embeddingProvider: deps.embedder.id,
      embeddingDimensions: deps.embedder.dimensions,
    };
  }

  // --- Fase 3: embeber, FUERA de transacción -------------------------------
  const embeddings = chunks.length > 0 ? await embedInBatches(deps.embedder, chunks) : [];

  // --- Fase 4: escritura, transacción corta --------------------------------
  return deps.transaction(async (tx) => {
    const previous = await tx.documentVersion.findFirst({
      where: { documentId: state.documentId },
      orderBy: { version: "desc" },
      select: { id: true, version: true },
    });

    if (previous !== null) {
      await tx.documentVersion.update({
        where: { id: previous.id },
        data: { isActive: false, supersededAt: new Date() },
      });
      // Los fragmentos de la versión anterior dejan de recuperarse en el mismo
      // acto. Si se desactivaran después, habría una ventana en la que el
      // documento respondería con las dos versiones a la vez.
      await tx.chunk.updateMany({
        where: { versionId: previous.id },
        data: { isActive: false },
      });
    }

    const version = await tx.documentVersion.create({
      data: {
        tenantId: input.tenantId,
        documentId: state.documentId,
        version: (previous?.version ?? 0) + 1,
        checksum,
        byteSize: input.bytes.byteLength,
        language,
        rawText: conversion.markdown,
        ...(conversion.pageCount !== undefined ? { pageCount: conversion.pageCount } : {}),
        ingestedAt: new Date(),
      },
      select: { id: true, version: true },
    });

    if (chunks.length > 0) {
      await insertChunks(tx, {
        tenantId: input.tenantId,
        versionId: version.id,
        chunks,
        embeddings,
        embedder: deps.embedder,
        language,
        title,
        category: input.category,
        tags: input.tags ?? [],
        department: input.department,
      });
    }

    await tx.document.update({
      where: { id: state.documentId },
      data: { status: "READY", statusError: null },
    });

    return {
      documentId: state.documentId,
      versionId: version.id,
      version: version.version,
      chunksCreated: chunks.length,
      unchanged: false,
      warnings: conversion.warnings,
      embeddingProvider: deps.embedder.id,
      embeddingDimensions: deps.embedder.dimensions,
    };
  });
}

interface ResolvedState {
  documentId: string;
  versionId: string | null;
  version: number;
  unchanged: boolean;
}

/** Fase 2: localiza o crea el documento y decide si el contenido ya está. */
async function resolveState(
  tx: PrismaNS.TransactionClient,
  input: IngestInput,
  args: { title: string; checksum: string },
): Promise<ResolvedState> {
  // Con `documentId` no se busca ni se crea: se exige que exista. Si no está,
  // se falla en vez de crear otro — un worker que "arregla" un id que no
  // encuentra creando una fila nueva deja huérfano el documento que el cliente
  // está consultando por la API, y este se queda en PENDING para siempre.
  if (input.documentId !== undefined) {
    const target = await tx.document.findUnique({
      where: { id: input.documentId },
      select: { id: true },
    });

    if (target === null) {
      throw new Error(
        `No existe el documento ${input.documentId} para este tenant. ` +
          "La ingesta con documentId no crea filas: si el documento no está, " +
          "o se borró o el id viene de otro tenant.",
      );
    }

    await tx.document.update({
      where: { id: target.id },
      data: { status: "RUNNING", statusError: null },
    });

    return resolveVersion(tx, target.id, args.checksum);
  }

  const existing = await tx.document.findFirst({
    where: input.sourceRef !== undefined
      ? { sourceRef: input.sourceRef }
      : { title: args.title, sourceId: input.sourceId ?? null },
    select: { id: true },
  });

  const document =
    existing ??
    (await tx.document.create({
      data: {
        tenantId: input.tenantId,
        title: args.title,
        kind: kindFor(input.filename, input.mimeType),
        mimeType: input.mimeType ?? null,
        sourceRef: input.sourceRef ?? null,
        sourceId: input.sourceId ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
        expiresAt: input.expiresAt ?? null,
        status: "RUNNING",
      },
      select: { id: true },
    }));

  return resolveVersion(tx, document.id, args.checksum);
}

/**
 * ¿Está ya indexado este contenido en este documento?
 *
 * Nada se borra: si el checksum coincide con la versión activa, no hay que
 * volver a pagar los embeddings. Es la fase que ahorra dinero cuando alguien
 * vuelve a subir el mismo fichero.
 */
async function resolveVersion(
  tx: PrismaNS.TransactionClient,
  documentId: string,
  checksum: string,
): Promise<ResolvedState> {
  const sameContent = await tx.documentVersion.findFirst({
    where: { documentId, checksum, isActive: true },
    select: { id: true, version: true },
  });

  if (sameContent !== null) {
    await tx.document.update({
      where: { id: documentId },
      data: { status: "READY", statusError: null },
    });
    return {
      documentId,
      versionId: sameContent.id,
      version: sameContent.version,
      unchanged: true,
    };
  }

  return { documentId, versionId: null, version: 0, unchanged: false };
}

/**
 * Embebe por lotes.
 *
 * Un documento de 200 páginas son ~400 fragmentos; mandarlos de uno en uno son
 * 400 viajes de red, y de golpe supera el límite de casi cualquier proveedor.
 */
async function embedInBatches(
  embedder: EmbeddingProvider,
  chunks: Chunk[],
): Promise<number[][]> {
  const vectors: number[][] = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const embedded = await embedder.embed(
      batch.map((c) => c.content),
      "document",
    );

    if (embedded.length !== batch.length) {
      throw new Error(
        `El proveedor devolvió ${embedded.length} vectores para ${batch.length} textos. ` +
          "Continuar desalinearía cada vector de su fragmento, y la búsqueda " +
          "devolvería contenido que no corresponde sin fallar nunca.",
      );
    }
    vectors.push(...embedded);
  }

  return vectors;
}

/**
 * Inserta los fragmentos con su vector y su `tsvector`.
 *
 * SQL crudo porque Prisma no sabe escribir ninguna de las dos columnas. El
 * `regconfig` sale del idioma del documento: un corpus multilingüe indexado
 * todo como español degrada la búsqueda léxica en silencio — nada falla, solo
 * se recupera peor.
 */
async function insertChunks(
  tx: PrismaNS.TransactionClient,
  args: {
    tenantId: string;
    versionId: string;
    chunks: Chunk[];
    embeddings: number[][];
    embedder: EmbeddingProvider;
    language: string;
    title: string;
    // `| undefined` explícito: con exactOptionalPropertyTypes, `category?: string`
    // significa "ausente o string", y el llamante pasa la propiedad presente con
    // valor undefined. Son cosas distintas y el compilador tiene razón.
    category: string | undefined;
    tags: string[];
    department: string | undefined;
  },
): Promise<void> {
  const config = tsConfig(args.language);
  // Falla ANTES de embeber si la dimensión no tiene columna: descubrirlo
  // después habría gastado la llamada al proveedor para nada.
  const column = columnForDimensions(args.embedder.dimensions);

  const rows = args.chunks.map((chunk, i) => {
    const vector = args.embeddings[i];
    if (vector === undefined) {
      throw new Error(`Falta el embedding del fragmento ${i}`);
    }

    return Prisma.sql`(
      ${randomUUID()},
      ${args.tenantId},
      ${args.versionId},
      ${chunk.ordinal},
      ${chunk.content},
      ${chunk.tokenCount},
      ${args.title},
      ${args.language},
      ${args.category ?? null},
      ${args.tags},
      ${args.department ?? null},
      ${chunk.breadcrumbs},
      ${chunk.pageNumber ?? null},
      ${chunk.sectionPath ?? null},
      ${args.embedder.id},
      ${args.embedder.model},
      ${args.embedder.dimensions},
      ${`[${vector.join(",")}]`}::vector,
      to_tsvector(${config}::regconfig, ${chunk.content}),
      true,
      now()
    )`;
  });

  // El nombre de columna no puede ir como parámetro, así que se interpola —
  // pero sale de `columnForDimensions`, que solo devuelve valores de una tabla
  // cerrada en el código. Nada de aquí procede de entrada del usuario.
  await tx.$executeRaw`
    INSERT INTO "chunk" (
      id, "tenantId", "versionId", ordinal, content, "tokenCount",
      title, language, category, tags, department, breadcrumbs,
      "pageNumber", "sectionPath",
      "embeddingProvider", "embeddingModel", "embeddingDimensions",
      ${Prisma.raw(`"${column}"`)}, search_vector, "isActive", "createdAt"
    )
    VALUES ${Prisma.join(rows)}
  `;
}

function kindFor(filename: string, mimeType?: string): "PDF" | "DOCX" | "CSV" | "TXT" | "MARKDOWN" | "URL" {
  const lower = filename.toLowerCase();
  if (mimeType?.includes("html") === true || lower.endsWith(".html")) return "URL";
  if (lower.endsWith(".pdf")) return "PDF";
  if (lower.endsWith(".docx")) return "DOCX";
  if (lower.endsWith(".csv")) return "CSV";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "MARKDOWN";
  return "TXT";
}

/**
 * Embebe una consulta.
 *
 * Va por `kind: "query"` a propósito: varios proveedores embeben consulta y
 * documento de forma distinta, y usar el modo equivocado degrada la
 * recuperación sin que nada falle.
 */
export async function embedQuery(
  embedder: EmbeddingProvider,
  text: string,
): Promise<number[]> {
  const [vector] = await embedder.embed([text], "query");
  if (vector === undefined) {
    throw new Error("El proveedor no devolvió embedding para la consulta");
  }
  return vector;
}
