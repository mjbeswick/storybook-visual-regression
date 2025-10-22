# Start from Microsoft Playwright image (includes Chromium + deps)
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

# Install Node.js v22 (for projects requiring Node ^22)
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && node -v \
  && npm -v

# Copy project files and install locally
COPY package.json /usr/local/lib/node_modules/storybook-visual-regression/
COPY dist /usr/local/lib/node_modules/storybook-visual-regression/dist
COPY README.md /usr/local/lib/node_modules/storybook-visual-regression/
COPY LICENSE /usr/local/lib/node_modules/storybook-visual-regression/

# Install dependencies and create global symlink
RUN cd /usr/local/lib/node_modules/storybook-visual-regression && npm install --production --ignore-scripts \
  && ln -sf /usr/local/lib/node_modules/storybook-visual-regression/dist/cli/index.js /usr/local/bin/storybook-visual-regression \
  && chmod +x /usr/local/lib/node_modules/storybook-visual-regression/dist/cli/index.js

# Install Playwright browsers to ensure they're available
RUN npx playwright install chromium

# Working directory
WORKDIR /app

# Use non-root user available in base image
USER pwuser

# Default entrypoint to run the CLI
ENTRYPOINT ["dumb-init", "--", "node", "/usr/local/lib/node_modules/storybook-visual-regression/dist/cli/index.js"]
CMD ["--help"]
