# 知衣 App 开发规划

> 状态：第一轮（骨架 + 认证 + 衣橱读取）
> 基线仓库：`Anyesh/wardrowbe` 快照，分支 `main`
> 本文档是第一轮的**规格与验收依据**，实现必须与本文档一致。

---

## 1. 产品定位与轮次范围

知衣从微信小程序改为**独立移动 App**，客户端采用 React Native + Expo + TypeScript，默认放在仓库 `mobile/`。
后端保持现有 FastAPI + PostgreSQL + Redis/arq 不变，**不做全仓重组，不另建后端**。

| 轮次 | 内容 | 状态 |
| --- | --- | --- |
| 第 1 轮 | mobile 工程、环境配置、统一请求封装、认证（dev + OIDC PKCE）、衣橱列表与详情读取、四入口导航 | **已完成** |
| 第 2 轮 | 衣物上传与完整增删改 | **已完成**（见 `docs/第二轮-收尾验收.md`） |
| 第 3 轮 | 插槽式搭配 | **已完成**（2026-09-27，见 `docs/第三轮-验收报告.md`） |
| 第 4 轮 | 待购数据与用户隔离 | 未开始 |

明确不做：校园连续场景、完整离线双向同步、全仓重组。

### 数据策略

**服务端为主数据源，客户端只做查询缓存**。本轮不实现离线写入队列、不做双向同步、不引入本地 DB。
重启后可恢复登录（凭证在安全存储中），但**离线不等于可写入**。

---

## 2. 保留现有能力（不得改写）

- `backend/`、`frontend/`、`docker-compose*.yml`、`k8s/` 保持原样。
- arq worker（`app.workers.worker`、`app.workers.image_worker`）与 Redis 队列**不删不改**。
- 迁移链 `backend/migrations/versions/` **不改写**；数据库通过 `alembic upgrade head` 正向建立。
- 前端 Web 登录流程**不能被破坏**：移动端复用同一套后端认证，只新增配置项，不改变既有 `/auth/sync` 语义。

---

## 3. 服务端地址矩阵（关键）

服务端**内部主机名不能直接作为手机访问地址**。`docker-compose` 里的 `backend:8000`、`postgres:5432` 只在容器网络内有效。

| 运行场景 | `EXPO_PUBLIC_API_URL` | 说明 |
| --- | --- | --- |
| 电脑本机浏览器 / Web | `http://127.0.0.1:8000` | 仅电脑自己可用 |
| **Android 模拟器** | `http://10.0.2.2:8000` | `10.0.2.2` 是 AVD 中宿主机的固定别名；`127.0.0.1` 在模拟器里指向模拟器自身 |
| iOS 模拟器 | `http://127.0.0.1:8000` | iOS 模拟器与宿主机共享网络栈 |
| Genymotion | `http://10.0.3.2:8000` | 另一种模拟器别名 |
| **真机（同一局域网）** | `http://<电脑局域网 IP>:8000` | 例如 `http://192.168.1.20:8000`，用 `ipconfig getifaddr en0` 查 |
| 通过 adb 反向代理的真机 | `http://127.0.0.1:8000` | 先执行 `adb reverse tcp:8000 tcp:8000` |

约束：
- 后端必须监听 `0.0.0.0`（不是 `127.0.0.1`）真机才能连上。
- Android 9+ 默认禁止明文 HTTP。开发期需要在 `app.json` 中开启 `android.usesCleartextTraffic`。
- 生产地址与密钥**绝不硬编码**；只通过 `EXPO_PUBLIC_*` 环境变量注入。

---

## 4. 认证契约（必须与 `backend/app/api/auth.py` 真实实现一致）

### 4.1 服务端事实

- `GET /api/v1/auth/config` → `{ oidc: { enabled, issuer_url, client_id }, dev_mode }`
  - `dev_mode = settings.debug and 未配置 OIDC`
  - `oidc.client_id` = `OIDC_MOBILE_CLIENT_ID or OIDC_CLIENT_ID`，移动端就使用这个值
  - **当同时配置 OIDC 与 DEBUG 时，OIDC 优先**，`dev_mode` 为 `false`
