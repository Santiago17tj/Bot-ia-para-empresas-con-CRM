# Enterprise AI OS

Motor empresarial de conocimiento, razonamiento, acciones e integraciones para
PYME. Multi-tenant, en español.

**No es un chatbot.** El chat es una de sus interfaces, ni la primera ni la más
importante. La regla que filtra cada decisión del proyecto:

> ¿Esto hace que la empresa dependa más del conocimiento que genera la
> plataforma? Si sí, es núcleo. Si solo mejora el chat, es interfaz y no debe
> condicionar la arquitectura.

La diferencia no es retórica. Un chatbot que responde bien es un gasto que se
renueva o no se renueva. Una plataforma que además le dice a la empresa **qué le
preguntan sus clientes y no sabe responder** genera algo que la empresa no tenía
antes y no puede reconstruir si se marcha.

---

## Qué hace hoy, de punta a punta

Está verificado, no descrito:

1. Se sube un PDF o un DOCX por la API — o se conecta una web, un espacio de
   Notion o una carpeta de Drive, que se sincronizan solos por cron.
2. Un worker lo convierte a Markdown conservando encabezados, lo trocea por
   ellos y lo indexa con búsqueda híbrida (vectorial + léxica).
3. Queda respondiendo preguntas **con citas validadas en código**: si una cita
   no aparece literalmente en su fragmento, la respuesta no se sirve.
4. Cada vez que se abstiene, lo registra como **hueco de conocimiento** y los
   agrupa por número de veces.
5. El chat da continuidad entre turnos, reescribiendo los seguimientos para que
   se puedan buscar.

## Lo que lo distingue, con números

La métrica que decide si un producto así es vendible no es el acierto: es la
**abstención**. Un sistema que responde bien todo lo que sabe y además inventa
lo que no sabe puntúa alto en recall y es inservible — peor que inservible,
porque una respuesta inventada con una cita al lado parece fundada.

Medición real contra Postgres y Groq (`openai/gpt-oss-120b`), 14 preguntas —
nueve respondibles y cinco **sin respuesta en el corpus**, cuatro de ellas con
hilo de conversación:

| | |
|---|---|
| Abstención correcta | **100 %** |
| Tasa de alucinación | **0 %** |
| Sobreabstención | 0 % |
| Fallos de citación | 0 % |
| Recall@k | 100 % |
| Reescritura de seguimientos | 100 % |
| Latencia p50 / p95 | 4,0 s / 24,1 s |
| Coste de la tirada | $0,0062 |

El caso que lo demuestra es `sin-plazo-reembolso`: el corpus fija el plazo para
DEVOLVER un pedido (30 días) y no dice nada del plazo de REEMBOLSO. Similitud
alta, respuesta inexistente, ningún umbral la filtraría. El generador se
abstiene.

Y la arquitectura aguanta sin el modelo grande. Tres generadores sobre el mismo
corpus — esta comparación es de los 10 casos de un turno, antes de añadir los
conversacionales:

| | Groq `gpt-oss-120b` | local `qwen2.5:7b` | local `qwen2.5:3b` |
|---|---|---|---|
| Abstención correcta | 100 % | 100 % | 100 % |
| Alucinación | 0 % | 0 % | 0 % |
| Sobreabstención | 0 % | 16,7 % | 33,3 % |
| Puerta | PASA | PASA | **BLOQUEA** |

**Ninguno inventa.** Lo que se degrada al bajar de modelo no es la seguridad
—salida estructurada con citas obligatorias más validación en código— sino la
utilidad: los pequeños se callan cosas que sí sabían.

La latencia sube con los casos conversacionales y no es ruido: un seguimiento
son **dos llamadas al modelo, no una** —primero reescribir, después responder— y
eso lo paga el cliente en cada turno. Para repetir la medición, pon
`AI_PROVIDER` y `GROQ_API_KEY` en `platform/.env` y ejecuta:

```bash
npm run eval
```

Sale con código 1 si la puerta bloquea, y CI la ejecuta en cada push.

## Arranque

Necesitas **Node 22+** y **Docker Desktop**.

```bash
cd platform
npm install
npm run db:up                  # Postgres 17 + pgvector, en el puerto 5433
npm run setup -w @platform/db  # migraciones + SQL crudo (vector, tsvector, RLS)
npm run prompts:seed           # carga el catálogo de prompts en el registro
npm test                       # 411 tests
```

