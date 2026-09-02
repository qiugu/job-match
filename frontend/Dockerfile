# syntax=docker.io/docker/dockerfile:1

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# corepack 缓存放卷上：pnpm 二进制（packageManager 锁定 8.14.3）只下载一次
ENV COREPACK_HOME="/root/.cache/corepack"
RUN npm install -g corepack@latest && corepack enable
# 代码中无任何 puppeteer import（仅历史遗留声明），跳过其 postinstall
# 下载 Chromium（~170MB）——只影响构建期安装，不影响运行时
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=cache,id=corepack,target=/root/.cache/corepack \
    pnpm install --frozen-lockfile

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=cache,id=corepack,target=/root/.cache/corepack \
    pnpm install --prod --frozen-lockfile

FROM deps AS builder
# 构建期注入后端 API 地址（import.meta.env 为编译期常量，运行时 env 无效）
# 默认值指向容器网络内的 backend 服务
ARG VITE_JOBMATCH_API=http://backend:8000
ENV VITE_JOBMATCH_API=$VITE_JOBMATCH_API
COPY . .
RUN pnpm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nodeapp

# 运行时只带生产依赖（prod-deps 阶段与 builder 并行构建），无需 pnpm prune
COPY --from=prod-deps --chown=nodeapp:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodeapp:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodeapp:nodejs /app/dist ./dist
COPY --from=builder --chown=nodeapp:nodejs /app/server.mjs ./server.mjs

USER nodeapp

EXPOSE 3005
ENV PORT=3005
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.mjs"]