- `GET /api/v1/auth/status` → `{ configured, mode, error? }`，`mode ∈ {oidc, dev, unknown}`
- `POST /api/v1/auth/sync` → 唯一换取 token 的入口
  - 开发模式：body `{ external_id, email, display_name? }`，**不需要** `id_token`
  - OIDC 模式：必须带 `id_token`，且 `claims.sub == external_id`
  - 返回 `{ id, email, display_name, is_new_user, onboarding_completed, access_token }`
- `GET /api/v1/auth/session` → `UserResponse`（需 Bearer）
- **没有 refresh 接口**。token 有效期 7 天（`create_access_token` 默认 `timedelta(days=7)`），签发/校验算法 HS256，secret 为 `SECRET_KEY`。
- 401 响应体固定为 `{"detail": "Not authenticated" | "Invalid or expired token"}`。
- 移动端服务端回调已存在：`GET /api/v1/auth/mobile-callback` 会把所有 query 参数转发到 `wardrowbe://auth/callback?...`。

### 4.2 客户端要求

1. 启动时先读安全存储中的凭证，再调 `/auth/session` 验证：
   - 200 → 恢复登录
   - 401 / 403 → 判定凭证失效，清除 -> 回到登录页
2. `access_token` 存入 `expo-secure-store`（iOS Keychain / Android Keystore）。
   非敏感的 `external_id`、`email`、`display_name` 可存 `AsyncStorage`。
   **token 绝不写入 AsyncStorage、日志或错误上报。**
3. 401 处理：**不做静默刷新**（服务端没有 refresh 接口），统一触发登出 + 跳登录页 + 提示"登录已过期，请重新登录"。
4. 登出必须清除：token、用户信息、**上一个用户的全部查询缓存**（`queryClient.clear()`），避免下一个用户看到残留数据。
5. OIDC 登录（仅当 `oidc.enabled === true`）：
   - Authorization Code + PKCE，公共客户端，**不带 client_secret**
   - `redirectUri` 走 `AuthSession.makeRedirectUri({ scheme: 'wardrowbe', path: 'auth/callback' })`
   - 回调页解析 `id_token`，从中取 `sub` 作为 `external_id`，再调 `/auth/sync`
   - 若 `oidc.enabled === false`，不显示 OIDC 按钮，只显示开发登录
6. 开发登录：**仅当 `dev_mode === true`** 才渲染邮箱/名称表单，并显示"开发模式"黄色警示条。生产构建下该表单不可达。

---

## 5. API 与图片 URL 契约

### 5.1 端点（本轮使用）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/auth/config` | 决定登录方式 |
| GET | `/api/v1/auth/status` | 后端认证是否配置 |
| POST | `/api/v1/auth/sync` | 换 token |
| GET | `/api/v1/auth/session` | 校验凭证 |
| GET | `/api/v1/users/me` | 用户资料 |
| GET | `/api/v1/items?page&page_size&...` | 衣橱列表 |
| GET | `/api/v1/items/{id}` | 衣物详情 |
| GET | `/api/v1/images/{user_id}/{filename}?expires&sig` | 签名图片 |

### 5.2 列表响应

```
{ items: ItemResponse[], total, page, page_size, has_more }
```

- `page` 从 1 开始，`page_size` 服务端限制 `1..100`，默认 20。
- 客户端本轮固定 `page_size=20`，滚动到底加载下一页，`has_more === false` 时停止。

### 5.3 图片 URL（易错点）

服务端返回的 `image_url` / `thumbnail_url` / `medium_url` 是**相对路径**，形如：

```
/api/v1/images/<user_id>/<file>.jpg?expires=1750000000&sig=abcdef...
```

客户端**必须**拼成绝对地址：`API_BASE_URL + 相对路径`。

