# Enterprise AI OS — contexto para Claude

## Qué es esto

**No es un chatbot.** Es un motor empresarial de conocimiento, razonamiento,
acciones e integraciones; el chat es una de sus interfaces, ni la primera ni la
más importante. Multi-tenant, en español, orientado a PYME.

La arquitectura completa está en **[`PLAN-TECNICO.md`](PLAN-TECNICO.md)** (v3, 38
secciones). Los comentarios del código citan sus secciones como `§6.2`. **Léelo
antes de proponer arquitectura** — el usuario ha especificado 55 capacidades en
tres bloques y hay tabla de trazabilidad en §38.

Regla de núcleo, que el usuario quiere como filtro de toda decisión:

> ¿Esto hace que la empresa dependa más del conocimiento que genera la
> plataforma? Si sí, es núcleo. Si solo mejora el chat, es interfaz y no debe
> condicionar la arquitectura.

## Arranque

```bash
cd platform
npm install
npm run db:up                  # Postgres 17 + pgvector en el puerto 5433
npm run setup -w @platform/db  # migraciones + SQL crudo (vector, tsvector, RLS)
npm run prompts:seed           # carga el catálogo de prompts en el registro
npm test                       # 408 tests
```

**`setup` y NO `db:migrate`.** `prisma migrate dev` detecta como deriva las
columnas que añade el SQL crudo —vectores, tsvector, políticas RLS— y ofrece
resetear la base. Decir que sí borra los datos de desarrollo. `setup` es
`migrate deploy` + el SQL crudo, que es lo correcto aquí y lo que usa CI.

Esta secuencia está **verificada contra un checkout limpio y un Postgres
vacío**, no solo escrita: desde cero hasta los 408 tests en verde.

Ese «checkout limpio» hay que decirlo aparte, porque durante doce ejecuciones de
CI la secuencia estuvo rota y en local no se notaba. `apply-sql.ts` importa
`@platform/env/load`, que vive en `dist/`, y `setup` corría antes de compilar
nada: en una máquina de desarrollo el `dist/` ya estaba de la vez anterior, y en
un runner recién clonado no. Arreglado haciendo que `apply-sql` compile primero,
como ya hacían `test`, `eval` y `prompts:seed`. Ver **La CI nunca había pasado**.

`.env` ya existe en `platform/` (ignorado por git). `.env.example` lo documenta.

### Dónde viven las claves, y por qué se atasca la gente aquí

Son **dos sitios distintos para dos cosas distintas**, y confundirlos cuesta un
rato:

- **`platform/.env`** — lo único que leen los comandos locales (`npm run eval`,
  `npm run dev`, `npm run worker`).
- **Secreto de GitHub** (`Settings → Secrets → Actions`) — lo único que lee CI.
  Es de **escritura únicamente**: ni la web lo vuelve a enseñar ni ningún
  proceso local puede leerlo. Guardar la clave ahí NO la deja disponible en la
  máquina.

Así que para medir en local hay que poner la clave en el `.env`, aunque ya esté
en GitHub. No es duplicar por descuido: son dos entornos que no se ven.

**No pases claves por la línea de comandos en Windows.** `VAR=x comando` es
sintaxis de bash y en `cmd.exe` da "no se reconoce como un comando interno o
externo". En PowerShell hay que escribir `$env:VAR="x"; comando`, y con `set` en
cmd la variable **se queda puesta** en esa terminal — que es la causa habitual
de "medí Groq y me salió el número del modelo local". Con la clave en el `.env`,
nada de esto importa.

`npm run eval` corre la medición completa (recuperación **y** abstención) contra
Postgres real y un generador real. Necesita el catálogo sembrado; si falta, lo
dice y explica cómo. Sale con código 1 si la puerta bloquea, para servir en CI.

### Docker en esta máquina

Docker Desktop **no arranca solo** (`AutoStart: false`). Si `docker ps` falla,
lánzalo:

```bash
powershell -c "Start-Process 'C:\Users\Isabel\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe'"
```

Tarda entre 1 y 4 minutos. El grupo `docker-users` no existe pero es opcional:
el diálogo "Continue" funciona.

**Los sockets huérfanos vuelven.** No fue un incidente aislado de la instalación
inicial: reaparecen cada pocos días. El error es siempre de la misma forma —
"An unexpected error occurred ... remove <ruta>.sock: The file cannot be accessed
by the system"— y cambia solo qué socket lo provoca. Vistos hasta ahora:

- `AppData\Local\Docker\run\dockerInference`
- `AppData\Local\Docker\run\dockerDesktopLinuxEngine`
- `AppData\Local\docker-secrets-engine\engine.sock`

El remedio es el mismo y funciona: parar todos los procesos `*docker*` y
**RENOMBRAR el directorio padre** del socket que nombre el error. Borrarlo no se
puede, ni siquiera tras reiniciar; renombrarlo sí, y Docker crea uno nuevo
limpio al arrancar. En `AppData\Local\Docker` se acumulan los renombrados de
veces anteriores, y se pueden ignorar.

```powershell
Get-Process | Where-Object { $_.Name -like '*docker*' } | Stop-Process -Force
Rename-Item 'C:\Users\Isabel\AppData\Local\Docker\run' 'run-roto-1'
```

Un detalle útil: el error puede saltar **con Docker ya funcionando**. Si el
socket que falla es de un servicio secundario —el motor de secretos, por
ejemplo— los contenedores arrancan y responden igual; comprueba con `docker ps`
antes de perseguir el diálogo.

## Estado

**Fase 0 y Fase 1 completas.**

**Fase 2 en marcha:** conectores, huecos de conocimiento y chat ya están.

El ciclo completo funciona de punta a punta y está verificado: se sube un PDF o
un DOCX por la API —o se conecta una web, Notion o Drive, que se sincronizan
solos por cron—, un worker lo indexa, y queda respondiendo preguntas con citas
validadas en código. Cada abstención se registra como hueco de conocimiento, y
el chat da continuidad entre turnos.

| Paquete | Qué es | Tests |
|---|---|---|
| `env` | Carga del único `.env` de la raíz | — |
| `db` | 28 modelos, aislamiento 3 capas, RLS | 11 + 9 int. |
| `providers` | `AIProvider` + `EmbeddingProvider`, 2 adaptadores | 23 |
| `events` | Outbox transaccional + despachador | 11 |
| `observability` | Trazas, Prompt Registry, siembra, consumo | 12 |
| `context` | Context Engine, presupuesto, recetas | 22 |
| `knowledge` | Conversión, troceado, híbrida, grounding, respuesta, huecos, **conversación** | 58 + 28 int. |
| `eval` | Arnés con abstención, **conversación**, modo `full` | 12 int. |
| `storage` | Costura de ficheros + driver local | 15 |
| `secrets` | Cifrado en reposo AES-256-GCM, llavero, redacción | 17 |
| `connectors` | Web, Notion, **Drive**, SSRF, cron con **zona horaria** | 107 |
| `apps/api` | Fastify, API key → tenant, `/v1/knowledge/*`, `/v1/sources`, `/v1/chat`, `/v1/contacts` | 39 int. |
| `apps/worker` | Outbox, ingesta, huecos, sincronización, planificador | 30 int. |
| `apps/panel` | **Panel de operación**: proxy con sesión cifrada, 3 pantallas | 9 int. |

