# 知衣 · iOS 桥接实测报告

> 本文件只记录**本轮实际跑出来的结果**。凡标注「已验证」的都有原始输出为凭；
> 凡因环境缺失未能跑通的一律标注「**受阻**」并写明确切原因，**不声称通过**。

- 测试对象：`wardrowbe/mobile`（Expo SDK 57 客户端）
- 测试方式：通过 Vetta「Xcode 桥接」插件（v0.1.4）驱动本机 Xcode / 模拟器
- 机器：Apple M1 · macOS 14.5 (23F79) · Node 22.22.2 · Python 3.13.12
- 时间：2026-09-26

---

## 1. 结论先行

| 项 | 结果 |
| --- | --- |
| 桥接插件本身 | **可用**（模拟器列举 / 启动 / 截图 / 构建 4 条链路实测通过） |
| 移动端代码静态检查 | **通过**（`tsc --noEmit` exit 0、`expo install --check` 干净） |
| 移动端在模拟器上真机运行 | **受阻**——工具链版本不满足，非代码问题 |
| 后端自带测试 | **708 passed / 2 failed**（2 个失败均与本轮代码无关） |
| 前端自带测试 | **受阻**——上游 `package-lock.json` 与 `package.json` 不同步 |

**一句话**：插件是好的、代码是好的，卡在**本机 Xcode 15.4 太旧**加上**macOS 14.5 拦住了升级路径**。

---

## 2. 桥接插件自检（全部实测）

| # | 调用 | 结果 |
| --- | --- | --- |
| 1 | 列举模拟器 | ✅ 自动发现 `/Users/Apple/Downloads/Xcode.app`（**不在 `/Applications` 也能识别**），报告 Xcode 15.4 (15F31d)，11 个设备，iPhone 15 已启动 |
| 2 | 模拟器截图 | ✅ 截图成功并读回：屏幕上确为插件自带的 `DemoApp`（bundle id `com.vetta.demoapp`），画面显示 "Xcode Bridge / built by the plugin toolchain" |
| 3 | 启动模拟器 | ✅ iPhone 15 Pro (iOS 17.5) 由 Shutdown 启动到 Booted |
| 4 | 构建（无工程目录） | ✅ 正确失败并给出可读原因：「未找到 .xcodeproj / .xcworkspace / Package.swift」 |
| 5 | 构建（真实工程） | ✅ 真的调起了 xcodebuild，失败在 `Pods` 阶段，错误原文见 §4 |

补充：`xcode-select -p` 指向 `CommandLineTools`（裸 `xcodebuild` 会报 "requires Xcode"），
但插件用显式 `DEVELOPER_DIR` 绕开了这一点，**无需 `sudo xcode-select -s`**。这条设计是有效的。

---

## 3. 移动端静态检查（已验证）

```
$ cd wardrowbe/mobile
$ npx tsc --noEmit
EXIT=0                                    # 无类型错误

$ npx expo install --check
Dependencies are up to date                # SDK 57 依赖矩阵零漂移
```

`app.json` 关键项与后端契约一致：`scheme = wardrowbe`、`bundleIdentifier = com.zhiyi.wardrobe`、
`newArchEnabled = true`。

---

## 4. iOS 运行受阻的确切原因（决定性）

不是代码问题，是**工具链版本链**断了。三处证据：

### 4.1 工程要求 Swift 6.0 / 6.2，本机只有 Swift 5.10

```
$ .../Xcode.app/.../usr/bin/swiftc --version
Apple Swift version 5.10 (swiftlang-5.10.0.13 clang-1500.3.9.4)

$ swiftc -sdk <macOS14.5.sdk> -swift-version 6 probe.swift
error: invalid value '6' in '-swift-version 6'
note: valid arguments to '-swift-version' are '4', '4.2', '5'
```

而工程侧的硬性声明是：

| 位置 | 声明 |
| --- | --- |
| `expo-modules-core` / `expo-modules-jsi` 等 4 个 podspec | `s.swift_version = '6.0'` |
| `expo-modules-jsi/apple/Package.swift` | `// swift-tools-version: 6.2` |
| `@expo/expo-modules-macros-plugin` | `// swift-tools-version: 6.2` |
| 各 podspec 部署目标 | `:ios => '16.4'` |

实测 SwiftPM 同样拒绝：

