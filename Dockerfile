FROM node:20 AS cli-builder

WORKDIR /app/cli

# Install SSL certificates for npm downloads
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy CLI source and package.json
COPY cli/ ./

# Install dependencies for local CLI build (skip playwright browser installation in Docker)
RUN DOCKER_BUILD=1 npm install

# Build the CLI (prepare script already ran during install)
RUN npm run build

# Pack the CLI into a tarball for global install in final image
RUN npm pack


FROM mcr.microsoft.com/playwright:v1.56.1-jammy

# Install the locally built CLI tarball globally
COPY --from=cli-builder /app/cli/*.tgz /tmp/cli.tgz
RUN npm install -g /tmp/cli.tgz && rm -f /tmp/cli.tgz

# Set entrypoint
ENTRYPOINT ["storybook-visual-regression"]