# 知衣 mobile

知衣（Zhiyi）的 React Native + Expo + TypeScript 客户端。

| 轮次 | 范围 | 状态 |
| --- | --- | --- |
| 第一轮 | 工程骨架、环境配置、统一请求封装、认证（开发登录 + OIDC PKCE）、衣橱列表与详情**读取**、四入口底部导航 | ✅ |
| **第二轮** | **添加衣物（拍照/相册）、上传与处理状态、手动录入属性、详情编辑、归档/删除、分类/搜索/筛选/分页** | ✅ 本轮 |
| 第三轮 | 插槽式搭配 | 未开始 |
| 第四轮 | 待购数据与隔离 | 未开始 |

**不做**离线写入队列，也不做双向同步：服务端是唯一主数据源，客户端只做查询缓存。
因此网络不可用时，添加/编辑/归档/删除都会**明确失败并保留已输入的内容**，不会静默排队。

第二轮的目标是让用户完成「添加一件衣服 → 查看 → 修改 → 再次打开仍存在」的完整流程。
统一请求封装、认证（开发登录 + OIDC PKCE）、衣橱列表与详情**读取**、四入口底部导航。

- 上传 / 增删改 → 第二轮
- 插槽式搭配 → 第三轮
- 待购数据与隔离 → 第四轮

本轮**不做**离线写入队列，也不做双向同步：服务端是唯一主数据源，客户端只做查询缓存。

---

## 1. 环境要求

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（本仓库验证于 22.22.2） | Expo CLI 需要 |
| npm | ≥ 10 | 锁定文件为 `package-lock.json` |
| Expo SDK | **57**（`expo@57.0.25`） | SDK 58 尚无稳定版 |

依赖版本已全部锁定（见 `package.json`），它们是按 Expo SDK 57 自带的
`bundledNativeModules.json` 逐项对齐的。**不要**随手 `npm update`：升级其中任何一项都可能
打破 SDK 兼容矩阵。

第二轮新增三个包（均由 `npx expo install` 按 SDK 57 选定版本）：

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `expo-image-picker` | `~57.0.20` | 从相册选图 / 拍照 |
| `expo-image-manipulator` | `~57.0.20` | 缩放、重编码（同时解决方向问题） |
| `expo-file-system` | `~57.0.7` | 把本地文件包成 `Blob` 分片用于上传（见 §10 的坑） |
`bundledNativeModules.json` 逐项对齐的。**不要**随手 `npm update`：升级其中任何一项都可能
打破 SDK 兼容矩阵。

---

## 2. 安装

```bash
cd mobile
npm install          # 严格按 package-lock.json 安装
```

验证解析到的版本：

```bash
npm ls --depth=0          # 逐项核对锁定版本
npx expo install --check  # SDK 兼容性检查，应为干净通过
```

---

## 3. 环境变量

复制示例文件后按本机情况修改：

```bash
cp .env.example .env
```

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | ✅ | 后端**源地址**，**不含** `/api/v1`。例如 `http://10.0.2.2:8000` |
| `EXPO_PUBLIC_OIDC_REDIRECT_SCHEME` | — | 默认 `wardrowbe`；须与服务端 `MOBILE_APP_SCHEME` 一致 |

要点：

- `EXPO_PUBLIC_` 前缀的变量会被 Expo 在**打包时内联进客户端**，因此只能放非敏感值。
  **绝不要**把生产域名、密钥或令牌写进去。
- `access_token` 只保存在 `expo-secure-store`（iOS Keychain / Android Keystore），
  永不进入环境变量、AsyncStorage、日志或错误信息。
- 缺少 `EXPO_PUBLIC_API_URL` 时，应用**不会崩溃**，而是在登录页与请求层给出明确提示
  「未配置后端地址。请在 mobile/.env 中设置 EXPO_PUBLIC_API_URL 后重新启动开发服务器。」
- 改动 `.env` 后必须**重启**开发服务器（`npx expo start -c` 清缓存），否则新值不会生效。

---

## 4. 连接后端（三种地址的区别，最容易踩坑）

服务端**内部主机名不能直接当作手机访问地址**。`docker-compose` 里的 `backend:8000`、
`postgres:5432` 只在容器网络内有效；写进 App 只会得到一个连不上的地址。

