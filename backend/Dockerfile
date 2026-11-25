FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./

# Development target: full install (includes nodemon), used by docker-compose
FROM base AS dev
RUN npm ci
COPY src/ ./src/
RUN mkdir -p uploads && chown -R node:node /app
USER node
EXPOSE 5000
CMD ["npm", "run", "dev"]

# Production target
FROM base AS prod
ENV NODE_ENV=production
RUN npm ci --omit=dev
COPY src/ ./src/
ENV MIGRATIONS_DIR=/database/migrations  # mount repo-root database/ here to run migrations
RUN mkdir -p uploads \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && chown -R nextjs:nodejs /app
USER nextjs
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"
CMD ["npm", "start"]