规则：
- 相对路径以 `/` 开头 → 直接拼到 API 基址（基址不含 `/api/v1` 后缀，需保留路径本身）。
- 已是 `http://` / `https://` 开头 → 原样使用（兼容外部存储）。
- `thumbnail_url` 为空时回退 `medium_url`，再回退 `image_url`，再无则用纯色占位块 + 类型文字（与 Web `ItemCard` 行为一致）。
- **签名 URL 1 小时过期**（`DEFAULT_EXPIRY_SECONDS = 3600`）。缓存条目的 `staleTime` 必须小于 1 小时；图片加载失败时允许重取列表以获得新签名。

---

## 6. UI 规格（**必须与 Web 端一致**）

参照 `frontend/app/globals.css` 的设计令牌、`frontend/components/mobile-nav.tsx` 的导航结构、`screenshots/wardrobe-grid.png`、`screenshots/settings.png`、`screenshots/dashboard.png`。

### 6.1 设计令牌（HSL → 十六进制，供 RN 使用）

浅色：

| Token | HSL（Web 原值） | Hex |
| --- | --- | --- |
| background | 0 0% 100% | `#FFFFFF` |
| foreground | 224 71.4% 4.1% | `#030712` |
| card | 0 0% 100% | `#FFFFFF` |
| primary | 220.9 39.3% 11% | `#111827` |
| primary-foreground | 210 20% 98% | `#FAFAFA` |
| secondary / muted / accent | 220 14.3% 95.9% | `#F3F4F6` |
| secondary-foreground | 220.9 39.3% 11% | `#111827` |
| muted-foreground | 220 8.9% 46.1% | `#6B7280` |
| destructive | 0 84.2% 60.2% | `#EF4444` |
| destructive-foreground | 210 20% 98% | `#FAFAFA` |
| border / input | 220 13% 91% | `#E5E7EB` |
| ring | 224 71.4% 4.1% | `#030712` |
| radius | 0.5rem | `8` |

深色：

| Token | HSL | Hex |
| --- | --- | --- |
| background / card | 0 0% 3.9% | `#0A0A0A` |
| foreground | 0 0% 98% | `#FAFAFA` |
| primary | 0 0% 98% | `#FAFAFA` |
| primary-foreground | 0 0% 9% | `#171717` |
| secondary / muted / accent / border / input | 0 0% 14.9% | `#262626` |
| muted-foreground | 0 0% 63.9% | `#A3A3A3` |
| destructive | 0 62.8% 30.6% | `#7F1D1D` |

语义补充色（沿用 Web Tailwind 类名）：`amber-500 #F59E0B`（需清洗徽标）、`red-500 #EF4444`（收藏心形）。

排版与字号（对齐 Tailwind）：
- 页面主标题 `text-2xl font-bold tracking-tight` → 24 / 700
- 副标题/描述 `text-sm text-muted-foreground` → 14 / 400
- 卡片标题 `text-sm font-medium` → 14 / 500
- 导航标签 `text-xs` → 12

字体：**不打包自定义字体**。Web 使用 Inter + 系统回退，且因 CJK 字形刻意不打包 Inter；RN 沿用系统默认字体（Android = Roboto + Noto CJK，iOS = SF Pro + PingFang），这是与 Web 一致的做法。

圆角 `8`，卡片 1px 边框 `border`，阴影 `hover:shadow-md` → RN `elevation: 3`（Android）。
图标尺寸：导航 20，卡片内小图标 16，使用 `lucide-react-native`（与 Web `lucide-react` 同一图标集）。

### 6.2 底部导航（四入口）

对齐 Web `MobileNav`：`fixed bottom-0`、上下 1px 边框、5 项改 4 项、选中色 `primary`、未选中 `muted-foreground`、图标在上文字在下。

| 顺序 | 标题 | 图标（lucide） | 路由 |
| --- | --- | --- | --- |
| 1 | 衣橱 | `Shirt` | `/wardrobe` |
| 2 | 搭配 | `LayoutGrid` | `/outfits` |
| 3 | 待购 | `ShoppingBag` | `/to-buy` |
| 4 | 我的 | `Settings` | `/profile` |