| 运行场景 | `EXPO_PUBLIC_API_URL` | 为什么 |
| --- | --- | --- |
| 电脑本机浏览器 / Web | `http://127.0.0.1:8000` | 仅电脑自己可用 |
| **Android 模拟器（AVD）** | `http://10.0.2.2:8000` | `10.0.2.2` 是模拟器里指向**宿主机**的固定别名。模拟器内的 `127.0.0.1` 指向模拟器自己，所以**必须**用它 |
| iOS 模拟器 | `http://127.0.0.1:8000` | iOS 模拟器与宿主机共享网络栈 |
| Genymotion | `http://10.0.3.2:8000` | 另一种模拟器的宿主机别名 |
| **真机（同一局域网）** | `http://<电脑局域网IP>:8000` | 例如 `http://192.168.1.20:8000`；查 IP：`ipconfig getifaddr en0` |
| 真机 + adb 反向代理 | `http://127.0.0.1:8000` | 先执行 `adb reverse tcp:8000 tcp:8000` |

两个硬性前提：

1. **后端必须监听 `0.0.0.0`**（不是 `127.0.0.1`），真机才连得上。
   本仓库的无 Docker 启动脚本支持：`BIND_HOST=0.0.0.0 ./scripts/dev-local.sh start`
2. **Android 9+ 默认禁止明文 HTTP**。`app.json` 里已按规范设置
   `expo.android.usesCleartextTraffic: true` —— 这是开发期必需项，上线走 HTTPS 后应重新评估。

自检：在手机浏览器里先打开 `http://<地址>:8000/api/v1/health`，能看到
`{"status":"healthy"}` 再回来跑 App；打不开就不是 App 的问题。

---

## 5. 运行

```bash
npx expo start           # 开发服务器，扫二维码
npx expo start --android # 直接拉起 Android
npx expo start --ios     # 直接拉起 iOS
npx expo start -c        # 改动 .env 后：清缓存重启
```

开发登录（仅当后端 `dev_mode: true`，即 `DEBUG=true` 且未配置 OIDC）：

1. 登录页自动显示「开发模式」黄条与邮箱/名称表单
2. 填入邮箱（如 `dev@example.com`）与显示名称
3. 客户端调 `POST /api/v1/auth/sync` 换取 token

> ⚠️ **不要用 `.local` 结尾的邮箱**（例如 `dev@wardrobe.local`）。后端 `/auth/sync` 接受它，
> 但 `/auth/session` 的响应模型把 `email` 校验为 `EmailStr`，会返回 **422**
> （`special-use or reserved name`），而 `/users/me` 和 `/items` 却仍然是 200。
> 结果是「看起来已登录、但启动校验过不去」。用真实 TLD 即可避开。
> Web 端默认值就是 `dev@wardrobe.local`，移动端**刻意没有照搬**这个默认值。

---

## 6. Development build

**OIDC 登录必须用 development build**：Expo Go 只能注册 `exp://` 回调，无法声明
`wardrowbe://` scheme，浏览器完成认证后没有东西可以跳回来。开发登录（表单）在 Expo Go 里也能用。

```bash
npm install -g eas-cli      # 或用 npx eas-cli
eas login
eas build --profile development --platform android   # 或 ios
```

本地构建（需要本机具备 Android SDK / Xcode 工具链，本仓库当前机器**不具备**）：

```bash
npx expo run:android
npx expo run:ios
```

OIDC 回调地址是 `wardrowbe://auth/callback`，与服务端
`backend/app/api/auth.py` 的 `MOBILE_APP_SCHEME = "wardrowbe"` 以及 `app.json` 的
`expo.scheme` 三者一致。改动其中任何一个都必须同步改另外两个。

若 IdP 无法配置自定义 scheme，可用服务端转发端点
`GET /api/v1/auth/mobile-callback`（它会把 query 参数 302 到 `wardrowbe://auth/callback?...`）。

---

## 7. 常见问题（FAQ）

**Q: 页面提示「无法连接后端服务器」/ 请求超时**
1. 后端是否在跑？`curl http://127.0.0.1:8000/api/v1/health`
2. 手机/模拟器能不能访问到？见 §4 的地址矩阵 —— 这是最常见的原因。
3. 真机是否用了电脑局域网 IP，且后端监听 `0.0.0.0`？
4. 改了 `.env` 是否重启了开发服务器（`-c`）？

