# ARONA Agent

[English](README_en.md) | [简体中文](README.md)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

> 谁不想在电脑上养一只 ~~香香软软~~ 可可爱爱的阿洛娜呢？

![示意图](./intro.png)

基于 [Pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 构建的终端对话式 AI Agent，集成 Computer Use（电脑控制）、语音（TTS/STT）、桌面宠物、持久记忆与会话管理。

---

## 安装

```bash
npm install -g git+https://github.com/SRC114514/arona-agent.git

# 初始化配置文件
arona setup

# 初始化后可直接启动
arona

# 禁用TTS+STT并启动
arona --no-voice
```

---

## 核心特性

- **Computer Use**：基于 [cua](https://pypi.org/project/cua/) 。
- **语音**：Qwen TTS + STT。
- **桌面宠物**：透明置顶 Electron 窗口，待机视频循环 + 15 种情绪表情 + 瞳孔跟随鼠标 + 左右摇晃彩蛋。


---

## 环境要求

- **Node.js >= 22.19.0**（通过 `--experimental-strip-types` 直接运行 TypeScript，无需编译）
- **Python 3.12 / 3.13**

---

## 配置

全部配置写在 JSON 文件 `~/.arona/settings.json`，大部分由 `arona setup` 交互式生成，少数高级参数需自行填充。

| 字段 | 说明 | 默认值 |
|---|---|---|
| `apiKey` | API Key | — |
| `apiBaseUrl` | API地址（留空则按模型名自动匹配） | — |
| `model` | 模型名（`provider/model-id`，裸名自动补前缀） | `openai/gpt-4o` |
| `thinkingLevel` | 思考等级 | `medium` |
| `language` | 界面语言（`auto`/`zh`/`en`） | `auto` |
| `ttsEnabled` | 启用 TTS | `true` |
| `sttEnabled` | 启用 STT | `true` |
| `ttsAuto` | 回复自动朗读 | `true` |
| `workspaceId` | 阿里云百炼业务空间 ID | — |
| `ttsApiKey` | 百炼 API Key | — |
| `ttsModel` | TTS 模型 | `qwen-audio-3.0-tts-plus` |
| `ttsVoice` | 音色克隆voice_id（`arona setup` 填充） | — |
| `ttsFormat` | TTS 音频格式（mp3/pcm/wav/opus） | `mp3` |
| `ttsSampleRate` | TTS 采样率 | `22050` |
| `sttApiKey` | 百炼 API Key | — |
| `sttModel` | STT 模型 | `qwen-audio-3.0-asr-flash-streaming` |
| `sttFormat` | STT 音频格式 | `pcm` |
| `sttSampleRate` | STT 采样率 | `16000` |
| `cuaApiKey` | Cua API Key | — |
| `pythonPath` | Python 路径 | `python3` |
| `mcpServers` | MCP 服务器 JSON 配置 | `{}` |

模型名前缀自动检测：若 `model` 不含 `/`，按模型名前缀或 `apiBaseUrl` 域名自动补 `provider/`。

---

## 数据路径（`~/.arona/`）

| 路径 | 说明 |
|---|---|
| `settings.json` | 本地总配置文件，字段见 [配置](#配置) |
| `MEMORY.md` | 持久记忆 |
| `sessions/` | 已保存会话 |
| `skills/` | 自定义 Skill |
| `undo/` | undo/redo 快照（按工作目录分桶） |
| `pet.json` | 桌宠窗口位置持久化 |

---

## 桌宠与 STT 热键

- **桌宠**：透明无边框置顶窗口，待机视频循环播放；Agent 每段发言前调用 `change_emotion` 切换 15 种情绪表情；情绪切换采用单向溶解过渡，拖动头部区域左右摇晃可触发彩蛋，TTS 逐句播放。
- **STT 热键**：右 Cmd 键，长按 ≥ 2 秒触发一次性录音。
- **macOS 权限**：全局键盘监听需「系统设置 → 隐私与安全性 → 辅助功能」为Python授权；Computer Use 截图需授予终端「屏幕录制」权限。

---

## 斜杠命令

| 分类 | 命令 |
|---|---|
| 会话 | `/new` `/clear`（新会话）· `/resume`（恢复）· `/exit`（退出）· `/export`（导出 Markdown） |
| 显示 | `/thinking` · `/details` · `/compact`（压缩上下文） |
| 语音 | `/tts` · `/stt` |
| 扩展 | `/skill`（列出/调用）· `/mcp`（管理 MCP 服务器和工具） |
| 其他 | `/undo` · `/redo` · `/help` |

---

## 扩展

- **自定义 Skill**：在 `~/.arona/skills/<名称>/` 放 `SKILL.md`，用 `/skill <名称>` 调用。
- **MCP 服务器**：在 `~/.arona/settings.json` 的 `mcpServers` 字段配置 JSON，工具自动注册。

---

## 都看到这里了

> 窝不是萝莉控别电我啊啊啊！

> 绝对不是因为 ~~她是我妈妈~~ 才做这个的

---

## License

本项目基于 [MIT License](LICENSE) 开源。

---

## 版权声明

本项目为独立开发的非官方项目，与Nexon Games Co., Ltd.、YOSTAR LIMITED及《蔚蓝档案》游戏官方团队无任何直接关联、授权关系。

- 项目主体代码采用MIT许可证发布，但本项目未就assets/blue-archive/目录下的所有文件（涉及《蔚蓝档案》游戏知识产权的内容，包括但不限于角色立绘、美术素材、音频文件、文本内容及相关衍生素材）向本项目/任何第三方授予任何许可，也不对其合法性、可用性做任何担保。
- 此类内容的使用、复制、分发需严格遵循Nexon Games Co., Ltd.及YOSTAR LIMITED发布的 [《蔚蓝档案官方同人创作守则》](https://weibo.com/ttarticle/p/show?id=2309404920534935929304) 及适用法律法规
- 本项目不附带此类第三方文件的获取渠道，用户需自行从权利方官方渠道获取合法副本，并自行承担使用责任；
- 本项目不得用于影响版权方权益之分发，否则自行承担相关侵权责任。

此类内容的知识产权归Nexon Games Co., Ltd.及YOSTAR LIMITED所有，其使用、复制及分发规则应严格遵循上述权利方的官方条款及适用法律法规。
若相关权利人认为本声明或项目使用方式存在不当，可与我联系，将在核实后第一时间调整或移除相关内容。