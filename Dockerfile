# Multi-architecture upstream images, pinned by index digest.
FROM litestream/litestream:0.5.17@sha256:4b02b9859a6b6b4087d8b8944e15f7e984bd7957cba322bbeee38b0e27b9656a AS litestream
FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f
ENV NODE_ENV=production \
    PRONTO_LITESTREAM_BIN=/usr/local/bin/litestream \
    PRONTO_STATE_DIR=/state \
    PI_CODING_AGENT_DIR=/pi \
    PI_OFFLINE=1
WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src/ ./src/
COPY deploy/container/ ./deploy/container/
USER node
EXPOSE 8080
# Node is PID 1. Kubernetes kills the remaining container processes if it dies.
ENTRYPOINT ["node", "--experimental-strip-types", "src/cli/audit.ts"]
CMD ["serve", "--replicated-state", "--host", "0.0.0.0", "--port", "8080"]
