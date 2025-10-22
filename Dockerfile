FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /usr/local/lib/node_modules/storybook-visual-regression

# Copy package files
COPY package.json package-lock.json ./

# Copy built distribution
COPY dist ./dist
COPY README.md ./
COPY LICENSE ./

# Install production dependencies and create symlink
RUN npm install --production --ignore-scripts && \
    ln -sf /usr/local/lib/node_modules/storybook-visual-regression/dist/cli/index.js /usr/local/bin/storybook-visual-regression && \
    chmod +x /usr/local/lib/node_modules/storybook-visual-regression/dist/cli/index.js

# Install Playwright browsers and set environment variables
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
RUN npx playwright install chromium

# Set entrypoint
ENTRYPOINT ["node", "/usr/local/lib/node_modules/storybook-visual-regression/dist/cli/index.js"]
