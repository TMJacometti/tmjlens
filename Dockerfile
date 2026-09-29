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
WORKDIR /src
COPY src-tauri ./src-tauri
COPY tools ./tools
WORKDIR /src/src-tauri
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/src-tauri/target \
    cargo build --release --locked \
    && cp /src/src-tauri/target/release/tmjlens /tmjlens

# The Helm plugin's uninstall and rollback are helm's own operations and run
# through its CLI — a faked uninstall would skip release hooks. Pinned to the
# version the publish workflow lints with, checksum-verified.
FROM debian:bookworm-slim AS helm
ARG HELM_VERSION=v3.16.4
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSLO "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
    && curl -fsSLO "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz.sha256sum" \
    && sha256sum -c "helm-${HELM_VERSION}-linux-amd64.tar.gz.sha256sum" \
    && tar -xzf "helm-${HELM_VERSION}-linux-amd64.tar.gz" \
    && mv linux-amd64/helm /helm

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 65532 --user-group --create-home --home-dir /app tmjlens

COPY --from=backend /tmjlens /usr/local/bin/tmjlens
COPY --from=helm /helm /usr/local/bin/helm
COPY --from=frontend /ui/dist /app/dist
COPY --from=backend /src/tools/tmjlite/libtmjlite_ffi.so /usr/local/lib/libtmjlite_ffi.so

# helm writes cache/config under these; /tmp stays writable even with a
# read-only root filesystem.
ENV TMJLENS_ADDR=0.0.0.0:8080 \
    TMJLENS_STATIC_DIR=/app/dist \
    TMJLENS_DB_PATH=/var/lib/tmjlens/tmjlens.tmjp \
    TMJLITE_FFI_PATH=/usr/local/lib/libtmjlite_ffi.so \
    HELM_CACHE_HOME=/tmp/helm/cache \
    HELM_CONFIG_HOME=/tmp/helm/config \
    HELM_DATA_HOME=/tmp/helm/data

WORKDIR /app
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/tmjlens"]