第 1 轮 `搭配` 与 `待购` 为**清楚的占位页**：页面标题 + "该功能将在后续版本提供" 说明 + 一句话说明计划内容。**不得伪造已实现的功能**（不放假数据列表、不假装可交互）。

### 6.3 登录页（对照 `frontend/app/login/page.tsx` + `screenshots/dashboard.png`）

- 居中布局，最大宽度约 400
- 顶部 64×64 的 Logo：**照搬 `frontend/public/logo.svg` 的视觉**（深色圆角方块 `#2a2a2a→#1a1a1a` 渐变、白色盲文点阵 W）。用 `react-native-svg` 内联绘制同一图形，不引入位图。
- `text-3xl font-bold` 标题「登录」，下方 `subtitle`「登录以管理你的衣橱」
- 后端不可达时显示 `destructive` 边框错误块：标题「后端配置错误」+「无法连接后端服务器。请检查后端是否正在运行。」
- 开发模式提示条：`amber-500/10` 底色 + `amber-500/20` 边框 + 黄褐色文字「开发模式 - 任意凭证均可登录」
- 输入框：`border-input` 边框、圆角、`px-3 py-2`、focus 时 ring
- 主按钮：`primary` 底色、`py-3`、圆角，加载时显示 `Loader2` 旋转图标 +「登录中...」
- 底部 `text-sm text-muted-foreground` 提示行
- 未配置任何认证方式时显示红色错误块，提示设置 `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` 或启用 DEBUG

### 6.4 衣橱页（对照 `screenshots/wardrobe-grid.png`）

结构自上而下：
1. 标题行：`衣橱`（24/700）+ 右侧「添加单品」按钮（**第 1 轮禁用**，点击提示"将在第二轮提供"，不隐藏但明确不可用）
2. 计数行：`衣柜中有 N 件单品`（14 / muted-foreground）
3. 搜索框 + 类型筛选（本轮实现**搜索关键字**，直接传给后端 `search` 参数；类型筛选下拉可不做，若做则用后端 `/items/types`）
4. 网格：**2 列**，间距 12，卡片 `aspect-square` 图片区 + 底部信息条
   - 图片：`object-cover` 铺满，`thumbnail_url` 优先级最高
   - 右上角：`favorite` 为真时显示实心红心（16）
   - 右下角：`needs_wash` 为真时显示琥珀色圆形水滴徽标
   - `status === 'processing'` 时图片上覆盖半透明黑层 + `Loader2` + 「AI 分析中...」
   - 底部条：上行 `item.name || item.type || 'unknown'`（14/500），下行 `subtype || type`（12 / muted-foreground）
   - 卡片可点击 → 进入详情
5. 分页：底部「加载更多」按钮 + `共 N 件`；`has_more === false` 时不显示

状态处理（每一条都要能真实触发）：

| 状态 | 表现 |
| --- | --- |
| 首次加载 | 骨架卡片 ×6（`#F3F4F6` 圆角块），不是转圈占位 |
| 加载更多 | 列表底部小号 `Loader2` + 「加载中...」 |
| 空衣橱（`total === 0` 且无筛选） | 居中：图标 + 「你的衣柜是空的」+「添加你的第一件衣物，开始获取个性化穿搭建议。」+ 禁用态「添加第一件单品」按钮 |
| 有筛选但无结果 | 居中：「没有找到符合筛选条件的单品。」+「清除筛选」按钮 |
| 网络失败 | 居中：`AlertCircle`（destructive 色）+「加载单品失败，请重试。」+「重试」按钮（`onPress` 触发 `refetch`） |
| 401 | 自动登出并跳登录页，页面显示「登录已过期，请重新登录」 |
| 下拉刷新 | `RefreshControl`，重新拉取第 1 页 |

