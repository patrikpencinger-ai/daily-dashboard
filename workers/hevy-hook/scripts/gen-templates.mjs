// Regenerate ../templates.json (compact {id: [primary, [secondary], equipment]})
// from the local template cache written by tools/build_strength.py:
//   <ZG_CACHE or ~/.claude/cache/daily-dashboard>/strength/templates.json
// Usage (from workers/hevy-hook):  node scripts/gen-templates.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cache = process.env.ZG_CACHE || join(homedir(), ".claude", "cache", "daily-dashboard");
const src = join(cache, "strength", "templates.json");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "templates.json");

const list = JSON.parse(readFileSync(src, "utf8"));
const map = {};
for (const t of [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
  map[t.id] = [t.primary_muscle_group || null, t.secondary_muscle_groups || [], t.equipment ?? null];
}
writeFileSync(out, JSON.stringify(map) + "\n", "utf8");
console.log(`templates.json: ${Object.keys(map).length} templates from ${src}`);
