# koishi-plugin-mc-check

## 项目介绍 (Project Introduction)

### 中文
这是一个为 Koishi 机器人框架开发的 **Minecraft 综合服务插件**，使用免费公共 API，支持服务器状态查询、正版皮肤预览、版本更新推送、精美卡片生成及分群管理。核心特性：
- 🌐 服务器状态查询：在线状态、版本、玩家列表、MOTD、软件信息及本地 TCP 延迟测试
- 🎨 正版皮肤预览：输入正版玩家名即可获取全身皮肤
- 📢 版本更新推送：插件启动即缓存最新的正式版/快照版信息，手动或自动检查更新
- 🖼️ 精美状态卡片（需 Puppeteer）：暗色主题卡片，展示图标、在线率、MOTD、延迟等
- 🏷️ 分群独立绑定：各群可绑定不同服务器，支持置顶，管理员可动态管理全局列表
- 💬 所有提示文本均可在配置页面自定义
- 🐛 内置 Debug 模式，可详细记录 API 请求/响应及操作日志

### English
A comprehensive Minecraft plugin for the Koishi bot framework, using free public APIs to query server status, preview vanilla skins, push version updates, generate beautiful status cards, and manage per-guild server bindings. Key features:
- 🌐 Server status query: online status, version, player list, MOTD, software info and local TCP ping
- 🎨 Vanilla skin preview: Full-body skin from a username
- 📢 Version update push: caches latest release/snapshot on startup, manual or scheduled checks
- 🖼️ Beautiful Status Cards (requires Puppeteer): dark-themed card with icon, player rate, MOTD, ping
- 🏷️ Per-guild binding: each group can bind different servers, pin servers, admin global list management
- 💬 All reply texts customizable via config
- 🐛 Debug mode for detailed API interaction logs

## 项目仓库 (Repository)
- GitHub: `https://github.com/Minecraft-1314/koishi-plugin-mc-check`
- Issues: `https://github.com/Minecraft-1314/koishi-plugin-mc-check/issues`

## 核心指令 (Core Commands)

| 指令 (Command) | 说明 (Description) | 示例 (Example) |
|----------------|--------------------|----------------|
| `mc-check [地址]` | 查询服务器状态，不填地址则显示本群绑定的所有服务器（群聊）或全局服务器列表（私聊） | `mc-check mc.hypixel.net` |
| `mc-bind <地址>` | 绑定当前群的默认 Minecraft 服务器（仅群聊） | `mc-bind play.example.com` |
| `mc-unbind [地址]` | 解绑服务器，不填地址则解绑全部（仅群聊） | `mc-unbind` |
| `mc-pin <地址>` | 置顶服务器，查询时排在前面 | `mc-pin play.example.com` |
| `mc-unpin <地址>` | 取消置顶 | `mc-unpin play.example.com` |
| `mc-global-set <add/remove/list> [地址]` | 管理全局服务器列表（需管理员权限） | `mc-global-set add new.server.com` |
| `mc-skin <玩家名>` | 查看正版玩家的 3D 全身皮肤 | `mc-skin Notch` |
| `mc-update` | 检查 Minecraft 最新正式版 / 快照版更新 | `mc-update` |

## 配置项说明 (Configuration)

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `debug` | boolean | false | 是否开启调试日志（详细输出所有请求/响应） |
| `globalServers` | string[] | [] | 全局默认服务器地址列表 |
| `globalServerType` | 'java'\|'bedrock' | 'java' | 全局默认服务器类型 |
| `enableGroupIsolation` | boolean | true | 启用后各群可单独绑定服务器 |
| `requestTimeout` | number | 5000 | API 请求超时（毫秒） |
| `enableAutoUpdatePush` | boolean | false | 开启版本更新自动推送 |
| `autoUpdateTime` | string | "09:00" | 版本更新推送时间（HH:mm） |
| `enableBedrockFallback` | boolean | true | Java 服务器离线时自动尝试 Bedrock 查询 |
| `enableCardImage` | boolean | false | 查询单个服务器时生成精美卡片（需 Puppeteer） |
| `messages.*` | string | 见下方 | 所有回复文本均可自定义 |

### 自定义消息 (Messages)

