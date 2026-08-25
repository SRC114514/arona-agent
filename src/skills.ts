import { readFileSync, existsSync, readdirSync, cpSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { SKILLS_DIR, verbose } from "./config.ts";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

/** ~/.agents/skills：Trae 全局技能目录（启动时补全缺失 Skill 的来源）。 */
const AGENTS_SKILLS_DIR = join(homedir(), ".agents", "skills");

/**
 * 启动时把 ~/.agents/skills 下缺失的 Skill 目录同步到 ~/.arona/skills。
 * 仅补缺（目标已存在同名目录则跳过），不覆盖、不删除；目录内需含 SKILL.md。
 * 返回本次新同步的数量；任何失败仅 verbose 告警，绝不阻塞启动。
 */
export function syncSkillsFromAgentsDir(): number {
  try {
    if (!existsSync(AGENTS_SKILLS_DIR)) return 0;
    const entries = readdirSync(AGENTS_SKILLS_DIR, { withFileTypes: true });
    let synced = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = join(AGENTS_SKILLS_DIR, entry.name);
      if (!existsSync(join(src, "SKILL.md"))) continue;
      const dest = join(SKILLS_DIR, entry.name);
      if (existsSync(dest)) continue;
      cpSync(src, dest, { recursive: true });
      synced++;
    }
    return synced;
  } catch (err) {
    if (verbose) console.warn(`[skills] sync from ${AGENTS_SKILLS_DIR} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * 从 SKILL.md 内容提取描述：优先解析 YAML frontmatter 的 description 主字段
 * （忽略 description_en 等扩展字段），回退到第一个 "# " 标题；都没有则返回空串。
 */
function extractSkillDescription(content: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) return descMatch[1].trim();
  }
  const headingMatch = content.match(/^#\s+(.+)$/m);
  return headingMatch ? headingMatch[1].trim() : "";
}

/**
 * List skills discovered by the DefaultResourceLoader plus any in ~/.arona/skills/.
 */
export function listSkills(loader?: DefaultResourceLoader): SkillInfo[] {
  const skills: SkillInfo[] = [];

  // From ResourceLoader (Pi SDK discovery)
  if (loader) {
    try {
      const { skills: loaderSkills } = loader.getSkills();
      for (const s of loaderSkills) {
        skills.push({
          name: s.name,
          description: s.description || "",
          path: s.filePath,
        });
      }
    } catch {
      // Loader might not be initialized
    }
  }

  // From ~/.arona/skills/ directory
  if (existsSync(SKILLS_DIR)) {
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = join(SKILLS_DIR, entry.name, "SKILL.md");
        if (existsSync(skillMdPath)) {
          // Avoid duplicates
          if (!skills.find((s) => s.name === entry.name)) {
            const content = readFileSync(skillMdPath, "utf-8");
            skills.push({
              name: entry.name,
              description: extractSkillDescription(content),
              path: skillMdPath,
            });
          }
        }
      }
    }
  }

  return skills;
}

/**
 * Get the content of a skill by name.
 */
export function getSkillContent(name: string, loader?: DefaultResourceLoader): string | null {
  // Check loader skills
  if (loader) {
    try {
      const { skills } = loader.getSkills();
      const skill = skills.find((s) => s.name === name);
      if (skill && existsSync(skill.filePath)) {
        return readFileSync(skill.filePath, "utf-8");
      }
    } catch {
      // ignore
    }
  }

  // Check ~/.arona/skills/
  const skillMdPath = join(SKILLS_DIR, name, "SKILL.md");
  if (existsSync(skillMdPath)) {
    return readFileSync(skillMdPath, "utf-8");
  }

  return null;
}