自动轮询：列表中存在 `status === 'processing'` 时 5 秒，否则 30 秒（对齐 Web `useItems` 的 `refetchInterval`）。

### 6.5 详情页

- 大图（`medium_url || image_url`）
- `favorite` / `needs_wash` 徽标
- 字段列表：类型、子类型、名称、品牌、颜色、穿着次数、上次穿着、创建时间
- `status` 与 `tagging_status` 状态徽标；`ai_error` 存在时显示失败原因
- 加载/错误/404 三态齐全，「重试」可重试

### 6.6 我的页（对照 `screenshots/settings.png`）

- 账号卡片：标题「账号」+ 描述「您的个人资料信息」；只读展示「名称」「邮箱」（`users/me`）
- 应用信息：后端地址（便于排查）、版本号
- 退出登录按钮（`destructive` 描边），二次确认后清除凭证与缓存

---

## 7. 环境变量与工程结构

`mobile/.env.example`（不含任何密钥或生产地址）：

```
EXPO_PUBLIC_API_URL=http://10.0.2.2:8000
EXPO_PUBLIC_OIDC_REDIRECT_SCHEME=wardrowbe
```

`EXPO_PUBLIC_` 前缀是 Expo 注入客户端变量的机制；**只有非敏感值可以放这里**。缺失时给出清晰错误而不是崩溃。

期望结构：

