import type { FastifyInstance } from "fastify";

import { withRlsTransaction } from "@platform/db";
import { publish } from "@platform/events";
import { availableFormats, converterFor } from "@platform/knowledge";
import { recordUsage } from "@platform/observability";
import { createStorage, documentKey, type StorageDriver } from "@platform/storage";

import { requireScope } from "../auth.js";
import { ApiError } from "../errors.js";
import { readInTenant, withTenant } from "../server.js";

/**
 * Ingesta de documentos (§7, §27).
 *
 * **Asíncrona, y no por gusto.** Embeber un manual de 200 páginas son cientos
 * de llamadas al proveedor o minutos de CPU con el modelo local; eso no cabe en
 * un timeout HTTP, y el propio pipeline de ingesta ya está partido en fases
 * porque el trabajo lento no puede vivir dentro de una transacción. Servirlo en
 * síncrono sería reintroducir en la capa de arriba el problema que la de abajo
 * ya resolvió.
 *
 * Así que: se guardan los bytes, se crea el documento en `PENDING` y se publica
 * el evento **en la misma transacción**, y se responde 202. El worker hace el
 * trabajo y el cliente consulta el estado.
 *
 * Lo que hace correcto ese 202 es que el evento y la fila se confirman juntos.
 * Si el evento se publicara fuera, un fallo entre ambos dejaría un documento
 * que la API muestra como PENDING y que nadie va a procesar nunca — el fallo
 * silencioso más caro de diagnosticar que tiene este sistema.
 */

interface UploadFields {
  title?: string;
  sourceRef?: string;
  category?: string;
  department?: string;
  tags?: string[];
  effectiveFrom?: Date;
  expiresAt?: Date;
}

