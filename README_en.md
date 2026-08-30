# ARONA Agent

[简体中文](README.md)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

![Screenshot](https://cdn.jsdelivr.net/gh/SRC114514/arona-agent/intro.jpeg)

A terminal-based conversational AI Agent built on the [Pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), featuring Computer Use, TTS / STT, desktop pets and persistent memory.

---

## Installation

```bash
npm i -g arona-agent

# First run auto-starts the setup wizard, then launches ARONA
arona

# Quick Start
npx arona-agent
```

---

## Optional commands

```bash
# Re-run setup manually (optional)
arona setup

# Upgrade
npm u -g arona-agent

# Launch with TTS/STT disabled
arona --no-voice

# Use --cli for the command line
arona --cli

# Clone/re-clone a character's voice
arona voice add [<character-name>]   # omit the name to enter the TUI for missing voices

# Environment health check
arona doctor
```

---

## Key Features

- **Computer Use**: based on [cua](https://pypi.org/project/cua/).
- **Voice**: Non-streaming TTS (whole-sentence synthesis for natural prosody) + STT.
- **Desktop pet**: transparent frameless always-on-top Electron window + emotion switching + cursor-following pupils + head-pat easter egg + full-screen click/trail FX.
- **Multi-character group chat**: main agent + sub agents on the same screen. After the main agent replies, sub agents take turns in order.

---

## Requirements

- **Node.js >= 22.19.0**
- **Python 3.12 / 3.13**

---

## Configuration

All configuration lives in the JSON file `~/.arona/settings.json`, mostly generated interactively by `arona setup`. Some advanced parameters must be entered manually.

| Field | Description | Default |
|---|---|---|
| `apiKey` | API key | — |
| `apiBaseUrl` | API base URL | — |
| `model` | Model name | `openai/gpt-4o` |
| `thinkingLevel` | Thinking level | `medium` |
| `contextWindow` | Context window | `1000000` |
| `language` | Interface language (`auto`/`zh`/`en`) | `auto` |
| `mainAgent` | Main agent (`arona`/`plana`) | `arona` |
| `subAgents` | Enabled sub agents array | `[]` |
| `ttsEnabled` | Enable TTS | `true` |
| `sttEnabled` | Enable STT | `true` |
| `workspaceId` | Alibaba Cloud Model Studio business space ID | — |
| `ttsApiKey` | DashScope API key | — |
| `ttsModel` | TTS model | `qwen-audio-3.0-tts-plus` |
| `ttsProvider` | TTS backend (`aliyun`/`gpt-sovits`) | `aliyun` |
| `ttsConfig` | Provider-specific config | `{}` |
| `sttApiKey` | DashScope API key | — |
| `sttModel` | STT model | `qwen-audio-3.0-asr-flash-streaming` |
| `sttFormat` | STT audio format | `pcm` |
| `sttSampleRate` | STT sample rate | `16000` |
| `cuaApiKey` | Cua API key | — |
| `tavilyApiKey` | Tavily API key | — |
| `pythonPath` | Python path | `python3` |
| `autoLoadSkills` | Automatically load missing Skills from `~/.agents` on startup | `true` |
| `CLIEnabled` | Launch the CLI when running bare `arona` | `false` |
| `mcpServers` | MCP server JSON | `{}` |

Model prefix auto-detection: if `model` contains no `/`, a `provider/` prefix is added automatically based on the model name prefix or the `apiBaseUrl` domain.

---

## Data Paths (`~/.arona/`)

| Path | Description |
|---|---|
| `settings.json` | Main config file; see the [Configuration](#configuration) section for fields |
| `voices.json` | TTS Voices config file |
| `MEMORY.md` | Persistent memory |
| `sessions/` | Saved sessions |
| `skills/` | Custom skills |
| `undo/` | Undo/redo snapshots |
| `pet.json` | Desktop pet window position |

---

## Key functions

- **Desktop pet**: transparent frameless always-on-top window; drag to move; shake the head region left-right to trigger the "head-pat" easter egg; clicks/drags also fire FX.
- **STT hotkey**: right Cmd on macOS, right Ctrl on Windows/Linux — hold for ≥ 2 seconds to start a one-shot recording.
> Global keyboard listening requires Accessibility permission for Python (System Settings → Privacy & Security → Accessibility).

> Computer Use screenshots require Screen Recording permission for the terminal.

---

## Slash Commands

| Category | Commands |
|---|---|
| Session | `/new` `/clear` · `/resume` · `/exit` · `/export` · `/compact` |
| Display | `/thinking` · `/details` |
| Voice | `/tts` · `/stt` |
| Extensions | `/skill` · `/mcp` |
| Other | `/change-agent` · `/undo` · `/redo` · `/help` |

---

## Extensions

- **Custom Skills**: place `SKILL.md` in `~/.arona/skills/<name>/`, then invoke with `/skill <name>`.
- **MCP servers**: configure a JSON object in the `mcpServers` field of `~/.arona/settings.json`; tools are registered automatically.

---

## License

This project is open-sourced under the [MIT License](LICENSE).

---

## Copyright

This project is an independently developed unofficial project and is not directly affiliated with or endorsed by Nexon Games Co., Ltd., YOSTAR LIMITED, or the official Blue Archive game team.

- The core project code is released under the MIT License. However, no license is granted by this project (or any third party) for any files within the assets/blue-archive/ directory. These files pertain to the intellectual property of Blue Archive and include, but are not limited to, character illustrations, artwork, audio files, text content, and related derivative assets. No warranty of legality or usability is provided for these assets.
- The use, reproduction, and distribution of such content must strictly comply with the [rules](https://bluearchive.jp/fankit/guidelines) published by Nexon Games Co., Ltd. and YOSTAR LIMITED, as well as all applicable laws and regulations.
- This project does not provide access to these third-party files. Users must obtain legitimate copies independently from the official channels of the rights holders and assume full responsibility for their use.
- This project must not be used for distribution that infringes upon the rights of the copyright holders; any such infringement is the sole responsibility of the user.

All intellectual property rights for such content belong to Nexon Games Co., Ltd. and YOSTAR LIMITED. Usage, reproduction, and distribution must strictly adhere to the official terms set by these rights holders and applicable laws.
If a rights holder believes this disclaimer or the project's usage violates any terms, please contact me. Upon verification, the relevant content will be adjusted or removed promptly.
