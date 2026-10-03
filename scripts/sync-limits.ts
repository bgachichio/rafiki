// Rewrites the generated "cannot do" blocks from src/limits.ts: always in README.md, and in the author's own pages
// when a notes folder is set (RAFIKI_NOTES, or a path in the ignored file .notes-path). Run: npm run limits
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EXPORT_PROMPT } from "../src/import.ts";
import { limitsHtml, limitsMarkdown } from "../src/limits.ts";

const promptHtml = (): string => EXPORT_PROMPT.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PROMPT_MARK: [string, string] = ["<!-- prompt:start -->", "<!-- prompt:end -->"];

const root = new URL("..", import.meta.url).pathname;
export const NOTES: string = process.env.RAFIKI_NOTES ?? (existsSync(`${root}.notes-path`) ? readFileSync(`${root}.notes-path`, "utf8").trim() : "");
const MARK: [string, string] = ["<!-- limits:start -->", "<!-- limits:end -->"];
export const TARGETS: { path: string; render: () => string; wrap: [string, string]; optional: boolean }[] = [
  { path: `${root}README.md`, render: limitsMarkdown, wrap: MARK, optional: false },
  ...(NOTES ? [
    { path: `${NOTES}/site/index.html`, render: limitsHtml, wrap: MARK, optional: true },
    { path: `${NOTES}/site/setup/index.html`, render: limitsHtml, wrap: MARK, optional: true },
    { path: `${NOTES}/site/setup/index.html`, render: promptHtml, wrap: PROMPT_MARK, optional: true },
    { path: `${NOTES}/site/rafiki-launch.md`, render: limitsMarkdown, wrap: MARK, optional: true },
    { path: `${NOTES}/21-what-rafiki-cannot-do.md`, render: limitsMarkdown, wrap: MARK, optional: true },
  ] : []),
];

export function replaceBlock(text: string, start: string, end: string, body: string): string | null {
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 || b < a) return null;
  return `${text.slice(0, a + start.length)}\n${body}\n${text.slice(b)}`;
}

if (process.argv[1]?.endsWith("sync-limits.ts")) {
  for (const t of TARGETS) {
    if (!existsSync(t.path)) { console.error(`missing ${t.path}`); process.exitCode = 1; continue; }
    const next = replaceBlock(readFileSync(t.path, "utf8"), t.wrap[0], t.wrap[1], t.render());
    if (next === null) { console.error(`markers missing in ${t.path}`); process.exitCode = 1; continue; }
    writeFileSync(t.path, next);
    console.log(`updated ${t.path.replace(root, "")}`);
  }
}
