FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile --prod

COPY dist/ ./dist/
COPY .claude/ ./.claude/

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/entrypoint.js"]