El arnés corrió en modo `full` contra un generador real y la puerta PASA (ver
**Estado actual del arnés**). CI lo ejecuta en cada push — desde que se arregló,
porque durante doce ejecuciones no ejecutó nada. Ver **La CI nunca había
pasado**.

## Invariantes que NO se pueden romper

**Aislamiento en tres capas.** `tenantId` en cada tabla con unicidades
compuestas · extensión de Prisma que falla cerrado sin contexto · políticas RLS.
`test/isolation.test.ts` verifica que las tres nombran las mismas tablas; una
tabla en una lista y no en otra es el conjunto con una sola defensa.

- La aplicación usa `prisma` (filtrado) dentro de `runWithTenant`.
- `systemPrisma` **se salta RLS**: crear tenants, migrar y limpiar en tests.
  Nunca en la ruta de una petición.

Hay **dos excepciones sancionadas**, y ninguna de las dos es una petición:
`findApiKeyByHash` en `@platform/db` —que averigua a qué tenant pertenece una
credencial, que es justo lo que aún no se sabe— y el planificador, que por
definición mira todos los tenants para saber a quién le toca sincronizar. Las
dos están encapsuladas con nombre propio para poder auditarlas leyendo quién las
llama. Ver **Cuatro trampas de este entorno**.

**`publish()` exige el cliente de transacción del llamante.** Es la garantía
entera del outbox: si abriera su propia conexión, podría confirmarse mientras el
cambio que lo motivó se revierte.

**Ningún prompt vive en el código.** Prompt Registry, versionado. Una variable
sin valor lanza en vez de dejar el marcador — un `{{fallbackMessage}}` literal
llegando al modelo produce respuestas plausibles y mal fundadas.

**El trabajo lento va fuera de las transacciones.** La ingesta tiene tres fases
por esto: embeber dentro de una transacción la mantenía abierta durante toda la
llamada al proveedor y expiraba.

**El adaptador descarta parámetros que el modelo rechaza.** `claude-opus-5`
devuelve 400 si recibe `temperature`, y `TenantAIConfig` la expone como ajuste
del cliente. Reenviarla ciegamente rompería a todos los tenants al cambiar el
modelo por defecto.

**Sin salida estructurada no se genera.** `answerFromKnowledge` falla al entrar
si el proveedor no puede exigir un esquema. `json_object` garantiza JSON válido
y **nada** sobre su forma, así que no cuenta como salida estructurada: el modelo
devuelve un objeto sin `citations` y el fallo no es ruidoso — es una respuesta
bien formada y sin fundar. Por eso `capabilities.structuredOutput` es `true`
solo con `json_schema`.

**Toda lectura de tenant va dentro de `withRlsTransaction`.** Las políticas RLS
leen `app.tenant_id` de la SESIÓN de Postgres, y eso lo fija esa función de
forma local a la transacción. Una consulta con `prisma` fuera de transacción
tiene contexto de aplicación y no tiene el de Postgres — y **no falla**: la capa
2 añade su `WHERE tenantId`, la capa 3 no deja pasar nada, y salen **cero filas
en silencio**. No es una fuga, pero sí un listado vacío o un `TenantAIConfig`
que parece no existir y se sustituye por los valores por defecto del sistema.
Pasó de verdad: la ruta de respuesta servía el umbral por defecto en vez del del
cliente, todo verde y todo mal. En la API se usa `readInTenant`, que es la única
forma correcta de leer en un manejador.

**Las consultas de Prisma son perezosas.** `withTenant` hace `await` de la
función que recibe, y ese `await` no sobra: `withTenant(ctx, () => prisma.x.findMany())`
construye la consulta dentro del contexto y la ejecutaría FUERA, con el
AsyncLocalStorage ya cerrado.

**El tenant sale de la credencial, nunca de la petición.** Si el `tenantId`
fuera un campo del cuerpo, bastaría cambiarlo: las políticas RLS obedecen al
contexto que abre la aplicación, no a la verdad. `findApiKeyByHash` en
`@platform/db` es la **única** excepción sancionada a "el cliente que se salta
RLS no aparece en la ruta de una petición" — la tabla `apiKey` lleva `tenantId`
y política RLS, y el tenant es justo lo que esa consulta averigua. Está
encapsulada con nombre propio para que se pueda auditar leyendo quién la llama;
la API nunca importa `systemPrisma`.

Olvidar `withTenant` en una ruta NO filtra datos: la extensión de Prisma falla
cerrado y la petición muere con un 500. El olvido produce un error ruidoso.

**Lo que no valida no llega al usuario.** Si una cita no aparece literalmente en
su fragmento, se sirve el mensaje de reserva del tenant, no la respuesta del
modelo. Una respuesta con una cita inventada es peor que una abstención porque
parece fundada. Se distingue en las métricas: `degraded` (el modelo intentó
inventar y la red aguantó) no es lo mismo que una abstención limpia.

## Hallazgos medidos — no obvios, costaron descubrirlos

**La similitud coseno no es una señal de abstención.** Medido sobre
`multilingual-e5-small` (`packages/eval/scripts/calibrate.mjs`):

| | Similitud |
|---|---|
| Respondibles | 0,853 – 0,927 |
| Sin respuesta | 0,775 – 0,846 |
| Hueco | **0,0075** |

Siete milésimas. Estos modelos comprimen todo en una banda alta y estrecha. El
umbral solo descarta el disparate (una receta de cocina puntúa 0,77); **la
abstención la deciden las capas 4–6**, que necesitan generador. No subas el
umbral para intentar que haga ese trabajo: produce sobreabstención sin evitar
una sola invención.

**RRF sirve para ordenar, no para umbralizar.** Su valor depende solo de `k` y
la posición (techo 0,0164 por rama), así que umbralizarlo exige de facto
aparecer en las dos ramas. Medido: 83% de sobreabstención antes de corregirlo.

**El modo `retrieval` del arnés NO mide abstención.** Mide bien recall,
precisión y latencia. El código lo dice explícitamente y emite un aviso. Para
abstención hace falta el modo `full`: `npm run eval`.

**En Groq, la salida estructurada es propiedad del MODELO, no del backend.**
`llama-3.3-70b-versatile` —la elección obvia por tamaño— responde 400 con
`This model does not support response format json_schema`. Solo la familia
`openai/gpt-oss` lo acepta; `qwen3.6-27b` tampoco. Por eso el perfil de Groq
lleva lista blanca y falla cerrado: un modelo desconocido al que se le suponga
capacidad de exigir citas es el fallo silencioso que este sistema existe para no
tener. Comprobado contra la API, no leído en una documentación.

**El arnés daba 100% de recall y precisión sin medir nada.** Ningún caso
declaraba `expectedSources` —no puede: los ids de fragmento nacen en la
ingesta—, así que ambas métricas dividían 0 entre 0 y `ratio()` devolvía 1. Y
`expectedContains` estaba declarado en el tipo y **no lo leía nadie**: una
respuesta bien citada y equivocada contaba como acierto. Corregido: el recall se
mide sobre el contenido de los fragmentos, la precisión dice `n/a` cuando nadie
la mide, y hay métrica de respuestas erróneas con umbral cero. Un 100% que
significa "no se midió" es peor que un hueco, porque nadie lo investiga.

