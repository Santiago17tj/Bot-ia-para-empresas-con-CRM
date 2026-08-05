# Enterprise AI OS — Arquitectura v3

**Fecha:** 2026-08-04
**Estado:** documento canónico. Sustituye a v2.
**Nombre interno:** `platform` (marcador de posición — §40).

---

## Principio rector

> **No estamos construyendo un chatbot con documentos. Estamos construyendo un sistema operativo de IA para empresas, donde el chat es solo una interfaz. El verdadero producto es un motor empresarial compuesto por conocimiento, memoria, razonamiento, acciones, integraciones y automatización, capaz de comportarse como un empleado experto, ejecutar procesos de negocio y conectarse con cualquier software mediante APIs o estándares abiertos.**

## Regla de núcleo

> **Cada característica nueva responde una pregunta: ¿hace que la empresa dependa más del conocimiento que genera la plataforma? Si la respuesta es sí, pertenece al núcleo. Si solo mejora el chat, es una interfaz y no debe condicionar la arquitectura.**

Esta regla es el filtro de toda decisión futura. Es también el criterio que separa un producto con foso defensivo de otro chatbot con muchas funciones: un cliente cambia de chatbot en una tarde; no cambia del sistema que ha estado midiendo, corrigiendo y mejorando su conocimiento corporativo durante dos años.

## Propuesta de valor

> *Transformamos el conocimiento de tu empresa en un empleado digital que atiende clientes, ayuda a tu equipo, ejecuta procesos y detecta oportunidades de mejora, todo conectado con los sistemas que ya utilizas.*

---

# PARTE I — PRINCIPIOS

## 1. Los cuatro errores que esta arquitectura evita

1. **Que el chat sea el producto.** El motor debe ser útil sin que exista ningún bot.
2. **Que un proveedor sea una dependencia.** `claude` fuera de un adaptador convierte un cambio de modelo en un refactor.
3. **Que responder sea todo lo que hace.** El valor está en las acciones ejecutadas y en el conocimiento que la plataforma genera de vuelta (§14).
4. **Que el sistema adivine.** Se aplica al RAG, al grafo, a las acciones y a los objetivos por igual.

## 2. La regla de costuras

**Costura** = límite entre módulos: barata al principio, carísima de retrofitear. **Implementación** = lo que hay a cada lado: al revés.

> Cada abstracción se define como costura desde el día uno y arranca con **exactamente una** implementación real. La segunda llega cuando un caso real la exige.

§38 declara explícitamente qué se aplaza. Un documento de arquitectura que no dice qué NO construye todavía no es un plan.

## 3. Dónde se compite

No se gana a Glean, Agentforce o Copilot igualando funciones —tienen cientos de ingenieros—. Se gana donde su arquitectura no llega:

| Hueco | Por qué no lo cubren |
|---|---|
| PYME y mediana con autoservicio | Venden implantaciones de seis cifras con consultoría |
| WhatsApp como canal de primera clase | Son productos de escritorio corporativo occidental |
| Español nativo, no traducido | Recuperación, troceado y evaluación pensados para español |
| Stack PYME: Shopify, WooCommerce, Odoo, Holded | Agentforce actúa sobre Salesforce; Copilot sobre M365 |
| Acciones sobre operaciones, no solo soporte | Intercom y Zendesk son productos de soporte |
| **Mejora continua del conocimiento** (§14) | **Todos son estáticos: subes documentos y responden** |

La última fila es el diferencial real y por eso tiene motor propio.

## 4. Topología — los siete motores

```
┌──────────────────────────────────────────────────────────────────────┐
│                         ENTERPRISE AI OS                             │
│                                                                      │
│  Knowledge   Memory    Action    Workflow   Integration              │
│  Engine      Engine    Engine    Engine     Engine                   │
│   §7-9        §10       §16       §17        §18                     │
│                                                                      │
│           Analytics Engine          Learning Engine                  │
│                §29                       §14                         │
└─────────────────────────────┬────────────────────────────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │   CONTEXT ENGINE   (§6)        │
              │   Ensambla el Context Package  │
              │   Punto único de permisos      │
              └───────────────┬────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │   AI ORCHESTRATOR  (§12)       │
              │   Clasifica → Planifica →      │
              │   Ejecuta → Valida             │
              └───────────────┬────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────────────────┐
│ INTERFACES — ninguna privilegiada                                    │
│ WhatsApp · Instagram · Messenger · Widget · REST · SDK · MCP         │
│ Móvil · Webhooks · CRM/ERP/POS externos · Automatizaciones           │
└──────────────────────────────────────────────────────────────────────┘

     AI CONTROL PLANE (§21-25)  ·  EVENT BUS (§19)  — transversales
```

---

# PARTE II — EL MOTOR DE CONTEXTO

## 5. Por qué es un motor y no una función

El LLM nunca debería tener que **descubrir** qué información necesita. Debe recibir un contexto consistente, verificable y presupuestado. El Context Engine es lo que lo garantiza, y se construye en la **Fase 0**.

Tres razones por las que es un módulo con nombre propio y no código disperso:

1. **Punto único de aplicación de permisos.** Si todo contexto se ensambla aquí, los permisos se filtran en un sitio en lugar de en siete. Un filtro olvidado en uno de siete caminos es una filtración; en un solo camino es un test.
2. **Punto único de presupuesto.** La ventana de contexto es finita y cara. Sin un asignador, "historial + CRM + RAG + datos en vivo + reglas + ADN" desborda la ventana el día que un cliente sube un manual grande, y falla en producción, no en pruebas.
3. **Punto único de trazabilidad.** El Context Package es exactamente lo que hay que archivar para reconstruir una respuesta (§25) y para auditar (§31).

## 6. Context Engine

```typescript
interface ContextPackage {
  // Identidad y permisos — resueltos primero, condicionan todo lo demás
  tenant: TenantRef;
  actor: { contact?: ContactRef; user?: UserRef; permissions: PermissionSet };
  channel: { type: ChannelType; capabilities: ChannelCapabilities };

  // Identidad de la empresa
  businessDNA: BusinessDNASnapshot;        // §11 — quiénes somos, cómo hablamos
  activeRules: BusinessRule[];             // §10.2 — qué está vigente hoy
  objectives: ActiveObjective[];           // §13 — qué perseguimos

  // Contexto de la interacción
  conversation: { recentTurns: Message[]; resolvedEntities: EntityMap };
  customerProfile?: CRMSnapshot;           // historial, pedidos, segmento

  // Conocimiento
  retrieved: RetrievedChunk[];             // con procedencia y puntuación
  graphFacts: Relationship[];              // solo VERIFIED y PROBABLE (§8.1)
  liveData: ActionResult[];                // stock, precios, pedidos en vivo

  // Metadatos del propio paquete
  budget: { allocated: TokenBudget; used: TokenBudget; truncated: string[] };
  assemblyTrace: AssemblyStep[];
  packageHash: string;                     // para caché y reproducibilidad
}
```

