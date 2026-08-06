import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rawPrisma, runAsSystem } from "@platform/db";

/**
 * Carga el catálogo de prompts desde `packages/observability/prompts/`.
 *
 * El invariante es que ningún prompt vive en el código. Estos ficheros no son
 * código: son datos versionados en git que se cargan en el registro, y el
 * registro es de donde los lee la aplicación en tiempo de ejecución. Un prompt
 * que solo estuviera en un `.md` sería igual de invisible para la traza que uno
 * escrito en un `.ts` — lo que hace diagnosticable una regresión es que cada
 * ejecución archive el `versionId` que usó.
 *
 * Es una función y no solo un script porque los tests necesitan sembrar antes
 * de ejercer la ruta de respuesta. Un test que dependa de que alguien haya
 * ejecutado un script a mano es un test que falla en CI por el motivo
 * equivocado.
 */

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export interface PromptFile {
  key: string;
  version: number;
  description: string;
  variables: string[];
  notes?: string;
  template: string;
}

/**
 * Lee la cabecera y el cuerpo de un fichero de prompt.
 *
 * Parser mínimo y deliberado: las claves son escalares y una lista separada por
 * comas. Traer una dependencia de YAML para cinco campos añadiría una versión
 * que mantener a cambio de nada.
 */
export function parsePromptFile(source: string, filename: string): PromptFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (match === null) {
    throw new Error(`${filename}: falta la cabecera --- ... --- al principio`);
  }

  const [, header = "", body = ""] = match;
  const fields = new Map<string, string>();

  for (const line of header.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const separator = line.indexOf(":");
    if (separator === -1) {
      throw new Error(`${filename}: línea de cabecera sin ':' → ${line}`);
    }
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  const key = fields.get("key");
  const versionRaw = fields.get("version");
  const description = fields.get("description");

  if (key === undefined || versionRaw === undefined || description === undefined) {
    throw new Error(`${filename}: la cabecera exige key, version y description`);
  }

  const version = Number(versionRaw);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`${filename}: version debe ser un entero ≥ 1, no "${versionRaw}"`);
  }

  const variables = (fields.get("variables") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");

  // Fines de línea normalizados a LF ANTES de nada más.
  //
  // Sin esto, el mismo fichero produce dos plantillas distintas según cómo lo
  // haya dejado el checkout: 1915 caracteres en Linux y 1956 en Windows, mismo
  // texto. Las consecuencias no son cosméticas. Una, que la versión es
  // inmutable y el seed compara textos: sembrar desde Windows contra una base
  // sembrada desde Linux aborta con "ya existe con un texto distinto", que es
  // verdad y no explica nada. Dos, y peor, que el prompt que se le manda al
  // modelo depende de la máquina que sembró — así que una traza que archiva un
  // `versionId` deja de identificar un texto, que es justo lo que da a esa
  // traza su valor. Visto de verdad en un worktree de Windows contra la base
  // de desarrollo.
  //
  // Va aquí y no en un `.gitattributes` porque un `.gitattributes` arregla los
  // checkouts futuros y no los que ya existen, y porque el registro debe ser
  // insensible a esto aunque el fichero llegue de cualquier otra forma.
  const template = body.replace(/\r\n/g, "\n").trimEnd();

  // Las variables declaradas y las usadas tienen que coincidir. Una declarada
  // de menos hace que `renderTemplate` lance en producción con un nombre que
  // nadie esperaba; una de más es documentación falsa sobre qué necesita este
  // prompt para funcionar.
  const used = new Set(
    [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string),
  );
  const missing = [...used].filter((v) => !variables.includes(v));
  const unused = variables.filter((v) => !used.has(v));

  if (missing.length > 0 || unused.length > 0) {
    throw new Error(
      `${filename}: la cabecera y la plantilla no cuadran.` +
        (missing.length > 0 ? ` Usadas sin declarar: ${missing.join(", ")}.` : "") +
        (unused.length > 0 ? ` Declaradas sin usar: ${unused.join(", ")}.` : ""),
    );
  }

  const notes = fields.get("notes");
  return {
    key,
    version,
    description,
    variables,
    ...(notes === undefined ? {} : { notes }),
    template,
  };
}

export interface SeedResult {
  key: string;
  version: number;
  action: "desplegado" | "sin cambios";
}

/**
 * Siembra el catálogo entero. Idempotente: ejecutarlo dos veces no crea nada.
 *
 * Corre como sistema porque `Prompt`, `PromptVersion` y el despliegue global no
 * llevan filtro de tenant: el catálogo es de la plataforma, no de un cliente.
 */
export async function seedPrompts(
  options: { silent?: boolean } = {},
): Promise<SeedResult[]> {
  const files = (await readdir(promptsDir)).filter((f) => f.endsWith(".md")).sort();
  const results: SeedResult[] = [];

  for (const filename of files) {
    const parsed = parsePromptFile(
      await readFile(join(promptsDir, filename), "utf8"),
      filename,
    );

    const result = await runAsSystem(
      `seed de prompts: ${parsed.key} v${parsed.version}`,
      () => seedOne(parsed, filename),
    );

    results.push(result);
    if (options.silent !== true) {
      console.log(`[prompts] ${result.key} v${result.version}: ${result.action}`);
    }
  }

  return results;
}

async function seedOne(parsed: PromptFile, filename: string): Promise<SeedResult> {
  const prompt = await rawPrisma.prompt.upsert({
    where: { key: parsed.key },
    update: { description: parsed.description },
    create: { key: parsed.key, description: parsed.description },
  });

  const existing = await rawPrisma.promptVersion.findUnique({
    where: { promptId_version: { promptId: prompt.id, version: parsed.version } },
  });

  // Una versión es inmutable. Si el texto cambió, lo que toca es una versión
  // nueva: editar la vigente deja archivadas respuestas que citan un
  // `versionId` cuyo texto ya no es el que las produjo, y con eso la traza deja
  // de explicar nada.
  if (existing !== null && existing.template !== parsed.template) {
    throw new Error(
      `${filename}: la versión ${parsed.version} de "${parsed.key}" ya existe ` +
        "con un texto distinto. Las versiones son inmutables: sube el número " +
        "de versión y renombra el fichero en vez de editarla.",
    );
  }

  const promptVersion =
    existing ??
    (await rawPrisma.promptVersion.create({
      data: {
        promptId: prompt.id,
        version: parsed.version,
        template: parsed.template,
        variables: parsed.variables,
        ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
        createdBy: "seed-prompts",
      },
    }));

  // Despliegue global (tenantId null). Los despliegues por tenant se hacen
  // desde el producto, no desde aquí: esto solo garantiza que hay un valor por
  // defecto servible.
  const deployed = await rawPrisma.promptDeployment.findFirst({
    where: { promptId: prompt.id, tenantId: null, isActive: true },
  });

  if (deployed?.versionId === promptVersion.id) {
    return { key: parsed.key, version: parsed.version, action: "sin cambios" };
  }

  if (deployed !== null) {
    await rawPrisma.promptDeployment.update({
      where: { id: deployed.id },
      data: { isActive: false },
    });
  }

  await rawPrisma.promptDeployment.create({
    data: {
      promptId: prompt.id,
      versionId: promptVersion.id,
      tenantId: null,
      trafficPercent: 100,
      isActive: true,
      deployedBy: "seed-prompts",
    },
  });

  return { key: parsed.key, version: parsed.version, action: "desplegado" };
}
