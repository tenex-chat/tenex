#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import alias from "esbuild-plugin-alias";

const projectRoot = process.cwd();
const distDir = join(projectRoot, "dist");
const packageJsonPath = join(projectRoot, "package.json");
const daemonWrapperPath = join(distDir, "daemon-wrapper.cjs");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const externalPackages = [
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {}),
    "@google/gemini-cli-core",
];

const commonBuildConfig = {
    bundle: true,
    minify: false,
    sourcemap: false,
    target: "node20",
    format: "esm",
    platform: "node",
    tsconfig: join(projectRoot, "tsconfig.build.json"),
    logLevel: "info",
    external: externalPackages,
    plugins: [
        alias({
            "@": resolve(projectRoot, "src"),
        }),
    ],
};

const daemonWrapper = `#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

function exitWithError(message) {
    console.error(\`[TENEX] \${message}\`);
    process.exit(1);
}

const passthroughArgs = process.argv.slice(2);
const helpFlags = new Set(["-h", "--help"]);
const versionFlags = new Set(["-V", "--version"]);
const wantsHelp = passthroughArgs.some((arg) => helpFlags.has(arg));
const wantsVersion =
    passthroughArgs.length > 0 &&
    passthroughArgs.every((arg) => versionFlags.has(arg));

const targetScript = wantsHelp || wantsVersion
    ? path.join(__dirname, "index.js")
    : path.join(__dirname, "wrapper.js");

if (!existsSync(targetScript)) {
    exitWithError(\`Missing runtime entrypoint: \${targetScript}\`);
}

const forwardedArgs = wantsHelp
    ? ["daemon", ...passthroughArgs]
    : passthroughArgs;

const child = spawn(process.execPath, [targetScript, ...forwardedArgs], {
    stdio: "inherit",
    env: process.env,
});

child.on("error", (error) => {
    exitWithError(\`Failed to launch TENEX daemon: \${error.message}\`);
});

child.on("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});
`;

async function buildAll() {
    try {
        console.log("🏗️  Building TENEX daemon package...");

        rmSync(distDir, { recursive: true, force: true });
        mkdirSync(distDir, { recursive: true });

        console.log("📦 Bundling runtime entrypoints for Node...");
        await Promise.all([
            build({
                ...commonBuildConfig,
                entryPoints: [join(projectRoot, "src", "index.ts")],
                outfile: join(distDir, "index.js"),
            }),
            build({
                ...commonBuildConfig,
                entryPoints: [join(projectRoot, "src", "wrapper.ts")],
                outfile: join(distDir, "wrapper.js"),
            }),
        ]);

        console.log("🧩 Writing npx launcher...");
        writeFileSync(daemonWrapperPath, daemonWrapper, "utf8");
        chmodSync(daemonWrapperPath, 0o755);

        console.log("✅ Build completed successfully!");
    } catch (error) {
        console.error("❌ Build failed:", error);
        process.exit(1);
    }
}

buildAll();
