# hydra-gateway image: @hydra/server and the built @hydra/web (spec sections 3.4.4, 11.1).
# Build from the repository root: docker build -f deploy/Dockerfile .
# The build context is filtered by deploy/Dockerfile.dockerignore.

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
ENV CI=true
RUN npm install -g pnpm@12.9.0
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=hydra-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter "@hydra/server..." --filter "@hydra/web..." run build
# Keep only the production dependencies of @hydra/server and of its workspace dependency
# @hydra/shared, in the same workspace layout. The pnpm links are relative, so the tree works
# after the copy to /app.
RUN --mount=type=cache,id=hydra-pnpm-store,target=/root/.local/share/pnpm/store \
    rm -rf node_modules packages/*/node_modules \
    && pnpm install --frozen-lockfile --prod --filter "@hydra/server..."
RUN mkdir -p /out/app/packages/web \
    && cp -a node_modules /out/app/ \
    && cp -a packages/server packages/shared /out/app/packages/ \
    && cp -a packages/web/dist /out/app/packages/web/dist \
    && sh deploy/write-hydra-cli.sh packages/server /app/packages/server /out/hydra

# Distroless Node.js 24 on Debian 13. It contains Node.js 24.21.0 and runs as UID 65532.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/app /app
# `hydra` on PATH without a shell: see deploy/write-hydra-cli.sh.
COPY --from=build /out/hydra /usr/local/bin/hydra
USER 65532:65532
EXPOSE 8080
# The ENTRYPOINT of the base image is /nodejs/bin/node.
CMD ["/app/packages/server/dist/main.js"]
