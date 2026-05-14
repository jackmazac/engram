#!/usr/bin/env node
import fs from "node:fs";

const bak = "package.json.prepack-bak";
if (fs.existsSync(bak)) {
  fs.copyFileSync(bak, "package.json");
  fs.unlinkSync(bak);
}
