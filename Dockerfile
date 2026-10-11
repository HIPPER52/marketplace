FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
# Both of them: tsconfig.json is what `tsc --noEmit` reads and covers src, test and
# scripts, while `build` compiles with -p tsconfig.build.json, the only one carrying a
# rootDir and an outDir. Copying just the first makes the image build fail with
# "TS5058: The specified path does not exist: 'tsconfig.build.json'".
COPY tsconfig*.json ./
COPY src ./src
COPY openapi ./openapi
COPY .env.example ./.env.example
RUN npm run build


FROM builder AS dev
ENV NODE_ENV=development
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# gen:types before the watcher, and it is not belt and braces.
#
# `builder` generated src/generated/api.ts into the image, and then the dev compose file
# bind-mounts ./src over /app/src — which replaces that directory with the host's. On a
# fresh clone the host has no src/generated at all: it is reproducible output and is
# git-ignored. `nest start --watch` compiles with tsc, so the missing module is a compile
# error, the server never listens, and the container is reported unhealthy with nothing in
# the log that names the cause.
#
# Regenerating at start costs ~25 ms and makes the mounted tree complete. exec so that the
# watcher, not the shell, is the process that receives signals.
CMD ["sh", "-c", "npm run gen:types && exec npm run start:dev"]


FROM node:22-slim AS runner
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/openapi ./openapi
COPY .env.example ./.env.example
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
