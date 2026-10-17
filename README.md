<p align="center">
  <img src="./frontend/public/logo.svg" alt="知衣 ZhiYi" width="120" height="120">
</p>

<h1 align="center">知衣 (ZhiYi)</h1>

<p align="center">
  智能衣橱管理与 AI 穿搭助手 • 把衣橱装进口袋，随时随地优雅穿搭
</p>

<p align="center">
  <a href="https://github.com/ives7153/ZhiYi"><img src="https://img.shields.io/badge/GitHub-ives7153%2FZhiYi-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-14-000000?style=for-the-badge&logo=nextdotjs&logoColor=white" alt="Next.js"></a>
  <a href="https://fastapi.tiangolo.com/"><img src="https://img.shields.io/badge/FastAPI-0.100+-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI"></a>
  <a href="https://expo.dev/"><img src="https://img.shields.io/badge/Expo-SDK%2052-000020?style=for-the-badge&logo=expo&logoColor=white" alt="Expo"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.python.org/"><img src="https://img.shields.io/badge/Python-3.11+-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python"></a>
</p>

<p align="center">
  <a href="#核心功能">核心功能</a> •
  <a href="#系统架构与技术栈">技术架构</a> •
  <a href="#目录结构">目录结构</a> •
  <a href="#快速上手">快速上手</a> •
  <a href="#ai-与服务配置">AI 与服务配置</a> •
  <a href="#验收与演进">验收与演进</a> •
  <a href="#致谢与许可">致谢与许可</a>
</p>

---

## 项目简介

**知衣 (ZhiYi)** 是一款面向个人与家庭的开源全功能智能衣橱管理与 AI 穿搭系统。支持多端协同（React Native 移动端 + Next.js Web 管理端），融合多模态 AI 智能图像标注、实时天气感知搭配、大图滑动穿搭推荐、待购单品灵感管理以及严格的多用户安全数据隔离。

