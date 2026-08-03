FROM node:22-slim

WORKDIR /app

# Chromium do proprio Debian em vez do binario baixado pelo puppeteer:
# menor, com as libs de sistema resolvidas via apt, e usado pelo modo
# "SPA" (renderizacao via Puppeteer) do downloader.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
