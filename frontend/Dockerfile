# StreamFlix web client.
#
# Two build args are baked into the bundle at build time (Vite convention — anything read via
# import.meta.env must exist before `vite build` runs, not at container start):
#   VITE_API_BASE_URL  - where the browser sends API requests, e.g. http://localhost:8080/api/v1
#   VITE_APP_NAME       - display name used in the nav bar and auth screens
#
# docker-compose.yml already passes both. The final image is nginx serving the static bundle
# on :8080 (compose maps host 3000 -> this), with an SPA fallback so client-side routes
# (e.g. /title/inception) don't 404 on a hard refresh.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ARG VITE_API_BASE_URL=http://localhost:8080/api/v1
ARG VITE_APP_NAME=StreamFlix
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_APP_NAME=${VITE_APP_NAME}

RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
