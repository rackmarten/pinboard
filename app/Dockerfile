# syntax=docker/dockerfile:1
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Every dependency, @rackmarten/* included, is on the public npm registry, so
# the build needs no token.
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Separate stage (not a step in the server's own build above) since it has
# an entirely different dependency tree (Vue/Vuetify/Vite, not
# Fastify/drizzle) - see pwa/package.json. Its dist/ becomes the server's
# ./public at runtime - the server serves the built SPA itself, there's no
# separate frontend container.
FROM node:26-alpine AS pwa-build
WORKDIR /app/pwa
COPY pwa/package.json pwa/package-lock.json ./
RUN npm ci
# Where account avatars live, as `<base><user id>`; empty shows initials.
ARG AVATAR_BASE_URL=""
ENV VITE_AVATAR_BASE_URL=${AVATAR_BASE_URL}
COPY pwa/tsconfig.json pwa/vite.config.ts pwa/index.html ./
COPY pwa/public ./public
COPY pwa/src ./src
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=pwa-build /app/pwa/dist ./public
COPY drizzle ./drizzle
EXPOSE 8095
CMD ["node", "dist/index.js"]