**`setup`, no `db:migrate`.** `prisma migrate dev` interpreta como deriva las
columnas que añade el SQL crudo —vectores, `tsvector`, políticas RLS— y ofrece
resetear la base; decir que sí borra los datos de desarrollo. `setup` es
`migrate deploy` más el SQL crudo, que es lo correcto y lo que usa CI.

Esta secuencia está verificada contra un checkout limpio y un Postgres vacío, no
solo escrita: desde cero hasta los 411 tests en verde.

Para levantarlo:

```bash
npm run dev      # API, en el PORT del .env
npm run worker   # worker, en OTRA terminal
npm run panel    # panel, en http://localhost:3002
```

El worker es un proceso aparte a propósito: el proveedor de embeddings local
corre ONNX en CPU y **bloquea el event loop**. Dentro de la API, ingerir un
manual dejaría al servidor sin responder a nadie.

## El panel

Tres pantallas —subir documentos, preguntar con citas, ver los huecos— en
`http://localhost:3002`. Se entra pegando una clave de API del tenant.

**El panel no toca la base de datos.** No depende de `@platform/db`, así que no
puede: todo pasa por `/v1/*`. Es la regla de §27 convertida en algo que no se
puede incumplir por descuido, y hay un test que lo comprueba.

**La clave no llega al navegador.** El panel la cifra con AES-256-GCM y la deja
en una cookie `httpOnly` y `SameSite=Strict`; el JavaScript de la página no
puede leerla y llama a un proxy del propio panel, que es quien pone la
credencial.

No es multiusuario: se entra con la clave del tenant, no con usuario y
contraseña. `User` y `Membership` existen en el esquema y todavía no los
autentica nadie.

## La API

Todo lo que hace el producto se hace por API. Si el panel accediera a la base
por su cuenta, la API pública quedaría siempre por detrás.

La autenticación es por clave, y de la clave sale el tenant — **nunca de un
campo del cuerpo**: si el `tenantId` fuera un dato de la petición, bastaría
cambiarlo, porque las políticas RLS obedecen al contexto que abre la aplicación,
no a la verdad.

```bash
npm run issue-key -w @platform/api -- <tenantId> "nombre"
```

La clave se imprime una vez: la base solo guarda el hash SHA-256 y los cuatro
últimos caracteres.

| Ruta | |
|---|---|
| `GET /v1/health` | Sin autenticar. Consulta la base: un health que solo dice que el proceso vive miente cuando Postgres está caído |
| `POST /v1/knowledge/search` | Búsqueda híbrida |
| `POST /v1/knowledge/answer` | Respuesta fundada con citas validadas |
| `POST /v1/knowledge/documents` | Subida de fichero → **202** |
| `GET /v1/knowledge/documents[/:id]` | Estado de la ingesta |
| `GET`·`PATCH /v1/knowledge/gaps[/:id]` | Qué le preguntan y no sabe responder |
| `GET`·`POST /v1/sources` · `PATCH /v1/sources/:id` | Orígenes que se sincronizan solos |
| `POST /v1/sources/:id/sync` | Sincronizar ya → **202** |
| `POST /v1/chat` | Conversación con continuidad |
| `GET /v1/conversations/:id` · `POST .../status` | Hilo y escalada |
| `GET`·`POST /v1/contacts` · `GET`·`PATCH /v1/contacts/:id` | Quién pregunta: identidad y datos de contacto |

La ingesta responde 202 y no espera: embeber un manual de 200 páginas no cabe en
un timeout HTTP. La fila del documento y el evento que lo pone en cola se
confirman **en la misma transacción**, así que no existe el documento en
`PENDING` que nadie va a procesar nunca.

## Aislamiento entre clientes

Tres capas, y ninguna sobra:

| Capa | Dónde | Qué hace |
|---|---|---|
| 1 | `schema.prisma` | `tenantId` en cada tabla, unicidades **compuestas** |
| 2 | `packages/db/src/client.ts` | Extensión de Prisma que **falla cerrado** sin contexto |
| 3 | `packages/db/sql/002_*.sql` | Políticas RLS de Postgres |

La capa 2 caza el error en desarrollo con un mensaje que dice qué hacer. La capa
3 es la que sigue negando el día que la capa 2 tenga un fallo. Y la aplicación no
se conecta como propietario de las tablas: un propietario **se salta RLS por
defecto**, así que conectarse así desactiva la capa 3 sin que nada lo indique y
con todos los tests de aislamiento en verde.

