/**
 * La interfaz, en HTML servido tal cual.
 *
 * Sin React, sin empaquetador y sin paso de compilación de front. No es
 * ascetismo: el panel tiene tres pantallas y ninguna tiene estado que merezca
 * un framework, y meter uno aquí añadiría un segundo sistema de build al
 * monorepo —con su lockfile, su caché y su versión de Node— a cambio de nada
 * que se vea. El día que haya un editor de flujos se replantea.
 *
 * Todo el JS habla con `/api/*` del propio panel. Nunca con la API directamente:
 * la credencial vive en una cookie `httpOnly` que este código no puede leer, y
 * ese es justo el punto.
 */

export type PageKind = "login" | "app";

export function page(kind: PageKind): string {
  return kind === "login" ? LOGIN : APP;
}

const STYLE = `
  :root {
    --fondo: #0f1115; --panel: #171a21; --borde: #262b36;
    --texto: #e6e8ec; --tenue: #9aa3b2; --acento: #4c8dff;
    --bien: #3fb950; --mal: #f85149; --aviso: #d29922;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --fondo: #f6f7f9; --panel: #ffffff; --borde: #dfe3ea;
      --texto: #1b1f27; --tenue: #5b6472; --acento: #1f6feb;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--fondo); color: var(--texto);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 1rem;
    padding: 1rem 1.5rem; border-bottom: 1px solid var(--borde);
  }
  header h1 { font-size: 1rem; margin: 0; }
  header .sub { color: var(--tenue); font-size: .85rem; }
  header button { margin-left: auto; }
  main { max-width: 60rem; margin: 0 auto; padding: 1.5rem; }
  nav { display: flex; gap: .5rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
  nav button {
    background: transparent; border: 1px solid var(--borde); color: var(--tenue);
  }
  nav button[aria-selected="true"] { color: var(--texto); border-color: var(--acento); }
  section[hidden] { display: none; }
  .caja {
    background: var(--panel); border: 1px solid var(--borde);
    border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem;
  }
  h2 { font-size: .95rem; margin: 0 0 .75rem; }
  p.ayuda { color: var(--tenue); font-size: .85rem; margin: .25rem 0 1rem; }
  input, textarea, button, select {
    font: inherit; border-radius: 8px; border: 1px solid var(--borde);
    background: var(--fondo); color: var(--texto); padding: .55rem .7rem;
  }
  input, textarea { width: 100%; }
  textarea { min-height: 4.5rem; resize: vertical; }
  button { cursor: pointer; background: var(--acento); color: #fff; border-color: transparent; }
  button:disabled { opacity: .55; cursor: default; }
  .fila { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid var(--borde); vertical-align: top; }
  th { color: var(--tenue); font-weight: 600; }
  .etiqueta { font-size: .78rem; padding: .1rem .5rem; border-radius: 999px; border: 1px solid var(--borde); }
  .READY, .ok { color: var(--bien); border-color: currentColor; }
  .FAILED, .mal { color: var(--mal); border-color: currentColor; }
  .PENDING, .RUNNING, .aviso { color: var(--aviso); border-color: currentColor; }
  .cita { border-left: 2px solid var(--acento); padding-left: .7rem; margin: .5rem 0; color: var(--tenue); font-size: .88rem; }
  .error { color: var(--mal); font-size: .88rem; }
  .vacio { color: var(--tenue); font-size: .9rem; padding: .75rem 0; }
  code { background: var(--fondo); padding: .1rem .3rem; border-radius: 4px; font-size: .85em; }
`;

const LOGIN = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrar · Enterprise AI OS</title><style>${STYLE}
  body { display: grid; place-items: center; min-height: 100vh; }
  main { width: min(28rem, 92vw); }
</style></head><body><main>
  <div class="caja">
    <h2>Enterprise AI OS</h2>
    <p class="ayuda">
      Pega la clave de API de tu tenant. Se emite con
      <code>npm run issue-key -w @platform/api -- &lt;tenantId&gt; "nombre"</code>.
    </p>
    <form id="f">
      <input id="k" type="password" autocomplete="off" placeholder="sk_..." required>
      <p class="ayuda">
        La clave no se guarda en el navegador: viaja al panel, que la cifra y la
        deja en una cookie que este JavaScript no puede leer.
      </p>
      <button type="submit">Entrar</button>
      <p id="e" class="error"></p>
    </form>
  </div>
