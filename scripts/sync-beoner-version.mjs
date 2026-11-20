// Release helper: pins beoner/package.json — its own version and its
// dependency on @beon-tech/ai-score — to the version being released, so the
// two packages always ship in lockstep. Usage: node scripts/sync-beoner-version.mjs <version>
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`expected a version like 1.2.3, got: ${version}`);
  process.exit(1);
}
const path = new URL("../beoner/package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(path, "utf8"));
pkg.version = version;
pkg.dependencies["@beon-tech/ai-score"] = version;
writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`beoner/package.json → ${version}`);
