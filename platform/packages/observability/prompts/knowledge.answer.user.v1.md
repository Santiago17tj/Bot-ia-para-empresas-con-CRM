---
key: knowledge.answer.user
version: 1
description: Turno de usuario del generador de respuestas fundadas — fragmentos y pregunta.
variables: contexto, pregunta
notes: Separado del prompt de sistema para que el prefijo estable sea cacheable y lo volátil quede después (§23).
---
FRAGMENTOS

{{contexto}}

PREGUNTA

{{pregunta}}