</main><script>
const f = document.getElementById("f");
f.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const e = document.getElementById("e");
  e.textContent = "";
  const r = await fetch("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: document.getElementById("k").value }),
  });
  if (r.ok) { location.reload(); return; }
  const cuerpo = await r.json().catch(() => ({}));
  e.textContent = cuerpo.message ?? "No se pudo iniciar sesión.";
});
</script></body></html>`;

const APP = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enterprise AI OS</title><style>${STYLE}</style></head><body>
<header>
  <h1>Enterprise AI OS</h1>
  <span class="sub">panel de operación</span>
  <button id="salir">Salir</button>
</header>
<main>
  <nav>
    <button data-t="conocimiento" aria-selected="true">Conocimiento</button>
    <button data-t="preguntar" aria-selected="false">Preguntar</button>
    <button data-t="huecos" aria-selected="false">Huecos</button>
  </nav>

  <section id="conocimiento">
    <div class="caja">
      <h2>Subir un documento</h2>
      <p class="ayuda">
        PDF, DOCX, Markdown, texto o CSV. La respuesta es un 202: indexar no cabe
        en un timeout HTTP, así que lo hace el worker y el estado se ve abajo.
      </p>
      <div class="fila">
        <input id="fichero" type="file" style="flex:1">
        <button id="subir">Subir</button>
      </div>
      <p id="subida" class="ayuda"></p>
    </div>
    <div class="caja">
      <h2>Documentos</h2>
      <div id="docs"><p class="vacio">Cargando…</p></div>
    </div>
  </section>

  <section id="preguntar" hidden>
    <div class="caja">
      <h2>Preguntar a la documentación</h2>
      <p class="ayuda">
        Cada afirmación se sirve con su cita, y la cita se comprueba contra el
        fragmento antes de enseñarla. Si no cuadra, el sistema se abstiene.
      </p>
      <textarea id="pregunta" placeholder="¿Cuántos días tengo para devolver un pedido?"></textarea>
      <div class="fila" style="margin-top:.6rem">
        <button id="preguntar-btn">Preguntar</button>
        <span id="estado-pregunta" class="ayuda"></span>
      </div>
      <div id="respuesta"></div>
    </div>
  </section>

  <section id="huecos" hidden>
    <div class="caja">
      <h2>Lo que preguntan y no sabes responder</h2>
      <p class="ayuda">
        Ordenado por número de veces, no por fecha: lo último que preguntó
        alguien es una anécdota; lo que preguntan treinta dirige el trabajo.
      </p>
      <div id="lista-huecos"><p class="vacio">Cargando…</p></div>
    </div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(ruta, opciones = {}) {
  const r = await fetch("/api/" + ruta, opciones);
  if (r.status === 401) { location.reload(); throw new Error("sesión caducada"); }
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(cuerpo?.error?.message ?? "Error " + r.status);
  return cuerpo;
}

// --- Navegación -----------------------------------------------------------
document.querySelectorAll("nav button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((o) => {
      o.setAttribute("aria-selected", String(o === b));
      $(o.dataset.t).hidden = o !== b;
    });
    if (b.dataset.t === "huecos") cargarHuecos();
    if (b.dataset.t === "conocimiento") cargarDocs();
  });
});

$("salir").addEventListener("click", async () => {
  await fetch("/session/end", { method: "POST" });
  location.reload();
});

// --- Conocimiento ---------------------------------------------------------
async function cargarDocs() {
  try {
    const { documents = [] } = await api("knowledge/documents");
    $("docs").innerHTML = documents.length === 0
      ? '<p class="vacio">Todavía no hay documentos. Sube uno arriba.</p>'
      // Las columnas son exactamente los campos que devuelve la API. Una que
      // siempre enseña "—" porque el dato no existe no es un hueco de datos,
      // es ruido que hace dudar de las que sí valen.
      : '<table><tr><th>Documento</th><th>Tipo</th><th>Estado</th><th>Subido</th></tr>' +
        documents.map((d) =>
          '<tr><td>' + esc(d.title ?? d.id) + '</td>' +
          '<td class="ayuda">' + esc(d.kind) + '</td>' +
          '<td><span class="etiqueta ' + esc(d.status) + '">' + esc(d.status) + '</span>' +
          (d.error ? '<div class="error">' + esc(d.error) + '</div>' : '') + '</td>' +
          '<td class="ayuda">' + new Date(d.createdAt).toLocaleString("es-ES") +
          '</td></tr>').join("") + '</table>';
  } catch (e) { $("docs").innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}

$("subir").addEventListener("click", async () => {
  const f = $("fichero").files?.[0];
  if (!f) { $("subida").textContent = "Elige un fichero primero."; return; }

  $("subir").disabled = true;
  $("subida").textContent = "Subiendo…";
  try {
    const datos = new FormData();
    datos.append("file", f);
    await api("knowledge/documents", { method: "POST", body: datos });
    $("subida").textContent = "Aceptado. El worker lo está indexando; el estado se actualiza solo.";
    $("fichero").value = "";
    // Se sondea porque la ingesta es asíncrona a propósito. Sin esto habría que
    // recargar a mano para ver PENDING → READY, que es justo lo que hace que
    // parezca que no ha pasado nada.
    for (const espera of [1000, 2000, 4000, 8000]) setTimeout(cargarDocs, espera);
  } catch (e) { $("subida").innerHTML = '<span class="error">' + esc(e.message) + '</span>'; }
  finally { $("subir").disabled = false; }
});

// --- Preguntar ------------------------------------------------------------
$("preguntar-btn").addEventListener("click", async () => {
  const question = $("pregunta").value.trim();
  if (question === "") return;

  $("preguntar-btn").disabled = true;
  $("estado-pregunta").textContent = "Pensando…";
  $("respuesta").innerHTML = "";
  try {
    const r = await api("knowledge/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });

    // Una abstención NO se enseña como un fallo: es el comportamiento correcto
    // y el que hace vendible el producto. Pintarla en rojo enseñaría a quien
    // mira el panel a desconfiar justo de lo que mejor funciona.
    const citas = (r.citations ?? []).map((c) =>
      '<div class="cita">' + esc(c.quote ?? "") +
      (c.title ? '<br><small>' + esc(c.title) + (c.pageNumber ? ", pág. " + c.pageNumber : "") + '</small>' : '') +
      '</div>').join("");

    $("respuesta").innerHTML =
      '<p><span class="etiqueta ' + (r.answered ? "ok" : "aviso") + '">' +
      (r.answered ? "respondido" : "sin respuesta en la documentación") + '</span></p>' +
      '<p>' + esc(r.response) + '</p>' + citas;
  } catch (e) { $("respuesta").innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
  finally { $("preguntar-btn").disabled = false; $("estado-pregunta").textContent = ""; }
});

// --- Huecos ---------------------------------------------------------------
async function cargarHuecos() {
  try {
    const { gaps = [] } = await api("knowledge/gaps?limit=100");
    const MOTIVO = {
      BELOW_THRESHOLD: "no había material",
      MODEL_ABSTAINED: "había documentación cercana que no lo cubre",
      GROUNDING_FAILED: "además intentó rellenarlo",
    };
    $("lista-huecos").innerHTML = gaps.length === 0
      ? '<p class="vacio">Ningún hueco todavía. Aparecen solos cada vez que el sistema se abstiene.</p>'
      : '<table><tr><th>Pregunta</th><th>Veces</th><th>Motivo</th></tr>' +
        gaps.map((g) =>
          '<tr><td>' + esc(g.question) +
          ((g.variants ?? []).length > 1
            ? '<div class="ayuda">También: ' + esc(g.variants.slice(1, 4).join(" · ")) + '</div>'
            : '') +
          '</td><td>' + g.occurrences + '</td>' +
          '<td class="ayuda">' + esc(MOTIVO[g.reason] ?? g.reason) + '</td></tr>').join("") + '</table>';
  } catch (e) { $("lista-huecos").innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}

cargarDocs();
</script></body></html>`;
