import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { SKILLS_DIR } from "./config.ts";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
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
