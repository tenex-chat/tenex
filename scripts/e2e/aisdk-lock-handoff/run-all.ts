// Runs every scenario in this directory sequentially. Exits non-zero on the
// first failure. Each scenario is a self-contained subprocess so a failure
// in one doesn't poison subsequent runs.

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const scenariosDir = join(here, "scenarios");
const files = readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".ts"))
    .sort();

let failed = 0;
for (const f of files) {
    console.log(`\n────────── ${f} ──────────`);
    const code = await new Promise<number>((resolve) => {
        const child = spawn("bun", ["run", join(scenariosDir, f)], {
            stdio: "inherit",
            env: process.env,
        });
        child.on("exit", (c) => resolve(c ?? 1));
    });
    if (code !== 0) {
        console.error(`FAIL: ${f} exited ${code}`);
        failed++;
    }
}

if (failed > 0) {
    console.error(`\n!! ${failed}/${files.length} scenarios failed`);
    process.exit(1);
}
console.log(`\n!! all ${files.length} scenarios passed`);
