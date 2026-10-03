// Regenerates src/schema.gen.ts (from schema.sql) and src/assets/mark.gen.ts (the mandrill profile photo). Run: npm run gen
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const schema = readFileSync(`${root}schema.sql`, "utf8");
writeFileSync(`${root}src/schema.gen.ts`, `// Generated from schema.sql by scripts/gen-assets.ts. Do not edit.\nexport const SCHEMA_SQL = ${JSON.stringify(schema)};\n`);
const png = readFileSync(`${root}brand/icons/icon-512.png`).toString("base64");
writeFileSync(`${root}src/assets/mark.gen.ts`, `// Generated from brand/icons/icon-512.png by scripts/gen-assets.ts. Do not edit.\nexport const MARK_PNG_BASE64 = "${png}";\n`);
const starter = readdirSync(`${root}skills/starter`).filter((f) => f.endsWith(".md")).sort().map((f) => [f, readFileSync(`${root}skills/starter/${f}`, "utf8")] as const);
writeFileSync(`${root}src/starter.gen.ts`, `// Generated from skills/starter/*.md by scripts/gen-assets.ts. Do not edit.\nexport const STARTER_SKILLS: [string, string][] = ${JSON.stringify(starter, null, 1)};\n`);
console.log("generated schema.gen.ts, mark.gen.ts and starter.gen.ts");
