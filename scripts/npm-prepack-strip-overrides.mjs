#!/usr/bin/env node
import fs from "node:fs";

const pkgPath = "package.json";
const raw = fs.readFileSync(pkgPath, "utf8");
const j = JSON.parse(raw);
if (!j.overrides) {
  process.exit(0);
}
fs.writeFileSync(`${pkgPath}.prepack-bak`, raw);
delete j.overrides;
fs.writeFileSync(pkgPath, `${JSON.stringify(j, null, 2)}\n`);