**El coseno tampoco distingue "misma pregunta" de "mismo tema".** Segunda vez
que este proyecto se encuentra con lo mismo. Medido en
`packages/eval/scripts/calibrate-gaps.mjs`:

| | Similitud |
|---|---|
| Equivalentes («¿ofrecéis financiación?» ≈ «¿puedo pagar a plazos?») | 0,842 – 0,939 |
| Distintas («¿cuánto **cuesta** el envío?» ≠ «¿cuánto **tarda** el envío?») | 0,885 – 0,948 |

Se solapan enteros y **al revés**: el par más parecido de la muestra (0,948) son
dos preguntas distintas y el menos parecido (0,842) es la misma pregunta con
otras palabras. Estos modelos codifican el TEMA, y dos preguntas del mismo tema
comparten casi todo el vector aunque pidan cosas opuestas. No hay umbral.

Por eso los huecos se agrupan con el generador y el vector solo preselecciona
candidatos. Si alguien vuelve a poner un umbral ahí, esta tabla dice por qué no.

**La reescritura mueve la pregunta de la banda "sin respuesta" a la banda
"respondible".** Medido en `packages/eval/scripts/calibrate-followups.mjs`:

| Seguimiento | Crudo | Reescrito |
|---|---|---|
| «¿Y a Canarias?» | 0,824 | **0,928** |
| «¿Y si ya lo he usado?» | 0,794 | **0,859** |
| «¿Qué garantía…?» (ya se entendía sola) | 0,887 | 0,887 |

Compárense con la tabla de calibración de arriba: 0,824 y 0,794 caen dentro de
la banda de las preguntas SIN respuesta (0,775–0,846); 0,928 y 0,859 caen dentro
de la de las respondibles (0,853–0,927). O sea que un seguimiento sin reescribir
no es solo "peor consulta": **se parece a una pregunta que el corpus no cubre**.

**Y aun así, sobre este corpus la recuperación no lo nota.** El mismo script lo
dice: 0 de 3 casos cambian de fragmentos al reescribir. No es que la reescritura
sobre — es que el corpus de referencia tiene **cinco fragmentos** y se piden
tres, así que cada consulta devuelve el 60% de todo lo que hay y el fragmento
bueno está en la lista se pregunte como se pregunte.

Esto costó un test falso: se escribió uno que afirmaba «un seguimiento sin
reescribir no recupera la respuesta», y falló, porque sobre este corpus sí la
recupera. Lo que hay en su lugar comprueba lo que sí se puede comprobar —que el
ejecutor busca el texto REESCRITO— reescribiendo a propósito hacia otro tema. El
valor de la reescritura en este conjunto se mide en modo `full`, en lo que el
generador hace con el TEXTO de la pregunta. Un corpus más grande volvería a
separar; el script es cómo se comprueba.

**El `.env` seleccionaba embeddings de OpenAI mientras todo se medía con el
local.** `EMBEDDING_PROVIDER=openai` con la clave vacía, frente a los 384d de
`multilingual-e5-small` sobre los que se calibró todo lo de arriba. Los tests no
lo detectaban porque instancian `LocalEmbeddingProvider` a mano; lo destapó el
primer script que llamó a `createEmbeddingProvider()`. Corregido en
`.env.example`. **Si tu `.env` local sigue diciendo `openai`, cámbialo**: con esa
configuración cualquier código que resuelva el proveedor por registro falla, y
si llegara a funcionar mediría un sistema distinto del calibrado.

## Estado actual del arnés

Medición real, modo `full`, contra Postgres y Groq (`openai/gpt-oss-120b`).

**Esta cifra es de ANTES de los casos conversacionales.** Son 10 casos; hoy el
conjunto tiene 14. Volver a medirla con Groq es el primer punto de **Próximo
paso** — hasta entonces, léase como el número del conjunto de un turno, que
sigue siendo válido para lo que mide.

```
Recall@k              100.0%  (6 casos)
Precision             n/a  (ningún caso lo mide)
Abstención correcta   100.0%   ← 4 casos, incluida la trampa
Tasa de alucinación     0.0%
Sobreabstención         0.0%
Respuestas erróneas     0.0%
Fallos de citación      0.0%
Latencia p50 / p95    2083 ms / 14962 ms
Coste total          $0.0043   (precio de lista; el plan gratuito factura 0)
RESULTADO: PASA
```

**El producto es vendible por esta métrica.** El caso que lo demuestra es
`sin-plazo-reembolso`: el corpus fija el plazo para DEVOLVER (30 días) y no dice
nada del plazo de REEMBOLSO. Similitud alta, respuesta inexistente, ningún
umbral la filtraría. El generador se abstiene.

La latencia p95 de 15 s es de las abstenciones: el modelo razona más cuando
decide que no puede responder. Es coste bien gastado, pero con streaming habrá
que enseñar algo mientras tanto.

## La decisión del generador, resuelta

Groq contra Ollama **no era una decisión de arquitectura**: los dos hablan
`POST /v1/chat/completions` de OpenAI. La decisión real era qué protocolo habla
el segundo adaptador del puerto `AIProvider`, y la respuesta es ese, porque
además resuelve el caso on-premise — un cliente que no puede sacar sus datos
apunta `AI_BASE_URL` a su propio vLLM y no cambia una línea de código.

`packages/providers/src/ai/openai-compatible.ts` sirve Groq, Ollama, vLLM, LM
Studio, Together y OpenRouter. Elegir entre ellos es una variable de entorno:

```bash
AI_PROVIDER=groq    GROQ_API_KEY=...   # requiere cuenta gratuita
AI_PROVIDER=ollama                     # sin cuenta; ollama pull qwen2.5:7b-instruct
```

**En uso: Groq con `openai/gpt-oss-120b`**, que es el modelo por defecto del
backend. No es el más grande del catálogo a propósito — ver el hallazgo sobre
salida estructurada. Un modelo de esa talla hace que un mal número sea
atribuible al pipeline; con uno pequeño en local, "abstención 40%" no distingue
entre pipeline roto y modelo corto, que es justo la ambigüedad que un arnés
existe para eliminar. Ollama queda como el camino sin cuenta y como la respuesta
on-premise.

El precio declarado en el perfil del backend es el de LISTA, aunque el plan
gratuito facture 0: así el informe dice cuánto costaría esa tirada en
producción, que es la cifra que importa para el producto. La tirada completa
sale a $0,0043.

## Los tres generadores, medidos

Mismo conjunto, mismo corpus, misma máquina:

| | Groq `gpt-oss-120b` | local `qwen2.5:7b` | local `qwen2.5:3b` |
|---|---|---|---|
| Abstención correcta | 100% | 100% | 100% |
| Alucinación | 0% | 0% | 0% |
| Sobreabstención | 0% | 16,7% | 33,3% |
| Fallos de citación | 0% | 0% | 10% |
| Latencia p50 | 2,1 s | 134 s | 31 s |
| Latencia p95 | 15 s | 394 s | 73 s |
| Puerta | PASA | PASA | **BLOQUEA** |

