// 主 Agent 注册表：桌宠形象 + 人格的切换（/change-agent 命令）。
// 持久化到 ~/.arona/settings.json 的 mainAgent 字段（"arona" | "plana"，缺省 arona）。
// 桌宠侧对应 pet/agents.cjs（ARONA_AGENT env 选择），人格侧对应 agent.ts 的 buildPrompt*Plana。

import { existsSync, readFileSync, writeFileSync } from "fs";
import { SETTINGS_FILE } from "./config.ts";

export const AGENT_IDS = ["arona", "plana"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** 校验 agent id（含类型收窄） */
export function isValidAgentId(id: string): id is AgentId {
  return (AGENT_IDS as readonly string[]).includes(id);
}

/** 当前主 Agent：读 settings.json 的 mainAgent 字段，非法/缺省回退 arona */
export function getMainAgent(): AgentId {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as { mainAgent?: unknown };
      if (typeof s.mainAgent === "string" && isValidAgentId(s.mainAgent)) return s.mainAgent;
    }
  } catch {
    // settings.json 损坏/不可读：回退默认
  }
  return "arona";
}

/**
 * 设置主 Agent 并写回 settings.json（read-modify-write，保留其它字段）。
 */
export function setMainAgent(id: AgentId): void {
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
