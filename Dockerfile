# syntax=docker/dockerfile:1.7
#
# 多阶段生产镜像：
# - builder 装全量依赖并构建前端；
# - runtime 只装生产依赖（tsx + workspace），非 root 运行；
# - /data 是项目/数据库/worktree 的持久化目录。
#
# 注意：运行时仍用 tsx 直接加载 TypeScript 源码；当前仓库没有单独的 JS 产物。

FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build:web

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/spec-agent \
    SPEC_AGENT_HOST=0.0.0.0 \
    SPEC_AGENT_PORT=4317 \
    SPEC_AGENT_PROJECTS_HOME=/data/projects
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
 && groupadd --gid 10001 spec-agent \
 && useradd --uid 10001 --gid spec-agent --create-home --home-dir /home/spec-agent spec-agent \
 && mkdir -p /data && chown -R spec-agent:spec-agent /app /data

COPY --from=build --chown=spec-agent:spec-agent /app/apps/web/dist ./apps/web/dist

USER spec-agent
EXPOSE 4317
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM
CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/server/src/index.ts", "--host", "0.0.0.0", "--port", "4317", "--web", "apps/web/dist", "--root", "/data/default"]
