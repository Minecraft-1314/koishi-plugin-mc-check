# koishi-plugin-ai-image

## 项目介绍 (Project Introduction)

### 中文
这是一款为 Koishi 聊天机器人框架开发的 AI 绘图插件，支持**文生图 + 图生图**，**严格兼容 OpenAI 标准接口**。
插件内置多 API 负载均衡、详细调试日志、超时等待机制、全配置化提示文案，配置简单、开箱即用、稳定可靠。

### English
An AI drawing plugin for the Koishi chatbot framework, supporting **text-to-image & image-to-image**.
**Only compatible with OpenAI-standard APIs**. Built-in API load balancing, debug logging, timeout mechanism, fully configurable messages. Easy to configure & ready to use.

## 使用说明 (Usage)

### 中文
| 命令 (Command) | 功能说明 (Description) |
|---------------|------------------------|
| `draw 提示词`  | 文生图，直接根据提示词生成图片 |
| `imgdraw 提示词` | 图生图，发送指令后在限定时间内上传参考图即可生成 |

### English
| Command         | Description |
|-----------------|-------------|
| `draw prompt`   | Text-to-image: Generate image by prompt |
| `imgdraw prompt` | Image-to-image: Upload reference image within timeout after command |

## 配置说明 (Configuration)

### 中文
| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| **🔧 基础配置** | | |
| `debug` | 开启调试模式，输出完整请求体、返回体与错误日志 | false |
| `apiStrategy` | API 调度策略：sequence（顺序）/ roundrobin（负载均衡） | roundrobin |
| `timeout` | API 请求超时时间（毫秒） | 300000 |
| `rateLimit` | 每小时调用频率限制 | 200 |
| `imgWaitTime` | 图生图等待图片超时时间（秒） | 60 |
| **📝 模型配置** | | |
| `model` | 绘图模型名称 | gpt-4o-mini |
| **🔗 API 列表** | | |
| `apiList` | API 配置数组，支持多账号轮询负载 | [] |
| `apiList[].enable` | 启用当前 API | true |
| `apiList[].apiKey` | 接口密钥 | 空 |
| `apiList[].baseUrl` | 接口地址（仅支持 OpenAI 格式） | 空 |
| **💬 指令配置** | | |
| `command` | 文生图指令 | draw |
| `aliases` | 文生图指令别名 | [] |
| `img2imgCommand` | 图生图指令 | imgdraw |
| `img2imgAliases` | 图生图指令别名 | [] |
| **⚙️ 功能开关** | | |
| `enableTxt2Img` | 启用文生图 | true |
| `enableImg2Img` | 启用图生图 | true |
| **💬 提示文案** | | |
| `messages.generating` | 生成中提示 | ⏳ 生成中... |
| `messages.waitImage` | 等待图片提示 | 请在60秒内发送需要编辑的图片 |
| `messages.timeout` | 超时提示 | 等待图片超时，已取消 |
| `messages.empty` | 未输入提示词 | ❌ 请输入提示词 |
| `messages.noApi` | 无可用 API | ❌ 未配置可用API |
| `messages.noImg` | 未返回图片 | ❌ 生成失败 |
| `messages.success` | 生成成功 | ✅ 生成成功 |
| `messages.fail` | 生成失败 | ❌ 生成失败 |

### English
| Config Item | Description | Default |
|-------------|-------------|---------|
| **🔧 Basic** | | |
| `debug` | Enable debug mode (full request/response/error logs) | false |
| `apiStrategy` | API strategy: sequence / roundrobin | roundrobin |
| `timeout` | API request timeout (ms) | 300000 |
| `rateLimit` | Hourly rate limit | 200 |
| `imgWaitTime` | Image wait timeout (seconds) | 60 |
| **📝 Model** | | |
| `model` | AI model name | gpt-4o-mini |
| **🔗 API List** | | |
| `apiList` | Multiple API configs for load balancing | [] |
| `apiList[].enable` | Enable this API entry | true |
| `apiList[].apiKey` | API Key | empty |
| `apiList[].baseUrl` | API endpoint (OpenAI format only) | empty |
| **💬 Commands** | | |
| `command` | Text-to-image command | draw |
| `aliases` | Text-to-image aliases | [] |
| `img2imgCommand` | Image-to-image command | imgdraw |
| `img2imgAliases` | Image-to-image aliases | [] |
| **⚙️ Features** | | |
| `enableTxt2Img` | Enable text-to-image | true |
| `enableImg2Img` | Enable image-to-image | true |
| **💬 Messages** | | |
| `messages.generating` | Generating message | ⏳ Generating... |
| `messages.waitImage` | Waiting image message | Please send image within 60s |
| `messages.timeout` | Timeout message | Image wait timeout, canceled |
| `messages.empty` | Empty prompt | ❌ Please enter a prompt |
| `messages.noApi` | No available API | ❌ No available API |
| `messages.noImg` | No image returned | ❌ Generation failed |
| `messages.success` | Success | ✅ Generation successful |
| `messages.fail` | Failed | ❌ Generation failed |

## 兼容接口 (Supported API)
仅支持 **OpenAI 标准接口**
- `/v1/chat/completions`

## 功能特性
- 支持多 API 密钥轮询与负载均衡
- 文生图 / 图生图指令完全分离
- 图生图自动等待图片、超时自动取消
- 内置 Base64 图片解析，稳定支持图生图
- 全配置化提示文案，无需修改代码
- 完整调试日志，便于排查问题
- 开箱即用，配置极简

## 项目贡献者 (Contributors)
| 贡献者 | 贡献内容 |
|--------|----------|
| Minecraft-1314 | 插件完整开发 |
| 欢迎提交 PR / Issue | 共同完善项目 |

## 许可协议 (License)
MIT License

## 支持我们 (Support Us)
如果你喜欢本插件，欢迎点亮 **Star ⭐** 支持项目持续更新！