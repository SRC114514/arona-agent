// Agent 注册表：主 Agent + 子 Agent 的桌宠形象与人格。
// 主 Agent（arona | plana）由 /change-agent 单选，持久化到 settings.json#mainAgent。
// 子 Agent（shiroko | hoshino | hanako | koharu | kei | aris）由 /change-agent 多选，持久化到 settings.json#subAgents。
// 桌宠侧对应 pet/agents.cjs（ARONA_AGENT env 选主、ARONA_SUB_AGENTS env 选子窗口），
// 人格侧对应 agent.ts 的 buildPrompt* + initSubAgent。

import { existsSync, readFileSync, writeFileSync } from "fs";
import { SETTINGS_FILE } from "./config.ts";
import { t } from "./locale.ts";

export const MAIN_AGENT_IDS = ["arona", "plana"] as const;
export type MainAgentId = (typeof MAIN_AGENT_IDS)[number];

export const SUB_AGENT_IDS = ["shiroko", "hoshino", "hanako", "koharu", "kei", "aris"] as const;
export type SubAgentId = (typeof SUB_AGENT_IDS)[number];

// 编码子 Agent：仅由主 Agent 经 create_subagent 工具派出（每次调用新建独立 in-memory
// session），不进 /change-agent、不进 settings、不进群聊轮询。
export const CODING_AGENT_IDS = ["millennium", "justice"] as const;
export type CodingAgentId = (typeof CODING_AGENT_IDS)[number];

export const AGENT_IDS = [...MAIN_AGENT_IDS, ...SUB_AGENT_IDS, ...CODING_AGENT_IDS] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** 可配置音色的角色（主 + 聊天子 Agent）。编码子 Agent 无 voice.mp3/voice_sovits.mp3 素材，
 *  不进 arona setup / arona voice add 的克隆与音色配置菜单。 */
export const VOICE_AGENT_IDS = [...MAIN_AGENT_IDS, ...SUB_AGENT_IDS] as const;

/** 角色的中英双语显示名（供 TUI / 命令文案复用）。 */
export function getAgentLabel(id: AgentId): string {
  switch (id) {
    case "arona":
      return t("阿洛娜", "Arona");
    case "plana":
      return t("普拉娜", "Plana");
    case "shiroko":
      return t("砂狼白子", "Shiroko");
    case "hoshino":
      return t("小鸟游星野", "Hoshino");
    case "hanako":
      return t("浦和花子", "Hanako");
    case "koharu":
      return t("下江小春", "Koharu");
    case "kei":
      return t("天童凯伊", "Kei");
    case "aris":
      return t("天童爱丽丝", "Aris");
    case "millennium":
      return t("千禧年学员", "Millennium Student");
    case "justice":
      return t("正义实现部成员", "Justice Task Force Member");
  }
}

/** 校验 agent id（含类型收窄） */
export function isValidAgentId(id: string): id is AgentId {
  return (AGENT_IDS as readonly string[]).includes(id);
}

/** 校验主 Agent id */
function isValidMainAgentId(id: string): id is MainAgentId {
  return (MAIN_AGENT_IDS as readonly string[]).includes(id);
}

/** 校验子 Agent id */
function isValidSubAgentId(id: string): id is SubAgentId {
  return (SUB_AGENT_IDS as readonly string[]).includes(id);
}

/** 当前主 Agent：读 settings.json 的 mainAgent 字段，非法/缺省回退 arona */
export function getMainAgent(): MainAgentId {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as { mainAgent?: unknown };
      if (typeof s.mainAgent === "string" && isValidMainAgentId(s.mainAgent)) return s.mainAgent;
    }
  } catch {
    // settings.json 损坏/不可读：回退默认
  }
  return "arona";
}

/** 当前启用的子 Agent 列表：读 settings.json 的 subAgents 数组，非法/缺省为空 */
export function getSubAgents(): SubAgentId[] {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as { subAgents?: unknown };
      if (Array.isArray(s.subAgents)) {
        const valid = s.subAgents.filter((x): x is SubAgentId => typeof x === "string" && isValidSubAgentId(x));
        // 去重并按 SUB_AGENT_IDS 声明顺序排列，避免乱序导致子窗口位置漂移
        return SUB_AGENT_IDS.filter((id) => valid.includes(id));
      }
    }
  } catch {
    // settings.json 损坏/不可读：返回空
  }
  return [];
}

/**
 * 设置主 Agent 并写回 settings.json（read-modify-write，保留其它字段）。
 */
export function setMainAgent(id: MainAgentId): void {
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    settings = {};
  }
  settings.mainAgent = id;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * 设置启用的子 Agent 列表并写回 settings.json（read-modify-write，保留其它字段）。
 */
export function setSubAgents(ids: readonly SubAgentId[]): void {
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    settings = {};
  }
  settings.subAgents = SUB_AGENT_IDS.filter((id) => (ids as readonly string[]).includes(id));
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}