# syntax=docker.io/docker/dockerfile:1

# 同后端 Dockerfile：pin digest 防止上游 tag 漂移打断整条层缓存链。
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS base
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
# 国内服务器构建：npm 包走国内镜像，避免层缓存失效时全量下载超时。
# frontend/pnpm-lock.yaml 不含硬编码 registry URL，可安全切换；
# 这条 ENV 会被 deps / prod-deps / builder / runner 各阶段继承。
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV npm_config_registry=${NPM_REGISTRY}

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
# 站点基址（canonical / hreflang / OG / sitemap 的唯一来源，必须带 https）
ARG VITE_SITE_URL=https://jdmatch.site
ENV VITE_SITE_URL=$VITE_SITE_URL
COPY . .
# node:22-alpine（musl）下 Node 探测不到真实内存，默认堆仅约 1GB；
# echarts 等大依赖会把 vite client+SSR 双份打包的模块图推过该上限，
# 显式抬高到 4GB（GHA ubuntu-latest 内存充足）。
ENV NODE_OPTIONS="--max-old-space-size=4096"
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
