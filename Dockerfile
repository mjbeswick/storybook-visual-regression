# Use Microsoft's Playwright Docker image with Node.js 22
FROM mcr.microsoft.com/playwright:v1.56.1-noble

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

# Set entrypoint
ENTRYPOINT ["node", "/usr/local/lib/node_modules/storybook-visual-regression/dist/cli/index.js"]