```
$ swift build
error: package 'swift62-probe' is using Swift tools version 6.2.0
       but the installed version is 5.10.0
```

`ExpoModulesJSI` 是 `ExpoModulesCore` 与 `Expo` 的**强制依赖**（`s.dependency 'ExpoModulesJSI'`），
绕不过去；`expo-modules-core` 虽带 `prebuilds/` 目录，但**目录为空**，没有可复用的 xcframework。

### 4.2 真实构建尝试的原始报错

```
$ xcode_build(cwd = wardrowbe/mobile/ios)     # 先用 expo prebuild 生成原生工程
build failed (exit 65), 9.5s

diff: /Podfile.lock: No such file or directory
error: The sandbox is not in sync with the Podfile.lock.
       Run 'pod install' or update your CocoaPods installation.

scheme: app | configuration: Debug | destination: iPhone 15 (iOS 17 5)
```

即：构建管线是通的（xcodebuild 真的跑起来了），卡在**依赖未安装**——而 `pod` 本机没有：

```
$ pod --version
command not found          # 且 ruby 仅 2.6.10，为系统自带
```

### 4.3 官方版本要求：本机差两个代际

[Expo SDK 文档](https://docs.expo.dev/versions/v57.0.0) 的版本表：

| Expo SDK | iOS 版本 | **所需 Xcode** |
| --- | --- | --- |
| **57.0.0** | 16.4+ | **26.4+** |
| 56.0.0 | 16.4+ | 26.4+ |
| 55.0.0 | 15.1+ | 26.2+ |
| 54.0.0 | 15.1+ | 16.1+ |

本机 Xcode **15.4**。而 Apple 的 [Xcode 系统要求](https://developer.apple.com/xcode/system-requirements/)：

| Xcode | 所需 macOS |
| --- | --- |
| 26.6 | macOS Tahoe 26.2+ |
| 26 | macOS Sequoia **15.6+** |
| 26.4.1 | macOS Tahoe 26.2+ |

本机 macOS **14.5**。

**所以这不是「装个 CocoaPods 就能解决」的问题**：
装 Xcode 26 → 需要升级 macOS 15.6+（或 26.2+）→ M1 支持，但要先升系统。
装了 CocoaPods 也仍会撞上 §4.1 的 Swift 6 墙。

### 4.4 另一条路（Expo Go）同样不通

```
$ npx expo start --ios
CommandError: No development build (com.zhiyi.wardrobe) for this project is installed.
              Install a development build on the target device and try again.
```

因为工程依赖 `expo-dev-client`（development build 路线），Expo Go 无法承载。

---

## 5. 后端自带测试（已验证，非插件范畴但同轮实跑）

```
$ cd wardrowbe/backend
$ PATH="$PWD/.venv/bin:$PATH" \
  TEST_DATABASE_URL="postgresql+asyncpg://wardrobe:wardrobe@127.0.0.1:5432/wardrobe_test" \
  AI_INTERNAL_ENABLED=true AI_VISION_ENABLED=true AI_TEXT_ENABLED=true \
  python -m pytest -q

2 failed, 708 passed, 491 warnings in 27.20s
```

### 5.1 必须先修的两个前置（否则看到的是假失败）

| 现象 | 真实原因 | 处理 |
| --- | --- | --- |
| **369 errors** | `conftest.py:52` 用裸 `python -m alembic`，PATH 上是 Vetta 运行时 Python（无 alembic） | 把 `backend/.venv/bin` 放进 `PATH` |
| **78 failed** | 本机 `backend/.env` 写了 `AI_INTERNAL_ENABLED=false`，而测试期望 AI 开启 | 用环境变量覆盖为 `true` |

不修这两项直接跑，会得到「40 failed / 369 errors」的假象——**那是环境，不是代码缺陷**。

### 5.2 剩下 2 个失败的定性

**① `test_capabilities.py::test_empty_string_env_var_inherits_master`** —— 环境干扰

```
assert False is None          # ai_vision_enabled 读到了 .env 里的显式 false
```

隔离复核：把 cwd 换到**没有 `.env`** 的目录后：

```
ai_vision_enabled = None
effective_vision  = True      # 与测试断言完全一致
```

→ 测试逻辑本身正确，`env_ignore_empty=True` 也确实生效。
仅因 `Settings` 会在 CWD 读到 `backend/.env` 而失真。**上游既有问题，与本轮无关。**

**② `test_bulk_rotate_and_remove_background.py::...skips_other_users_item`** —— 缺 Redis

```
assert 500 == 200
redis connection error 127.0.0.1:6379 ... Connect call failed
ERROR app.api.items: Failed to connect to Redis for bulk remove-background
```

→ `POST /items/bulk/remove-background` 属 §3.7 列出的 **7 个必须 Redis 的端点**。
本机无 Redis，命令本轮未安装。**环境缺失，非代码缺陷。**

---

## 6. 前端自带测试（受阻）

```
$ cd wardrowbe/frontend && npm ci
npm error `npm ci` can only install packages when your package.json and
          package-lock.json are in sync.
npm error Missing: @swc/helpers@0.5.23 from lock file

$ npm install --no-package-lock --cache /tmp/npmcache-fresh
npm error Cannot read properties of null (reading 'edgesOut')
```

→ 上游 `frontend/package-lock.json` 与 `package.json` 已不同步，**两种装法都装不上**，
`vitest` 因此无法运行。**属上游仓库既有状态，非本轮改动引起**（本轮未碰 `frontend/`）。

---

## 7. 本轮对仓库的改动

| 项 | 说明 |
| --- | --- |
| 新增 | `mobile/ios/`（由 `expo prebuild` 生成，476 KB）——**已被 `mobile/.gitignore:40` 忽略**，不进版本库 |
| 改动后还原 | `mobile/package.json` —— prebuild 曾把 `android`/`ios` 脚本改成 `expo run:android`/`expo run:ios`，**已改回原值** |
| 未改动 | `mobile/app.json`、`backend/**`、`frontend/**`、所有 tracked 文件 |

---

## 8. 要在本机真机/模拟器跑起来，还差什么

按依赖顺序，缺一不可：

1. **升级 macOS** → 至少 Sequoia 15.6（Xcode 26 的下限）；若要 Xcode 26.4.x 则需 Tahoe 26.2+。
   - 这是**唯一的前置硬门槛**，M1 硬件本身支持。
2. **装 Xcode 26.4+**（App Store 或 developer.apple.com）。当前只装了 15.4，且在 `~/Downloads` 而非 `/Applications`。
3. **装 CocoaPods**（macOS 升级后随之可装）。
4. 然后：
   ```bash
   cd wardrowbe/mobile
   npx expo prebuild --platform ios --clean
   npx expo run:ios          # 或 npx expo start --ios
   ```
5. 后端监听 `0.0.0.0`，`.env` 里 `EXPO_PUBLIC_API_URL` 用 `http://127.0.0.1:8000`
   （iOS 模拟器与宿主共享网络栈，**不要**照搬 Android 的 `10.0.2.2`）。
   登录用**非 `.local`** 邮箱（见 `docs/知衣-开发进度.md` §3.3 的 422 陷阱）。

### 若暂时不动系统，还能验证什么

- ✅ 移动端：`tsc --noEmit`、`expo install --check`、`expo export --platform ios`（Metro 依赖图/Hermes 字节码）
- ✅ 后端：708 项测试（需 Redis 以覆盖剩余 1 项）
- ✅ 接口契约：`curl` 直接打 `127.0.0.1:8000`
- ❌ **不能**验证：任何需要「App 真的跑起来」的项——
  冷启动、四个 Tab、登录全流程、真实衣物网格、401/422 处理、下拉刷新、跨用户缓存隔离。

---

## 9. 给桥接插件的一点反馈

| 观察 | 说明 |
| --- | --- |
| 无工程目录时报错清晰 | ✅ 直接说「未找到 .xcodeproj / .xcworkspace / Package.swift」，没有硬试 |
| 能自动发现非 `/Applications` 位置的 Xcode | ✅ 本机 Xcode 在 `~/Downloads` 也被识别 |
| 不依赖 `xcode-select` 全局设置 | ✅ 设计正确，避免动用户的机器级配置 |
| **建议** | 构建失败在依赖阶段（如缺 `Podfile.lock`）时，可顺带提示「这看起来是缺 CocoaPods / 需先跑 pod install」，与「代码编译错误」区分开——本次两者都在同一份 log tail 里，`error:` 行实际是环境问题 |
