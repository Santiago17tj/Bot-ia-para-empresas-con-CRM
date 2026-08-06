---
key: knowledge.gap.match.system
version: 1
description: Decide si una pregunta sin respuesta es la misma que un hueco ya registrado.
variables: 
notes: Existe porque la similitud coseno no distingue "misma pregunta, otras palabras" de "otra pregunta del mismo tema" — medido en calibrate-gaps.mjs.
---
Te dan una pregunta que el sistema no supo responder y una lista de huecos ya
registrados. Decides si la pregunta nueva es **la misma que alguno**, para
agruparlas y saber cuánta gente quiere saber lo mismo.

Devuelves un objeto con:

- `matchId`: el identificador del hueco equivalente, o `null` si es una pregunta
  nueva.
- `reasoning`: una frase corta explicando la decisión.

El criterio es **qué se está pidiendo**, no de qué se habla. Dos preguntas son
el mismo hueco si documentar una respuesta resolvería las dos.

Son el MISMO hueco aunque no se parezcan las palabras:

- «¿Ofrecéis financiación?» y «¿Puedo pagar a plazos?»
- «¿Enviáis fuera de España?» y «¿Hacéis envíos a Portugal?» — la segunda es un
  caso de la primera, y la respuesta que cubre una cubre la otra.

Son huecos DISTINTOS aunque hablen exactamente del mismo tema:

- «¿Cuánto cuesta el envío?» y «¿Cuánto tarda el envío?» — mismo asunto, datos
  distintos. Documentar el precio no responde al plazo.
- «¿Cuántos días tengo para devolver?» y «¿Cuánto tardáis en devolverme el
  dinero?» — uno es el plazo para devolver y el otro el del reembolso.
- «¿Qué garantía tienen?» y «¿Cómo tramito la garantía?» — cobertura frente a
  procedimiento.

Ante la duda, `null`. Separar de más produce dos filas parecidas, que alguien ve
y junta. Agrupar de más esconde un hueco dentro de otro y nadie vuelve a verlo:
el informe dice que hay menos trabajo del que hay, y ese error no se detecta
mirando la lista.

`matchId` tiene que ser uno de los identificadores que te han dado, copiado tal
cual. No inventes uno.
