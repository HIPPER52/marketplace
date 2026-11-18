# The production image, and the development one, from one file.
#
# Two questions shape it. "What does a build need that a run does not?" — the compiler,
# the type generator, the dev dependencies, the sources themselves — and "what does an
# attacker get to use after a remote code execution?" The first question is what the
# `build` and `deps` stages answer by never reaching the last one. The second is why the
# last one is distroless: it is **not** a size decision. Against `node:22-slim` the
# saving is a few per cent; what changes is that there is no `sh` in the final image, so
# `sh -c` has nothing to execute — not "harder", nothing.
#
# There is no `# syntax=` line and that is deliberate: on Docker 23 and later BuildKit is
# the default builder, and `RUN --mount=type=secret` is understood without it.


# --- build: everything needed to produce dist/, and nothing after that -----------------
FROM node:22-slim AS build
WORKDIR /app

COPY package*.json ./

# The build-time secret, in the one form that leaves no trace.
#
# A private registry token is needed by `npm ci` and by nothing else, and there are three
# places a careless answer leaves it. `ARG NPM_TOKEN` is substituted into the TEXT of this
# command and stays in the image's history and config for ever — `rm` afterwards cleans a
# filesystem, not metadata. `COPY .npmrc` writes the bytes into a layer, and deleting the
# file in the next layer only adds a whiteout on top of them. `--mount=type=secret` is
# neither: the value is mounted at /run/secrets/<id> for the duration of this RUN, it is
# not part of the command text, and no layer ever contains it. `npm run demo:image` looks
# in all three places and prints the three zeros.
#
# No private registry here, so the token is a decoy with a random string in it — which is
# the point of the measurement rather than a weakness of it: whatever it is, it does not
# end up in the image. Optional, so that a build without one still works; the byte count
# is logged, the value never is.
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN="$(cat /run/secrets/npm_token 2>/dev/null || echo '')"; \
    if [ -n "$NPM_TOKEN" ]; then \
        echo "[build] registry token supplied: $(printf '%s' "$NPM_TOKEN" | wc -c) bytes"; \
    else \
        echo "[build] no registry token supplied, installing anonymously"; \
    fi; \
    NPM_TOKEN="$NPM_TOKEN" npm ci --ignore-scripts

# Both of them: tsconfig.json is what `tsc --noEmit` reads and covers src, test and
# scripts, while `build` compiles with -p tsconfig.build.json, the only one carrying a
# rootDir and an outDir. Copying just the first makes the image build fail with
# "TS5058: The specified path does not exist: 'tsconfig.build.json'".
COPY tsconfig*.json ./
COPY src ./src
COPY openapi ./openapi
COPY .env.example ./.env.example
RUN npm run build


# --- deps: the runtime dependency tree, built separately from the one above ------------
#
# `npm ci --omit=dev` from a clean slate rather than pruning the build stage's tree: a
# prune leaves the layer that held the dev dependencies underneath it, and that layer
# travels in the image whether or not the final filesystem shows it.
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force


# --- dev: the watcher the compose override runs ----------------------------------------
FROM build AS dev
ENV NODE_ENV=development
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# gen:types before the watcher, and it is not belt and braces.
#
# `build` generated src/generated/api.ts into the image, and then the dev compose file
# bind-mounts ./src over /app/src — which replaces that directory with the host's. On a
# fresh clone the host has no src/generated at all: it is reproducible output and is
# git-ignored. `nest start --watch` compiles with tsc, so the missing module is a compile
# error, the server never listens, and the container is reported unhealthy with nothing in
# the log that names the cause.
#
# Regenerating at start costs ~25 ms and makes the mounted tree complete. exec so that the
# watcher, not the shell, is the process that receives signals.
CMD ["sh", "-c", "npm run gen:types && exec npm run start:dev"]


# --- runtime: no shell, no package manager, no sources, not root ------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The OpenAPI document is read at runtime: it is what express-openapi-validator validates
# every request and every response against, so it is a runtime asset and not a build one.
COPY --from=build /app/openapi ./openapi

# Numeric, not the image's own `nonroot` name, and that is a Kubernetes requirement rather
# than a preference: `runAsNonRoot: true` makes the kubelet verify the user is not root
# before it starts the container, it cannot resolve names, and a non-numeric USER fails
# with CreateContainerConfigError — "image has non-numeric user (nonroot)".
USER 65532
EXPOSE 3000

# `node` is the entrypoint of this base image, so the command is a path and not a command
# line. The absolute interpreter path is deliberate: a HEALTHCHECK does not run through
# the entrypoint, and there is no shell here to resolve a bare name for it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/main.js"]
