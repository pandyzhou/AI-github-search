# AI GitHub Search 🚀

`AI GitHub Search` 是一个高效、现代化的 GitHub 仓库搜索与项目对比工作台。它整合了 GitHub 仓库多维检索、趋势榜单、项目对比、README 浏览、文件树导航、收藏夹管理、搜索历史和用户/管理后台，适合作为个人开源知识库或团队内部的开源项目发现入口。

## 🌟 功能特性

- **多维仓库搜索**：支持关键词、编程语言、Stars/Forks 数量、更新时间、License、Topics 等条件进行灵活检索。
- **趋势榜单 (Trending)**：实时查看 GitHub 日榜、周榜、月榜，支持语言筛选与热度排序。
- **仓库项目对比**：可同时将多个项目添加至对比看板，进行关键指标（Stars、Forks、更新时间、文件结构等）直观对比。
- **项目文件浏览器**：提供在线文件树导航，可以直接在线浏览项目目录结构和查看文件内容。
- **健康度评分与风险提示**：从社区活跃度、维护质量、文档完整度和安全合规等多维度展示仓库健康分及风险提示。
- **个人工作台 (Dashboard)**：
  - 自动记录并保存搜索历史，随时回溯与复用搜索条件。
  - 创建并管理多分类收藏夹，归档感兴趣的开源项目。
  - 个人设置保留遗留 Token 的安全删除入口，不再把个人密钥用于查询。
- **GitHub 共享账号池**：管理员可通过 OAuth 或手动方式加入多个 GitHub 账号，分别查看 Core/Search 额度；额度耗尽或 Token 失效时自动切换，并可配置全站上游并发数和并行搜索页数。
- **全站访问防护**：验证真实 NextAuth 会话后才允许访问搜索与后台，保护共享额度、搜索历史与系统资源。
- **SQLite / PostgreSQL 双模式**：默认支持 SQLite 免外部数据库极速部署，也支持 PostgreSQL + Meilisearch 高性能生产部署。

## 🛠️ 技术栈

- **框架**：Next.js 16 (App Router) + React 19 + TypeScript
- **样式与 UI**：Tailwind CSS 4 + UnoCSS + shadcn/ui
- **数据库**：SQLite（原生支持，通过 `DATABASE_PROVIDER=sqlite`）/ PostgreSQL + Drizzle ORM
- **认证**：NextAuth.js (Credentials 认证 + Middleware 拦截)
- **部署**：Docker / Docker Compose / Node.js 独立运行

## 🚀 快速开始

### 环境要求

- Node.js 20+
- SQLite（免配置）或 PostgreSQL 16+

### 本地轻量运行 (SQLite 模式)

1. 克隆代码库：

```bash
git clone https://github.com/pandyzhou/AI-github-search.git
cd AI-github-search
```

2. 安装依赖：

```bash
npm install
```

3. 配置环境变量：

创建 `.env.local` 文件：

```env
DATABASE_PROVIDER=sqlite
SQLITE_DATABASE_PATH=./data/ai-github-search.sqlite
AUTH_SECRET=your_custom_random_auth_secret
NEXTAUTH_URL=http://localhost:3000
PORT=3000

# 可选：管理员邮箱（注册/创建时自动赋予 ADMIN 权限）
ADMIN_EMAILS=admin@example.com

# 可选：管理员通过 OAuth 向共享账号池新增 GitHub 账号
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# 可选：共享池为空时的兼容兜底 Token
GITHUB_TOKEN=

# 可选：数据库尚无池配置行时的默认值
GITHUB_POOL_MAX_CONCURRENCY=4
GITHUB_POOL_PARALLEL_SEARCH_PAGES=1
```

4. 构建并启动服务：

```bash
# 方式一：开发调试
npm run dev

# 方式二：生产构建与运行
npm run build
npm run start
```

访问 [http://localhost:3000](http://localhost:3000) 即可开始使用。管理员可在 `/admin/github-pool` 管理共享 GitHub 账号和并发配置。

## 🐳 Docker 部署

使用 Docker Compose 可以一键启动：

```bash
docker compose up -d --build
```

查看日志与运行状态：

```bash
docker compose ps
docker compose logs -f
```

## 📜 许可证

[MIT License](LICENSE)