/** 25 MB. Un manual grande cabe; una subida accidental de un vídeo no. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function registerDocumentRoutes(app: FastifyInstance): Promise<void> {
  const storage: StorageDriver = createStorage();

  await app.register(import("@fastify/multipart"), {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  app.post("/v1/knowledge/documents", async (request, reply) => {
    requireScope(request.apiKey, "knowledge:write");

    const part = await request.file();
    if (part === undefined) {
      throw new ApiError(
        400,
        "invalid_request",
        "Falta el fichero. Envía multipart/form-data con un campo de tipo fichero.",
      );
    }

    const bytes = await part.toBuffer().catch(() => {
      throw new ApiError(
        413,
        "payload_too_large",
        `El fichero supera el máximo de ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      );
    });

    if (bytes.byteLength === 0) {
      throw new ApiError(400, "invalid_request", "El fichero está vacío.");
    }

    const fields = readFields(part.fields);
    const filename = part.filename;
    const mimeType = part.mimetype;

    // Se comprueba que sabemos convertirlo ANTES de guardar nada. Aceptar un
    // .pptx, responder 202 y fallar en el worker le da al cliente un documento
    // en FAILED por algo que se sabía en el momento de subirlo.
    assertConvertible(filename, mimeType);

    const documentId = crypto.randomUUID();
    const key = documentKey(request.tenantCtx.tenantId, documentId, extensionOf(filename));

    // Los bytes van al almacenamiento ANTES de la transacción: es E/S lenta y
    // no debe mantener abierta una conexión del pool. Si la transacción falla
    // después, queda un fichero huérfano — barato y detectable, mientras que
    // lo contrario sería una fila que apunta a bytes que no existen.
    await storage.put(key, bytes, { contentType: mimeType });

    const created = await withTenant(request.tenantCtx, () =>
      withRlsTransaction(async (tx) => {
        const document = await tx.document.create({
          data: {
            id: documentId,
            tenantId: request.tenantCtx.tenantId,
            title: fields.title ?? filename,
            kind: kindFor(filename, mimeType),
            mimeType,
            storageKey: key,
            sourceRef: fields.sourceRef ?? null,
            effectiveFrom: fields.effectiveFrom ?? null,
            expiresAt: fields.expiresAt ?? null,
            status: "PENDING",
          },
          select: { id: true, title: true, status: true, createdAt: true },
        });

        await publish(tx, {
          type: "document.uploaded",
          tenantId: request.tenantCtx.tenantId,
          payload: {
            documentId: document.id,
            storageKey: key,
            filename,
            mimeType,
            byteSize: bytes.byteLength,
            ...(fields.category === undefined ? {} : { category: fields.category }),
            ...(fields.department === undefined ? {} : { department: fields.department }),
            ...(fields.tags === undefined ? {} : { tags: fields.tags }),
          },
        });

        await recordUsage(tx, request.tenantCtx.tenantId, [
          { metric: "API_CALLS", quantity: 1 },
          { metric: "DOCUMENTS", quantity: 1 },
          { metric: "STORAGE_BYTES", quantity: bytes.byteLength },
        ]);

        return document;
      }),
    );

    // 202 y no 201: el recurso existe, pero lo que el cliente quiere —que su
    // documento responda preguntas— todavía no ha pasado. Decir 201 sería
    // decir que ya está.
    return reply.status(202).send({
      id: created.id,
      title: created.title,
      status: created.status,
      byteSize: bytes.byteLength,
      createdAt: created.createdAt,
      statusUrl: `/v1/knowledge/documents/${created.id}`,
    });
  });

  app.get<{ Params: { id: string } }>(
    "/v1/knowledge/documents/:id",
    async (request, reply) => {
      requireScope(request.apiKey, "knowledge:read");

      const document = await readInTenant(request.tenantCtx, (tx) =>
        tx.document.findUnique({
          where: { id: request.params.id },
          select: {
            id: true,
            title: true,
            kind: true,
            mimeType: true,
            sourceRef: true,
            status: true,
            statusError: true,
            createdAt: true,
            updatedAt: true,
            versions: {
              where: { isActive: true },
              select: { version: true, byteSize: true, language: true, ingestedAt: true },
              take: 1,
            },
          },
        }),
      );

      // 404 y no 403 para un documento de otro tenant. El filtro de tenant hace
      // que no exista, y decir "existe pero no es tuyo" confirmaría el id.
      if (document === null) {
        throw new ApiError(404, "not_found", `No existe el documento ${request.params.id}.`);
      }

      const [active] = document.versions;
      return reply.send({
        id: document.id,
        title: document.title,
        kind: document.kind,
        mimeType: document.mimeType,
        sourceRef: document.sourceRef,
        status: document.status,
        // Se devuelve el motivo del fallo: el cliente subió el fichero y es
        // quien puede arreglarlo. Ocultarlo lo deja mirando un FAILED mudo.
        error: document.statusError,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        version: active === undefined ? null : active.version,
        indexedAt: active?.ingestedAt ?? null,
      });
    },
  );

  app.get<{ Querystring: { status?: string; limit?: number } }>(
    "/v1/knowledge/documents",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["PENDING", "RUNNING", "READY", "FAILED", "SKIPPED"],
            },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      requireScope(request.apiKey, "knowledge:read");

      const { status, limit = 50 } = request.query;

      const documents = await readInTenant(request.tenantCtx, (tx) =>
        tx.document.findMany({
          where: status === undefined ? {} : { status: status as "PENDING" },
          orderBy: { createdAt: "desc" },
          take: limit,
          select: {
            id: true,
            title: true,
            kind: true,
            status: true,
            statusError: true,
            createdAt: true,
          },
        }),
      );

      return reply.send({
        documents: documents.map((d) => ({
          id: d.id,
          title: d.title,
          kind: d.kind,
          status: d.status,
          error: d.statusError,
          createdAt: d.createdAt,
        })),
      });
    },
  );
}

/**
 * Rechaza lo que no sabemos convertir, con la lista de lo que sí.
 *
 * El mensaje enumera los formatos soportados porque es la pregunta inmediata
 * de quien recibe el error, y hoy la respuesta cambia según qué conversores
 * estén registrados.
 */
