#!/usr/bin/env bun

import { homedir } from 'os';
import path from 'path';
import { promises as fs } from 'fs';

async function testOpenRouterStream() {
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
      stream: true,
      stream_options: {
        include_usage: true
      }
    })
  });
  
  // Log headers
  console.log('Response Headers:');
  response.headers.forEach((value, key) => {
    if (key.includes('cost') || key.includes('usage') || key.includes('data') || key.includes('rate')) {
      console.log(`  ${key}: ${value}`);
    }
  });
  
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  
  console.log('\nStream chunks:');
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        
        try {
          const parsed = JSON.parse(data);
          
          // Check for usage or cost information
          if (parsed.usage || parsed.cost || parsed.cost_details) {
            console.log('\n>>> FOUND COST/USAGE DATA:');
            console.log(JSON.stringify(parsed, null, 2));
          }
          
          // Also check in choices
          if (parsed.choices) {
            for (const choice of parsed.choices) {
              if (choice.usage || choice.cost) {
                console.log('\n>>> FOUND COST IN CHOICE:');
                console.log(JSON.stringify(choice, null, 2));
              }
            }
          }
        } catch (e) {
          // Not JSON
        }
      }
    }
  }
}

testOpenRouterStream().catch(console.error);
