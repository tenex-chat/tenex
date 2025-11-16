#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import alias from "esbuild-plugin-alias";

const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

// Get all dependencies to mark as external
const external = [
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {}),
];

const aliasPlugin = alias({
    "@": resolve(process.cwd(), "src"),
});

const sharedConfig = {
    entryPoints: [],
    minify: false,
    sourcemap: true,
    target: "es2022",
    format: "esm",
    platform: "node",
    outdir: "dist",
    tsconfig: "tsconfig.build.json",
    logLevel: "info",
    // Resolve TypeScript paths
    resolveExtensions: [".ts", ".js", ".json"],
    plugins: [aliasPlugin],
};

async function buildAll() {
    try {
        console.log("🏗️  Building TENEX CLI...");

        const { execSync } = await import("child_process");
        const { existsSync, mkdirSync } = await import("fs");

        // Ensure dist directory exists
        if (!existsSync("dist")) {
            mkdirSync("dist", { recursive: true });
        }

        // Use bun to transpile all TypeScript files
        console.log("📦 Transpiling TypeScript files...");
        execSync("bun build src --outdir dist --target node --format esm", { stdio: "inherit" });

        console.log("✅ Build completed successfully!");
    } catch (error) {
        console.error("❌ Build failed:", error);
        process.exit(1);
    }
}

buildAll();