/**
 * Formatos que existen, que un cliente va a subir, y que todavía no sabemos
 * convertir.
 *
 * Se comprueban por EXTENSIÓN y antes que nada. `converterFor` da prioridad al
 * MIME —con razón: un `.txt` que en realidad es HTML se convierte mejor como
 * HTML—, pero el MIME lo elige quien sube, y las librerías HTTP mandan
 * `text/plain` o `application/octet-stream` por defecto continuamente. Un PDF
 * etiquetado como `text/markdown` resolvería al conversor de Markdown, que
 * "funcionaría": extraería los bytes binarios como si fueran texto y crearía un
 * documento indexado lleno de basura, sin que nada fallara.
 *
 * Un `.pdf` es un PDF diga lo que diga la cabecera.
 */
const PENDIENTES: Record<string, string> = {
  // PDF y DOCX ya NO están aquí: tienen conversor propio.
  doc: "DOC (Word 97-2003) — guárdalo como .docx",
  xlsx: "XLSX",
  xls: "XLS",
  pptx: "PPTX",
};

function assertConvertible(filename: string, mimeType: string): void {
  const extension = extensionOf(filename);

  const pendiente = PENDIENTES[extension];
  if (pendiente !== undefined) {
    throw new ApiError(
      415,
      "unsupported_format",
      `Todavía no se pueden ingerir ficheros ${pendiente}. ` +
        `Conviértelo a Markdown o texto plano. PDF y DOCX todavía no.`,
    );
  }

  // Para todo lo demás manda la resolución real del conversor, la misma que
  // usará la ingesta. Duplicarla aquí con otra regla sería garantizar que un
  // día divergen y aceptamos algo que el worker no sabe abrir.
  if (converterFor(filename, mimeType) === undefined) {
    throw new ApiError(
      415,
      "unsupported_format",
      `No hay conversor para "${filename}" (${mimeType}). Soportados: ` +
        availableFormats()
          .map((f) => f.extensions.join(", "))
          .join(" · "),
    );
  }
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function kindFor(
  filename: string,
  mimeType: string,
): "PDF" | "DOCX" | "CSV" | "TXT" | "MARKDOWN" | "URL" {
  const lower = filename.toLowerCase();
  if (mimeType.includes("html") || lower.endsWith(".html")) return "URL";
  if (lower.endsWith(".pdf")) return "PDF";
  if (lower.endsWith(".docx")) return "DOCX";
  if (lower.endsWith(".csv")) return "CSV";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "MARKDOWN";
  return "TXT";
}

/**
 * Lee los campos de texto del multipart.
 *
 * Las fechas se validan aquí: una `expiresAt` ilegible que llegara como
 * `Invalid Date` a Prisma reventaría la transacción con un error que no dice
 * cuál de los dos campos era.
 */
function readFields(raw: unknown): UploadFields {
  const fields = raw as Record<string, { value?: unknown } | undefined>;
  const text = (name: string): string | undefined => {
    const value = fields[name]?.value;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };

  const date = (name: string): Date | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ApiError(400, "invalid_request", `"${name}" no es una fecha ISO válida.`);
    }
    return parsed;
  };

  const tags = text("tags");

  return {
    ...(text("title") === undefined ? {} : { title: text("title") as string }),
    ...(text("sourceRef") === undefined ? {} : { sourceRef: text("sourceRef") as string }),
    ...(text("category") === undefined ? {} : { category: text("category") as string }),
    ...(text("department") === undefined
      ? {}
      : { department: text("department") as string }),
    ...(tags === undefined
      ? {}
      : { tags: tags.split(",").map((t) => t.trim()).filter((t) => t !== "") }),
    ...(date("effectiveFrom") === undefined
      ? {}
      : { effectiveFrom: date("effectiveFrom") as Date }),
    ...(date("expiresAt") === undefined ? {} : { expiresAt: date("expiresAt") as Date }),
  };
}
