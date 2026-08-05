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
npm test               # 199 tests
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

**Fase 0 completa. Fase 1 cerrada salvo los conversores PDF/DOCX.**

El producto ya tiene puerta de entrada: se sube un documento por la API, un
worker lo indexa y queda respondiendo preguntas. Verificado con los dos
procesos vivos contra Groq.

| Paquete | Qué es | Tests |
|---|---|---|
| `env` | Carga del único `.env` de la raíz | — |
| `db` | 22 modelos, aislamiento 3 capas, RLS | 11 + 9 int. |
| `providers` | `AIProvider` + `EmbeddingProvider`, 2 adaptadores | 23 |
| `events` | Outbox transaccional + despachador | 11 |
| `observability` | Trazas, Prompt Registry, siembra, consumo | 11 |
| `context` | Context Engine, presupuesto, recetas | 22 |
| `knowledge` | Conversión, troceado, híbrida, grounding, **respuesta** | 45 + 20 int. |
| `eval` | Arnés con abstención, modo `full` | 6 int. |
| `storage` | Costura de ficheros + driver local | 15 |
| `apps/api` | Fastify, API key → tenant, `/v1/knowledge/*` | 14 int. |
| `apps/worker` | Despachador del outbox, ingesta asíncrona | 8 int. |

El arnés corrió en modo `full` contra un generador real y la puerta PASA (ver
**Estado actual del arnés**). La API sirve `/v1/knowledge/search` y `/answer`,
verificada de punta a punta contra Groq. Faltan los conversores PDF/DOCX.

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

## Próximo paso

Conversores PDF/DOCX, los únicos que necesitan librería. El registro
(`registerConverter`) ya está y la ruta de subida los rechaza hoy con un 415 que
lo dice. Después, CI —no hay `.github`, así que la puerta del arnés no bloquea
nada— y el resto de la superficie de §27.

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

## Cómo trabaja el usuario

Piensa en producto y competencia (Intercom, Glean, Agentforce, Copilot), no solo
en código. Responde bien a que se le señalen tensiones arquitectónicas reales y
a las correcciones honestas — varias de las mejores decisiones del proyecto
salieron de decirle que una idea suya chocaba con otra. Escribe en español.

Los repos `crm-main/` y `TencentDB-Agent-Memory-feat-server_team/` son **material
de referencia, no dependencias**, y están fuera de git. `crm-main` es
single-tenant irreparable (`Company.domain` y `Contact.email` son `@unique`
globales); se canibalizó su esquema CRM y su disciplina de evidencia.
