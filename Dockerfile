FROM --platform=linux/amd64 mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /opt/svr/src/cli
COPY cli/ ./
ENV DOCKER_BUILD=1
RUN npm ci || npm install
RUN npm run build
RUN npm install -g .

WORKDIR /work
ENTRYPOINT ["storybook-visual-regression"]