### 6.1 La tensión con el planificador, y cómo se resuelve

El Context Engine dice *"reúne todo y entrégalo"*. El planificador de §12 dice *"decide qué necesitas y solo entonces búscalo"*. Son filosofías opuestas, y combinarlas ingenuamente hace que se pague dos veces: se recupera todo **y** se planifica sobre ello.

**La resolución: el Context Engine es el ejecutor del plan, no su competidor.**

```
Clasificar intención
   │
   ├─ Intención simple ──▶ RECETA POR DEFECTO ──▶ Context Package ──▶ Generar
   │                       (sin planificar)
   │
   └─ Intención compleja ─▶ PLANIFICAR ──▶ el plan es la RECETA
                                        └─▶ Context Package ──▶ Ejecutar/Generar
```

Una **receta** declara qué fuentes entran y con qué presupuesto. Las recetas por defecto se definen por tipo de intención y no cuestan ninguna llamada al modelo; el planificador solo interviene cuando la pregunta no encaja en ninguna. Así el paquete es siempre consistente y solo se paga la planificación cuando aporta.

### 6.2 El presupuesto es la parte de ingeniería real

Cada fuente tiene prioridad y tope. Cuando el paquete no cabe, se trunca **por política declarada**, nunca por orden de llegada:

| Prioridad | Fuente | Política si no cabe |
|---|---|---|
| 1 | Permisos e identidad | Nunca se trunca. Sin esto, se aborta |
| 2 | Business DNA (núcleo: prohibiciones y límites legales) | Nunca se trunca |
| 3 | Reglas de negocio vigentes aplicables | Se filtra por relevancia, no se recorta a medias |
| 4 | Datos en vivo solicitados | Se reduce el número de acciones |
| 5 | Fragmentos recuperados | Se recorta por puntuación ascendente |
| 6 | Perfil del cliente | Se resume |
| 7 | Historial de conversación | Se compacta (resumen + últimos turnos literales) |
| 8 | Business DNA (tono y estilo) | Se abrevia |

**Lo que se trunca se declara** en `budget.truncated` y viaja a la traza. Un contexto recortado en silencio produce una respuesta peor sin que nadie pueda explicar por qué, y esa es una queja irresoluble.

### 6.3 Por qué las prohibiciones nunca se truncan

Si el ADN dice *"nunca dar diagnósticos médicos"* y esa línea se cae del contexto por falta de espacio en la conversación número cuarenta, el sistema da un diagnóstico. Las prohibiciones y los límites legales viajan en un bloque compacto de prioridad 2, junto a los permisos, y su presencia se verifica antes de generar. Es barato y es la diferencia entre un producto vendible a una clínica y uno que no lo es.

---

# PARTE III — MOTOR DE CONOCIMIENTO

## 7. Knowledge Service

Reutilizable **sin bot, sin chat y sin conversación**.

```
POST /v1/knowledge/search      POST /v1/knowledge/sources
POST /v1/knowledge/answer      POST /v1/knowledge/sources/:id/sync
POST /v1/knowledge/graph/query GET  /v1/knowledge/health
```

### 7.1 Knowledge Sources

```typescript
type SourceKind =
  | "pdf" | "docx" | "xlsx" | "csv" | "txt" | "markdown"
  | "url" | "sitemap" | "rss"
  | "notion" | "confluence" | "google_drive" | "sharepoint" | "dropbox" | "onedrive"
  | "sql_query" | "rest_api" | "graphql"
  | "products" | "inventory" | "pricing" | "orders" | "customers"
  | "manual_entry" | "faq" | "business_rule";
```

Adaptador con `incrementalSync`, `changeDetection`, `supportsPermissions` y `yieldsStructuredEntities` (alimenta el grafo sin extracción, §8.2).

### 7.2 Estable frente a volátil

| Naturaleza | Tratamiento |
|---|---|
| Estable (manuales, políticas, fichas, FAQs) | Se indexa |
| Volátil (stock, precio, estado de pedido) | Se consulta en vivo vía Action (§16) |

Embeber un stock garantiza afirmar con seguridad que hay existencias de algo agotado hace tres semanas.

### 7.3 Versionado

`KnowledgeSource → Document → DocumentVersion → Chunk`, con una sola versión activa. Nada se borra. Permite citar *"según la política del 12 de marzo"*, revertir cargas y auditar qué sabía el sistema cuando respondió.

### 7.4 Metadatos y permisos por fragmento

`title` · `language` · `category` · `tags[]` · `version` · `sourceKind` · `sourceRef` · `department` · `author` · `effectiveFrom` · `expiresAt` · `breadcrumbs[]` · `permissions` · `entityIds[]`

Si el conocimiento viene de Drive o SharePoint, **trae sus ACLs**, y el Context Engine (§5) las aplica antes de que el modelo vea nada.

### 7.5 Recuperación híbrida

Vectorial + léxica (BM25) + expansión por grafo, fusionadas con RRF (`Σ 1/(60 + rank)`). La léxica captura SKUs y referencias donde lo vectorial falla con confianza: `AX-4402` y `AX-4403` son casi idénticos como vectores.

## 8. Knowledge Graph

El RAG no responde *"¿qué productos compatibles con Samsung tienen garantía superior a dos años?"* — eso no es semejanza semántica, son relaciones y filtros.

### 8.1 Bandas de evidencia — el grafo no puede inventar

Un módulo de extracción con LLM produce miles de aserciones inferidas sin verificar, y una relación falsa es peor que una alucinación en texto porque no se lee: se usa.

| Banda | Origen | Uso |
|---|---|---|
| `VERIFIED` | Dato estructurado de integración | Libre |
| `PROBABLE` | Extraído de texto, corroborado | Citando el documento origen |
| `WEAK` | Extracción única sin corroborar | **No se usa**; cola de curación humana |

Una relación nunca es `VERIFIED` porque el modelo lo crea. Lo es porque vino de una tabla.

### 8.2 La mayor parte del grafo se importa, no se extrae

| Prioridad | Fuente de aristas | Coste | Banda |
|---|---|---|---|
| 1 | Integraciones estructuradas (Shopify, Odoo, SQL, CRM) | Casi nulo | `VERIFIED` |
| 2 | Tablas de documentos estructurados (XLSX, CSV) | Bajo | `VERIFIED`/`PROBABLE` |
| 3 | Extracción por LLM sobre texto libre | Alto | `PROBABLE`/`WEAK` |

