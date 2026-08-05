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
npm test               # 137 tests
```

`.env` ya existe en `platform/` (ignorado por git). `.env.example` lo documenta.

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

**Fase 0 completa. Fase 1 al 80%.**

| Paquete | Qué es | Tests |
|---|---|---|
| `env` | Carga del único `.env` de la raíz | — |
| `db` | 22 modelos, aislamiento 3 capas, RLS | 11 + 9 int. |
| `providers` | `AIProvider` + `EmbeddingProvider` | 10 |
| `events` | Outbox transaccional + despachador | 11 |
| `observability` | Trazas, Prompt Registry, consumo | 11 |
| `context` | Context Engine, presupuesto, recetas | 22 |
| `knowledge` | Conversión, troceado, híbrida, grounding | 45 + 10 int. |
| `eval` | Arnés con abstención | 6 int. |

Falta: **generador** (para medir abstención de verdad), `apps/api` con
`/v1/knowledge/search` y `/answer`, y conversores PDF/DOCX.

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
precisión y latencia. El código lo dice explícitamente y emite un aviso.

## Estado actual del arnés

```
Recall@k              100.0%
Precision             100.0%
Abstención correcta     0.0%   ← con umbral solo
RESULTADO: BLOQUEA
```

**La puerta bloqueando es correcto**, no un fallo: el arnés dice la verdad. La
recuperación funciona; falta el generador para que las capas 4–6 abstengan.

## Próximo paso

Añadir un generador gratuito para cerrar Fase 1 con la medición completa.
Pendiente de decisión del usuario:

- **Ollama** local — sin cuenta, consume RAM
- **Groq** plan gratuito — más rápido, requiere registro, soporta salida
  estructurada (necesaria para las citas obligatorias)

Después: `apps/api` con `/v1/knowledge/search` y `/answer`, y los conversores
PDF/DOCX (los únicos que necesitan librería).

## Decisiones abiertas

- **Proveedor de embeddings definitivo.** Ahora el local gratuito. Cambiarlo
  obliga a reindexar, pero la convivencia de dimensiones ya está implementada y
  probada (`packages/knowledge/src/dimensions.ts` + migración 003).
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
