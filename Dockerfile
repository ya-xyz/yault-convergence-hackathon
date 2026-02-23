# Yallet Asset Management Platform — Server
# Multi-stage build: WASM core + Node.js API

# --- Stage 1: Build WASM core ------------------------------------------------
FROM rust:1.75-slim AS wasm-builder

RUN apt-get update && apt-get install -y curl && \
    curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh && \
    rustup target add wasm32-unknown-unknown && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build/wasm-core
COPY wasm-core/ .
RUN wasm-pack build --target web --release

# --- Stage 2: Node.js server -------------------------------------------------
FROM node:18-slim

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json ./
RUN npm install --omit=dev

# Copy server and client source
COPY server/ ./server/
COPY client/ ./client/

# Copy WASM build output
COPY --from=wasm-builder /build/wasm-core/pkg/ ./wasm-core/pkg/

# Copy unified web app (client / authority / ops portals)
COPY webapp/ ./webapp/

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>{if(!r.ok)throw 1})" || exit 1

CMD ["node", "server/index.js"]
