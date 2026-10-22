FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json .npmrc ./

# Install dependencies (Vite and the build tooling are devDependencies)
RUN npm ci

# Copy source and build config
COPY index.html vite.config.mjs postcss.config.js tailwind.config.js .eslintrc.build.js ./
COPY public/ ./public/
COPY src/ ./src/

# Build for production (override in compose for dev)
RUN npm run build

# Create non-root user
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

# Serves the production build. docker-compose overrides this with `npm start`
# (the Vite dev server) for hot reload.
CMD ["npm", "run", "preview"]
