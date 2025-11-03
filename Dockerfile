# Simple, single-stage image that installs the CLI from GitHub and bakes deps into the image
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

# Install git for cloning the repository
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Build args to allow pinning a specific ref (tag/branch/commit)
ARG CLI_REPO=https://github.com/mjbeswick/storybook-visual-regression.git
ARG CLI_REF=main

# Clone only the requested ref (shallow) and install the CLI
WORKDIR /opt/svr/src
RUN git clone --depth 1 --branch ${CLI_REF} ${CLI_REPO} .

WORKDIR /opt/svr/src/cli

# Install deps (skip playwright browser download in Docker), build, and install globally
ENV DOCKER_BUILD=1
RUN npm ci || npm install
RUN npm run build
RUN npm install -g .

# Set a clean working directory for mounting user project files without masking installed deps
WORKDIR /work

# Default entrypoint uses globally installed CLI (with its own node_modules inside the image)
ENTRYPOINT ["storybook-visual-regression"]