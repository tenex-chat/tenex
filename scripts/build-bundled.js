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

    // Build all TypeScript files without bundling
    await build({
      ...sharedConfig,
      entryPoints: ["src/**/*.ts"],
      outdir: "dist",
    });

    // Build CLI executable with bundling
    await build({
      entryPoints: ["src/cli.ts"],
      bundle: true,
      minify: false,
      sourcemap: true,
      target: "node18",
      format: "esm",
      platform: "node",
      outfile: "dist/cli.js",
      tsconfig: "tsconfig.build.json",
      logLevel: "info",
      plugins: [aliasPlugin],
      banner: {
        js: "#!/usr/bin/env node",
      },
      // Mark all Node built-ins as external
      external: [
        ...external,
        "node:*",
        "fs",
        "path",
        "http",
        "https",
        "stream",
        "util",
        "url",
        "child_process",
        "crypto",
        "os",
        "tty",
        "net",
        "events",
        "buffer",
        "querystring",
        "zlib",
        "assert",
      ],
    });

    console.log("✅ Build completed successfully!");
  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

buildAll();
