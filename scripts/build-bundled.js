#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import alias from "esbuild-plugin-alias";

const projectRoot = process.cwd();
const distDir = join(projectRoot, "dist");
const packageJsonPath = join(projectRoot, "package.json");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const externalPackages = [
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {}),
    "@google/gemini-cli-core",
    "bun:*",
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

async function buildAll() {
    try {
        console.log("🏗️  Building TENEX CLI package...");

        rmSync(distDir, { recursive: true, force: true });
        mkdirSync(distDir, { recursive: true });

        console.log("📦 Bundling runtime entrypoints for Node...");
        const cliEntrypoint = join(distDir, "index.js");
        await build({
            ...commonBuildConfig,
            entryPoints: [join(projectRoot, "src", "index.ts")],
            outfile: cliEntrypoint,
        });
        chmodSync(cliEntrypoint, 0o755);

        console.log("✅ Build completed successfully!");
    } catch (error) {
        console.error("❌ Build failed:", error);
        process.exit(1);
    }
}

buildAll();