La extracción por LLM se reserva para lo que solo existe en prosa, en lote y en diferido, nunca en la ruta de respuesta.

### 8.3 Entity Resolution

Se unifica **con evidencia** (identificador compartido, dominio, referencia cruzada), nunca por parecido de nombre. Una fusión errónea de dos proveedores contamina todas las respuestas sobre ambos y nadie lo detecta. Los conflictos van a cola de curación.

## 9. Knowledge Health Engine

**Módulo propio, y uno de los dos diferenciales comerciales del producto.** Mide la salud del conocimiento como un activo, no la calidad de las respuestas.

| Dimensión | Qué mide | Cómo se calcula |
|---|---|---|
| **Cobertura** | ¿Responde el 95 % de lo que preguntan? | Tasa de abstención + escalados, agrupados por tema. **Ya lo tenemos: sale del registro de "no sé"** (§12.2) |
| **Consistencia** | Dos documentos dicen cosas distintas | §9.1 |
| **Actualización** | Documento sin editar en 4 años | `updatedAt` vs. volumen de consultas. Barato y muy revelador |
| **Riesgo** | La política más consultada está vencida | Cruce de `expiresAt` con frecuencia de uso |
| **Confianza** | Esta respuesta depende de un único documento | Recuento de fuentes distintas por tema |
| **Redundancia** | Tres documentos dicen lo mismo con matices | Agrupación por semejanza dentro de categoría |

Cada dimensión produce **hallazgos accionables**, no una puntuación abstracta. *"Salud del conocimiento: 73"* no le dice a nadie qué hacer.

### 9.1 Detección de contradicciones — cómo hacerlo sin arruinarse

Comparar todos los documentos contra todos es O(n²) de llamadas al modelo: en un corpus de 5.000 fragmentos son millones de comparaciones. Inviable como se plantea normalmente. Tres vías, en orden de coste:

1. **En tiempo de consulta, gratis.** Cuando la recuperación devuelve fragmentos de documentos distintos que responden a lo mismo, el validador (§12.2) ya los está comparando. Una discrepancia detectada ahí se registra como hallazgo sin coste adicional. **Esta vía sola cubre las contradicciones que importan: las que aparecen en preguntas reales.**
2. **Por lotes dentro de categoría.** Solo se comparan fragmentos de la misma categoría y con semejanza alta — vecinos en el espacio vectorial. Reduce el problema de millones a cientos.
3. **Dirigida por señal.** Cuando §14 detecta que los humanos editan repetidamente respuestas sobre un tema, ese tema se analiza a fondo.

Nunca un barrido completo del corpus. La contradicción que nadie ha encontrado en una pregunta real no vale lo que cuesta buscarla.

### 9.2 El informe es el producto

Semanal o mensual, entregable al cliente:

> *"Las consultas sobre cambios de talla generan mucha incertidumbre: 250 preguntas esta semana y el 62 % terminan con intervención humana. La documentación existente cubre el proceso pero no las equivalencias entre marcas. Recomendación: crear una guía visual de tallas."*

Eso no es atención al cliente. Es consultoría automática, y es lo que renueva contratos.

---

# PARTE IV — MOTOR DE MEMORIA

## 10. Las tres memorias

| | **Knowledge** | **Business Memory** | **Conversation** |
|---|---|---|---|
| Contiene | Manuales, políticas, catálogo | Reglas operativas vigentes | Historial, preferencias, entidades |
| Origen | Ingesta y sincronización | **Panel, por un humano** | Interacción |
| Ámbito | Tenant | Tenant | Contacto |
| Ciclo | Versionado | Vigencia con fecha, deroga | Retención / RGPD |
| Si se corrompe | Todos responden mal | Todos responden mal **hoy** | Un cliente responde mal |

### 10.1 La barrera

Lo que un cliente cuenta en una conversación **nunca** entra en Knowledge ni en Business Memory. Sin esa barrera, lo que dice un cliente acaba respondiéndose a otro. El único puente permitido es §14, y funciona porque pasa por una persona.

### 10.2 Business Memory

> *"Desde mañana, envío gratis en compras superiores a 300 dólares."*

Ni conversación ni PDF: conocimiento operativo con fecha de entrada en vigor, que deroga una regla anterior.

```typescript
interface BusinessRule {
  statement: string; category: string;
  effectiveFrom: Date; effectiveUntil?: Date; supersedes?: RuleRef;
  authoredBy: UserRef;                        // siempre humano
  scope: { channels?: string[]; segments?: string[]; regions?: string[] };
  priority: number;                           // gana sobre el documento
}
```

- **Precedencia explícita:** si una regla vigente contradice un documento, gana la regla y la respuesta lo dice. Sin precedencia declarada, el modelo elige y el resultado es aleatorio.
- **Solo se escribe desde el panel o la API por un humano autenticado.** Que un cliente pueda instaurar una política diciéndosela al bot sería la vulnerabilidad más grave del sistema.
- **Se indexa y además se inyecta** en el contexto (§6.2, prioridad 3), sin depender de que la recuperación la encuentre.

### 10.3 Conversation Memory

Entidades resueltas, no historial en bruto:

```
"¿Cuánto cuesta la camisa azul?" → {producto: camisa, color: azul}
"¿Y la roja?"                    → {producto: camisa, color: rojo}
"¿La tienes en M?"               → {producto: camisa, color: rojo, talla: M}
```

## 11. Business DNA

El ADN de la empresa condiciona **todas** las respuestas, no solo el prompt. Es lo que convierte cada instancia en un empleado distinto.

```typescript
interface BusinessDNA {
  // Identidad
  mission: string; values: string[]; culture: string;

  // Cómo habla
  voice: { tone: string; formality: Formality; vocabulary: string[]; avoid: string[] };

  // Cómo se comporta — esto es lo que lo diferencia de un prompt de tono
  alwaysDo: BehaviorRule[];      // "siempre enlazar el reglamento aplicable"
  neverDo: BehaviorRule[];       // "nunca dar un diagnóstico" ← nunca se trunca
  legalBoundaries: string[];
  escalationPhilosophy: string;

  // Comercial
  commercialPolicy: { crossSell: boolean; discountAuthority: string; priceDisclosure: string };
  priorities: string[];
}
```

| Sector | Comportamiento característico |
|---|---|
| Clínica | Nunca diagnostica. Siempre ofrece cita |
| Tienda | Siempre sugiere productos relacionados |
| Despacho jurídico | Siempre cita la normativa aplicable |
| Universidad | Siempre enlaza el reglamento |

