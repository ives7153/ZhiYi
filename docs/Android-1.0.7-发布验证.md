# Android 1.0.7 发布与验证报告

## 1. 本次修复

深色主题的 `colors.primary` 是浅色，但部分按钮文字及加载图标写死为 `#FFFFFF`，造成白底白字。统一改为对应主题的 `colors.primaryForeground`：

- 搭配页：场景选中项、分体搭 / 连体裙、AI 帮我搭及加载状态。
- 保存弹窗：确认保存文字及加载图标。
- 城市定位弹窗：使用当前定位文字及加载图标。

没有修改后端业务逻辑、账号密码、已有衣物或搭配数据。

## 2. APK 交付与后端地址

| 属性 | 实测结果 |
| --- | --- |
| 仓库内安装包 | [`releases/android/zhiyi-1.0.7-release.apk`](../releases/android/zhiyi-1.0.7-release.apk) |
| 本地交付副本（工作区根目录） | `交付/android-apk/知衣-1.0.7-release.apk` |
| 包名 | `com.zhiyi.wardrobe` |
| 版本 | `versionName 1.0.7` / `versionCode 8` |
| 文件大小 | `61,337,325` 字节 |
| SHA-256 | `7265c3eb40f64f19c3ad62377a69b0ad6fff95e9c5d1df5909a22eda41d1576f` |
| 内置后端 | `https://status.2119999.xyz`，不依赖电脑局域网 IP 或 adb reverse |
| ABI | `arm64-v8a`、`armeabi-v7a` |
| Android 最低 / 目标 SDK | `24` / `36` |
| APK 签名 | v2 校验通过，与 1.0.6 的证书一致 |
| 签名证书 SHA-256 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` |

签名沿用项目既有的 **Android Debug 证书**，不是应用商店生产发布证书。本次已在模拟器执行 `1.0.6 → 1.0.7` 的 `adb install -r`，覆盖安装成功。

已从最终 APK 的 `assets/index.android.bundle` 确认包含上述公网 HTTPS 地址。用户提供的测试密码不在 APK 中，也未写入源码、报告或提交。该地址是构建期内联值；未来更换后端地址需要重新构建 APK。连接能力仍依赖目标设备网络和后端服务持续可用。

## 3. 自动化与构建验证

### 3.1 TypeScript 与 Android 原生构建

- `npm run typecheck`：通过。
- `npx expo prebuild --platform android --no-install`：通过。
- `./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a --no-daemon --offline --max-workers=4`：**BUILD SUCCESSFUL**，844 个任务，耗时 7 分 53 秒。
- `aapt2 dump badging`：包名、版本、SDK、网络权限验证通过。
- `apksigner verify --verbose --print-certs`：签名验证通过，证书与旧包相同。
- `git diff --check`：通过。

使用 JDK 17、Android SDK 36、Build Tools 35/36、NDK 27.1.12297006、CMake 3.22.1。首次构建因缺少手势组件要求的 Build Tools 35 失败，补齐环境后重新构建通过；未修改依赖版本来绕过检查。

### 3.2 移动端验证脚本：10 个脚本、341 项全部通过

| 脚本 | 通过数 |
| --- | ---: |
| `auth-status-policy.mjs` | 34 |
| `button-contrast.mjs`（新增） | 34 |
| `edit-payload-diff.mjs` | 10 |
| `formdata-part-contract.mjs` | 14 |
| `garment-availability.mjs` | 25 |
| `outfit-item-limit.mjs` | 35 |
| `outfit-slot-map.mjs` | 30 |
| `round6-session-epoch.mjs` | 12 |
| `to-buy-input.mjs` | 67 |
| `write-outcome-uncertainty.mjs` | 80 |

新增配色检查读取实际 TSX 样式和主题 token，验证三个修复文件中主按钮的文字、加载状态及选中状态。文字对比度要求至少 4.5:1，加载指示器至少 3:1。

复跑：

```bash
cd mobile
npm run typecheck
# TMPDIR 请设置为自己的工作区 Temp 或会话 scratch。
for test in scripts/verify/*.mjs; do node "$test" || exit 1; done
```

## 4. 公网后端联调

测试基于 App 的真实 `src/api/client.ts` / `src/api/auth.ts` 请求封装编译执行，不使用假服务或 Mock。

- 独立开发测试账号的 11 项检查全部通过：HTTPS 健康、数据库就绪、密码认证配置、开发测试令牌交换、会话校验、个人资料、衣橱列表、待购列表、搭配列表、能力开关、无令牌会话拒绝。
- 使用用户提供的有效账号，额外完成 5 项检查：邮箱密码登录、会话、衣橱、待购、搭配读取，全部通过。
- 文档旧测试账号密码返回 401，未修改或重置该账号；后续使用了用户授权提供的账号进行真实密码登录测试。
- 没有调用真实账号的改密或服务端退出接口，也没有增删改其业务数据。

## 5. Android 原生运行与截图验证

环境：Android 16 / API 36、ARM64 模拟器，720×1600。

已完成：

1. 安装旧版 1.0.6，再覆盖安装本次 1.0.7：成功。
2. 在 APK 登录表单输入有效账号，经公网 HTTPS 后端完成登录并进入四入口主页：成功。
3. 浅色和深色模式下打开搭配页，检查场景及模式按钮、底部 AI 主按钮：通过。
4. 浅色和深色模式下打开城市定位弹窗，检查 GPS 按钮：通过；未触发定位更新。
5. `am force-stop` 后冷启动：保留并恢复登录态，通过。
6. `AndroidRuntime` / `ReactNativeJS` 错误日志检查：未发现应用运行错误。
7. 对 8 组原生截图区域做像素验证：场景、分体搭、AI 主按钮、定位按钮各覆盖两套主题，全部通过。浅色主题实际像素为深底 `#111827` / 浅字 `#FAFAFA`；深色主题为浅底 `#FAFAFA` / 深字 `#171717`。

原生截图保留在工作区 `交付/截图/1.0.7/`，不提交账号相关画面到 GitHub。保存弹窗和加载状态通过自动化样式检查，未通过原生界面触发业务保存或 AI 请求。

## 6. 验证边界

- 本次是按钮可读性修复、APK 交付与后端连接回归，不等于全部业务端到端验收。
- 未执行真实 AI 生成、真实邮件投递、GPS 更新或完整增删改业务流程。
- 已完成 Android 模拟器验证；未对用户实体手机、其他厂商 ROM 或全部 Android 版本逐一验证。
- 后端当前启用了开发测试认证；生产环境应按部署需求关闭开发模式。此轮未改变服务端部署配置。