**Q: 提示「未配置后端地址」**
`.env` 缺失或 `EXPO_PUBLIC_API_URL` 为空。复制 `.env.example` 并填写后重启。

**Q: Android 上图片加载不出来，但列表有数据**
1. 通常是明文 HTTP 被拦：确认 `app.json` 的 `usesCleartextTraffic: true`。
2. 图片 URL 是**相对路径的签名地址**（`/api/v1/images/...`），客户端用 `joinUrl()` 拼成绝对
   地址。签名**1 小时过期**，过期后需重新拉列表换取新签名；下拉刷新即可。
3. 列表里图片区域是纯色块 + 类型文字，说明该单品本来就没有缩略图（缩略图 → 中图 → 原图 →
   占位块的降级顺序）。

**Q: 登录成功但马上又被踢回登录页**
说明 `/auth/session` 校验未通过。客户端把 **401 / 403 / 422** 都判定为「凭证不可用」并强制
重新登录 —— 服务端**没有 refresh 接口**，不做静默刷新。若你用了 `.local` 邮箱，见 §5 的警告。

> **第二轮的改动**：其他端点的 422 **不再**导致登出。因为写操作（`POST/PATCH /items`）对普通
> 请求体校验失败也返回 422，旧规则会让「衣服名多打一个字」直接把人踢出登录。现在只有显式声明了
> `credentialChecked` 的端点（仅 `/auth/session`）才把 422 当凭证问题。见 `src/api/errors.ts`
> 与 `scripts/verify/auth-status-policy.mjs`。

**Q: 点「添加」后按钮一直转，最后提示「上传失败」，但后端日志里根本没有那条 POST？**
几乎肯定就是 §10.1 那个坑：用了 `{uri, name, type}` 构造 multipart 分片。改回
`expo-file-system` 的 `File`（见 §10.1 的代码）。特征：不报错、不超时、服务端零请求。

是明确的占位页（第三/四轮实现），没有假数据也没有假交互。
`添加单品` 在第二轮已经接通；详情页的「编辑」「归档」「删除」也都已可用。

**Q: `npx expo install --check` 报包版本不符？**

现在应当**干净通过**：`react-native-web@0.21.2`、`@types/react@19.2.4` 已对齐 SDK 57.0.25 的期望区间
（SDK 自带的 `bundledNativeModules.json` 写的是 `react-native-web: ~0.21.0`，即 `>=0.21.0 <0.22.0`，
`0.21.2` 同样落在该区间内）。若你改动了依赖又看到该告警，说明锁定值被改动了，请改回
`package-lock.json` 中的版本。

**Q: 切换账号后会看到上一个用户的衣物吗？**
不会。所有查询的 `queryKey` 都以 `userId` 开头（`['user', userId, 'items', ...]`），
缓存天然按用户隔离；登出时还会额外 `queryClient.clear()` 清空整个缓存。

---

## 8. 目录结构

```
mobile/
├── app/                        # expo-router 路由（文件即路由）
│   ├── _layout.tsx             # Providers + 认证门禁
│   ├── login.tsx               # 登录页（开发表单 / OIDC 按钮）
│   ├── auth/callback.tsx       # OIDC 回调 wardrowbe://auth/callback
│   ├── item/new.tsx            # 添加单品（拍照/相册 + 手动属性 + 上传状态）
│   ├── item/[id].tsx           # 单品详情（查看 + 编辑 + 归档/删除）
│   └── (tabs)/                 # 四入口底部导航
│       ├── _layout.tsx         # 衣橱 / 搭配 / 待购 / 我的
│       ├── index.tsx           # 衣橱（列表 + 搜索 + 筛选 + 排序 + 分页）
│       ├── outfits.tsx         # 搭配（占位）
│       ├── to-buy.tsx          # 待购（占位）
│       └── profile.tsx         # 我的（账号信息 + 退出登录）
├── src/
│   ├── api/                    # client(统一请求 + multipart) / errors(错误分类) / url(URL 拼接)
│   │                           # auth / items(读) / itemWrites(写) / itemVocab(词表)
│   │                           # itemMutations(写 + 缓存失效) / hooks(React Query) / types
│   ├── auth/                   # AuthContext(凭证状态机) / storage(安全存储) / useOidcLogin
│   ├── media/photoPicker.ts    # 相册/相机、权限、取消、缩放与方向归一化
│   ├── components/             # ui / form(表单原语) / ConfirmDialog / ItemCard / states / Logo
│   ├── config/env.ts           # 环境变量读取与校验
│   ├── i18n/zh.ts              # 中文文案
│   └── theme/                  # tokens(设计令牌) / ThemeContext
├── scripts/                    # 设备验证脚手架 + verify/ 自动化验证
├── app.json  package.json  package-lock.json  tsconfig.json
├── .env.example
└── README.md
```

