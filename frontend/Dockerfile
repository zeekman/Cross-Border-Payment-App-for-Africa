# Production (default target):
#   docker build --build-arg REACT_APP_API_URL=https://api.example.com/api \
#     --build-arg REACT_APP_STELLAR_NETWORK=mainnet -t afripay-frontend ./frontend
#   docker run -p 8080:8080 afripay-frontend
# Dev server with hot reload: docker build --target dev ./frontend
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci
COPY . .

FROM deps AS dev
RUN chown node:node /app && mkdir -p node_modules/.cache && chown -R node:node node_modules/.cache
USER node
EXPOSE 3000
CMD ["npm", "start"]

FROM deps AS build
ARG REACT_APP_API_URL
ARG REACT_APP_STELLAR_NETWORK
ARG REACT_APP_STELLAR_HORIZON_URL
ARG REACT_APP_API_TIMEOUT_MS
ARG REACT_APP_SENTRY_DSN
ARG REACT_APP_VAPID_PUBLIC_KEY
ARG REACT_APP_ANCHOR_DOMAINS
# Fail rather than silently ship localhost/testnet defaults.
RUN test -n "$REACT_APP_API_URL" && test -n "$REACT_APP_STELLAR_NETWORK" \
  || { echo "REACT_APP_API_URL and REACT_APP_STELLAR_NETWORK build args are required" >&2; exit 1; }
# ARG values are visible to RUN as environment variables.
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
