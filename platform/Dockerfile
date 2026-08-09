# syntax=docker/dockerfile:1

# Una sola imagen para los tres procesos —API, worker y panel—, que se
# distinguen por el comando.
#
# Es un monorepo con workspaces: los tres comparten `node_modules` y la mitad de
# los paquetes. Tres imágenes separadas significarían compilar tres veces lo
# mismo y mantener tres ficheros que se desincronizan en cuanto alguien añada una
# dependencia a `@platform/knowledge`. Lo que separa a los procesos no es el
# código que llevan dentro, es lo que ejecutan.
#
# `-slim` y no `-alpine`: Prisma y ONNX traen binarios nativos compilados contra
# glibc. En musl, Prisma exige un motor distinto y ONNX directamente no arranca —
# y el síntoma aparece en la primera petición, no al construir.

# ---------------------------------------------------------------------------
# Compilación
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

# openssl lo necesita Prisma para elegir su motor de consultas; sin él avisa y
# escoge mal. ca-certificates, para descargar el modelo de embeddings.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Se copia todo de una vez en vez de escalonar package.json y fuentes. Escalonar
# aprovecha mejor la caché de capas, pero en un monorepo con doce workspaces son
# doce COPY que hay que acordarse de actualizar al añadir el trece — y el fallo
# es un `npm ci` que resuelve mal en silencio. Aquí pesa más no equivocarse.
COPY . .

# `npm ci` y no `npm install`: instala EXACTAMENTE el lockfile. Un despliegue que
# resuelve versiones por su cuenta no despliega lo que se probó.
RUN npm ci

RUN npm run build

# El modelo de embeddings, dentro de la imagen.
#
# `@huggingface/transformers` lo descarga de HuggingFace en la PRIMERA llamada y
# lo cachea. En un contenedor eso significa que la primera ingesta de un cliente
# se queda parada bajando 450 MB — y en on-premise sin salida a internet, que no
# funciona nunca. Como el camino on-premise es una de las razones de existir del
# adaptador de proveedores, la imagen tiene que traerlo puesto.
#
# El coste es honesto y hay que decirlo, con el número medido y no estimado: la
# imagen pesa **2,81 GB**. El modelo son 465 MB de eso; el resto es el árbol de
# `node_modules` sin podar (ver más abajo por qué no se poda). Quien prefiera
# imágenes pequeñas puede quitar esta capa y montar
# `node_modules/@huggingface/transformers/.cache` como volumen, a cambio de una
# descarga en el primer arranque y de necesitar internet.
RUN node --input-type=module -e "\
  const { LocalEmbeddingProvider } = await import('@platform/providers'); \
  const embedder = new LocalEmbeddingProvider(); \
  await embedder.embed(['precalentado'], 'document'); \
  console.log('[build] modelo de embeddings cacheado:', embedder.model); \
  "

# ---------------------------------------------------------------------------
# Ejecución
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Se copia el árbol entero, con las dependencias de desarrollo dentro. No es
# descuido: el paso de migraciones ejecuta la CLI de Prisma, que es una
# devDependency, y el arranque documentado del proyecto es `npm run setup`. Una
# imagen podada obligaría a una segunda imagen solo para migrar, o a reinventar
# el arranque — dos formas de que el despliegue deje de parecerse a lo probado.
COPY --from=builder /app /app

# El usuario `node` viene en la imagen base y no es root. Los procesos escriben
# en /data (volumen), así que el árbol de la aplicación puede quedarse de root.
RUN mkdir -p /data/storage && chown -R node:node /data
USER node

# Sin CMD a propósito: esta imagen no tiene un proceso "por defecto". Cuál de los
# tres se ejecuta lo dice el compose, y dejar uno puesto invita a arrancar el
# equivocado sin darse cuenta.