---

## 9. 添加衣物：上传怎么工作（本轮核心）

```
相册/相机  →  重编码为 JPEG（长边 ≤1600、质量 0.8）  →  multipart POST /api/v1/items
```

界面上的阶段与文案（区分「照片传完了」和「AI 认完了」）：

| 阶段 | 界面文案 | 含义 |
| --- | --- | --- |
| `preparing` | 正在添加... | 在读图、缩放、重编码 |
| `uploading` | 正在上传照片... | 字节还在传 |
| `analyzing` | 正在识别衣物信息... | **照片已存到服务端**，AI 正在后台打标 |
| `saved` | 已添加 / 这件衣物已经可以使用了。 | 服务端返回了可用的衣物 |
| `error` | 上传失败... + 照片和填写的信息都已保留 | 表单原样保留，可直接重试 |

是否进入 `analyzing` 看**服务端返回的 `status`**，不是客户端猜的：AI 未配置时服务端直接返回
`status: "ready"`，界面就告诉你已经可用，而不会假装在识别。

**不产生重复记录**：按钮在同一帧内重复点击由同步锁丢弃；服务端对同一张照片返回 **409**
（感知哈希重复），批量上传则用 `upload_keys` 幂等键 —— 重试会拿回**同一件**衣物而不是新建一条。

---

## 10. 四个必须知道的坑（都是真机上踩到的）

### 10.1 上传用 `{uri, name, type}` 会**静默失败**（Expo SDK 57）

这是 React Native 的经典写法，但在 Expo 下**不能用**。Expo 把全局 `fetch` 换成了自己的实现，
它在 JS 里序列化 multipart body：`expo/src/winter/fetch/convertFormData.ts` 的
`convertFormDataAsync` 只接受 `string` / `Blob` / 带 `bytes()` 的对象，遇到 `{uri}` 分片直接
`throw new Error('Unsupported FormDataPart implementation')`；该文件注释原文就写着
「`uri` is not supported for React Native's FormData.」

**症状很好认**：点上传后按钮一直转，最后提示「上传失败」，而**后端日志里完全没有那条 POST**
（GET 都正常）——不报错也不超时，因为请求根本没发出去。

**正确写法**：用 `expo-file-system` 的 `File` 做分片（它 `implements Blob`）：

```ts
import { File } from 'expo-file-system';

const file = new File(photo.uri);            // photo.uri 是本地 file:// 路径
form.append('image', file as unknown as Blob, photo.name);   // name 会变成 filename
```

实现见 `src/api/itemWrites.ts` 的 `appendFilePart()`。回归测试：
`node scripts/verify/formdata-part-contract.mjs`。

### 10.2 不要手设 `Content-Type`

multipart 的 boundary 必须由 `fetch` 自己生成。手写 `'Content-Type': 'multipart/form-data'`
会让服务端无法解析 body。`requestMultipart()` 故意只设 `Accept` 和 `Authorization`。

### 10.3 选完图统一重编码（三条各自的理由）

后端处理上传时会 `ImageOps.exif_transpose`，所以**方向本身并不依赖**客户端重编码 —— 四种
进图路径（`quality:1` 原样、picker 压缩、裁剪、manipulator）实测落盘几何都正确。

但 picker 的正确性建立在一条**隐式契约**上：`quality: 1` 走 `RawImageExporter`（**字节原样复制**，
像素未转正、orientation 标签保留，靠后端转正）；`quality < 1` 走 `CompressionImageExporter`
（像素已转正，而 `copyExifData` **会把 `TAG_ORIENTATION` 排除掉**，后端转为 no-op）。
两者恰好互补 —— 一旦以后调了 `quality`、换了导出器，正确性就寄在别人代码里。

所以客户端统一用 expo-image-manipulator 重编码，三个理由各自成立：