`test/isolation.test.ts` verifica que las tres capas nombran las **mismas
tablas**: una tabla en una lista y ausente de otra es exactamente el conjunto de
tablas con una sola defensa.

## Estructura

```
PLAN-TECNICO.md     Arquitectura canónica, 38 secciones. Los comentarios
                    del código citan sus secciones como §6.2
CLAUDE.md           Contexto de trabajo: invariantes, hallazgos medidos,
                    trampas del entorno
platform/           El monorepo
```

| Paquete | |
|---|---|
| `env` | Carga del único `.env` de la raíz |
| `db` | 28 modelos, aislamiento en 3 capas, RLS |
| `providers` | Puertos `AIProvider` y `EmbeddingProvider`, 2 adaptadores |
| `events` | Outbox transaccional y despachador |
| `observability` | Trazas, Prompt Registry, siembra, consumo |
| `context` | Context Engine, presupuesto, recetas |
| `knowledge` | Conversión, troceado, híbrida, grounding, respuesta, huecos, conversación |
| `eval` | Arnés de evaluación con abstención y puerta |
| `storage` | Costura de ficheros y driver local |
| `secrets` | Cifrado en reposo AES-256-GCM, llavero, redacción |
| `connectors` | Web, Notion, Drive, defensa SSRF, cron con zona horaria por tenant |
| `apps/api` · `apps/worker` | Fastify · outbox, ingesta, sincronización |

## Decisiones que conviene conocer antes de tocar nada

**Ningún prompt vive en el código.** Están en el Prompt Registry, versionados, y
cada respuesta archiva el `versionId` que usó. Una versión desplegada es
inmutable: si el texto cambia, sube el número. Sin eso, una traza archivada cita
un texto que ya no es el que la produjo y deja de explicar nada.

**Sin salida estructurada no se genera.** `json_object` garantiza JSON válido y
**nada** sobre su forma: el modelo devuelve un objeto sin `citations` y el fallo
no es ruidoso, es una respuesta bien formada y sin fundar. Solo cuenta
`json_schema`.

**Un conector que descarga URLs elegidas por el cliente es un SSRF por diseño.**
`http://169.254.169.254/…` es el endpoint de metadatos de AWS, GCP y Azure y
devuelve credenciales de la instancia; un rastreador ingenuo la guarda como
"documento" y el cliente la consulta después por la API de conocimiento. Se
resuelve el nombre y se juzgan **las IPs**, no el texto, y se valida **cada
salto** de redirección.

**Los secretos no salen por la API ni cifrados.** Publicar un texto cifrado es
publicar algo que solo depende de una clave, y las claves se filtran.

**La similitud coseno no es una señal de abstención.** Está medido: sobre
`multilingual-e5-small`, las preguntas respondibles puntúan 0,853–0,927 y las
que no tienen respuesta 0,775–0,846. Siete milésimas de hueco. El umbral solo
descarta el disparate; **la abstención la decide el generador**, y por eso hace
falta uno para medirla.

El resto de hallazgos —con sus tablas y lo que costó descubrirlos— está en
[`CLAUDE.md`](CLAUDE.md).

## Lo que todavía no está

Se dice porque un README que solo enumera lo que funciona es publicidad:

- **Notion y Drive están verificados contra servidores simulados**, no contra
  cuentas reales. Eso verifica nuestro código, no el comportamiento de Notion ni
  el de Google.
- **No hay CRM.** `/v1/contacts` guarda identidad y datos de contacto, que es lo
  que pide §27 para esta fase. `Company`, oportunidades y sincronización con un
  CRM externo son Fase 4 y no están empezadas.
- **No hay canales.** `WHATSAPP` es hoy un valor del enum de canal de una
  conversación, no una integración con Meta.
- **El panel no tiene login de usuario.** Se entra con la clave de API del
  tenant; no hay contraseñas ni sesiones por persona.
- `xlsx`, `pptx` y el `.doc` antiguo se rechazan con un 415 que dice qué hacer.
- Sin generador configurado, los huecos **no se agrupan**: cada abstención abre
  su fila. Peor informe, pero no es un dato perdido — y es mejor que agrupar con
  un umbral que la medición dice que no existe.
