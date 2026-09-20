# apps/web/Dockerfile
# NOTE: build context must be the repo root (see infra/docker/docker-compose.yml).

FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json
RUN bun install --frozen-lockfile

COPY apps/web ./apps/web
COPY packages/crypto ./packages/crypto

WORKDIR /app/apps/web
# The only build input left, and it defaults to the relative same-origin form
# so an image built with no arguments works on any domain. Next compiles a
# NEXT_PUBLIC_ value into the browser bundle, so an absolute value here would
# send every user of this image to whichever host built it. Pass one only for
# a cross-origin layout, which is what the local smoke stack has: web on 3000
# calling an API on 8080. SITE_URL is not here on purpose; it is read on the
# server at runtime.
ARG NEXT_PUBLIC_API_BASE=/api/v1
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
RUN bun run build

# ---- Runtime stage ----
FROM oven/bun:1 AS runtime
WORKDIR /app

COPY --from=build --chown=10001:10001 /app /app

# The same value again for the server side: proxy.ts derives the CSP
# connect-src from it at request time, which the bundle does not carry.
ARG NEXT_PUBLIC_API_BASE=/api/v1
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE

WORKDIR /app/apps/web
# Non-root, matching the API image. The tree is owned by the same UID because
# Next writes its image cache under .next at runtime, and bun looks for a
# writable HOME even when it has nothing to install.
ENV HOME=/tmp
USER 10001:10001
EXPOSE 3000
CMD ["bun", "run", "start"]