1. 方向不再取决于 `quality` 取值；
2. 满足服务端的 20MB / 50MP 硬限制；
3. 上传的字节**构造上就是 EXIF 干净的**（manipulator 不读也不写 EXIF）。

> 早先这个仓库的注释曾声称「picker 会抄回一个已被应用的 orientation 标签导致二次旋转」——
> **那个机制描述对 SDK 57 是错的**（`TAG_ORIENTATION` 被明确排除）。行为一直是对的，
> 但理由已按实测改正。证据见
> [第二轮-图片选择与上传调研.md](</Users/Apple/.vetta/workspace/知衣/wardrowbe/mobile/docs/第二轮-图片选择与上传调研.md>) §3
> 与 `backend/.venv/bin/python scripts/verify/exif-roundtrip.py`。

---

### 10.4 相册权限在 Android 13+ 返回的是「空权限列表」

这条很容易被误读成 bug，所以单独说明。`requestMediaLibraryPermissionsAsync()` 在 Android 13+
**不会真的申请任何权限** —— `ImagePickerModule.kt:258-266` 直接返回 `emptyArray<String>()`，
因为系统 PhotoPicker 是按 URI 逐个授权的，不需要清单权限。

空数组传到原生后结果 map 也是空的，而 `PermissionsService.kt:141` 用的是
`areAllGranted = map.all { ... }` —— **对空集合恒为 true**，所以 `granted` 返回 `true`。

结论：
- **不要**用这个 `granted` 判断「用户是否允许选图」，它不携带信息；**选图结果本身才是权威信号**。
- 因此本仓库只在**真正无法继续**时才拦：老设备（API < 33）权限被拒且 `canAskAgain === false`。
- 相册选图**不需要**在 `app.json` 里加 `READ_MEDIA_IMAGES`；相机才需要 `CAMERA`（已由插件加好）。

---

## 11. 自查命令

```bash
npx tsc --noEmit                              # 类型检查
npx expo export --platform android            # 打包校验（真实 Metro 图解析）
npx expo export --platform ios
npx expo install --check                      # SDK 兼容性
npm ls --depth=0                              # 锁定版本审计

# 本轮新增的自动化验证（均可重复运行）
node scripts/verify/auth-status-policy.mjs          # 422/401/403 判定回归（21 项）
node scripts/verify/formdata-part-contract.mjs      # multipart 分片契约回归（13 项）
node scripts/verify/edit-payload-diff.mjs           # 编辑只发变化字段（10 项，防「改名=人工分类」）
bash scripts/verify/api-contract.sh                 # 后端契约 35 项（需后端在跑）
/Users/Apple/.vetta/workspace/知衣/wardrowbe/backend/.venv/bin/python \
  scripts/verify/exif-roundtrip.py                   # 后端 EXIF 行为刻画

# 设备验证（需 emulator/真机）
source scripts/android-env.sh
scripts/device-prep.sh prepare                       # 幂等：推样张、检查后端
scripts/device-prep.sh dump current                  # 可读 UI 树
scripts/device-prep.sh deny-permissions hard         # 模拟「相机权限被永久拒绝」
scripts/device-prep.sh type "Shirt"                  # 输入框需先聚焦
scripts/verify-device.sh                             # 冷启动自检
scripts/run-acceptance.sh s1 s3 s4 s6                # 场景化验收

# 真机 APK —— ⚠️ 改完源码必须重新构建再装，否则设备上验的是旧代码。
# `app-release.apk` 只在这个脚本里更新；`npx expo export` 不产出可安装的 APK。
DEV_ROOT=/tmp/zhiyi-android API_URL=http://10.0.2.2:8000 SKIP_SDK=1 \
  ./mobile/scripts/build-android.sh
```

> ⚠️ `run-acceptance.sh` 目前**无法在模拟器上跑完 s1**：它需要往输入框里写中文/长名称，
> 而模拟器的 `input text` 会丢字符（CJK 直接报 NullPointerException）。脚本已能推进到
> 「照片已附加」，卡在名称输入。**这是模拟器 IME 的限制，不是产品缺陷**；真机上应能跑通。
>
> 另：该脚本会反复 `pm clear` 应用数据，所以**不要在它运行时同时手工验证** ——
> 两边会互相破坏（审计期间实际发生过）。
