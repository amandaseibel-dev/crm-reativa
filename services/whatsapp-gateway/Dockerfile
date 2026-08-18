# Imagem enxuta: sem navegador, sem Chrome, sem Puppeteer. O Baileys fala o
# protocolo do WhatsApp direto por websocket — é o que permite os 2 números
# caberem com folga em 1-2 GB de RAM.
FROM node:20-alpine

# tini garante que sinal de parada chegue ao processo e a sessão feche limpa,
# em vez de morrer no meio de uma escrita de credencial.
RUN apk add --no-cache tini

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Volume das credenciais e da fila de reenvio. SEM ISTO, recriar o container
# significa reparear o número — e reparear significa perder para sempre a
# chance da sincronização inicial daquele número.
RUN mkdir -p /dados
VOLUME ["/dados"]

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
