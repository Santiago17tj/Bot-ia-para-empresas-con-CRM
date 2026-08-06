/**
 * Bloques de Notion → Markdown.
 *
 * Es la mitad que decide si el conector sirve. El listón de un conversor en
 * este proyecto no es extraer caracteres: es **conservar encabezados**, porque
 * el troceador corta por ellos y las citas se construyen con ellos.
 *
 * Aquí, por una vez, no hay heurística. Notion guarda `heading_1`, `heading_2`
 * y `heading_3` como tipos de bloque distintos, así que la estructura viene
 * dada — al contrario que en un PDF, donde hubo que inferirla del tamaño de la
 * fuente. Perder esa estructura sería tirar información que el origen sí tenía.
 */

export interface NotionRichText {
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  /** Hijos ya resueltos por el cliente. La API los sirve aparte. */
  children?: NotionBlock[];
  [key: string]: unknown;
}

/**
 * Texto enriquecido → Markdown en línea.
 *
 * El orden de los envoltorios importa: el código va por dentro de todo porque
 * dentro de un `código` el asterisco de la negrita se vería literal. Y el
 * enlace envuelve por fuera, que es como se lee.
 */
export function richTextToMarkdown(rich: NotionRichText[] | undefined): string {
  if (!Array.isArray(rich)) return "";

  return rich
    .map((span) => {
      let text = span.plain_text ?? "";
      if (text === "") return "";

      const annotations = span.annotations ?? {};

      // Escapado mínimo: solo lo que rompería el Markdown que generamos. Un
      // escapado agresivo llena el texto de barras que luego se embeben y se
      // le enseñan al modelo como si fueran contenido.
      if (annotations.code === true) {
        text = `\`${text}\``;
      } else {
        if (annotations.bold === true) text = `**${text}**`;
        if (annotations.italic === true) text = `_${text}_`;
        if (annotations.strikethrough === true) text = `~~${text}~~`;
      }

      // El enlace se conserva porque muchas veces ES la respuesta: "el
      // formulario está aquí".
      return span.href != null && span.href !== "" ? `[${text}](${span.href})` : text;
    })
    .join("");
}

/**
 * Bloques → Markdown.
 *
 * Recursivo por las listas anidadas y los desplegables. Notion permite anidar
 * sin límite práctico, así que hay tope de profundidad: un bucle en los datos
 * —que los ha habido en su API— no puede colgar un worker.
 */
export function blocksToMarkdown(blocks: NotionBlock[], depth = 0): string {
  if (depth > 10) return "";

  const lines: string[] = [];
  let numbered = 0;

  for (const block of blocks) {
    const content = (block[block.type] ?? {}) as {
      rich_text?: NotionRichText[];
      language?: string;
      checked?: boolean;
      url?: string;
      caption?: NotionRichText[];
      title?: string;
    };
    const text = richTextToMarkdown(content.rich_text);
    const indent = "  ".repeat(depth);

    // La numeración se reinicia en cuanto aparece cualquier otro bloque: si no,
    // dos listas separadas por un párrafo se numerarían 1,2,3,4 seguidas.
    if (block.type !== "numbered_list_item") numbered = 0;

    switch (block.type) {
      case "heading_1":
        lines.push("", `# ${text}`, "");
        break;
      case "heading_2":
        lines.push("", `## ${text}`, "");
        break;
      case "heading_3":
        lines.push("", `### ${text}`, "");
        break;

      case "paragraph":
        if (text !== "") lines.push(text, "");
        break;

      case "bulleted_list_item":
        lines.push(`${indent}- ${text}`);
        break;

      case "numbered_list_item":
        numbered++;
        lines.push(`${indent}${numbered}. ${text}`);
        break;

      case "to_do":
        lines.push(`${indent}- [${content.checked === true ? "x" : " "}] ${text}`);
        break;

      case "quote":
        lines.push(`> ${text}`, "");
        break;

      case "callout":
        // Los avisos suelen llevar justo lo importante — "OJO: solo hasta el
        // día 15" — así que se conservan como cita en vez de perderse.
        lines.push(`> ${text}`, "");
        break;

      case "code":
        lines.push("```" + (content.language ?? ""), text, "```", "");
        break;

      case "divider":
        lines.push("---", "");
        break;

      case "table":
        lines.push(tableToMarkdown(block), "");
        break;

      case "toggle":
        // El resumen del desplegable es un encabezado de hecho: agrupa lo que
        // hay debajo. Se conserva como texto en negrita y no como `####`
        // porque anidados producirían una jerarquía falsa.
        if (text !== "") lines.push(`**${text}**`, "");
        break;

      case "child_page":
      case "child_database":
        // No se aplana el contenido de una subpágina aquí: se ingiere como
        // documento propio, con su propia URL para citarla. Meterla dentro
        // haría una cita que apunta a la página equivocada.
        if (typeof content.title === "string" && content.title !== "") {
          lines.push(`- ${content.title}`);
        }
        break;

      case "image":
      case "video":
      case "file":
      case "pdf": {
        // Sin OCR, un fichero incrustado no aporta texto. Se deja la leyenda,
        // que muchas veces describe lo que hay dentro.
        const caption = richTextToMarkdown(content.caption);
        if (caption !== "") lines.push(`_${caption}_`, "");
        break;
      }

      case "table_of_contents":
      case "breadcrumb":
      case "column_list":
      case "column":
        // Navegación, no contenido. Sus hijos sí se recorren.
        break;

      default:
        // Tipo desconocido: si trae texto, se conserva. Notion añade bloques
        // nuevos cada pocos meses y perderlos en silencio sería lo peor.
        if (text !== "") lines.push(text, "");
        break;
    }

    if (Array.isArray(block.children) && block.children.length > 0) {
      const nested = blocksToMarkdown(
        block.children,
        // Las listas anidan visualmente; lo demás no debe indentarse o el
        // Markdown lo interpretaría como bloque de código.
        isListItem(block.type) ? depth + 1 : depth,
      );
      if (nested.trim() !== "") lines.push(nested);
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isListItem(type: string): boolean {
  return (
    type === "bulleted_list_item" || type === "numbered_list_item" || type === "to_do"
  );
}

/**
 * Tabla de Notion → tabla de Markdown.
 *
 * Merece el esfuerzo porque una tabla es justo donde una PYME pone sus precios y
 * sus plazos. Aplanarla a texto corrido deja las cifras sin la cabecera que dice
 * qué son: se recupera perfectamente y responde mal.
 */
function tableToMarkdown(table: NotionBlock): string {
  const rows = (table.children ?? []).filter((child) => child.type === "table_row");
  if (rows.length === 0) return "";

  const cells = rows.map((row) => {
    const content = (row["table_row"] ?? {}) as { cells?: NotionRichText[][] };
    return (content.cells ?? []).map((cell) => richTextToMarkdown(cell).replace(/\|/g, "\\|"));
  });

  const [header = [], ...body] = cells;
  const width = Math.max(header.length, ...body.map((r) => r.length), 1);
  const pad = (row: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;

  return [
    pad(header),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(pad),
  ].join("\n");
}