### 11.1 Tres conceptos que se confundirán si no se separan ahora

| | Qué define | Cadencia de cambio | Quién lo toca |
|---|---|---|---|
| **Business DNA** (§11) | Identidad y comportamiento — **cómo** responde | Meses | Dirección |
| **Business Memory** (§10.2) | Reglas operativas vigentes — **qué** responde | Días | Operaciones |
| **Tenant AI Config** (§23) | Parámetros técnicos — modelo, umbrales, cuotas | Ajuste puntual | Administrador |

Sin esta separación acaban los tres en el mismo blob de configuración, y entonces cambiar el umbral de recuperación exige tocar el mismo objeto que define la misión de la empresa.

### 11.2 `neverDo` es una restricción, no una sugerencia

Las prohibiciones se aplican en **dos** sitios: en el contexto (prioridad 2, nunca truncable, §6.3) y en el validador de salida (§12.2), que comprueba la respuesta generada contra ellas antes de enviarla. Una prohibición que solo vive en el prompt es una prohibición que se incumple el día que la conversación es larga.

---

# PARTE V — RAZONAMIENTO

## 12. AI Orchestrator

```
Entrada (de cualquier interfaz)
  ├─ 1. Resolver tenant, identidad, permisos, configuración
  ├─ 2. CLASIFICAR INTENCIÓN
  │     ├─ simple ──▶ receta por defecto ──▶ Context Package ──▶ generar
  │     └─ compleja ▼
  ├─ 3. PLANIFICAR: ¿documentos? ¿grafo? ¿memoria? ¿acciones? ¿skills?
  │                 ¿workflow? ¿revisión humana? → el plan es la receta
  ├─ 4. CONTEXT ENGINE ensambla el paquete (§6)
  ├─ 5. EJECUTAR (paralelo cuando se puede)
  ├─ 6. ¿Suficiente? ── no ──▶ replanificar (tope de iteraciones)
  ├─ 7. GENERAR con citas obligatorias
  ├─ 8. VALIDAR en código (§12.2)
  ├─ 9. ¿Requiere revisión humana? (§15) → cola, no envío
  └─10. Emitir eventos + traza (§25) + señales de aprendizaje (§14)
```

**La bifurcación del paso 2 es obligatoria.** Sin ella, *"¿cuál es el horario?"* paga un ciclo completo de planificación —tres o cuatro llamadas al modelo, dos segundos, veinte veces el coste— para algo que resuelve una consulta. En un producto que cobra por conversación, es la diferencia entre margen y pérdida.

**Presupuesto explícito por plan:** tope de pasos, coste y tiempo. Alcanzarlo es un final normal que responde con lo que tenga y lo declara.

### 12.1 El modelo genera lenguaje; el sistema decide

Pasos 1, 4, 6, 8 y 9 son determinismo. El modelo participa en clasificar, planificar y redactar.

### 12.2 Grounding — seis capas

| # | Capa | Mecanismo |
|---|---|---|
| 1 | **Umbral de recuperación** | Si nada supera el umbral, **no se invoca al generador** |
| 2 | **Herramientas cerradas** | Solo Actions y Skills autorizadas. Sin web, sin conocimiento general |
| 3 | **Contexto verificado** | El paquete llega completo y con prohibiciones presentes (§6.3) |
| 4 | **Prompt restrictivo** | Del Registry (§22), versionado, nunca en el código |
| 5 | **Salida estructurada** | `{answered, response, citations[], actionsUsed[], rulesApplied[]}` |
| 6 | **Validación en código** | Citas existentes y literales · prohibiciones del ADN respetadas · objetivos que no contradicen fuentes. Lo que falla **no llega al usuario** |

**El modelo nunca declara su propia confianza.** Un modelo al que se le pide puntuar su certeza lo hará, y errará en la dirección que le hace parecer útil. O hay fuente, o no hay respuesta.

Cada *"no sé"* alimenta Knowledge Health (§9) y el panel de vacíos.

## 13. IA con objetivos

Cada empresa declara qué persigue, y el comportamiento cambia:

```typescript
interface Objective {
  kind: "increase_sales" | "reduce_tickets" | "capture_leads"
      | "book_appointments" | "reduce_calls" | "improve_satisfaction";
  weight: number;
  constraints: ObjectiveConstraint[];
  successMetric: KPIRef;                 // se mide, no se supone
}
```

Un objetivo `capture_leads` hace que el sistema pida datos de contacto en el momento oportuno; `reduce_tickets` hace que profundice más antes de escalar; `book_appointments` hace que toda consulta clínica termine ofreciendo cita.

### 13.1 La jerarquía de precedencia — no negociable

Un objetivo es un incentivo, y un incentivo mal acotado produce exactamente el comportamiento que arruina la confianza en el producto: una IA optimizando *"vender más"* recomienda lo que no encaja, exagera beneficios y presiona. En una clínica, *"agendar cita"* sin acotar entra en conflicto con la seguridad del paciente.

**El orden es fijo y se aplica en el validador, no en el prompt:**

```
1. Límites legales y neverDo del ADN   ← ganan siempre
2. Grounding: no afirmar sin fuente     ← un objetivo nunca licencia inventar
3. Reglas de negocio vigentes
4. Objetivos
5. Preferencias de tono
```

Ningún objetivo puede justificar una afirmación sin fuente. *"Vender más"* no autoriza a inventar una ventaja de producto — cambia **qué** se ofrece y **cuándo**, nunca **qué se afirma como cierto**.

---

# PARTE VI — MOTOR DE APRENDIZAJE

## 14. Continuous Knowledge Improvement

El segundo diferencial, y el que crea dependencia según la regla de núcleo. Los competidores son estáticos:

```
Empresa → sube documentos → el chat responde
```

Aquí el ciclo se cierra:

```
Empresa → sube conocimiento → la IA trabaja → detecta problemas
       → sugiere mejoras → aprueba un humano → la empresa mejora → ↺
```

### 14.1 Señales

Respuestas editadas en revisión (§15) · escalados repetidos sobre un tema · preguntas sin respuesta recurrentes · valoraciones negativas · acciones corregidas a mano · consultas al grafo sin resultado · contradicciones detectadas (§9.1) · **información nueva aportada por un empleado**.

### 14.2 Aprendizaje asistido

Un empleado responde en una conversación escalada:

> *"La nueva política de devoluciones es 45 días para clientes premium."*

El sistema detecta que eso no existe en el conocimiento y pregunta:

> *"Esta información no está en el conocimiento empresarial. ¿Convertirla en regla de negocio vigente desde hoy?"*

Con aprobación humana, entra como `BusinessRule` (§10.2) con autor y fecha. **Es el único puente permitido entre conversación y conocimiento** (§10.1), y funciona precisamente porque una persona lo autoriza.

### 14.3 Todo es propuesta, nunca cambio automático

Un sistema que aprende solo de las ediciones aprende también de las equivocadas, y una corrección errónea se propaga a todos sin que nadie pueda señalar cuándo empezó. Cada sugerencia lleva la evidencia que la motivó, cuántas veces se observó, y qué cambiaría exactamente.

### 14.4 Autoevaluación diaria

```
100 conversaciones → 18 respuestas mejorables → 5 documentos incompletos
                   → 3 políticas en contradicción → informe
```

Ejecutada en diferido sobre una **muestra**, no sobre todo el volumen: analizar cada conversación con un modelo duplica el coste del producto. La muestra se estratifica por resultado (escalados y valoraciones negativas entran siempre; el resto por muestreo), que es donde está la señal.

## 15. Human Review

```
Pregunta → IA genera → cola → humano aprueba/edita → envío
```

Se activa por categoría (contratos, RRHH, finanzas, salud, legal), acción irreversible, baja cobertura de fuentes, importe sobre umbral, o regla del tenant.

- **Lo que el humano edita se registra como señal** para §14. Sin eso, la revisión es solo coste.
- **Vencimiento configurable:** si nadie revisa en N minutos, respuesta de reserva o escalado. Una cola sin vencimiento es un cliente esperando indefinidamente sin que nadie lo sepa.

## 16. AI Business Advisor

Función premium. No espera preguntas: analiza el negocio.

> *"En las últimas dos semanas las preguntas sobre garantías del producto X subieron un 40 %. Puede indicar un problema de calidad."*

Se apoya en lo que ya se registra: temas por volumen y tendencia, correlación con pedidos y devoluciones, tasas de escalado por categoría, acciones fallidas.

**Cada observación declara su evidencia y su incertidumbre.** *"Puede indicar"* no es cobardía: correlación no es causa, y un Advisor que afirma causas se equivoca en público delante de un director. La observación es del sistema; la conclusión es del cliente.

---

# PARTE VII — ACCIÓN, PROCESO E INTEGRACIÓN

## 17. Action Engine

```typescript
interface Action<TIn, TOut> {
  readonly name: string; readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly sideEffect: "read" | "write" | "irreversible";
  execute(input: TIn, ctx: ActionContext): Promise<ActionResult<TOut>>;
}
```

| Nivel | Comportamiento |
|---|---|
| `read` | Sin intervención |
| `write` | Se ejecuta, se audita, es reversible |
| `irreversible` | **Confirmación explícita obligatoria** |

Toda ejecución se audita con entrada, salida, origen y conversación. Un pedido creado por error sin rastro de por qué es peor que una alucinación: tiene consecuencias contables.

Catálogo: `inventory.check` · `product.search` · `price.get` · `order.create` · `order.status` · `quote.generate` · `appointment.schedule` · `invoice.get` · `shipment.track` · `crm.upsert_contact` · `crm.create_deal` · `ticket.create` · `email.send` · `human.escalate`

## 18. AI Skills

Una **Action** toca un sistema externo. Una **Skill** transforma información con IA.

| | Action | Skill |
|---|---|---|
| Efecto | Sistema externo | Ninguno fuera del sistema |
| Fallo | Reintentar / compensar | Reintentar es seguro |
| Coste | Llamada API | **Tokens, a veces muchos** |
| Ejemplo | `order.create` | `contract.analyze` |

Catálogo: analizar contrato · resumir · extraer datos estructurados · comparar documentos · clasificar tickets · traducir · generar propuesta · responder RFP · redactar acta.

**Las Skills son producto por sí solas.** `POST /v1/skills/contract.analyze` es vendible a quien nunca usará el chat, y es la prueba más fuerte de que el chat es una interfaz.

## 19. Workflow Engine

```
Cliente pregunta → sin stock → crear tarea → avisar vendedor
                 → enviar correo → programar seguimiento
```

Diseñable visualmente. **Motor de ejecución duradera, no un bucle sobre pasos:** un flujo con una espera de tres días debe sobrevivir a un redespliegue. Estado persistido, pasos idempotentes, reanudación desde el último punto confirmado.

**Presupuesto obligatorio** de pasos, coste y duración: un workflow que dispara un evento que dispara el mismo workflow es un bucle que gasta dinero real.

## 20. Integration Engine

**El bot nunca habla con Shopify: habla con la interfaz.** Una integración sirve a cinco consumidores —Knowledge, Graph, Actions, Context Engine y Event Bus— y por eso es un módulo.

Sincronización **incremental** siempre que el origen lo permita: reindexar 40.000 productos porque cambiaron nueve es un coste recurrente absurdo.

## 21. Event Bus

```
document.uploaded  → extract → chunk → embed → index → graph.update → health.recompute
message.received   → orchestrate → message.sent → crm.activity → analytics → billing
answer.reviewed    → learning.signal
knowledge.gap      → health.finding → advisor.input
```

**Outbox transaccional:** los eventos se escriben en la misma transacción que el cambio que los origina. Sin eso, un fallo entre "guardar documento" y "publicar evento" deja un documento que el panel muestra como listo y que no responde nada, sin log que lo explique.

## 22. Agentes especializados

Un agente es **configuración, no código**: ámbito de conocimiento, acciones, skills, workflows, prompt, reglas de escalado, política de modelo, canales, y **ADN heredado con anulaciones**.

| Agente | Conocimiento | Acciones |
|---|---|---|
| Comercial | Catálogo, precios, promociones | Cotizar, pedido, CRM |
| Soporte | Manuales, FAQs, incidencias | Tickets, envíos, garantías |
| Jurídico | Contratos, políticas, legal | Analizar contrato, revisión humana obligatoria |
| RRHH interno | Convenios, procesos | Solicitudes, ausencias |
| Inventario | Stock, proveedores | Consultar, reservar, reponer |
| Finanzas | Facturación, cobros | Consultar factura, conciliar |

Que el agente jurídico no vea el catálogo no es preferencia: es la contención que impide que una consulta legal se responda con una ficha de producto.

---

# PARTE VIII — PLANO DE CONTROL

**El comportamiento del modelo es configuración operable, no código desplegado.**

## 23. AI Router y Cost Optimizer

