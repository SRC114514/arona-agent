import { Type } from "typebox";
import {
  defineTool,
  type DefaultResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { listSkills, getSkillContent } from "../skills.ts";
import { t } from "../locale.ts";

/**
 * 让 Agent 自行发现并加载技能（~/.arona/skills/<名称>/SKILL.md 或 loader 发现的技能）。
 * factory 模式：loader 与 initAgent 生命周期绑定，避免模块级全局状态。
 */
export function createSkillTools(loader: DefaultResourceLoader): ToolDefinition[] {
  return [loadSkillsTool(loader)];
}

function loadSkillsTool(loader: DefaultResourceLoader): ToolDefinition {
  return defineTool({
    name: "load_skills",
    label: t("加载技能", "Load Skills"),
    description: t(
      "列出或加载技能。**不传 names 时**：返回所有可用技能的 name + description 列表，便于先发现再加载。**传 names 时**：返回对应技能的 SKILL.md 全文（支持单个字符串或字符串数组），加载后遵循其中指令执行；未找到的技能会在结果中列出。建议单次加载不超过 5 个，避免上下文膨胀。",
      "List or load skills. **Without names**: returns the name + description list of all available skills, so you can discover before loading. **With names**: returns the full SKILL.md content of the requested skills (accepts a single string or an array of strings); follow the instructions inside after loading; missing skills are reported in the result. Load at most 5 per call to avoid bloating the context.",
    ),
    parameters: Type.Object({
      names: Type.Optional(
        Type.Union(
          [
            Type.String({ description: t("技能名称（单个）", "Skill name (single)") }),
            Type.Array(Type.String(), { description: t("技能名称列表（多个）", "Skill names (multiple)") }),
          ],
          {
            description: t(
              "要加载的技能名称。省略或传空数组时返回可用技能列表。",
              "Skill name(s) to load. Omit or pass an empty array to list available skills.",
            ),
          },
        ),
      ),
    }),
    execute: async (_id, params) => {
      const raw = params.names;
      const names: string[] = !raw ? [] : Array.isArray(raw) ? raw : [raw];

      // 未指定名称 → 列出可用技能（复用 listSkills：loader 发现 + ~/.arona/skills，去重）
      if (names.length === 0) {
        const all = listSkills(loader);
        if (all.length === 0) {
          return {
            content: [{ type: "text" as const, text: t("未找到任何技能。", "No skills found.") }],
            details: { count: 0, loaded: [], missing: [] },
          };
        }
        const lines = all.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`);
        return {
          content: [
            {
              type: "text" as const,
              text: t("可用技能：\n", "Available skills:\n") + lines.join("\n"),
            },
          ],
          details: { count: all.length, loaded: [], missing: [] },
        };
      }

      // 按名加载 SKILL.md 全文
      const blocks: Array<{ type: "text"; text: string }> = [];
      const loaded: string[] = [];
      const missing: string[] = [];
      for (const name of names) {
        const content = getSkillContent(name, loader);
        if (content === null) {
          missing.push(name);
        } else {
          loaded.push(name);
          blocks.push({
            type: "text" as const,
            text: t(`\n===== 技能：${name} =====\n`, `\n===== Skill: ${name} =====\n`) + content,
          });
        }
      }

      if (missing.length > 0) {
        blocks.push({
          type: "text" as const,
          text: t(
            `未找到技能：${missing.join(", ")}。可先不传参数查看可用技能列表。`,
            `Skills not found: ${missing.join(", ")}. Call without arguments to list available skills.`,
          ),
        });
      }
      if (loaded.length === 0) {
        blocks.push({ type: "text" as const, text: t("未加载到任何技能。", "No skills were loaded.") });
      }

      return { content: blocks, details: { count: loaded.length, loaded, missing } };
    },
  });
}
