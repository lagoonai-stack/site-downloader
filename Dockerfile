FROM node:20-slim

WORKDIR /app

# O download do Chromium do puppeteer (dependencia opcional, usada so
# no modo "SPA") e pesado e nao e necessario para o funcionamento
# principal do login/downloader. Pulamos para builds mais rapidos e
# previsiveis; o modo SPA fica desabilitado nesta imagem.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
