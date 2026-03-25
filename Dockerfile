FROM oven/bun:1.3.7-alpine AS builder
WORKDIR /app

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile --registry https://registry.npmjs.org --network-concurrency 8 --no-verify

COPY ./admin-ui/package.json ./admin-ui/bun.lock ./admin-ui/
RUN bun install --frozen-lockfile --cwd admin-ui --registry https://registry.npmjs.org --network-concurrency 8 --no-verify

COPY . .
RUN bun run build

FROM oven/bun:1.3.7-alpine AS runner
WORKDIR /app

COPY ./package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 4141

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://localhost:4141/ || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