- **维护者**：[ives7153](https://github.com/ives7153)
- **代码仓库**：[https://github.com/ives7153/ZhiYi](https://github.com/ives7153/ZhiYi)

### 最新 Android 安装包

- **版本**：`1.0.7`（`versionCode 8`），修复深色模式下按钮白底白字及加载图标不可见的问题。
- **[下载 APK](https://github.com/ives7153/ZhiYi/raw/refs/heads/main/releases/android/zhiyi-1.0.7-release.apk)** · [SHA-256 校验文件](releases/android/zhiyi-1.0.7-release.apk.sha256) · [构建与测试报告](docs/Android-1.0.7-发布验证.md)
- 本包连接 `https://status.2119999.xyz`，已完成公网接口、Android 模拟器邮箱密码登录、覆盖升级、深浅主题及冷启动验证。
- 沿用历史 Android Debug 证书签名，可覆盖安装 `1.0.6`；此证书不适用于应用商店正式生产发布。

---

## 核心功能

### 1. 智能衣橱与单品录入
- **拍照与相册快速录入**：移动端直连相机与相册，快速记录每件单品。
- **结构化属性体系**：支持品类、颜色、季节、款式、材质、品牌、购买价格等多维度属性分类管理。
- **私有安全图片保护**：图片访问支持 HMAC-SHA256 签名鉴权与用户数据隔离，保护用户隐私。

### 2. AI 图像分析与属性提取
- **多模态大模型兼容**：支持接入各类兼容 OpenAI 规范的 Vision 多模态模型，或本地部署的 Ollama（如 Gemma 3 / Qwen-VL 等）。
- **自动化标注**：自动识别衣物颜色、品类、花纹与适宜季节，大幅降低手动录入成本。

### 3. 实时天气与智能穿搭
- **天气与位置感知**：集成 Open-Meteo 实时气象数据，移动端结合定位自动推荐适宜温感穿搭。
- **大图滑动穿搭主界面**：沉浸式卡片滑动浏览成套穿搭方案，直观选定当日出门装扮。
- **场景化穿搭建议**：按通勤、日常休闲、运动等不同场景生成搭配推荐。

### 4. 待购清单与虚拟试穿
- **灵感收藏（To-Buy List）**：遇到心仪单品可先加入待购清单。
- **搭配预览**：支持将待购单品与已拥有衣物进行组合试穿预览。
- **一键转入**：购买后一键转为已拥有单品并移入衣橱。

### 5. 账号体系与严格用户隔离
- **正式账号系统**：支持本地邮箱 + 密码注册、邮箱验证码核验、登录、找回密码与修改密码。
- **安全密码加密**：采用符合 OWASP 规范的 **Argon2id** 慢哈希存储用户密码。
- **会话撤销与代次管理**：服务端 `token_version` 与客户端会话代次（Session Epoch），修改密码或注销后历史令牌立即失效并中止在途请求。
- **多用户严格隔离**：后端接口、异步 AI 队列、图片资源及客户端缓存全面实行多租户隔离。

---

## 系统架构与技术栈

```
┌─────────────────────────────────┐      ┌──────────────────────────────────┐
│          移动端 App              │      │           Web 管理端             │
│   (React Native + Expo SDK 52)  │      │     (Next.js 14 + Tailwind)      │
└────────────────┬────────────────┘      └─────────────────┬────────────────┘
                 │                                         │
                 └──────────────────┬──────────────────────┘
                                    │ HTTP / REST
                         ┌──────────▼──────────┐
                         │      后端 API 服务   │
                         │ (FastAPI + Pydantic)│
                         └──────────┬──────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
    ┌──────▼──────┐          ┌──────▼──────┐          ┌──────▼──────┐
    │  PostgreSQL │          │    Redis    │          │  AI Service │
    │ (持久化数据) │          │(缓存/异步队列)│          │(OpenAI/Ollama)│
    └─────────────┘          └──────┬──────┘          └─────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │   异步任务 Worker   │
                         │    (arq / AI 处理)  │
                         └─────────────────────┘
```

| 层级 | 技术选型 | 说明 |
| :--- | :--- | :--- |
| **移动端 (Mobile)** | React Native, Expo SDK 52, Expo Router, React Query | 支持 iOS / Android，当前版本 v1.0.7 |
| **前端 (Frontend)** | Next.js 14, React 18, TypeScript, Tailwind CSS, shadcn/ui | 桌面端与平板响应式管理界面 |
| **后端 (Backend)** | Python 3.11+, FastAPI, SQLAlchemy (Async), Alembic | 高性能异步 REST API |
| **数据库与缓存** | PostgreSQL 15, Redis 7 | 结构化存储与高速缓存 |
| **异步任务** | arq (Async Redis Queue) | 图像分析与后台任务处理 |
| **安全与认证** | Argon2id, JWT, HMAC-SHA256, Expo SecureStore | 密码哈希、令牌管理与私有媒体防盗链 |

---

## 目录结构

```text
.
├── backend/          # FastAPI 后端源码、数据迁移与服务端脚本
│   ├── app/          # 核心路由、数据模型、业务服务与安全工具
│   ├── migrations/   # Alembic 数据库版本演进脚本
│   └── tests/        # 后端自动化接口测试套件
├── frontend/         # Next.js 14 Web 前端应用
│   ├── src/          # 页面、组件、状态管理与 i18n 国际化配置
│   └── public/       # 静态资源与矢量图标
├── mobile/           # React Native / Expo 移动端 App
│   ├── app/          # Expo Router 文件路由系统（含登录、大图穿搭、衣橱、个人中心）
│   ├── src/          # 认证上下文、API 客户端、状态机与主题定义
│   └── app.json      # 应用清单配置（包名：com.zhiyi.wardrobe）
├── docs/             # 项目开发规范、轮次验收报告（Round 1 ~ 6）与设计文档
├── k8s/              # Kubernetes 生产部署清单
├── docker-compose.yml     # 基础运行编排
├── docker-compose.dev.yml # 本地开发热重载与源码构建编排
└── LICENSE           # 开源授权许可
```

---

## 快速上手

### 环境要求

- [Docker](https://www.docker.com/) & Docker Compose
- [Node.js](https://nodejs.org/) (>= 18)
- Python (>= 3.11，可选，本地非容器开发需要)

### 1. 启动后端及基础设施（本地构建）

克隆代码并进入工程目录：

```bash
git clone git@github.com:ives7153/ZhiYi.git
cd ZhiYi
```

复制环境配置模板：

```bash
cp .env.example .env
```

使用本地开发编排启动容器（从本地源码构建，包含后端 API、PostgreSQL 与 Redis，支持热重载）：

```bash
# 启动本地容器化开发环境
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# 执行数据库迁移（必选）
docker compose exec backend alembic upgrade head

# 检查服务健康状态
curl http://localhost:8000/api/v1/health
```

- **后端 API 文档 (Swagger)**：[http://localhost:8000/docs](http://localhost:8000/docs)
- **Web 前端管理端**：[http://localhost:3000](http://localhost:3000)

### 2. 运行移动端 (Mobile)

进入移动端目录并安装依赖：

```bash
cd mobile
cp .env.example .env
npm install
```

配置 `mobile/.env` 中的 `EXPO_PUBLIC_API_URL`：
- **Android 模拟器**：`http://10.0.2.2:8000`
- **局域网真机调试**：`http://<电脑局域网IP>:8000`
- **电脑本地 Web 预览**：`http://127.0.0.1:8000`

启动 Expo 开发服务器：

```bash
# 启动 Expo 开发服务
npx expo start

# 或直接在 Android 模拟器运行
npm run android

# 或在浏览器中预览
npm run web
```

---

## AI 与服务配置

知衣支持多种 AI 后端提供商，可在 `.env` 中按需配置：

### 选项 A：使用本地 Ollama（免费、私密、离线）

1. 安装并启动 [Ollama](https://ollama.ai/)：
   ```bash
   ollama pull gemma3:latest
   ```
2. 在 `.env` 中配置：
   ```env
   AI_BASE_URL=http://host.docker.internal:11434/v1
   AI_API_KEY=not-needed
   AI_VISION_MODEL=gemma3:latest
   AI_TEXT_MODEL=gemma3:latest
   ```

### 选项 B：使用商用大模型 API

在 `.env` 中配置相应的 API 密钥与模型名称：
```env
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-your-api-key-here
AI_VISION_MODEL=gpt-4o
AI_TEXT_MODEL=gpt-4o
```

> **注意**：若未配置外部 AI 提供商，系统基础衣橱增删改查仍可完整使用，AI 自动标注和推荐接口将根据服务可用性返回相应提示。

---

## 验收与演进

知衣项目经过系统化迭代研发，各开发阶段均附带详尽的实测验收报告，详见 `docs/` 目录：
- `docs/第二轮-收尾验收.md`：移动端基础闭环与枚举泄漏修复
- `docs/第三轮-验收报告.md`：槽位穿搭体系与成套搭配
- `docs/第四轮-验收报告.md`：待购清单与试穿转入衣橱链路
- `docs/第五轮-验收报告.md`：真实 AI 任务链路、Android 定位天气与全新大图滑动穿搭
- `docs/第六轮-验收报告.md`：正式邮箱密码账号系统（Argon2id）与全链路用户数据隔离

---

## 致谢与许可

- 本项目基于开源项目 [Anyesh/wardrowbe](https://github.com/Anyesh/wardrowbe) 衍生重构与定制开发。
- 本项目遵循 [MIT License](LICENSE) 协议开源。