| Tarea | Clase de modelo |
|---|---|
| Clasificación de intención, idioma | Rápido y barato |
| Resumen, extracción simple | Rápido y barato |
| Generación fundamentada | Equilibrado |
| Planificación, análisis de contrato | Capacidad alta |
| Razonamiento complejo, comparación | Máxima capacidad |
| OCR, visión | Especializado |

Pagar un modelo caro para responder *"horario"* o *"dirección"* es el error de coste más común: esas preguntas ni siquiera deberían llegar al modelo — las sirve la **caché semántica**, cuya clave incluye el **hash de versión del conocimiento**. Sin ese hash, la caché sirve la política derogada indefinidamente.

## 24. Prompt Registry

**Ningún prompt vive en el código.** Versiones inmutables, variables tipadas, despliegue global/por tenant/por experimento, A/B, rollback. Toda ejecución registra qué versión usó — sin eso, una regresión de calidad es indiagnosticable. Cada versión pasa el conjunto de evaluación antes de promoverse.

## 25. Tenant AI Configuration, Feature Flags y Observabilidad

**Config por tenant:** tono, idiomas, temperatura, acciones y skills habilitadas, coste máximo por conversación y mes, proveedor preferido, proveedor de embeddings, reglas legales, mensaje institucional, umbral de grounding, categorías de revisión humana, residencia de datos.

**Flags** con ámbito global / tenant / porcentaje / usuario interno. Toda respuesta registra qué flags estaban activos.

**Migración de embeddings:** proveedor y dimensión **por fragmento**, varias dimensiones conviviendo, migración por lotes con doble escritura, comparada contra el conjunto de evaluación y conmutada por flag. Sin esto la interfaz `EmbeddingProvider` es cosmética: puedes cambiar de proveedor pero no ejecutar el cambio.

**Observabilidad:** cada ejecución produce una traza —intención, enrutado, plan, **Context Package con lo truncado**, prompts y versiones, recuperación con puntuaciones, consultas al grafo, acciones, reglas aplicadas, flags, tokens, coste, latencia por paso, resultado de validación, errores—. Muestreada para el contenido, completa para la estructura. Cuando un cliente diga *"la IA respondió mal"*, hay que reconstruir exactamente qué ocurrió.

---

# PARTE IX — INTERFACES

## 26. Canales

`ChannelAdapter` con `verifySignature` obligatorio, `parseInbound`, `sendOutbound` y capacidades declaradas (longitud máxima, respuestas rápidas, medios, ventana proactiva). Añadir Telegram o SMS = un fichero.

**Identidad entre canales** solo con evidencia (teléfono verificado, correo confirmado), nunca por parecido de nombre.

**WhatsApp:** la ventana de 24 h es restricción de negocio. El alta tarda días o semanas: **se tramita desde la Fase 0**.

## 27. API pública, MCP, Marketplace y AI Studio

**Todo lo que hace el panel se hace por API.** Si el panel accede a la base de datos por su cuenta, la API pública quedará siempre por detrás.

```
/v1/chat · /v1/knowledge/* · /v1/graph/* · /v1/skills/:name · /v1/actions/:name/execute
/v1/workflows/* · /v1/conversations · /v1/contacts · /v1/sources · /v1/integrations
/v1/events · /v1/analytics/* · /v1/audit · /v1/agents · /v1/prompts · /v1/usage
/v1/health · /v1/advisor · /v1/dna · /v1/objectives
```

**MCP:** Actions, Skills y Knowledge ya son un registro declarativo con esquema JSON; exponerlos es un adaptador fino, siempre que el registro sea declarativo desde el principio.

**Marketplace:** es modelo de negocio, no función. Lo que se decide ahora: identidad de publicador, firma, revisión, permisos que el tenant aprueba, reparto. Un plugin de terceros con acceso a datos de clientes es la mayor superficie de riesgo — el aislamiento se diseña antes del primer plugin externo.

**AI Studio:** Conocimiento → Prompt → Actions → Workflow → Canales → Publicar, sin programar. Es lo último que se construye y lo primero que se diseña: **impone hoy que cada módulo exponga su configuración como datos declarativos**. El módulo que guarde configuración como código queda fuera del Studio para siempre.

---

# PARTE X — GOBIERNO Y NEGOCIO

## 28. Multi-tenancy y seguridad

Tres capas: `tenantId` obligatorio · extensión Prisma que **falla cerrado** sin tenant resuelto · **RLS de Postgres** como red final. Unicidades siempre compuestas `@@unique([tenantId, campo])` — el error exacto que hace inviable bifurcar `crm-main`.

Secretos cifrados en reposo, nunca devueltos por API. API keys con ámbitos y rotación, límites de tasa, webhooks firmados en ambos sentidos. Retención y RGPD con borrado por contacto que alcance conversaciones, memoria, trazas y analítica.

## 29. AI Governance

Registro inmutable: qué respondió · qué fragmentos usó · qué reglas aplicó · qué aristas del grafo · **qué contexto se ensambló y qué se truncó** · qué acción ejecutó · quién autorizó · por qué (el plan) · qué modelo · qué versión de prompt · qué flags · qué coste.

**No es lo mismo que observabilidad:** la observabilidad es operativa, muestreada, retención corta; la gobernanza es legal, completa para categorías reguladas, inmutable, retención larga. Confundirlas lleva a borrar por coste lo que había que conservar por ley.

## 30. Billing y Quotas

**Toda la arquitectura emite métricas de consumo desde el día uno.** El consumo pasado no se reconstruye.

Tokens · embeddings · almacenamiento · conversaciones · acciones · skills · workflows · llamadas a integraciones · usuarios · documentos · llamadas API.

Cuotas configurables con comportamiento explícito al alcanzarlas: bloquear, degradar o exceso facturable. **Nunca fallar en silencio** — un tenant que agota su cuota y no lo sabe cree que el producto está roto. La medición pasa por el Event Bus: si el contador falla, la respuesta sale igual.

### 30.1 Planes

| Plan | Valor |
|---|---|
| **Starter** | Empleado digital para atención al cliente |
| **Growth** | Integraciones con CRM, ERP y ecommerce |
| **Business** | Automatización de procesos y acciones |
| **Enterprise** | Knowledge Intelligence, auditoría, métricas, gobierno de IA y múltiples agentes |

Los planes se implementan como **combinaciones de flags y cuotas** (§25, §30), no como ramas de código. Un plan nuevo es configuración.

Nótese que la progresión no es por volumen sino por profundidad de integración con el negocio: es la regla de núcleo aplicada al precio. Un cliente en Enterprise no paga más conversaciones — paga que la plataforma mida y mejore su conocimiento.

