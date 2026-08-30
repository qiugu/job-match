# syntax=docker.io/docker/dockerfile:1

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# 构建期注入后端 API 地址（import.meta.env 为编译期常量，运行时 env 无效）
# 默认值指向容器网络内的 backend 服务
ARG VITE_JOBMATCH_API=http://backend:8000
ENV VITE_JOBMATCH_API=$VITE_JOBMATCH_API

FROM deps AS builder
COPY . .
RUN pnpm run build && pnpm prune --prod

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodeapp

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.mjs ./server.mjs

USER nodeapp

EXPOSE 3005
ENV PORT=3005
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.mjs"]
