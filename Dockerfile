FROM oven/bun:1.3.14-alpine AS bun-runtime
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY ./admin-ui/package.json ./admin-ui/bun.lock ./admin-ui/
RUN bun install --frozen-lockfile --cwd admin-ui --ignore-scripts
COPY . .
RUN bun run build

FROM bun-runtime AS runner
WORKDIR /app
COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --no-cache
COPY --from=builder /app/dist ./dist
COPY entrypoint.sh /entrypoint.sh
COPY docker-data-home.sh /docker-data-home.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data/cache && chown bun:bun /data /data/cache
USER bun
EXPOSE 4141
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:4141/ || exit 1
ENTRYPOINT ["/entrypoint.sh"]
