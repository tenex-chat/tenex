#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Find all TypeScript files in src
const srcDir = path.join(__dirname, 'src');
const files = [];

function findTsFiles(dir) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory() && !item.includes('test')) {
      findTsFiles(fullPath);
    } else if (item.endsWith('.ts') && !item.includes('.test.') && !item.includes('.spec.')) {
      files.push(fullPath);
    }
  }
}

findTsFiles(srcDir);

console.log(`Checking ${files.length} TypeScript files...`);

// Run tsc on batches of files
const batchSize = 50;
let hasErrors = false;

for (let i = 0; i < files.length; i += batchSize) {
  const batch = files.slice(i, Math.min(i + batchSize, files.length));
  const fileList = batch.map(f => `"${f}"`).join(' ');
  
  try {
    execSync(`npx tsc --noEmit --skipLibCheck ${fileList}`, {
      stdio: 'inherit',
      maxBuffer: 1024 * 1024 * 10
    });
  } catch (error) {
    hasErrors = true;
  }
}

if (!hasErrors) {
  console.log('✅ No TypeScript errors found!');
} else {
  console.log('❌ TypeScript errors found');
  process.exit(1);
}