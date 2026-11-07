import { readFileSync } from "node:fs";

// One source for terminal instructions and the digest-verified MCP skill catalog.
export const auditSkillMarkdown = readFileSync(new URL("../../skills/pronto-audit-discussion/SKILL.md", import.meta.url), "utf8");
const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(auditSkillMarkdown);
if (!frontmatter) throw new Error("The audit discussion skill is missing YAML frontmatter.");
export const auditChatInstructions = auditSkillMarkdown.slice(frontmatter[0].length).trim();