## 31. Analytics Engine y KPIs

**Operativa:** preguntas frecuentes · **sin respuesta** · coste por conversación y tenant · latencia · documentos y fragmentos más usados · uso por integración · tasa de resolución · acciones · escalados.

**KPIs de negocio:**

| KPI | Cómo se calcula honestamente |
|---|---|
| Ventas generadas | Pedidos vía Action, atribuidos a conversación |
| Tickets evitados | Conversaciones resueltas sin escalado |
| Horas ahorradas | Tickets evitados × tiempo medio (**parámetro del cliente**) |
| Tiempo de respuesta | Medido contra línea base previa |
| Conversión | Conversaciones → pedido |
| Calidad de lead | Datos capturados + intención |
| ROI | Valor generado − coste |

**Cada KPI declara su método de cálculo en la interfaz.** Un panel que afirma "127 horas ahorradas" sin decir de dónde sale es marketing, y el primer cliente que lo cuestione en una renovación descubre que no se sostiene.

## 32. White Label

Logo, colores, tipografía, dominio propio con TLS, branding del widget, plantillas de correo, dominio de envío, textos legales, idioma. Tres decisiones que no se deshacen y se toman ahora: URLs de activos, resolución de dominio a tenant, y **plantillas de correo como datos, no como ficheros**.

## 33. Sistema de evaluación

| Métrica | Qué mide |
|---|---|
| Recall@k · Precision | Calidad de recuperación |
| **Grounding** | ¿Toda afirmación respaldada? |
| **Hallucination rate** | ¿Algo ausente de las fuentes? |
| **Abstención correcta** | De las preguntas **sin respuesta**, ¿en cuántas se abstuvo? |
| **Respeto a `neverDo`** | ¿Violó alguna prohibición del ADN? |
| Exactitud del grafo · Acierto del planificador | |
| **Coherencia del Context Package** | ¿Se truncó algo crítico? |
| Latencia p50/p95 · Coste | |

**Un tercio del conjunto deben ser preguntas deliberadamente sin respuesta.** Un sistema que acierta todo lo que sabe y además inventa lo que no sabe puntúa alto en recall y precision y es inservible.

Se ejecuta en cada despliegue —de código, prompt, modelo o embeddings— y **bloquea si hay regresión**.

---

# PARTE XI — EJECUCIÓN

## 34. Modelo de datos

```
Tenant
├── BusinessDNA · Objective · TenantAIConfig · TenantQuota · Branding · FlagOverride
├── ApiKey · AuditLog · GovernanceRecord · Membership
├── AgentProfile
├── KnowledgeSource ─▶ Document ─▶ DocumentVersion ─▶ Chunk
│                                   └ metadata · permissions · entityIds
│                                   └ embedding · provider · dimensions
├── Entity ─▶ Relationship (evidence · band · provenance)
├── BusinessRule (vigencia · precedencia · autor)
├── HealthFinding · AdvisorInsight                    ← §9, §16
├── Integration ─▶ Credential(cifrada) · SyncCursor · SyncRun
├── ChannelConnection ─▶ ChannelIdentity ─▶ Contact
├── Conversation ─▶ Message · ConversationState · ReviewQueueItem
├── ContextPackage (archivado, muestreado)            ← §6
├── ActionDefinition ─▶ ActionExecution
├── SkillDefinition ─▶ SkillExecution
├── WorkflowDefinition ─▶ WorkflowRun ─▶ WorkflowStepRun (duradero)
├── Prompt ─▶ PromptVersion ─▶ PromptDeployment
├── AITrace ─▶ TraceStep
├── UsageRecord · LearningSignal · LearningSuggestion
├── CRM: Company · Contact · Deal · Activity
├── OutboxEvent · SemanticCacheEntry
└── EvalSuite ─▶ EvalCase · EvalRun
```

Los modelos CRM se toman de [`schema.prisma`](crm-main/crm-main/packages/db/prisma/schema.prisma), quitando el enriquecimiento y añadiendo `tenantId` con unicidades compuestas.

## 35. Fases

| Fase | Costuras nuevas | Implementación | Criterio de aceptación |
|---|---|---|---|
| **0. Cimientos** | Tenant+RLS · Event Bus+outbox · **Context Engine** · `AIProvider` · `EmbeddingProvider` · API `/v1` · Prompt Registry · Observabilidad · medición de uso · flags · **BusinessDNA (esquema)** | Una de cada | Dos tenants aislados por test; toda llamada deja traza, Context Package y registro de consumo |
| **1. Knowledge** ⭐ | Sources · versionado · metadatos · permisos · híbrida · **conjunto de evaluación** | PDF/DOCX/URL | `/v1/knowledge/search` responde con citas **sin bot, canal ni panel** |
| **2. Razonamiento** | Clasificación · planificador · recetas · 6 capas de grounding · Conversation + Business Memory · **ADN aplicado y validado** · caché · Router | Widget web | Contexto mantenido, abstención correcta, `neverDo` respetado bajo prueba adversaria |
| **3. Acciones + Hub** | `Action` con niveles · `Integration` · autorización · sync · Human Review | Shopify **o** el ERP del primer cliente | Consulta stock real y crea pedido con confirmación y auditoría |
| **4. Canales + CRM** | `ChannelAdapter` · identidad entre canales · CRM | WhatsApp → Instagram/Messenger | Producción real; conversación → contacto → oportunidad |
| **5. Inteligencia** ⭐ | **Knowledge Health** · **Learning Engine** · grafo con bandas · Skills · **Objetivos** | Grafo desde integraciones · 3 skills | **Primer informe de salud entregable a un cliente real** |
| **6. Automatización** | Workflow duradero · agentes múltiples · Advisor | 2 agentes | Proceso completo end-to-end sin intervención |
| **7. Plataforma** | Marketplace · MCP · AI Studio · White Label · Billing · Quotas | Segundo proveedor IA | Autoservicio completo |

**Dos puntos de decisión.** La **Fase 1** prueba que el motor de conocimiento existe de verdad (criterio deliberadamente incómodo: *sin bot, sin canal, sin panel*). La **Fase 5** prueba el diferencial comercial: si el primer informe de salud no le dice a un cliente real algo que no sabía y puede accionar, la tesis de §14 no se sostiene y hay que revisarla antes de construir encima.

### Lo que se diseña y NO se implementa todavía

