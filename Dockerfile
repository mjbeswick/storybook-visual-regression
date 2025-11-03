FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /opt/svr/src/cli
COPY cli/ ./
ENV DOCKER_BUILD=1
RUN npm ci || npm install
RUN npm run build
RUN npm install -g .

# After global install, ensure the correct odiff binary is present for arm64
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
      ODIFF_VERSION="4.1.1" && \
      echo "Downloading odiff arm64 binary for $ARCH..." && \
      curl -Lf -o /tmp/odiff-linux-arm64 "https://github.com/dmtrKovalenko/odiff/releases/download/v${ODIFF_VERSION}/odiff-linux-arm64" && \
      chmod +x /tmp/odiff-linux-arm64 && \
      echo "Locating odiff-bin package..." && \
      GLOBAL_NODE_ROOT=$(npm root -g) && \
      echo "Global node_modules: $GLOBAL_NODE_ROOT" && \
      ODIFF_BIN_PATH=$(find "$GLOBAL_NODE_ROOT" -path "*/odiff-bin/bin/odiff" -type f 2>/dev/null | head -1) && \
      if [ -z "$ODIFF_BIN_PATH" ]; then \
        ODIFF_BIN_PATH=$(find "$GLOBAL_NODE_ROOT" -path "*/odiff-bin/*odiff*" -type f ! -name "*.js" ! -name "*.map" ! -name "*.d.ts" 2>/dev/null | head -1); \
      fi && \
      if [ -n "$ODIFF_BIN_PATH" ]; then \
        echo "Found odiff binary at: $ODIFF_BIN_PATH" && \
        mv "$ODIFF_BIN_PATH" "${ODIFF_BIN_PATH}.backup" 2>/dev/null || true && \
        cp /tmp/odiff-linux-arm64 "$ODIFF_BIN_PATH" && \
        chmod +x "$ODIFF_BIN_PATH" && \
        echo "Verifying binary..." && \
        "$ODIFF_BIN_PATH" --version && \
        echo "odiff binary successfully installed and verified"; \
      else \
        echo "WARNING: Could not find odiff-bin binary location" && \
        echo "Searched in: $GLOBAL_NODE_ROOT" && \
        find "$GLOBAL_NODE_ROOT/odiff-bin" -type f 2>/dev/null | head -10; \
      fi && \
      rm -f /tmp/odiff-linux-arm64; \
    else \
      echo "Skipping odiff binary replacement (not arm64, detected: $ARCH)"; \
    fi

WORKDIR /work
# Forward all CLI args directly to the CLI
ENTRYPOINT ["/bin/sh","-lc","exec storybook-visual-regression \"$@\"","--"]