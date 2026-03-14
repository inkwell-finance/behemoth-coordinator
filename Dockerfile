# Multi-stage build for Behemoth Coordinator (public)
# Build context should be repos/ directory
# Using Node.js 22 for runtime due to libp2p requirements:
#   - Bun lacks full X25519/TLS crypto support
#   - libp2p deps (it-queue) require Promise.withResolvers (Node 22+)
FROM node:22-slim AS builder

WORKDIR /app

# Copy shared protocol package first
COPY behemoth-protocol/ ./behemoth-protocol/

# Copy coordinator package
COPY behemoth-coordinator/package.json behemoth-coordinator/package-lock.json* ./behemoth-coordinator/

# Install dependencies from coordinator directory
WORKDIR /app/behemoth-coordinator
RUN npm install

COPY behemoth-coordinator/tsconfig.json ./
COPY behemoth-coordinator/src/ ./src/

# Production runner - using Node.js 22 with tsx for TypeScript execution
FROM node:22-slim AS runner

RUN addgroup --system coordinator && adduser --system --ingroup coordinator coordinator

WORKDIR /app

# Install tsx globally for TypeScript execution
RUN npm install -g tsx

# Copy protocol (needed at runtime for types and values)
COPY --from=builder --chown=coordinator:coordinator /app/behemoth-protocol ./behemoth-protocol
COPY --from=builder --chown=coordinator:coordinator /app/behemoth-coordinator/node_modules ./node_modules
COPY --from=builder --chown=coordinator:coordinator /app/behemoth-coordinator/src ./src
COPY --from=builder --chown=coordinator:coordinator /app/behemoth-coordinator/package.json ./
COPY --from=builder --chown=coordinator:coordinator /app/behemoth-coordinator/tsconfig.json ./

# Fix local package symlink - npm creates a relative symlink that doesn't work
# after copying files to a different directory structure
RUN rm -f node_modules/@behemoth/protocol && \
    mkdir -p node_modules/@behemoth && \
    ln -s /app/behemoth-protocol node_modules/@behemoth/protocol

USER coordinator

# P2P libp2p port
EXPOSE 4001

# gRPC port for trader communication
EXPOSE 50051

# HTTP API port
EXPOSE 8080

CMD ["tsx", "src/index.ts"]

