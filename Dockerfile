FROM node:22-slim
WORKDIR /app

# Copiamos package.json y (si existe) package-lock.json
COPY package.json package-lock.json* ./

# Instala dependencias: usa npm ci si hay lock, si no npm install
RUN set -eux; \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev || npm ci --omit=dev --legacy-peer-deps; \
    else \
      npm install --only=production || npm install --only=production --legacy-peer-deps; \
    fi

# Copia el resto del código
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm","start"]
