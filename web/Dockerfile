# Образ фронта: сборка Vite, раздача через nginx.
#
# Собирается в два шага, чтобы в готовый образ не уехали ни node_modules, ни
# исходники: наружу выходит каталог dist и конфиг nginx.
FROM node:22-alpine AS build

WORKDIR /app

# Зависимости отдельным слоем: правка кода не должна тянуть переустановку пакетов.
COPY package.json package-lock.json ./
RUN npm ci

COPY vite.config.js index.html ./
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# Проба живости идёт тем же путём, каким её делает браузер: через проксирование
# на API. Если сломалось проксирование — контейнер об этом скажет.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1/health || exit 1
