FROM node:22-alpine AS build
WORKDIR /app
# better-sqlite3 falls back to compiling if no prebuilt binary matches.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ARG GIT_SHA=""
ARG GIT_COMMIT_DATE=""
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 GIT_SHA=$GIT_SHA GIT_COMMIT_DATE=$GIT_COMMIT_DATE
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "dist/server.js"]
