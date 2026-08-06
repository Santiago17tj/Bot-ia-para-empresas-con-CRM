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
npm run db:up          # Postgres 17 + pgvector en el puerto 5433
npm run db:migrate     # migraciones + SQL crudo (vector, tsvector, RLS)
npm run prompts:seed   # carga el catálogo de prompts en el registro
npm test               # 321 tests
```

`.env` ya existe en `platform/` (ignorado por git). `.env.example` lo documenta.

`npm run eval` corre la medición completa (recuperación **y** abstención) contra
Postgres real y un generador real. Necesita el catálogo sembrado; si falta, lo
dice y explica cómo. Sale con código 1 si la puerta bloquea, para servir en CI.

### Docker en esta máquina

Docker Desktop **no arranca solo** (`AutoStart: false`). Si `docker ps` falla,
lánzalo:

```bash
powershell -c "Start-Process 'C:\Users\Isabel\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe'"
```

Tarda 1–2 minutos. Historial: la instalación se interrumpió a medias y dejó
sockets huérfanos indelebles en `AppData\Local\Docker\run` y
`docker-secrets-engine`; se arreglaron **renombrando los directorios padre** (no
se pueden borrar ni tras reiniciar). Si vuelve a fallar con "An unexpected error
occurred", ese es el patrón. El grupo `docker-users` no existe pero es opcional:
el diálogo "Continue" funciona.

## Estado

**Fase 0 y Fase 1 completas.**

El producto ya tiene puerta de entrada completa: se sube un PDF o un DOCX por
la API, un worker lo indexa y queda respondiendo preguntas con citas. Verificado
de punta a punta.

| Paquete | Qué es | Tests |
|---|---|---|
| `env` | Carga del único `.env` de la raíz | — |
| `db` | 22 modelos, aislamiento 3 capas, RLS | 11 + 9 int. |
| `providers` | `AIProvider` + `EmbeddingProvider`, 2 adaptadores | 23 |
| `events` | Outbox transaccional + despachador | 11 |
| `observability` | Trazas, Prompt Registry, siembra, consumo | 11 |
| `context` | Context Engine, presupuesto, recetas | 22 |
| `knowledge` | Conversión (PDF/DOCX), troceado, híbrida, grounding, respuesta, **huecos** | 58 + 28 int. |
| `eval` | Arnés con abstención, modo `full` | 6 int. |
| `storage` | Costura de ficheros + driver local | 15 |
| `secrets` | Cifrado en reposo AES-256-GCM, llavero, redacción | 17 |
| `connectors` | Orígenes, rastreador web, defensa SSRF, cron | 65 |
| `apps/api` | Fastify, API key → tenant, `/v1/knowledge/*`, `/v1/sources` | 14 int. |
| `apps/worker` | Outbox, ingesta, huecos, sincronización, planificador | 26 int. |

El arnés corrió en modo `full` contra un generador real y la puerta PASA (ver
**Estado actual del arnés**). La API sirve `/v1/knowledge/search`, `/answer` y
`/documents`, y CI ejecuta todo en cada push.

## Invariantes que NO se pueden romper

**Aislamiento en tres capas.** `tenantId` en cada tabla con unicidades
compuestas · extensión de Prisma que falla cerrado sin contexto · políticas RLS.
`test/isolation.test.ts` verifica que las tres nombran las mismas tablas; una
tabla en una lista y no en otra es el conjunto con una sola defensa.

- La aplicación usa `prisma` (filtrado) dentro de `runWithTenant`.
- `systemPrisma` se salta RLS y existe **solo** para crear tenants, migrar y
  limpiar en tests. Nunca en la ruta de una petición.

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

**El `.env` seleccionaba embeddings de OpenAI mientras todo se medía con el
local.** `EMBEDDING_PROVIDER=openai` con la clave vacía, frente a los 384d de
`multilingual-e5-small` sobre los que se calibró todo lo de arriba. Los tests no
lo detectaban porque instancian `LocalEmbeddingProvider` a mano; lo destapó el
primer script que llamó a `createEmbeddingProvider()`. Corregido en
`.env.example`. **Si tu `.env` local sigue diciendo `openai`, cámbialo**: con esa
configuración cualquier código que resuelva el proveedor por registro falla, y
si llegara a funcionar mediría un sistema distinto del calibrado.

## Estado actual del arnés

Medición real, modo `full`, contra Postgres y Groq (`openai/gpt-oss-120b`):

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

## La API

```bash
npm run dev                                    # arranca en el PORT del .env
npm run issue-key -w @platform/api -- <tenantId> "nombre" knowledge:read knowledge:answer
```

`POST /v1/knowledge/search` · `POST /v1/knowledge/answer` · `GET /v1/health`.

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
  ICU que `docker-compose.yml`. Ejecuta los 199 tests, integración incluida:
  con `DATABASE_URL` puesta dejan de saltarse, y ahí están los que importan.
- **Arnés** — corre `npm run eval` y bloquea si la puerta bloquea. Necesita el
  secreto `GROQ_API_KEY`; **sin él el job avisa y no mide**, que es honesto pero
  deja la puerta abierta. Añádelo en Settings → Secrets → Actions.

Usa `npm run setup -w @platform/db`, no `db:migrate`: `prisma migrate dev`
detecta como deriva las columnas que añade el SQL crudo y querría resetear la
base. Ver el apartado de migraciones.

La secuencia entera está verificada contra una base vacía en un contenedor
aparte, no solo escrita.

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

**Todo en UTC.** La misma expresión tiene que significar lo mismo en el
portátil, en CI y en producción. La consecuencia hay que decirla: una PYME
española que escriba `0 3 * * *` sincroniza a las 4:00 hora local en verano. Una
zona horaria por tenant es el paso siguiente, no un descuido.

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

## Próximo paso

Conectores con credenciales (Notion, Drive). La capa de secretos ya está, así
que lo que falta de cada uno es su OAuth y su paginación.

Luego `/v1/chat` y `/v1/contacts`.

Deuda conocida: la sincronización programada se interpreta en **UTC**, así que
una PYME española que ponga `0 3 * * *` sincroniza a las 4:00 locales en verano.
Zona horaria por tenant.

Pendiente menor: `xlsx`, `pptx` y el `.doc` antiguo se rechazan con un 415 que
dice qué hacer.

Para repetir la medición:

```bash
npm run prompts:seed
AI_PROVIDER=groq GROQ_API_KEY=... npm run eval
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
  verá ficheros enteros como modificados sin tocarlos.

## Dos trampas de este entorno

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