**Ninguno inventa.** Ese es el resultado que importa: la arquitectura —salida
estructurada con citas obligatorias más validación en código— aguanta incluso
con un 3B. Lo que se degrada al bajar de modelo no es la seguridad, es la
utilidad: los pequeños se callan cosas que sí sabían.

El 3B además falla al citar el 10% de las veces (copió un paréntesis que no
estaba en el fragmento) y la red lo tumbó a abstención. Bloquea, y es correcto.

**Para on-premise, el 7B es servible en calidad y no en latencia**: 6,5 minutos
en el peor caso sobre CPU. Ese cliente necesita GPU, y ahora se puede decir con
un número antes de firmar.

**Para repetir la tirada local hay que subir el timeout.** El del adaptador son
120 s por defecto, y el comentario del código dice que es generoso a propósito
«porque un timeout corto convierte lento en roto y el arnés lo contaría como
abstención». No lo es bastante para esta misma tabla: **120 s está por debajo
del p50 del 7B (134 s)**, así que la medición muere con «The operation was
aborted due to timeout» antes de llegar al informe. Se sube con `AI_TIMEOUT_MS`
en el `.env`, junto al proveedor — no delante del comando, por lo de **Dónde
viven las claves**:

```bash
AI_PROVIDER="ollama"
AI_TIMEOUT_MS="900000"
```

Y después `npm run eval` a secas. Acuérdate de devolver `AI_PROVIDER` a `groq`
al terminar: un `.env` que se quedó en `ollama` es la otra forma de «medí Groq y
me salió el número del modelo local».

Contra Groq no aparece —p95 de 15 s— así que solo muerde en el camino
on-premise, que es justo el que se prueba menos.

## La API

```bash
npm run dev      # API, en el PORT del .env
npm run worker   # worker, en OTRA terminal
npm run issue-key -w @platform/api -- <tenantId> "nombre"
```

Sin ámbitos, la clave sale con los cinco por defecto: `knowledge:read`,
`knowledge:answer`, `knowledge:write`, `chat:read` y `chat:write`.

| Ruta | Qué hace |
|---|---|
| `GET /v1/health` | Sin autenticar. Consulta la base: un health que solo dice que el proceso vive miente cuando Postgres está caído |
| `POST /v1/knowledge/search` | Búsqueda híbrida |
| `POST /v1/knowledge/answer` | Respuesta fundada con citas validadas |
| `POST /v1/knowledge/documents` | Subida de fichero → **202** |
| `GET /v1/knowledge/documents[/:id]` | Estado de la ingesta |
| `GET /v1/knowledge/gaps` · `PATCH /v1/knowledge/gaps/:id` | Qué le preguntan y no sabe responder |
| `GET`/`POST /v1/sources` · `PATCH /v1/sources/:id` | Orígenes que se sincronizan solos |
| `POST /v1/sources/:id/sync` | Sincronizar ya → **202** |
| `POST /v1/chat` | Conversación con continuidad |
| `GET /v1/conversations/:id` · `POST .../status` | Hilo y escalada |
| `GET`/`POST /v1/contacts` · `GET`/`PATCH /v1/contacts/:id` | Quién pregunta |

La clave se imprime UNA vez: la base solo guarda el hash SHA-256 y los cuatro
últimos caracteres. SHA-256 y no bcrypt a propósito — son 256 bits aleatorios,
contra los que una KDF lenta no compra nada y además impediría buscar la fila
por hash en una consulta indexada.

Las rutas no tienen lógica propia: ensamblan `answerFromKnowledge`, que es lo
que el arnés mide. Cualquier decisión tomada en la ruta sería una decisión sin
medir sirviéndose en producción.

## La ingesta es asíncrona, y no por gusto

`POST /v1/knowledge/documents` guarda los bytes, crea el documento en `PENDING`
y publica `document.uploaded` **en la misma transacción**, y responde **202**.
El worker lo recoge, ingiere y lo deja en `READY`; el cliente consulta
`GET /v1/knowledge/documents/:id`.

Embeber un manual de 200 páginas no cabe en un timeout HTTP, y el pipeline de
ingesta ya estaba partido en fases justamente porque el trabajo lento no puede
vivir dentro de una transacción. Servirlo en síncrono habría reintroducido
arriba el problema que abajo ya estaba resuelto.

Lo que hace correcto ese 202 es que la fila y el evento se confirman juntos. Si
el evento se publicara fuera de la transacción, un fallo entre ambos dejaría un
documento en `PENDING` que nadie va a procesar nunca.

```bash
npm run dev      # API
npm run worker   # worker, en OTRA terminal
```

**El worker es un proceso aparte a propósito.** El proveedor de embeddings local
corre ONNX en CPU y **bloquea el event loop**: durante los tests llegamos a ver
a Prisma reportar "can't reach database server" con la base perfectamente viva.
Dentro de la API, ingerir un manual dejaría al servidor sin responder a nadie.
Es también el motivo de `--test-concurrency=1`: en paralelo, los tests de
integración se bloquean entre ellos y fallan por algo que no es el código.

## CI

`.github/workflows/ci.yml`, dos jobs:

- **Tests** — Postgres 17 + pgvector como servicio, con los MISMOS argumentos de
  ICU que `docker-compose.yml`. Ejecuta los 408 tests, integración incluida:
  con `DATABASE_URL` puesta dejan de saltarse, y ahí están los que importan.
- **Arnés** — corre `npm run eval` y bloquea si la puerta bloquea. Necesita el
  secreto `GROQ_API_KEY`; **sin él el job avisa y no mide**, que es honesto pero
  deja la puerta abierta. Añádelo en Settings → Secrets → Actions.

Usa `npm run setup -w @platform/db`, no `db:migrate`: `prisma migrate dev`
detecta como deriva las columnas que añade el SQL crudo y querría resetear la
base. Ver el apartado de migraciones.

La secuencia entera está verificada contra una base vacía en un contenedor
aparte, no solo escrita.

### La CI nunca había pasado

Doce ejecuciones, doce fallos, desde la primera. Nadie lo miró porque el
documento decía que CI ejecutaba todo en cada push, y eso se leía como que
pasaba.

El error, siempre el mismo:

```
Cannot find module '.../platform/node_modules/@platform/env/dist/load.js'
imported from '.../platform/packages/db/scripts/apply-sql.ts'
```

`apply-sql.ts` importa `@platform/env/load`, que se resuelve a `dist/load.js`, y
el paso «Preparar la base de datos» iba **antes** que «Compilar». En un runner
recién clonado no hay `dist/`; en una máquina de desarrollo sí, de la última vez
que se compiló, así que en local nunca falla. Ese es el motivo entero de que
durara doce ejecuciones.

Arreglado en `apply-sql`, que ahora compila primero — igual que ya hacían `test`,
`eval` y `prompts:seed`. Ahí y no reordenando los pasos del workflow porque el
mismo agujero se lo comía **cualquiera que clonara el repositorio**: la secuencia
de arranque documentada tampoco tenía un `build` antes de `setup`.

