FROM node:22-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS builder
COPY --chown=node:node . .
# Установка и сборка в одном слое уменьшают расход диска у Docker VFS.
# Необязательный CA для build-прокси передаётся секретом, не сохраняется в слоях.
# DATABASE_URL используется только для анализа Prisma/Next; подключение не требуется.
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci \
    && DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npm run build \
    && chown -R node:node /app/.next \
    && rm -rf tests docs .github /root/.npm

# Повторно используем готовый слой без второй гигабайтной копии node_modules.
FROM builder AS runner
ENV NODE_ENV=production
ENV PORT=3000
# Prisma CLI и tsx нужны для явного запуска миграций и seed в выбранной среде.
USER node
EXPOSE 3000
CMD ["npm", "start"]
