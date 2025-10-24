FROM mcr.microsoft.com/playwright:v1.56.1-jammy

# Install the CLI package globally
RUN npm install -g @storybook-visual-regression/cli@latest

# Set entrypoint
ENTRYPOINT ["storybook-visual-regression"]