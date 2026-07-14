FROM node:22-slim

WORKDIR /app

# Устанавливаем зависимости отдельным слоем для кэширования.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["node", "server.js"]
