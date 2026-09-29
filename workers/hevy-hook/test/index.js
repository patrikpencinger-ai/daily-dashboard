// Entry point so that `node --test workers/hevy-hook/test/` works: Node resolves
// a directory argument to its index.js, which loads every *.test.mjs here.
import { readdirSync } from "node:fs";

for (const f of readdirSync(new URL(".", import.meta.url)).filter((n) => n.endsWith(".test.mjs")).sort()) {
  await import(new URL(f, import.meta.url));
}
