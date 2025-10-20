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

# Install storybook-visual-regression globally
RUN npm install -g storybook-visual-regression@latest

# Install Playwright browsers to ensure they're available
RUN npx playwright install chromium

# Working directory
WORKDIR /app

# Use non-root user available in base image
USER pwuser

# Default entrypoint to run the CLI
ENTRYPOINT ["dumb-init", "--", "npx", "storybook-visual-regression"]
CMD ["--help"]
