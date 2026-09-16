# Образ API. Тот же, что уезжает в Container Registry и запускается на ВМ
# (пункт cloud-cicd), и тот же, что поднимается рядом с базой в docker compose.
FROM node:22-alpine

WORKDIR /app

# Зависимости ставятся отдельным слоем: правка кода не должна тянуть за собой
# повторную установку пакетов.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Приложение под своим пользователем: в образе node такой уже есть.
USER node

# Проба живости — тот же путь, который опрашивает балансировщик.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/api/server.ts"]
