#!/usr/bin/env node

import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { join } from 'path';

const packageJson = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8')
);

// Get all dependencies to mark as external
const external = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
];

const sharedConfig = {
  entryPoints: [],
  bundle: true,
  minify: false,
  sourcemap: true,
  target: 'es2022',
  format: 'esm',
  platform: 'node',
  external,
  outdir: 'dist',
  tsconfig: 'tsconfig.build.json',
  logLevel: 'info',
};

async function buildAll() {
  try {
    console.log('🏗️  Building TENEX CLI...');
    
    // Build main entry point
    await build({
      ...sharedConfig,
      entryPoints: ['src/index.ts'],
      outdir: 'dist',
    });


    // Build CLI executable
    await build({
      ...sharedConfig,
      entryPoints: ['src/tenex.ts'],
      outdir: 'dist',
      banner: {
        js: '#!/usr/bin/env node',
      },
    });

    console.log('✅ Build completed successfully!');
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

buildAll();
