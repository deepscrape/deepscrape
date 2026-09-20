# The Angular client bundle is produced by CI/the host (`bun run build`), because
# the identical artifact is deployed to Firebase Hosting. This image only serves
# it, so it never needs the Angular toolchain or the repo's root dependencies.
FROM oven/bun:1.4.2

WORKDIR /app

COPY bff/package.json bff/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY bff/ ./
# The BFF reuses the function's handlers and middleware verbatim via relative
# imports (`../functions/src/...`). From /app/*.ts that resolves to /functions/src
# — one level ABOVE /app — so both the tree and its DEPENDENCY SET have to be
# present: those modules import firebase-functions, express and dotenvx, which
# resolve by walking up from /functions/src. This is invisible in local dev, where
# the function's own node_modules already exists one directory over.
# --ignore-scripts: the function's install scripts build/copy Angular output that
# is not part of this image.
COPY functions/src /functions/src
# package.json goes to /functions (NOT ./functions) so the install lands in
# /functions/node_modules, which is the tree the imports at /functions/src/*
# resolve by walking up. Installing under /app/functions instead leaves them
# unresolved — the module error only shows at runtime, not at build time.
COPY functions/package.json functions/bun.lock* /functions/
RUN cd /functions && bun install --production --ignore-scripts
# ...and the function's source in turn reaches BACK OUT of its own package for the
# shared Redis key/script/store constants (`../../../src/config/...`), which from
# /functions/src/* resolves to /src/config. All 14 such imports live in those three
# modules, so this one directory closes the whole class.
COPY src/config /src/config
# That directory resolves @upstash/redis and rate-limit-redis by walking up from
# /src, so point the lookup at the function's tree. Must come after the COPY above,
# which is what creates /src.
RUN ln -sfn /functions/node_modules /src/node_modules
COPY dist/deepscrape/browser ./dist/deepscrape/browser

ENV NODE_ENV=production \
    PORT=8080 \
    SSR_BROWSER_DIR=/app/dist/deepscrape/browser

USER bun
EXPOSE 8080

CMD ["bun", "run", "server.ts"]
