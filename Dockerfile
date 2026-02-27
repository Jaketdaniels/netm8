FROM docker.io/cloudflare/sandbox:0.7.6

# Pre-install common dev tooling
RUN npm install -g typescript esbuild

# Set default workspace
WORKDIR /workspace

# Required for local development (preview URLs)
EXPOSE 8080
