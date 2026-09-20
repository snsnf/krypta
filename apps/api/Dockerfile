# apps/api/Dockerfile

# ---- Build stage ----
FROM rust:1-slim-bookworm AS build
WORKDIR /app

# System packages first, above every COPY. They depend on this file rather
# than on the source, so ordering them here keeps editing one Rust file from
# re-running the install, which measured 39s of a 276s build.
#
# webauthn-rs pulls in webauthn-attestation-ca, which links against native
# OpenSSL (openssl-sys). The rest of this service deliberately uses rustls,
# so pkg-config and libssl-dev are an exception forced by that one
# dependency, not a general choice, and are needed here to compile it.
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

ENV SQLX_OFFLINE=true

# Compile the dependency tree against the manifests alone.
#
# This layer is keyed on Cargo.toml and Cargo.lock, so it survives every
# source change and re-runs only when a dependency actually moves. Without it
# `COPY src` sat above the only build step, so editing one Rust file
# recompiled axum, tokio, sqlx, webauthn-rs and the native OpenSSL it links:
# the whole 235s, every time.
#
# The stub binary exists only to give cargo something to build. Its artifacts
# are removed afterwards so the real build below cannot link a stale `api`
# from it. Dependency artifacts stay, which is the entire point.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src target/release/api target/release/api.d target/release/deps/api-*

COPY src ./src
COPY migrations ./migrations
COPY .sqlx ./.sqlx
RUN cargo build --release

# ---- Runtime stage ----
FROM debian:bookworm-slim AS runtime
WORKDIR /app

# libssl3 is the runtime counterpart to libssl-dev above: webauthn-rs's
# native OpenSSL dependency needs it to load at runtime, even though the
# rest of this service uses rustls.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/target/release/api ./api

# Nothing here needs root: the binary reads its configuration from the
# environment and writes nothing to disk. A numeric UID rather than a named
# user so the image needs no passwd entry and orchestrators can verify it.
USER 10001:10001

EXPOSE 8080
CMD ["./api"]
