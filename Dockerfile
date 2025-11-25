FROM mcr.microsoft.com/playwright:v1.56.1-jammy

# This image will not bake the CLI into the image. Instead it invokes the published
# CLI at runtime via `npx`. That means you can publish new CLI versions and the
# container will fetch the latest when started (no image rebuild required).

WORKDIR /work

# For arm64, download a prebuilt odiff binary directly to `/usr/local/bin/odiff` so
# the runtime CLI (installed by npx) can find and execute it regardless of how
#/where node_modules are laid out.
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
      ODIFF_VERSION="4.1.1" && \
      echo "Downloading odiff arm64 binary for $ARCH..." && \
      curl -Lf -o /usr/local/bin/odiff "https://github.com/dmtrKovalenko/odiff/releases/download/v${ODIFF_VERSION}/odiff-linux-arm64" && \
      chmod +x /usr/local/bin/odiff && \
      echo "odiff installed to /usr/local/bin/odiff" && \
      /usr/local/bin/odiff --version || true; \
    else \
      echo "Skipping odiff binary installation (not arm64, detected: $ARCH)"; \
    fi

# Forward all CLI args directly to `npx` so the container will install/run the
# published CLI package at runtime. Use `--yes` to auto-accept prompts from npx.
ENTRYPOINT ["/bin/sh","-lc","exec npx --yes @storybook-visual-regression/cli \"$@\"","--"]