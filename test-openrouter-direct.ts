#!/usr/bin/env bun

import { homedir } from 'os';
import path from 'path';
import { promises as fs } from 'fs';

async function testOpenRouterDirect() {
  // Load config
  const configPath = path.join(homedir(), '.tenex', 'llms.json');
  const configContent = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(configContent);
  
  const apiKey = config.credentials?.openrouter?.apiKey;
  if (!apiKey) {
    console.error('No OpenRouter API key found');
    return;
  }
  
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'TENEX Test',
      'HTTP-Referer': 'https://github.com/pablof7z/tenex',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'user', content: 'Say "test" and nothing else.' }
      ],
      temperature: 0.7,
      stream: false
    })
  });
  
  // Log all headers
  console.log('Response Headers:');
  response.headers.forEach((value, key) => {
    console.log(`  ${key}: ${value}`);
    if (key.includes('cost') || key.includes('usage') || key.includes('rate')) {
      console.log(`  >>> FOUND: ${key}: ${value}`);
    }
  });
  
  const data = await response.json();
  console.log('\nResponse Data:');
  console.log(JSON.stringify(data, null, 2));
  
  if (data.usage) {
    console.log('\nUsage Details:');
    console.log(JSON.stringify(data.usage, null, 2));
  }
}

testOpenRouterDirect().catch(console.error);