| 消息键 | 默认值 | 说明 |
|--------|--------|------|
| `mcCheckNoServer` | `请提供服务器地址，或使用 mc-bind 绑定` | 无服务器提示 |
| `mcCheckNoGlobal` | `未配置全局服务器` | 无全局服务器提示 |
| `mcCheckTimeout` | `查询超时` | 查询超时提示 |
| `mcBindSuccess` | `已绑定: {0}` | 绑定成功（{0} 为地址） |
| `mcBindGroupOnly` | `该指令仅群聊可用` | 仅群聊可用提示 |
| `mcBindDisabled` | `分群功能已关闭` | 分群功能关闭提示 |
| `mcBindDuplicate` | `该服务器已绑定` | 重复绑定提示 |
| `mcBindMissing` | `请提供服务器地址，例如 mc-bind play.example.com` | 缺少地址提示 |
| `mcUnbindSuccess` | `已解绑全部服务器` | 解绑全部成功 |
| `mcUnbindSuccessOne` | `已解绑: {0}` | 解绑指定成功 |
| `mcUnbindNoBind` | `当前群未绑定该服务器` | 未找到绑定提示 |
| `mcUnbindGroupOnly` | `该指令仅群聊可用` | 解绑仅群聊提示 |
| `mcUnbindDisabled` | `分群功能已关闭` | 解绑分群关闭提示 |
| `mcUpdateNoUpdate` | `当前已是最新版本，暂无更新。` | 无更新提示 |
| `mcUpdateRelease` | `📦 Minecraft 正式版更新` | 正式版更新标题 |
| `mcUpdateSnapshot` | `📦 Minecraft 快照版更新` | 快照版更新标题 |
| `mcUpdateError` | `获取版本信息失败` | 版本检查失败提示 |
| `pinSuccess` | `已置顶: {0}` | 置顶成功 |
| `unpinSuccess` | `已取消置顶: {0}` | 取消置顶成功 |
| `globalSetAdd` | `已添加全局服务器: {0}` | 添加全局服务器成功 |
| `globalSetRemove` | `已移除全局服务器: {0}` | 移除全局服务器成功 |
| `globalSetList` | `当前全局服务器列表:\n{0}` | 全局服务器列表 |
| `skinNotFound` | `未找到该玩家` | 皮肤未找到提示 |
| `skinTitle` | `{0} 的皮肤` | 皮肤标题 |
| `databaseRequired` | `本功能需要安装数据库插件（如 database-sqlite）。` | 缺少数据库提示 |
| `puppeteerRequired` | `需要安装并启用 puppeteer 服务才能使用此功能。` | 缺少 Puppeteer 提示 |

## 依赖 (Dependencies)
- **Koishi 数据库插件**：需安装并启用任意数据库插件（如 `database-sqlite`），用于存储服务器绑定与版本缓存。
- **Puppeteer 服务**（可选）：若需使用状态卡片图片生成，必须安装 `koishi-plugin-puppeteer` 并确保无头浏览器正常工作。

## 使用的 API (APIs Used)
所有 API 均为免费公共接口，无需注册或密钥：

| 功能 | API | 说明 |
|------|-----|------|
| 服务器状态 | `api.mcsrvstat.us` | Java/Bedrock 双协议，返回在线状态、版本、玩家列表、MOTD 等 |
| 延迟测试 | 本地 TCP Ping | 直接连接服务器端口获取真实延迟（毫秒） |
| 玩家 UUID | `api.mojang.com` | 正版玩家名 → UUID |
| 皮肤渲染 | `visage.surgeplay.com` | 正版 3D 全身皮肤渲染 |
| 版本清单 | `piston-meta.mojang.com` | Mojang 官方版本信息（release + snapshot） |

## 功能特性
- 完善的服务器状态查询，支持 Java / Bedrock 协议及离线自动回退
- 本地 TCP Ping 测量延迟，精准稳定
- 正版皮肤预览
- 版本更新智能缓存，启动时获取，对比变化，避免重复请求
- 分群隔离，不同群可绑定不同服务器，互不干扰
- 所有提示文本均可通过配置界面自定义
- 详细的 Debug 日志，便于排查网络与 API 问题

## 项目贡献者 (Contributors)

| 贡献者 (Contributor) | 贡献内容 (Contribution) |
|----------------------|-------------------------|
| Minecraft-1314 | 插件完整开发 |
| koishi-shangxue-apps | UI 背景图灵感与卡片排版风格参考 |
| api.mcsrvstat.us | 免费 Minecraft 服务器状态查询 API |
| Mojang (api.mojang.com) | 玩家名 → UUID 查询 |
| visage.surgeplay.com | 皮肤 3D 渲染服务 |
| piston-meta.mojang.com | Minecraft 官方版本清单 API |

（欢迎通过 Issues 或 PR 加入贡献者列表）

## 许可协议 (License)

本项目采用 MIT 许可证，详情参见 [LICENSE](LICENSE) 文件。

This project is licensed under the MIT License, see the [LICENSE](LICENSE) file for details.

## 支持我们 (Support Us)

如果这个项目对您有帮助，欢迎点亮右上角的 Star ⭐ 支持我们，这将是对所有贡献者最大的鼓励！

If this project is helpful to you, please feel free to star it in the upper right corner ⭐ to support us, which will be the greatest encouragement to all contributors!