Lo caro no fue el fallo, fue lo que tapaba. El job del arnés declara
`needs: test`, así que **nunca llegó a ejecutarse**: la puerta que existe para
bloquear despliegues no había bloqueado ni aprobado nada, y el `GROQ_API_KEY`
que hay guardado como secreto no lo había leído nadie. El comentario que
encabeza `ci.yml` —«una puerta que nadie abre no bloquea nada»— seguía siendo
verdad después de escribirlo.

Si algún día vuelve a fallar, el log está en Actions y hay que abrir el job para
verlo: el resumen del run solo dice «Process completed with exit code 1».

## Los conversores binarios

**Un PDF no tiene encabezados.** No es una limitación de la librería: el formato
describe glifos en coordenadas, no estructura. Y el listón de un conversor aquí
es conservar encabezados, porque el troceador corta por ellos y las citas se
construyen con ellos.

Así que se infieren del TAMAÑO de cada línea. El cuerpo del texto es la altura
más frecuente ponderada **por caracteres, no por líneas** — un documento con
veinte titulares cortos y tres párrafos largos tiene más líneas de titular, y la
moda por líneas elegiría el titular como cuerpo, invirtiendo la jerarquía
entera. Lo que sobresale un 15% se promueve a encabezado. Cuando no encuentra
ninguno lo dice en los avisos, en vez de dejar creer que el documento venía bien
estructurado.

**DOCX pasa por HTML.** mammoth traduce los estilos de Word a `<h1>/<h2>/<ul>`
semánticos y de ahí reutiliza `htmlToMarkdown`, que ya estaba probado. Leer el
XML de OOXML a mano habría sido un segundo camino que mantener para llegar al
mismo Markdown. Aquí no hay heurística: los encabezados son encabezados.

**`pageNumber` ya se rellena.** Estaba declarado en el tipo desde el primer día
y no lo ponía nadie. El conversor de PDF emite `<!--page:N-->` y `splitByHeadings`
lo convierte en el número de página del fragmento — el dato con el que una
persona comprueba una cita en un manual de 300 páginas. El marcador se elimina
antes de embeber: dejarlo metería ruido en el vector.

## Huecos de conocimiento

Cada abstención dice algo que la empresa no sabe por otro medio: sus clientes
preguntan por X y su documentación no lo cubre. Es conocimiento que **genera la
plataforma**.

Se registra desde el día uno por el mismo motivo que el consumo: **el pasado no
se reconstruye**. Lo que no se guarde hoy no se puede recuperar mañana.

`POST /v1/knowledge/answer` publica `knowledge.gap` en la misma transacción que
la medición de consumo; el worker embebe, busca candidatos por vector y le pide
al generador que decida si es un hueco ya conocido. `GET /v1/knowledge/gaps` los
sirve **ordenados por número de veces**, no por fecha: lo último que preguntó
alguien es una anécdota, lo que preguntan treinta dirige el trabajo.

Tres motivos, y no significan lo mismo: `BELOW_THRESHOLD` (no había ni
material), `MODEL_ABSTAINED` (había documentación cercana que no cubría el caso
— el más accionable) y `GROUNDING_FAILED` (además el modelo intentó rellenarlo).

Sin generador configurado **no se agrupa**: cada abstención abre su fila. Peor
informe, pero no es un dato perdido — y es mejor que agrupar con un umbral que
la medición dice que no existe.

## Conectores

`/v1/sources`. El primero es el rastreador **web** y no Notion ni Drive, por una
razón práctica: no necesita cuenta de terceros ni OAuth ni secretos que cifrar,
así que se puede construir Y verificar entero. Y para una PYME su web ES su
documentación — condiciones de envío, devoluciones y preguntas frecuentes ya
están publicadas y aprobadas.

**El conector no ingiere.** Descubre y entrega bytes; a partir de ahí es
exactamente el mismo camino que un fichero subido a mano: almacenamiento,
documento en `PENDING`, `document.uploaded` en la misma transacción. Por eso
añadir Notion es un fichero en `@platform/connectors` y nada más.

**Un conector que descarga URLs elegidas por el cliente es un SSRF por diseño.**
El tenant escribe una dirección y nuestro servidor la pide, desde dentro de
nuestra red y con nuestra identidad. El caso que lo resume:

