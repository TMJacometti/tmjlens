# In-cluster tmjLens web console. Built on tag web-<semver>.
#
# Frontend and the Linux binary are compiled in separate stages so the runtime
# image is only the binary, the tmjLite engine, and the static UI.

FROM node:20-bookworm-slim AS frontend
WORKDIR /ui
COPY src/package.json src/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY src/ ./
RUN npm run build

FROM rust:1-bookworm AS backend
WORKDIR /build
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./
COPY src-tauri/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked \
    && cp /build/target/release/tmjlens /tmjlens

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 65532 --user-group --create-home --home-dir /app tmjlens

COPY --from=backend /tmjlens /usr/local/bin/tmjlens
COPY --from=frontend /ui/dist /app/dist
COPY tools/tmjlite/libtmjlite_ffi.so /usr/local/lib/libtmjlite_ffi.so

ENV TMJLENS_ADDR=0.0.0.0:8080 \
    TMJLENS_STATIC_DIR=/app/dist \
    TMJLENS_DB_PATH=/var/lib/tmjlens/tmjlens.tmjp \
    TMJLITE_FFI_PATH=/usr/local/lib/libtmjlite_ffi.so

WORKDIR /app
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/tmjlens"]
