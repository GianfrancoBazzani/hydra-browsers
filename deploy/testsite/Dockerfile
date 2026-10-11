# hydra-testsite image: @hydra/testsite, used only by the dev overlay (spec sections 11.1, 15.3).
# Build from the repository root: docker build -f deploy/testsite/Dockerfile .

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
ENV CI=true
RUN npm install -g pnpm@12.9.0
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=hydra-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
    && pnpm --filter @hydra/testsite run build \
    # No runtime dependencies, so `pnpm deploy` (which needs a lockfile importer) is not used.
    # Switch back to it if @hydra/testsite gains a dependency.
    && mkdir -p /out && cp -a packages/testsite/dist packages/testsite/package.json /out/

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/main.js"]