```
http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

Esa IP es el endpoint de metadatos de AWS, GCP y Azure y devuelve credenciales
de la instancia. Un rastreador ingenuo la pide, la guarda como "documento", y el
cliente la consulta después por la API de conocimiento.

`packages/connectors/src/net.ts` resuelve el nombre y juzga **las IPs**, no el
texto: comprobar el hostname no sirve porque un dominio público puede apuntar a
donde quiera. Y valida **cada salto** de redirección con `redirect: "manual"` —
con seguimiento automático, validar la primera URL no sirve de nada.

`CONNECTORS_ALLOW_PRIVATE_NETWORK=true` abre la red privada para on-premise,
donde es exactamente donde está la documentación. Apagado por defecto porque
dejarlo abierto falla en silencio y tenerlo cerrado falla diciendo qué activar.

El cursor guarda el hash por URL: la segunda pasada no vuelve a pagar troceado
ni embeddings de lo que no cambió. Sin eso, una sincronización nocturna cuesta
dinero cada noche por nada.

## El planificador

`syncSchedule` guarda un cron y ahora lo lee el worker en cada sondeo. Sin esto,
"el conocimiento siempre al día" era un botón que alguien tenía que pulsar.

**Se sondea, no se programan temporizadores.** Un `setTimeout` por fuente no
sobrevive a un reinicio, no se reparte entre procesos y hay que rehacerlo cada
vez que alguien cambia un horario. Mirar quién toca cada minuto es más tonto y
no tiene ninguno de esos problemas.

**La reclamación la decide la base, no el proceso.** Un `UPDATE` condicional
sobre `lastScheduledAt`, igual que el `SKIP LOCKED` del outbox: varios workers
son correctos por diseño, los dos ven que a la fuente le toca, y leer-entonces-
escribir haría que los dos publicaran. Gana quien cambia la fila.

**En la zona del TENANT, nunca en la del servidor.** `Tenant.timezone` (nombre
IANA, por defecto `UTC`) es lo que interpreta el cron, y `KnowledgeSource.syncTimezone`
lo anula por fuente. La zona del servidor no vale: depende de dónde se
despliegue, así que la misma expresión significaría una cosa en el portátil y
otra en producción. La del tenant es un dato del negocio, viaja con él.

Antes se interpretaba todo en UTC y una PYME española que escribía `0 3 * * *`
sincronizaba a las 5:00 locales en verano. La conversión usa `Intl` y no una
librería de zonas: los datos de zonas vienen con Node y se actualizan con él, en
vez de con un `npm update` que alguien tiene que recordar cuando un país cambia
su horario de verano.

**Los dos bordes del horario de verano están medidos, y se aceptan a
propósito.** Hay test de cada uno:

| Borde | Qué pasa | Por qué se acepta |
|---|---|---|
| Primavera (29-03-2026, Madrid) | `30 2 * * *` **no se dispara**: las 02:30 no existen ese día | La web se indexa un día después |
| Otoño (25-10-2026) | Se dispara **dos veces**: las 02:30 ocurren a las 00:30 y a las 01:30 UTC | El cursor guarda el hash por URL, así que la segunda pasada no vuelve a pagar troceado ni embeddings |

Aceptable **aquí**, que es una sincronización de contenido idempotente. En un
cron de facturación o de envío de correos no lo sería, y quien añada el segundo
caso de uso de cron tiene que releer esta tabla antes de reutilizar el matcher.

**Una zona desconocida degrada a UTC con aviso, no tumba el planificador.**
Dejar de sincronizar a todos los clientes porque uno escribió `Europe/Madird`
sería peor que sincronizar a ese uno como se hacía antes. Al escribir sí se
rechaza con 400: aceptarla no da ningún error, da un horario equivocado que
nadie mira.

El matcher es propio y no una librería porque solo hace falta "¿casa este
minuto?", no calcular próximas ejecuciones — que es la parte difícil de cron y
la única razón para traer una dependencia. Implementa la trampa del POSIX: con
día-del-mes Y día-de-semana ambos restringidos, la regla es **O**, no Y.
`0 0 1 * 1` es "el día 1 y además todos los lunes".

## La capa de secretos

`SECRETS_ENCRYPTION_KEY` llevaba en `.env` desde el primer commit y no lo leía
ningún código. `packages/secrets` es lo que lo lee, y es requisito previo a
cualquier conector con credenciales.

**AES-256-GCM**, no "cifrar y ya". GCM es cifrado AUTENTICADO: si alguien altera
un byte del texto cifrado, el descifrado FALLA en vez de devolver basura. Sin
autenticación, quien tenga escritura en la base puede modificar el cifrado a
ciegas y el sistema usaría el resultado como si fuera un token válido.

**El texto cifrado va atado a su contexto** con datos autenticados asociados:
`tenantId` + para qué es. Sin eso, copiar el valor cifrado de la fila de un
cliente a la de otro FUNCIONA — el texto cifrado es válido y descifra
perfectamente. Con AAD, falla. En multi-tenant eso no es teórico, y hay test.

**El identificador de clave viaja dentro del sobre**, derivado de la propia
clave. Es lo que hace posible rotar: la nueva en `SECRETS_ENCRYPTION_KEY`, la
anterior en `SECRETS_ENCRYPTION_KEYS_OLD`, y lo viejo se sigue leyendo mientras
lo nuevo usa la clave nueva. Sin él, rotar obliga a re-cifrar toda la base en
una transacción —imposible con volumen— o a perder el acceso a lo anterior.

**Cifrar no basta: los secretos no salen por la API ni cifrados.** Publicar un
texto cifrado es publicar algo que solo depende de una clave, y las claves se
filtran. `redactSecrets` se aplica en un único sitio para las cuatro respuestas
que devuelven configuración — si cada una decidiera por su cuenta, bastaría
añadir una quinta para filtrar un token.

**Sin clave configurada NO se guarda nada en claro**: la API responde 503 y dice
cómo generarla. Guardar la credencial sin cifrar sería peor que rechazarla,
porque el cliente creería que está protegida.

El conector declara qué campos son secretos (`secretFields`). El rastreador ya
tiene uno: `authToken`, para intranets y wikis internos — que es donde una
empresa tiene lo que no está en su web pública. **La cabecera va atada al origen
y no cruza a otro dominio**: una redirección a un CDN o a un acortador entregaría
el token del cliente a un tercero.

## Notion

**Token interno, no OAuth.** OAuth público exige registrar una integración en
Notion, alojar una URL de callback y pasar su revisión. El camino que una PYME
usa de verdad —y el único construible y verificable hoy— es que el cliente cree
una integración interna en su espacio y pegue el token. Ese token es un secreto
y va cifrado: es el primer usuario real de `@platform/secrets`.

Cuando llegue OAuth, el token acaba en el mismo campo y nada del conector
cambia; lo que cambia es de dónde sale.

**La integración solo ve lo que le han compartido.** Es la primera causa de "no
funciona" con Notion y no es un fallo: hay que compartir cada página con la
integración desde `··· → Conexiones`. Crearla no basta. Un espacio entero sin
nada compartido devuelve cero resultados, así que ese caso emite un aviso que lo
explica en vez de terminar en verde con cero documentos.

**Aquí no hay heurística.** Notion guarda `heading_1/2/3` como tipos de bloque
distintos, así que la estructura viene dada — al contrario que en un PDF, donde
hubo que inferirla del tamaño de fuente. Se conservan tablas (donde una PYME
pone precios y plazos), enlaces (que muchas veces SON la respuesta) y los tipos
desconocidos con su texto, porque Notion añade bloques nuevos cada pocos meses.

**Lo incremental usa `last_edited_time`**, no un hash del contenido: se salta la
página ANTES de pedir sus bloques. Una página de cien bloques son varias
peticiones que no se hacen.

Notion limita a ~3 peticiones por segundo **por integración**, y pasarse bloquea
el token DEL CLIENTE. De ahí la pausa entre peticiones, que en producción no se
toca.

**Verificado contra un servidor que imita su API**, con paginación por cursor e
hijos en peticiones aparte. Conviene decirlo claro: eso verifica nuestro código,
no el comportamiento de Notion. Falta una pasada contra un espacio real.

## Google Drive

**Cuenta de servicio, no OAuth de usuario**, por lo mismo que en Notion se
eligió el token interno. Y el modelo mental le sale gratis al cliente: la cuenta
de servicio tiene un correo, y **se comparte la carpeta con ese correo** como se
comparte con un compañero. Es la misma operación que compartir una página con
una integración de Notion, y no hay que explicarle qué es un `scope`.

El JWT se firma a mano con `node:crypto` — treinta líneas contra una dependencia
con su propia superficie. Ámbito de **solo lectura**: un conector de conocimiento
no tiene por qué poder escribir.

**Lo interesante es lo que NO hubo que escribir.** Drive entrega PDF y DOCX tal
cual, y esos conversores ya existen y están probados. El conector descarga bytes
y los entrega, igual que una subida manual. Solo lo nativo de Google necesita
trato propio: un Documento no es un fichero, es un objeto en su servidor, y hay
que pedirle que lo EXPORTE.

Los Documentos se exportan a **markdown y no a texto plano**, porque conserva
los encabezados — el listón de siempre. Las Hojas a CSV, que ya tiene conversor
y es donde una PYME pone sus tarifas.

Drive **no busca en profundidad**: hay que recorrer el árbol de subcarpetas a
mano. Y los ids de carpeta se interpolan en su lenguaje de consulta, así que se
validan con lista blanca antes de tocarlo.

Como en Notion, lo incremental usa `modifiedTime` y se salta el fichero ANTES de
descargarlo. Aquí pesa más: un PDF de veinte megas se bajaría entero para nada.

**Verificado contra un servidor simulado**, con clave RSA generada en el propio
test. Verifica nuestro código, no el comportamiento de Google.

## Contactos

`/v1/contacts` cierra la superficie de §27. Es el contacto **mínimo**: identidad
y datos, para que varias conversaciones de la misma persona dejen de ser
personas distintas. No es un CRM — `Company`, oportunidades y sincronización con
un sistema externo son Fase 4 y se enganchan aquí.

**Las unicidades son compuestas, y ese es el punto entero.** En `crm-main`,
`Contact.email` es `@unique` GLOBAL, y eso es exactamente lo que lo hace
irreparable: dos clientes distintos no pueden tener a la misma persona en su
agenda. Hay test que lo comprueba en los dos sentidos — el mismo correo en dos
tenants convive, y repetido dentro de uno da 409.

**Un contacto sin email, teléfono ni `externalId` se rechaza con 400.** No se le
puede volver a encontrar, así que la siguiente conversación crearía un duplicado
en silencio, y un duplicado silencioso es peor que un error: rompe justo lo que
el contacto viene a resolver.

**`externalId` exige canal.** El mismo literal en WhatsApp y en Slack son dos
personas distintas, y así lo dice la unicidad compuesta.

**Borrar un contacto NO borra sus conversaciones**: la clave ajena es
`SET NULL`. El historial de lo que se habló sobrevive al contacto, que es lo que
hace auditable el borrado por contacto del RGPD (§28).

`Conversation.externalUserId` se conserva junto a `contactId` y no se sustituye
por él: es el dato CRUDO que entregó el canal, y es lo que permite reconstruir
por qué se resolvió a este contacto y no a otro.

**Los datos del cliente van en `attributes`, no en columnas nuevas.** Cada PYME
quiere los suyos, y una columna por cliente no escala ni cabe en el AI Studio,
que exige configuración declarativa (§27).

Al escribir esto salió un fallo que afectaba a **toda** la API: el manejador de
errores reenvolvía cualquier error con `statusCode` 4xx —incluidos los
`ApiError` nuestros— y les borraba el `code`, así que `not_found`,
`contact_exists` y todos los demás salían como `bad_request`. El `code` existe
para que un cliente pueda ramificar sin leer el texto en español; uno que
siempre vale lo mismo no es cosmético, es el campo entero sin servir para nada.
Arreglado comprobando `instanceof ApiError` antes de normalizar.

## El panel

`apps/panel`, en `npm run panel` (puerto 3002). Tres pantallas: subir un
documento y verlo pasar a `READY`, preguntar y ver la respuesta con sus citas, y
la lista de huecos ordenada por veces.

**No depende de `@platform/db`, y eso es la garantía de §27.** «Todo lo que hace
el panel se hace por API» deja de ser disciplina y pasa a ser algo que no se
puede incumplir: el paquete no declara la dependencia, así que no puede importar
la base aunque alguien quiera el atajo. Hay test que lo comprueba leyendo el
`package.json`. Si una pantalla necesita un dato que la API no da, el arreglo es
añadirlo a la API.

**La clave de API no llega nunca al navegador.** Se pega una vez, el panel la
valida contra la API de verdad —aceptar una inválida deja al usuario dentro de
un panel que falla en cada pantalla— y la guarda cifrada con `@platform/secrets`
en una cookie `httpOnly`, `SameSite=Strict` y de sesión. El JS del panel llama a
`/api/*`, que reenvía poniendo la credencial del lado del servidor. Cifrada y no
firmada: firmar evita la falsificación pero deja la clave legible para quien
mire sus cookies. Y como GCM es autenticado, una cookie manipulada **falla al
descifrar** en vez de devolver basura que después se mandaría como credencial.

**El cuerpo se reenvía crudo.** `removeAllContentTypeParsers()` antes del
comodín, porque el parser de JSON de Fastify tiene prioridad sobre `*` y sin
quitarlo el proxy reenviaba `[object Object]`. Crudo es además lo que permite
pasar un `multipart` de subida sin desmontarlo y volverlo a montar, que es donde
se pierden los límites de sección y el fichero llega corrupto sin aviso.

Sin framework de front ni empaquetador: tres pantallas sin estado no lo
justifican, y meterlo añadiría un segundo sistema de build al monorepo.

**Lo que el panel NO es: multiusuario.** Se entra con la clave de API del
tenant, no con usuario y contraseña. `User` y `Membership` están en el esquema y
no los autentica nadie todavía; un login de verdad —hash de contraseña, sesiones,
recuperación— es una superficie de seguridad aparte y hacerla a medias es peor
que no tenerla.

## El chat

**Es interfaz, no núcleo** — la regla del proyecto. La ruta no decide nada sobre
la calidad de la respuesta: ensambla `resolveQuestion` y `answerFromKnowledge`,
que es lo que mide el arnés. Lo que añade es continuidad y archivo.

**Lo único del chat que SÍ es núcleo: una pregunta de seguimiento no se puede
buscar.** Lo que se busca en la documentación es el TEXTO de la pregunta, y
«¿y a Canarias?» no se parece a ninguna frase de ningún manual. Sin reescribir,
el sistema se abstiene de algo que sí sabe — y justo después de haber contestado
bien a la anterior, que es la peor abstención posible de cara al cliente.

Por eso `resolveQuestion` vive en `@platform/knowledge` y no en la ruta: es una
decisión que cambia lo que se recupera, y una decisión tomada en la ruta es una
decisión sin medir sirviéndose en producción.

Tres cosas que hace bien y no son obvias:

- **Sin historia no llama al modelo.** El primer mensaje no puede ser un
  seguimiento; gastar una llamada ahí es pagar por una decisión ya tomada.
- **Si la pregunta ya se entiende sola, la deja intacta.** Reescribir una
  pregunta que estaba bien solo puede empeorarla.
- **Falla hacia delante.** Si la reescritura no sale, se busca la original:
  recupera peor, pero abortar sería cambiar un resultado mediocre por ninguno.

La pregunta reescrita se archiva junto a la original. Depurar por qué una
respuesta salió rara en el tercer turno sin saber qué se buscó de verdad es
adivinar.

Una conversación `ESCALATED` calla al bot: seguir contestando encima de una
persona que ya está atendiendo es peor que no responder. Y el hilo se localiza
por canal + id externo, así que un reintento de entrega de WhatsApp no abre una
conversación nueva.

**Toda abstención del chat también alimenta los huecos**, y se registra la
pregunta RESUELTA: «¿y a Canarias?» en un informe no le dice nada a nadie.

**Ya pasa por la puerta.** El arnés medía un solo turno; ahora
`CONVERSATIONAL_CASES` añade cuatro casos con hilo y `minFollowUpResolution`
(0,8) los juzga. Son cuatro y cubren las cuatro cosas distintas que puede hacer
esta capa:

| Caso | Qué atrapa |
|---|---|
| `hilo-canarias` | El seguimiento canónico: "¿y a Canarias?" sin antecedente |
| `hilo-usado` | El seguimiento salta de sección dentro del mismo tema |
| `hilo-autonoma` | **Reescribir de más.** Hay hilo pero la pregunta se entendía sola |
| `hilo-sin-reembolso` | La trampa, con el modelo habiendo citado bien el turno anterior |

Ojo con lo que estos casos miden y lo que no: sobre ESTE corpus la reescritura
no cambia qué fragmentos se recuperan —cinco fragmentos, se piden tres— así que
lo que juzgan es lo que el generador hace con el TEXTO de la pregunta. Está
medido, con números, en **Hallazgos medidos**.

El tercero importa tanto como el primero y es el que casi no se escribe: un
reescritor que reformula preguntas que ya estaban bien recupera peor **sin que
salte ninguna otra métrica**. Por eso `expectsRewrite` se declara en los dos
sentidos y el fallo se cuenta en las dos direcciones.

**Un caso conversacional sin reescritor NO se ejecuta.** Buscar «¿y a Canarias?»
literal mide el sistema roto que la reescritura existe para evitar, y esa
abstención entraría en el informe como si describiera el producto. El ejecutor
los salta, los lista en `report.skipped` y avisa; las métricas se calculan solo
sobre lo que corrió, así que `total` nunca cuenta un caso que nadie miró.

La reescritura entra en el coste y en la latencia del caso, incluida la de las
abstenciones que corta el umbral: es una llamada al modelo que el cliente paga
en cada turno de seguimiento, aunque después no se genere nada.

## Próximo paso

Probar Notion y Drive **contra cuentas de verdad**. Es lo único que los tests
con servidor simulado no pueden cubrir, y son dos ratos cortos:

- Notion: integración interna en notion.so/my-integrations, compartirle un par
  de páginas, crear la fuente con el token.
- Drive: cuenta de servicio en Google Cloud, habilitar la API de Drive,
  compartir una carpeta con su correo, pegar el JSON.

**Volver a medir la puerta con Groq.** Los casos conversacionales ya están y los
tests pasan, pero la cifra de la tabla de "Estado actual del arnés" es de ANTES
de añadirlos: son cuatro casos más, y uno de ellos —`hilo-sin-reembolso`— es más
duro que cualquiera de los de un turno. Hace falta una tirada de `npm run eval`
con `AI_PROVIDER="groq"` y una `GROQ_API_KEY` con valor en `platform/.env` — ver
**Dónde viven las claves**.

`/v1/contacts` **ya está**, y con ello la superficie de la API de §27 queda
completa. Ver **Contactos**.

Pendiente menor: `xlsx`, `pptx` y el `.doc` antiguo se rechazan con un 415 que
dice qué hacer.

Para repetir la medición:

Con `AI_PROVIDER` y `GROQ_API_KEY` puestos en `platform/.env`:

```bash
npm run prompts:seed
```

```bash
npm run eval
```

## Decisiones abiertas

- **Proveedor de embeddings definitivo.** Ahora el local gratuito. Cambiarlo
  obliga a reindexar, pero la convivencia de dimensiones ya está implementada y
  probada (`packages/knowledge/src/dimensions.ts` + migración 003).
- **Enviar datos de tenant a Groq.** El corpus del arnés es sintético, así que
  medir no compromete nada. Servir a un cliente real desde Groq sí exige un DPA;
  para quien no lo acepte, el mismo adaptador apuntado a un servidor propio es
  la respuesta, y ya funciona.
- **Prisma 6.19 vs 7.x.** Se arrancó en 6.19 por estabilidad.
- **`.gitattributes`.** Git avisa de conversión LF→CRLF; sin él, un equipo mixto
  verá ficheros enteros como modificados sin tocarlos. Ya dejó de ser solo
  cosmético una vez: rompió la siembra de prompts (ver **Cuatro trampas**). Eso
  está arreglado donde tocaba —en el parser, no en git— pero el aviso sigue en
  pie para el resto de ficheros.

## Cuatro trampas de este entorno

**`prisma generate` falla con EPERM si hay un proceso vivo con el cliente
cargado.** Windows bloquea `query_engine-windows.dll.node` y el renombrado del
temporal falla. Pasa al medir en segundo plano y compilar a la vez: hay que
esperar a que el proceso termine.

**`rawPrisma` NO se salta RLS: `systemPrisma` sí.** Los dos se llaman "cliente
crudo" en el código y hacen cosas distintas — `rawPrisma` se conecta con el rol
de aplicación, así que las políticas siguen aplicando. Una consulta entre
tenants con `rawPrisma` y sin contexto devuelve **cero filas en silencio**.
Pasó de verdad al escribir el planificador: no encontraba una sola fuente, sin
error ni traza. El síntoma es la ausencia de síntoma.

Las dos excepciones sancionadas a "el cliente que se salta RLS no aparece en la
ruta de una petición" son `findApiKeyByHash` y el planificador. Ninguna de las
dos es una petición.

**El fin de línea del checkout cambiaba el prompt.** El catálogo se lee de
ficheros `.md`, y un checkout de Windows los deja con CRLF: el mismo
`knowledge.answer.system` mide 1915 caracteres con LF y **1956 con CRLF**. Como
las versiones son inmutables y la siembra compara textos, sembrar desde un
worktree de Windows contra una base sembrada con LF aborta con «ya existe con un
texto distinto» — verdad literal y ninguna pista. Y el fallo de fondo es peor
que la molestia: el prompt que recibe el modelo dependía de qué máquina sembró,
así que una traza que archiva un `versionId` dejaba de identificar un texto, que
es exactamente lo que le da su valor.

Arreglado en `parsePromptFile`, que normaliza a LF antes de nada. Ahí y no en un
`.gitattributes` porque un `.gitattributes` arregla los checkouts futuros y no
los que ya existen, y porque el registro debe ser insensible a esto aunque el
fichero llegue de cualquier otra forma. Pasó de verdad al abrir un worktree para
los casos conversacionales: 23 tests cancelados, ninguno relacionado.

**Las transacciones expiran por el event loop, no por su propio trabajo.** El
proveedor de embeddings local corre ONNX en el hilo principal y lo bloquea
segundos seguidos. El efecto es desconcertante: una transacción con un solo
`UPDATE` trivial expira porque, mientras esperaba turno, otro trabajo del mismo
proceso tenía el bucle parado — y el error dice "considera hacer menos trabajo
en la transacción". Por eso `withRlsTransaction` lleva `timeout: 30_000`. Visto
de verdad: "6372 ms passed" en un `update` de una fila, con una medición
corriendo en paralelo; con la CPU libre, esos mismos tests tardan 4 s.

Corolario: **no corras `npm test` y `npm run eval` a la vez.** Además de fallos
espurios, la latencia que informe el arnés no será real.

## Cómo trabaja el usuario

Piensa en producto y competencia (Intercom, Glean, Agentforce, Copilot), no solo
en código. Responde bien a que se le señalen tensiones arquitectónicas reales y
a las correcciones honestas — varias de las mejores decisiones del proyecto
salieron de decirle que una idea suya chocaba con otra. Escribe en español.

Los repos `crm-main/` y `TencentDB-Agent-Memory-feat-server_team/` son **material
de referencia, no dependencias**, y están fuera de git. `crm-main` es
single-tenant irreparable (`Company.domain` y `Contact.email` son `@unique`
globales); se canibalizó su esquema CRM y su disciplina de evidencia.
