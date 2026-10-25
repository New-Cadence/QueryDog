# Build stage for frontend
FROM node:22-alpine AS frontend-builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source files
COPY . .

# Build the frontend
RUN npm run build

# Build stage for CLI
FROM node:22-alpine AS cli-builder

WORKDIR /app/cli

# Copy CLI package files
COPY cli/package*.json ./

# Install CLI dependencies
RUN npm ci

# Copy CLI source
COPY cli/ ./

# Build CLI
RUN npm run build

# Production stage
FROM node:22-slim

# Install CA certificates for TLS connections and useful debugging tools
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl wget && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files for server
COPY package*.json ./

# Install only production dependencies for server
RUN npm ci --omit=dev

# Copy server files
COPY server ./server

# Copy built frontend from builder stage
COPY --from=frontend-builder /app/dist ./dist
# Recommendation providers bundled for the backend scheduler (npm run build:server)
COPY --from=frontend-builder /app/server/generated ./server/generated

# Copy CLI package files and install dependencies
COPY cli/package*.json ./cli/
RUN cd cli && npm ci --omit=dev

# Copy built CLI from builder stage
COPY --from=cli-builder /app/cli/dist ./cli/dist
COPY cli/config ./cli/config

# Ship the bundled client folder (monitoring checks, alert rules, performance
# queries, data quality assertions) so a fresh container works out of the box.
# Bind-mount another client folder and set `client:` in querydog.yml to swap it.
COPY clienta ./clienta

# Copy entrypoint script
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 3001

# Use entrypoint script
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Default to showing help
CMD []
