// LIVE check, not part of npm test: runs real Rafiki functions against the deployed D1 database through wrangler (writes test rows, then removes them).
// Usage: node tests/live/d1check.ts   Use it after adding any new SQL, because D1 differs from the SQLite used in tests (5 terms per compound SELECT, 100 bound parameters).
import { execFileSync } from "node:child_process";
import { buildContext } from "../../src/agent.ts";
import { recall, ftsQuery } from "../../src/memory.ts";
import { importSkill, recallSkills, removeSkill } from "../../src/skills.ts";
import { fileImport, parseExport, undoImport } from "../../src/import.ts";
import { storeDoc } from "../../src/media.ts";

const lit = (v: unknown): string => v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
function run(sql: string, binds: unknown[]): { results: Record<string, unknown>[] } {
  let i = 0;
  const q = sql.replace(/\?/g, () => lit(binds[i++]));
  const out = execFileSync("npx", ["--no-install", "wrangler", "d1", "execute", "rafiki", "--remote", "--json", "--yes", "--command", q], { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8", maxBuffer: 50_000_000 });
  const j = JSON.parse(out);
  return { results: (Array.isArray(j) ? j[j.length - 1]?.results : []) ?? [] };
}
const db: any = { prepare: (sql: string) => ({ bind: (...b: unknown[]) => ({
  first: async () => run(sql, b).results[0] ?? null,
  all: async () => run(sql, b),
  run: async () => { run(sql, b); },
}) }) };

const now = Date.now();
const step = async (name: string, f: () => Promise<unknown>) => { try { const r = await f(); console.log("OK  ", name, typeof r === "string" ? r.slice(0, 160).replace(/\n/g, " | ") : JSON.stringify(r)?.slice(0, 120)); } catch (e) { console.log("FAIL", name, String((e as Error).message).slice(0, 300)); } };

await step("buildContext (all 14 terms, money+location on)", () => buildContext(db, now, 180, true, [], true, []));
await step("recall (FTS join across kinds)", async () => (await recall(db, "remind me to call Otieno", 5)).length);
await step("storeDoc multi-row FTS insert", async () => { const n = await storeDoc({ db, now, off: 180 } as any, "zz-d1check.md", "text/markdown", 3000, "retainer ".repeat(400)); return n; });
await step("recall finds the doc chunk", async () => (await recall(db, "retainer", 3)).map((h) => h.kind).join(","));
const SK = "---\nname: zz-d1check\ndescription: temporary check\nversion: 1\n---\n# zz\nintro\n## Alpha\nbreakeven formula zebra\n## Beta\nsecond section zebra";
await step("importSkill (multi-row RETURNING + FTS insert)", async () => JSON.stringify(await importSkill(db, now, "zz-d1check.md", SK)));
await step("recallSkills", async () => (await recallSkills(db, "zebra", ftsQuery("zebra breakeven"), 3, 4000)).map((h) => h.heading).join(","));
await step("importSkill again (unchanged)", async () => JSON.stringify(await importSkill(db, now, "zz-d1check.md", SK)));
await step("removeSkill", async () => String(await removeSkill(db, "zz-d1check")));
const P = parseExport("## People\n[unknown] - Zzcheck Person One is a colleague.\n[unknown] - Zzcheck Person Two is a friend.");
await step("fileImport (multi-row facts + FTS)", async () => JSON.stringify(await fileImport(db, now, "d1check", P)));
await step("undoImport", async () => { const imp = run("SELECT MAX(id) AS id FROM imports", []).results[0] as { id: number }; return String(await undoImport(db, imp.id)); });
// cleanup of anything left by the check
run("DELETE FROM memory_fts WHERE kind = 'doc' AND ref_id IN (SELECT id FROM docs WHERE name = ?)", ["zz-d1check.md"]);
run("DELETE FROM docs WHERE name = ?", ["zz-d1check.md"]);
run("DELETE FROM imports WHERE source = ?", ["d1check"]);
console.log("cleanup done");