```
mobile/
├── app/                      # expo-router 路由
│   ├── _layout.tsx           # 根：Providers + 认证门禁
│   ├── login.tsx
│   ├── auth/callback.tsx     # OIDC 回调（wardrowbe://auth/callback）
│   └── (tabs)/
│       ├── _layout.tsx       # 四入口底部导航
│       ├── index.tsx         # 衣橱
│       ├── outfits.tsx       # 搭配（占位）
│       ├── to-buy.tsx        # 待购（占位）
│       └── profile.tsx       # 我的
├── src/
│   ├── api/client.ts         # 统一请求封装
│   ├── api/auth.ts           # /auth/* 调用
│   ├── api/items.ts          # /items 调用
│   ├── auth/AuthContext.tsx  # 凭证状态机
│   ├── auth/storage.ts       # SecureStore + AsyncStorage
│   ├── config/env.ts         # 环境变量读取与校验
│   ├── theme/tokens.ts       # 设计令牌
│   ├── theme/ThemeContext.tsx# 浅色/深色（跟随系统）
│   ├── i18n/zh.ts            # 中文文案
│   ├── components/           # Button/Input/Card/Badge/Skeleton/ErrorState/EmptyState/ItemCard
│   └── components/Logo.tsx   # react-native-svg 复刻 logo.svg
├── app.json
├── package.json
├── package-lock.json         # 必须提交，锁定版本
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 8. 统一请求封装要求

- 单一 `request()`：拼接 `EXPO_PUBLIC_API_URL` + `/api/v1` + path，注入 `Authorization: Bearer`
- 超时（默认 15 秒）用 `AbortController`，超时给出可读文案
- 错误分三类，**文案必须可读**：
  - `NetworkError`：「无法连接服务器，请检查网络或后端地址」
  - `ApiError`（4xx/5xx）：读取后端 `detail` 字段
  - `AuthError`（401/403）：触发全局登出
- 区分「后端不可达」与「业务错误」——Web 端 `lib/api.ts` 就是这种分层，保持一致
- 请求失败**不吞异常**：交给 React Query 的 `error`，由页面渲染错误态

查询缓存（React Query v5）：
- `queryKey` 必须包含 `userId`，实现**用户隔离**：`['items', userId, filters, page]`
- `staleTime`：列表 60 秒（< 签名 URL 的 1 小时）
- 登出时 `queryClient.clear()`
- 开启 `retry: 2` 但**401 不重试**

---

## 9. 第一轮验收标准

| # | 验收项 | 验证方式 |
| --- | --- | --- |
| 1 | App 能启动并进入四个导航入口 | 启动日志 + 页面渲染；无 adb 时用 `expo export` 证明打包通过 |
| 2 | 能通过真实后端认证 | 真实 `/auth/sync` 拿到 token 并读取 `/users/me` |
| 3 | 能读取该用户真实衣物 | 真实 `/items` 返回该用户数据；空库时返回 `total=0` |
| 4 | 重启按凭证有效性恢复登录 | 持久化凭证 → 冷启动 → `/auth/session` 200 恢复；401 则清除 |
| 5 | 退出清除凭证与上一用户缓存 | 代码路径 + 登出后 `queryClient` 为空 |
| 6 | API 不可用时错误可理解且有重试 | 指到错误端口，确认错误页与「重试」可用 |
| 7 | 类型检查与构建检查通过 | `npx tsc --noEmit` + `npx expo export` |
| 8 | UI 与 Web 一致 | 对照本文件 §6 与 `screenshots/` |
| 9 | 无硬编码生产地址/密钥 | 全仓 grep `EXPO_PUBLIC_API_URL` 与密钥模式 |

无法在当前机器验证的项（无 Docker/adb/真机）必须标记为**待验证**，并给出复现步骤，**不得声称已通过**。

---

## 10. 已知环境约束（本机）

- 无 Docker、无 brew、无系统 PostgreSQL/Redis、无 adb、无 Xcode 模拟器。
- 因此服务端需要走「无 Docker 本地启动」路径（见 `scripts/dev-local.sh`），移动端只能验证到 **type-check + bundle 导出**，真机/模拟器运行属待验证。
- 后端开发登录生效条件：`DEBUG=true` 且未配置 OIDC。本轮不接入真实 OIDC 账号，OIDC 流程属**待验证**。

---

## 11. 第三轮补充规格：席位与搭配（2026-09-27）

本节记录本轮定下的、后续轮次必须沿用的口径，避免实现漂移。

### 11.1 五个席位与它们覆盖的类别

| 席位 | 类别（衣物 `type`） | 必需 |
| --- | --- | --- |
| 上衣 | `top` `t-shirt` `shirt` `blouse` `polo` `tank-top` `sweater` | 是 |
| 下装 | `pants` `jeans` `shorts` `skirt` | 是 |
| 外套 | `cardigan` `vest` `jacket` `blazer` `coat` `hoodie` | 否 |
| 鞋子 | `shoes` `sneakers` `boots` `sandals` | 是 |
| 配饰 | `socks` `tie` `hat` `scarf` `belt` `bag` `accessories` | 否 |

对应用衣物自身的 `type` 经 `ITEM_ROLE`（`backend/app/utils/clothing.py`）推导，
**不是**存在搭配里的字段。理由见 `docs/第三轮-验收报告.md` §2.3：`OutfitItem.layer_type`
在 API 里没有任何写入口，且 `PATCH` 会重建 `outfit_items`。

### 11.2 明确不支持的

* **连衣裙（`dress`）与连体衣（`jumpsuit`）**：一件替代多席，本轮不进任何席位；界面明确提示，
  读取已有搭配时它们显示在「其他单品」分组并原样保留，不会被丢弃。
* **待分类（`unknown` / `other` / `suit`）**：没有可靠类别，一律提示「待分类」，**不塞进上衣**。

### 11.3 与后端的交互口径

* 保存：`POST /outfits/suggestions`（`source=external`、`status=pending`、不写 feedback），
  `items` 按席位顺序发送；**发送 `occasion=casual`**，因为该端点必填而本轮表单不收集场合。
* 编辑：`PATCH /outfits/{id}`，`items` 是**整体替换**，因此界面必须发送完整集合；
  409（已穿着）与 403（衣物不可用）要分别给出中文说明。
* 删除：`DELETE /outfits/{id}` 只删搭配；确认文案必须说明衣物不受影响。
* 幂等：该端点没有幂等键，超时后结果不确定，界面必须说明"可能已保存"而不是宣称成功。

