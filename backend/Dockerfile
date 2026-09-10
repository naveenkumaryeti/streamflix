# StreamFlix backend. Three build targets, matching docker-compose.yml and the Helm chart:
#   runtime  - used by both `api` and the one-shot `migrate` job. No ffmpeg — the API never
#              transcodes anything itself, and keeping it slim keeps image pulls/scans fast.
#   worker   - runtime + system ffmpeg, for the local-mode transcoder driver (media/transcoder/
#              ffmpegTranscoder.js shells out to the `ffmpeg` binary via spawn()). In
#              MediaConvert mode the binary just sits unused — cheap insurance either way.
#
# Both final stages run as a non-root user and expect the caller to set NODE_ENV, DATABASE_URL,
# REDIS_URL, etc. via env/secrets (see docker-compose.yml locally, the Helm chart in EKS).

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-alpine AS runtime
RUN addgroup -S streamflix && adduser -S streamflix -G streamflix
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/storage && chown -R streamflix:streamflix /app
USER streamflix
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]

FROM runtime AS worker
USER root
RUN apk add --no-cache ffmpeg
USER streamflix
EXPOSE 9090
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_PORT||9090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/worker/index.js"]