| Capacidad | Costura en | Implementación cuando |
|---|---|---|
| Marketplace | Fase 7 | Haya ≥3 plugins de terceros reales |
| AI Studio | Fase 7 | La configuración declarativa esté estable |
| Multiagente (>2) | Fase 6 | Un cliente necesite el tercero |
| MCP | Fase 7 | Exista el primer consumidor |
| Extracción de grafo por LLM | Fase 5 | Tras agotar las fuentes estructuradas |
| Proveedores 2..n | Fase 0 | Lo exija un caso real |
| White Label · Data residency | Fase 0 (campos) | Haya cliente que lo pague o lo exija |
| Advisor | Fase 6 | Haya ≥3 meses de datos históricos |

## 36. Riesgos

| Riesgo | Mitigación |
|---|---|
| **Sobreabstracción — framework que nadie usa** | Regla de costuras (§2) + §35 declara qué se aplaza |
| **Context Engine y planificador pagándose dos veces** | El Engine ejecuta el plan; recetas por defecto sin planificar (§6.1) |
| **Contexto desbordado o truncado en silencio** | Presupuesto con prioridades declaradas; lo truncado viaja en la traza (§6.2) |
| **Prohibición del ADN caída por falta de espacio** | Prioridad 2 no truncable + validación de salida (§6.3, §11.2) |
| **Objetivo que degenera en presión comercial** | Jerarquía de precedencia aplicada en el validador (§13.1) |
| **El grafo contamina el grounding** | Bandas de evidencia; `WEAK` no se usa (§8.1) |
| **Detección de contradicciones inasumible** | Tres vías escalonadas; nunca barrido completo (§9.1) |
| **Autoevaluación duplicando el coste** | Muestra estratificada, en diferido (§14.4) |
| **Aprendizaje que propaga errores** | Todo es propuesta con aprobación humana (§14.3) |
| **Advisor afirmando causas** | Cada observación declara evidencia e incertidumbre (§16) |
| **Cliente instaura políticas hablando con el bot** | Business Memory solo desde panel/API por humano (§10.2) |
| **Alucinación** | 6 capas (§12.2) + un tercio del conjunto sin respuesta (§33) |
| **Coste y latencia por planificar todo** | Bifurcación obligatoria + presupuesto por plan (§12) |
| **Filtración entre tenants** | 3 capas (§28) + test que intente leer otro tenant y falle |
| **Filtración por permisos de origen** | Punto único de filtrado en el Context Engine (§5) |
| **Acción irreversible mal ejecutada** | Niveles + confirmación + auditoría (§17) |
| **Workflow en bucle gastando dinero** | Presupuesto obligatorio (§19) |
| **Queja irresoluble: "respondió mal"** | Traza + Context Package archivado (§25) |
| **Datos volátiles caducados** | Stock y precio vía Action, jamás indexados (§7.2) |
| **Caché sirviendo políticas derogadas** | Hash de versión en la clave (§23) |
| **Migración de embeddings imposible** | Proveedor y dimensión por fragmento (§25) |
| **Evento perdido → documento fantasma** | Outbox transaccional (§21) |
| **Facturación no reconstruible** | Medición desde Fase 0 (§30) |
| **KPIs inflados pierden renovaciones** | Cada KPI declara su método (§31) |
| **Plugin de terceros con acceso a datos** | Aislamiento diseñado antes del primer plugin (§27) |
| **Alta de WhatsApp bloqueada** | Trámite desde Fase 0 |

## 37. Nombre interno

Renombrar de "Bot IA para empresas con CRM". Candidatos: **Enterprise AI OS**, **AI Business Platform**, o un nombre propio. El nombre condiciona lo que la gente cree que construye, y "bot" invita a meter lógica de chat en el núcleo.

---

## 38. Trazabilidad

**Bloque 1 (23):** 1 §1,§4 · 2 §7 · 3 §23 · 4 §25 · 5 §20 · 6 §7.1 · 7 §20 · 8 §27 · 9 §10.3 · 10 §10 · 11 §17 · 12 §17 · 13 §21 · 14 §7.3 · 15 §7.4 · 16 §23 · 17 §33 · 18 §12 · 19 §22 · 20 §27 · 21 §27 · 22 §31 · 23 §28

**Bloque 2 (20):** 1 §8 · 2 §10.2 · 3 §19 · 4 §18 · 5 §22 · 6 §15 · 7 §27 · 8 §25 · 9 §23 · 10 §23 · 11 §25 · 12 §24 · 13 §25 · 14 §30 · 15 §30 · 16 §29 · 17 §14 · 18 §31 · 19 §32 · 20 §27 · ★ Razonar antes de responder §12

**Bloque 3 (v3):**

| Cambio | Sección |
|---|---|
| Enterprise AI OS — siete motores | §4 |
| Regla de núcleo | Cabecera |
| Continuous Knowledge Improvement | §14 |
| Knowledge Health Engine | §9 |
| AI Business Advisor | §16 |
| Aprendizaje asistido | §14.2 |
| IA con objetivos | §13 |
| Personalidad empresarial | §11 |
| Business DNA | §11 |
| Autoevaluación diaria | §14.4 |
| Modelo de negocio por planes | §30.1 |
| **Enterprise Context Engine** | **§5–6** |

**Añadidos no solicitados, por necesidad técnica:** resolución de la tensión Context Engine ↔ planificador (§6.1) · presupuesto de contexto con prioridades y truncado declarado (§6.2) · prohibiciones no truncables (§6.3) · jerarquía de precedencia de objetivos (§13.1) · separación DNA / Business Memory / Config (§11.1) · validación de `neverDo` en la salida (§11.2) · detección de contradicciones escalonada (§9.1) · autoevaluación por muestra estratificada (§14.4) · incertidumbre declarada en el Advisor (§16) · bandas de evidencia en el grafo (§8.1) · prioridad a fuentes estructuradas (§8.2) · autorización por nivel de efecto (§17) · outbox transaccional (§21) · estable frente a volátil (§7.2) · separación observabilidad/gobernanza (§29) · método declarado en cada KPI (§31).

---

## Siguiente paso propuesto

**Fase 0 + Fase 1.** La Fase 0 incorpora ahora el **Context Engine** y el esquema de **Business DNA**, además de Prompt Registry, observabilidad, medición y flags. Los seis son baratos al principio e imposibles de retrofitear: el consumo pasado no se reconstruye, una regresión sin versión de prompt es indiagnosticable, y un contexto ensamblado en siete sitios distintos no se centraliza después sin reescribir todo lo que lo consume.

Criterio de aceptación de la Fase 1, sin cambios y deliberadamente incómodo: `/v1/knowledge/search` y `/v1/knowledge/answer` funcionando **sin bot, sin canal y sin panel**, con conjunto de evaluación desde el primer día y un tercio de preguntas sin respuesta.
