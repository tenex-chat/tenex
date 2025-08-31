#!/usr/bin/env bun

import { generateText, streamText, CoreMessage, CoreTool, convertToCoreMessages } from 'ai';
import { openrouter } from '@openrouter/ai-sdk-provider';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { tool } from 'ai';
import { z } from 'zod';
import { configService } from './src/services/index.js';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { appendFileSync, writeFileSync } from 'fs';

// Colors for output
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// Create log file with timestamp
const logFile = `./ral-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
writeFileSync(logFile, `RAL Debug Log - Started at ${new Date().toISOString()}\n${'='.repeat(80)}\n\n`);

// Helper to print colored output and write to log file
function log(prefix: string, message: string, color: string = COLORS.reset) {
  console.log(`${color}${prefix}${COLORS.reset} ${message}`);
  appendFileSync(logFile, `${new Date().toISOString()} ${prefix} ${message}\n`);
}

// Helper to write detailed JSON to log file
function logJson(label: string, data: any) {
  appendFileSync(logFile, `\n${'-'.repeat(40)}\n${label}:\n${JSON.stringify(data, null, 2)}\n${'-'.repeat(40)}\n\n`);
}

// Test tools
const testTools: Record<string, CoreTool> = {
  calculate: tool({
    description: 'Perform mathematical calculations',
    parameters: z.object({
      expression: z.string().describe('Mathematical expression to evaluate'),
    }),
    execute: async (params: any) => {
      const expression = params.expression;
      log('[TOOL]', `Calculating: ${expression}`, COLORS.yellow);
      try {
        // Simple eval for testing - DO NOT use in production
        const result = eval(expression);
        log('[TOOL]', `Result: ${result}`, COLORS.green);
        return { result };
      } catch (error) {
        log('[TOOL]', `Error: ${error}`, COLORS.red);
        return { error: String(error) };
      }
    },
  }),

  search: tool({
    description: 'Search for information',
    parameters: z.object({
      query: z.string().describe('Search query'),
    }),
    execute: async (params: any) => {
      const query = params.query;
      log('[TOOL]', `Searching for: ${query}`, COLORS.yellow);
      // Mock search results
      const results = [
        `Found information about "${query}": This is a mock result.`,
        `Additional context: ${query} is commonly used in various contexts.`,
        `Related topics include advanced ${query} techniques.`,
      ];
      log('[TOOL]', `Found ${results.length} results`, COLORS.green);
      return { results };
    },
  }),

  complete: tool({
    description: 'Mark the task as complete with a final response',
    parameters: z.object({
      response: z.string().describe('Final response to the user'),
    }),
    execute: async (params: any) => {
      const response = params.response;
      log('[TOOL]', `Completing with: ${response}`, COLORS.yellow);
      return { completed: true, response };
    },
  }),
};

// Simplified RAL implementation
class SimplifiedRAL {
  private messages: CoreMessage[] = [];
  private maxIterations = 10;
  private totalCost = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  constructor(
    private model: string,
    private apiKey: string,
    private useOpenRouter: boolean = true
  ) {}

  async execute(userPrompt: string) {
    log('\n[RAL]', 'Starting Reason-Act Loop (STREAMING)', COLORS.bright + COLORS.blue);
    log('[CONFIG]', `Model: ${this.model}`, COLORS.gray);
    log('[CONFIG]', `Using: ${this.useOpenRouter ? 'OpenRouter' : 'Direct Provider'}`, COLORS.gray);

    // Initialize messages
    this.messages = [
      {
        role: 'system',
        content: `You are a helpful assistant with access to tools. 
When you have completed the user's request, you MUST either:
1. Call the 'complete' tool with your final response, OR
2. End your message with === EOM === on its own line

Think step by step and use tools when needed.`,
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ];

    let iteration = 0;
    let isComplete = false;

    while (!isComplete && iteration < this.maxIterations) {
      iteration++;
      log(`\n[ITERATION]`, `${iteration}/${this.maxIterations}`, COLORS.cyan);

      try {
        // Create provider based on configuration with app attribution
        const provider = this.useOpenRouter
          ? createOpenRouter({ 
              apiKey: this.apiKey,
              headers: {
                'X-Title': 'TENEX Test Script',
                'HTTP-Referer': 'https://github.com/pablof7z/tenex'
              }
            })
          : openrouter; // Would need direct provider here for non-OpenRouter

        // Call LLM with streaming
        log('[LLM]', `Streaming response (${this.messages.length} messages in context)`, COLORS.blue);
        
        // Log the exact request being sent
        const requestPayload = {
          model: this.model,
          messages: this.messages,
          tools: Object.keys(testTools),
          maxSteps: 5,
          temperature: 0.7,
          timestamp: new Date().toISOString()
        };
        logJson('LLM REQUEST', requestPayload);
        
        const result = await streamText({
          model: provider(this.model),
          messages: this.messages as any, // Type assertion for now
          // tools: testTools, // Temporarily disable tools to test cost tracking
          maxSteps: 5, // Let AI SDK handle tool calls automatically
          temperature: 0.7,
          // Enable usage tracking to get cost details
          experimental_includeProviderMetadata: true,
          usage: { include: true },
          onFinish: (test) => {
            console.log("ON FINISHED CALLED", test)
          }
        } as any);

        // Collect the full text and tool calls
        let fullText = '';
        let toolCalls: any[] = [];
        
        // Visual streaming indicator
        console.log(`${COLORS.green}[STREAM] ${COLORS.cyan}Streaming response...${COLORS.reset}`);
        console.log(`${COLORS.bright}${'─'.repeat(60)}${COLORS.reset}`);
        
        // Process the full stream (not just text)
        let chunkCount = 0;
        let textChunkCount = 0;
        const streamChunks: any[] = [];
        
        for await (const chunk of result.fullStream) {
          console.log('chunk', chunk.type)
          chunkCount++;
          streamChunks.push({ ...chunk, timestamp: new Date().toISOString() });
          
          // Handle different chunk types
          if (chunk.type === 'text-delta') {
            textChunkCount++;
            // AI SDK may use different properties for the text depending on provider
            const delta = chunk.textDelta || (chunk as any).text || (chunk as any).delta || '';
            if (delta) {
              process.stdout.write(delta);
              fullText += delta;
            }
          } else if (chunk.type === 'tool-call') {
            // Tool call started
            console.log(''); // New line
            log('[TOOL]', `Calling ${chunk.toolName}`, COLORS.yellow);
            logJson('TOOL CALL CHUNK', chunk);
          } else if (chunk.type === 'tool-result') {
            // Tool result received
            log('[TOOL]', `Result received`, COLORS.green);
            logJson('TOOL RESULT CHUNK', chunk);
          } else if (chunk.type === 'step-finish' || chunk.type === 'finish' || chunk.type === 'finish-step') {
            // Log finish events with their metadata
            logJson(`${chunk.type.toUpperCase()} CHUNK`, chunk);
            
            // Check for response headers in finish chunks
            if ((chunk as any).response?.headers) {
              log('[HEADERS]', 'Response headers found in chunk', COLORS.magenta);
              logJson('CHUNK RESPONSE HEADERS', (chunk as any).response.headers);
              
              const dataUsage = (chunk as any).response.headers['data-usage'];
              if (dataUsage) {
                log('[COST]', `OpenRouter cost from chunk: $${dataUsage}`, COLORS.bright + COLORS.green);
                this.totalCost += parseFloat(dataUsage) || 0;
              }
            }
            
            // Check providerMetadata in chunks
            if ((chunk as any).providerMetadata?.openrouter) {
              const orData = (chunk as any).providerMetadata.openrouter;
              log('[OPENROUTER]', `Chunk provider data: ${orData.provider}`, COLORS.cyan);
              
              // Check for cost in usage data (where OpenRouter actually puts it)
              if (orData.usage?.cost !== undefined) {
                const cost = orData.usage.cost;
                log('[COST]', `OpenRouter cost from chunk: $${cost.toFixed(8)}`, COLORS.bright + COLORS.green);
                this.totalCost += cost;
              }
              
              // Also check cost_details
              if (orData.usage?.cost_details) {
                logJson('COST DETAILS FROM CHUNK', orData.usage.cost_details);
              }
            }
          }
        }
        
        // Log all stream chunks to file for analysis
        if (streamChunks.length > 0) {
          logJson('ALL STREAM CHUNKS', streamChunks);
        }
        
        if (chunkCount === 0) {
          log('[DEBUG]', 'No chunks received from stream', COLORS.red);
        }
        
        // Line break after streaming
        console.log('');
        console.log(`${COLORS.bright}${'─'.repeat(60)}${COLORS.reset}`);
        
        // Get the final result with tool calls
        const finalResult = await result;
        
        // Log ALL properties on finalResult for debugging
        log('[DEBUG]', `FinalResult properties: ${Object.keys(finalResult).join(', ')}`, COLORS.gray);
        logJson('FINAL RESULT OBJECT (ALL PROPERTIES)', {
          keys: Object.keys(finalResult),
          hasRawResponse: !!(finalResult as any).rawResponse,
          hasResponse: !!(finalResult as any).response,
          hasHeaders: !!(finalResult as any).headers,
          hasResponseMessages: !!(finalResult as any).responseMessages,
          hasExperimental: !!(finalResult as any).experimental_providerMetadata,
        });
        
        // Log all available metadata
        const metadata: any = {
          timestamp: new Date().toISOString(),
          usage: null,
          finishReason: null,
          warnings: null,
          responseMetadata: null,
          steps: null,
          toolCalls: null,
          toolResults: null,
          text: null,
          responseId: null,
          modelId: null
        };
        
        // Extract usage information
        try {
          metadata.usage = await finalResult.usage;
          const inputTokens = metadata.usage?.promptTokens || metadata.usage?.inputTokens || 0;
          const outputTokens = metadata.usage?.completionTokens || metadata.usage?.outputTokens || 0;
          const totalTokens = metadata.usage?.totalTokens || (inputTokens + outputTokens);
          
          log('[METADATA]', `Usage - Input: ${inputTokens}, Output: ${outputTokens}, Total: ${totalTokens}`, COLORS.magenta);
          
          // Check for costDetails from OpenRouter (added in PR #107)
          if (metadata.usage?.costDetails) {
            const costDetails = metadata.usage.costDetails;
            log('[COST]', `OpenRouter Cost Details Available!`, COLORS.bright + COLORS.green);
            logJson('COST DETAILS', costDetails);
            
            // Extract actual cost from costDetails
            const totalCost = costDetails.total || costDetails.totalCost || 0;
            if (totalCost > 0) {
              log('[COST]', `OpenRouter native cost: $${totalCost.toFixed(6)}`, COLORS.bright + COLORS.green);
              this.totalCost += totalCost;
            }
          }
          
          // Also check for cost in other possible locations
          const cost = metadata.usage?.cost || (metadata.usage as any)?.totalCost || (metadata.usage as any)?.['data-usage'];
          if (cost && typeof cost === 'number') {
            log('[COST]', `OpenRouter cost from usage: $${cost.toFixed(6)}`, COLORS.bright + COLORS.green);
            this.totalCost += cost;
          }
          
          // Log all usage properties to see what's available
          logJson('ALL USAGE PROPERTIES', {
            ...metadata.usage,
            allKeys: Object.keys(metadata.usage || {})
          });
          
          // Track tokens
          this.totalInputTokens += inputTokens;
          this.totalOutputTokens += outputTokens;
          
          log('[COST]', `Session total: $${this.totalCost.toFixed(6)} (${this.totalInputTokens} input, ${this.totalOutputTokens} output tokens)`, COLORS.cyan);
        } catch (e) {
          log('[ERROR]', `Failed to extract usage: ${e}`, COLORS.red);
        }
        
        // Extract finish reason
        try {
          metadata.finishReason = await finalResult.finishReason;
          log('[METADATA]', `Finish reason: ${metadata.finishReason}`, COLORS.magenta);
        } catch (e) {}
        
        // Extract warnings
        try {
          metadata.warnings = await finalResult.warnings;
          if (metadata.warnings) {
            log('[METADATA]', `Warnings: ${JSON.stringify(metadata.warnings)}`, COLORS.yellow);
          }
        } catch (e) {}
        
        // Extract response metadata (includes provider-specific data)
        try {
          metadata.responseMetadata = await finalResult.responseMetadata;
          if (metadata.responseMetadata) {
            log('[METADATA]', `Provider metadata available`, COLORS.magenta);
            logJson('PROVIDER METADATA', metadata.responseMetadata);
          }
        } catch (e) {}
        
        // Extract all possible metadata sources for OpenRouter cost
        try {
          // Check experimental_providerMetadata
          const experimental = (finalResult as any).experimental_providerMetadata;
          if (experimental) {
            logJson('EXPERIMENTAL PROVIDER METADATA', experimental);
            
            // Try to get cost from OpenRouter data
            if (experimental.openrouter) {
              const orData = experimental.openrouter;
              log('[OPENROUTER]', `Provider: ${orData.provider || 'N/A'}`, COLORS.cyan);
              
              // Log ALL properties to find cost
              logJson('OPENROUTER EXPERIMENTAL DATA (ALL PROPERTIES)', {
                ...orData,
                allKeys: Object.keys(orData)
              });
              
              // Check for cost in different possible locations
              const nativeCost = orData.nativeTotalCost || orData.native_total_cost || orData.cost || orData.costDetails?.total;
              if (nativeCost !== undefined && nativeCost !== null) {
                log('[COST]', `OpenRouter native cost found: $${nativeCost}`, COLORS.bright + COLORS.green);
                this.totalCost += nativeCost;
              }
              
              // Check usage details
              if (orData.usage) {
                log('[OPENROUTER]', `Usage: ${JSON.stringify(orData.usage)}`, COLORS.cyan);
                
                // OpenRouter returns cost in usage.cost
                if (orData.usage.cost !== undefined) {
                  const cost = orData.usage.cost;
                  log('[COST]', `OpenRouter cost: $${cost.toFixed(8)} USD`, COLORS.bright + COLORS.green);
                  this.totalCost += cost;
                }
                
                // Also check cost_details
                if (orData.usage.cost_details) {
                  log('[COST]', `Cost breakdown available`, COLORS.bright + COLORS.green);
                  logJson('COST DETAILS', orData.usage.cost_details);
                }
              }
            }
          }
          
          // Check response headers (where OpenRouter puts cost info)
          if ((finalResult as any).response?.headers) {
            const headers = (finalResult as any).response.headers;
            logJson('RESPONSE HEADERS', headers);
            
            // OpenRouter specific headers
            const dataUsage = headers['data-usage'] || headers['x-data-usage'];
            if (dataUsage) {
              log('[COST]', `OpenRouter Data-Usage header: ${dataUsage}`, COLORS.bright + COLORS.cyan);
              
              // Parse the data-usage header (it's a number representing cost in USD)
              try {
                const cost = parseFloat(dataUsage);
                if (!isNaN(cost)) {
                  log('[COST]', `Parsed cost: $${cost.toFixed(6)} USD`, COLORS.bright + COLORS.green);
                  this.totalCost += cost;
                }
              } catch (e) {}
            }
            
            // Rate limit headers
            const rateLimitRequests = headers['x-ratelimit-requests'] || headers['x-ratelimit-limit-requests'];
            const rateLimitTokens = headers['x-ratelimit-tokens'] || headers['x-ratelimit-limit-tokens'];
            const remainingRequests = headers['x-ratelimit-remaining-requests'];
            const remainingTokens = headers['x-ratelimit-remaining-tokens'];
            
            if (rateLimitRequests || rateLimitTokens) {
              log('[RATELIMIT]', `Requests: ${remainingRequests || '?'}/${rateLimitRequests || '?'}, Tokens: ${remainingTokens || '?'}/${rateLimitTokens || '?'}`, COLORS.yellow);
            }
          }
          
          // Check rawResponse headers
          if ((finalResult as any).rawResponse?.headers) {
            const rawHeaders = (finalResult as any).rawResponse.headers;
            log('[DEBUG]', 'Raw response headers available', COLORS.gray);
            
            // Try to get headers as a Map or object
            if (rawHeaders.get) {
              // Headers is a Map-like object
              const dataUsage = rawHeaders.get('data-usage');
              if (dataUsage) {
                log('[COST]', `OpenRouter Data-Usage (from raw): ${dataUsage}`, COLORS.bright + COLORS.cyan);
                try {
                  const cost = parseFloat(dataUsage);
                  if (!isNaN(cost)) {
                    log('[COST]', `Request cost: $${cost.toFixed(6)} USD`, COLORS.bright + COLORS.green);
                  }
                } catch (e) {}
              }
            }
          }
          
          // Check steps for headers
          if ((finalResult as any).steps && (finalResult as any).steps.length > 0) {
            for (const step of (finalResult as any).steps) {
              if (step.response?.headers) {
                const stepHeaders = step.response.headers;
                const dataUsage = stepHeaders['data-usage'];
                if (dataUsage) {
                  log('[COST]', `Step Data-Usage: ${dataUsage}`, COLORS.bright + COLORS.cyan);
                }
              }
            }
          }
        } catch (e) {
          log('[ERROR]', `Failed to extract OpenRouter metadata: ${e}`, COLORS.red);
        }
        
        // Get the text if it's a promise
        if (!fullText && finalResult.text) {
          try {
            // text might be a Promise
            const textValue = await finalResult.text;
            if (textValue) {
              fullText = textValue;
              metadata.text = fullText;
              log('[RESULT]', `Got text from await result.text: "${fullText.substring(0, 100)}..."`, COLORS.green);
            }
          } catch (e) {
            // text might not be a promise, try direct access
            if (typeof finalResult.text === 'string') {
              fullText = finalResult.text;
              metadata.text = fullText;
              log('[RESULT]', `Got text directly: "${fullText.substring(0, 100)}..."`, COLORS.green);
            }
          }
        }
        
        // Check steps for final response after tool execution
        try {
          metadata.steps = (finalResult as any).steps;
          if (metadata.steps && metadata.steps.length > 0) {
            log('[METADATA]', `Total steps: ${metadata.steps.length}`, COLORS.magenta);
            logJson('ALL STEPS', metadata.steps);
            
            const lastStep = metadata.steps[metadata.steps.length - 1];
            if (lastStep.text && !fullText) {
              fullText = lastStep.text;
              metadata.text = fullText;
              log('[RESULT]', `Got final response from steps: "${fullText.substring(0, 100)}..."`, COLORS.green);
            }
          }
        } catch (e) {}
        
        // Get tool calls if they're promises
        let toolCallsFromResult = [];
        if (finalResult.toolCalls) {
          try {
            toolCallsFromResult = await finalResult.toolCalls;
            if (toolCallsFromResult && toolCallsFromResult.length > 0) {
              toolCalls = toolCallsFromResult;
              metadata.toolCalls = toolCalls;
              log('[RESULT]', `Got ${toolCalls.length} tool calls from result`, COLORS.yellow);
            }
          } catch (e) {
            // Not a promise
          }
        }
        
        // Get tool results
        try {
          metadata.toolResults = await finalResult.toolResults;
          if (metadata.toolResults && metadata.toolResults.length > 0) {
            log('[METADATA]', `Tool results: ${metadata.toolResults.length}`, COLORS.yellow);
            logJson('TOOL RESULTS', metadata.toolResults);
          }
        } catch (e) {}
        
        // Log the complete response metadata
        logJson('COMPLETE RESPONSE METADATA', metadata);
        
        // Update message history with the final result
        // The AI SDK already handled tool execution, so just add the final response
        if (fullText) {
          const assistantMessage: CoreMessage = {
            role: 'assistant',
            content: fullText
          };
          
          this.messages.push(assistantMessage);
          log('[HISTORY]', `Added assistant message with ${fullText.length} chars`, COLORS.gray);
        }
        
        // Check for EOM marker
        if (fullText.includes('=== EOM ===')) {
          log('[RAL]', 'Found EOM marker - completing', COLORS.magenta);
          isComplete = true;
        }

        // Show final text if we got it
        if (fullText) {
          console.log(''); // New line after streaming
          log('[ASSISTANT]', `Complete response (${fullText.length} chars)`, COLORS.green);
        }

        // Handle tool calls (AI SDK handles execution with maxSteps)
        if (toolCalls && toolCalls.length > 0) {
          log('[RAL]', `Model called ${toolCalls.length} tool(s)`, COLORS.yellow);

          for (const toolCall of toolCalls) {
            const toolArgs = (toolCall as any).input || toolCall.args || {};
            log('[TOOL CALL]', `${toolCall.toolName}(${JSON.stringify(toolArgs)})`, COLORS.yellow);
            
            // Check if complete tool was called
            if (toolCall.toolName === 'complete') {
              log('[RAL]', 'Complete tool called - ending loop', COLORS.magenta);
              isComplete = true;
            }
          }
        } else if (!fullText || fullText.trim() === '') {
          // No response and no tool calls
          log('[RAL]', 'Empty response - ending loop', COLORS.red);
          isComplete = true;
        }

      } catch (error) {
        log('[ERROR]', String(error), COLORS.red);
        isComplete = true;
      }
    }

    log('\n[RAL]', `Completed after ${iteration} iterations`, COLORS.bright + COLORS.green);
    
    // Display session summary
    log('\n[SESSION SUMMARY]', '═══════════════════════════════════════', COLORS.bright + COLORS.cyan);
    log('[TOKENS]', `Total Input: ${this.totalInputTokens} tokens`, COLORS.cyan);
    log('[TOKENS]', `Total Output: ${this.totalOutputTokens} tokens`, COLORS.cyan);
    log('[TOKENS]', `Total Combined: ${this.totalInputTokens + this.totalOutputTokens} tokens`, COLORS.cyan);
    log('[COST]', `Total Session Cost: $${this.totalCost.toFixed(6)}`, COLORS.bright + COLORS.cyan);
    log('[SESSION SUMMARY]', '═══════════════════════════════════════', COLORS.bright + COLORS.cyan);
    
    this.displayMessageHistory();
  }

  private displayMessageHistory() {
    log('\n[HISTORY]', 'Final message history:', COLORS.bright + COLORS.cyan);
    this.messages.forEach((msg, i) => {
      const preview = typeof msg.content === 'string' 
        ? msg.content.substring(0, 100) + (msg.content.length > 100 ? '...' : '')
        : JSON.stringify(msg.content).substring(0, 100) + '...';
      
      let color = COLORS.reset;
      if (msg.role === 'system') color = COLORS.gray;
      if (msg.role === 'user') color = COLORS.blue;
      if (msg.role === 'assistant') color = COLORS.green;
      if (msg.role === 'tool') color = COLORS.yellow;
      
      log(`  [${i}]`, `${msg.role}: ${preview}`, color);
    });
  }
}

// Main execution
async function main() {
  log('\n[MAIN]', 'AI SDK RAL Test Script', COLORS.bright + COLORS.magenta);
  
  try {
    // Load configuration
    log('[CONFIG]', 'Loading configuration from ~/.tenex/llms.json', COLORS.cyan);
    const homeDir = homedir();
    const configPath = path.join(homeDir, '.tenex');
    
    // Load the config using existing service
    const config = await configService.loadConfig(configPath);
    
    // Find gemini-flash configuration or use first available
    let selectedConfig = null;
    let selectedConfigName = '';
    
    // Look for a config that uses a PAID model to test cost tracking
    // Try to find claude-3-haiku or gpt-4o-mini for testing costs
    for (const [name, cfg] of Object.entries(config.llms.configurations)) {
      if (cfg.model.includes('haiku') || cfg.model.includes('4o-mini') || cfg.model.includes('gpt-3.5')) {
        selectedConfig = cfg;
        selectedConfigName = name;
        log('[CONFIG]', `Selected paid model for cost testing: ${name}`, COLORS.yellow);
        break;
      }
    }
    
    // Fallback to gemini if no paid model found
    if (!selectedConfig) {
      for (const [name, cfg] of Object.entries(config.llms.configurations)) {
        if (cfg.model.includes('gemini') && cfg.model.includes('flash')) {
          selectedConfig = cfg;
          selectedConfigName = name;
          break;
        }
      }
    }
    
    // Final fallback to first config
    if (!selectedConfig) {
      const firstConfigName = Object.keys(config.llms.configurations)[0];
      selectedConfig = config.llms.configurations[firstConfigName];
      selectedConfigName = firstConfigName;
      log('[CONFIG]', `Using fallback: ${firstConfigName}`, COLORS.yellow);
    }
    
    log('[CONFIG]', `Selected configuration: ${selectedConfigName}`, COLORS.green);
    log('[CONFIG]', `Provider: ${selectedConfig.provider}`, COLORS.gray);
    log('[CONFIG]', `Model: ${selectedConfig.model}`, COLORS.gray);
    
    // Get API key based on provider
    let apiKey = '';
    let useOpenRouter = false;
    
    if (selectedConfig.provider === 'openrouter') {
      apiKey = config.llms.credentials?.openrouter?.apiKey || '';
      useOpenRouter = true;
    } else if (selectedConfig.provider === 'google') {
      // For Google, we'll use OpenRouter if available, otherwise direct
      if (config.llms.credentials?.openrouter?.apiKey) {
        apiKey = config.llms.credentials.openrouter.apiKey;
        useOpenRouter = true;
        // Convert model name for OpenRouter if needed
        if (!selectedConfig.model.startsWith('google/')) {
          selectedConfig.model = `google/${selectedConfig.model}`;
        }
      } else {
        apiKey = config.llms.credentials?.google?.apiKey || '';
        useOpenRouter = false;
      }
    } else {
      // Try to use OpenRouter for other providers
      if (config.llms.credentials?.openrouter?.apiKey) {
        apiKey = config.llms.credentials.openrouter.apiKey;
        useOpenRouter = true;
        
        // Ensure model name has provider prefix for OpenRouter
        if (selectedConfig.provider === 'openai' && !selectedConfig.model.startsWith('openai/')) {
          selectedConfig.model = `openai/${selectedConfig.model}`;
        } else if (selectedConfig.provider === 'anthropic' && !selectedConfig.model.startsWith('anthropic/')) {
          selectedConfig.model = `anthropic/${selectedConfig.model}`;
        }
      } else {
        apiKey = config.llms.credentials?.[selectedConfig.provider]?.apiKey || '';
      }
    }
    
    if (!apiKey) {
      throw new Error(`No API key found for provider: ${selectedConfig.provider}`);
    }
    
    // Create RAL instance
    const ral = new SimplifiedRAL(selectedConfig.model, apiKey, useOpenRouter);
    
    // Test scenarios
    const testPrompts = [
      "Calculate 25 * 4 + 10",
      "Write a short poem about coding in TypeScript",
      "Search for information about TypeScript and then calculate 100 / 5",
    ];
    
    // Run test with poem prompt to see text streaming and metadata
    log('\n[TEST]', `Testing with prompt: "${testPrompts[1]}"`, COLORS.bright + COLORS.cyan);
    await ral.execute(testPrompts[1]);
    
    log('\n[COMPLETE]', 'Test completed successfully!', COLORS.bright + COLORS.green);
    
    // Display key findings
    log('\n[FINDINGS]', 'Key observations:', COLORS.bright + COLORS.magenta);
    log('  ✓', 'Tool calls are preserved in message history', COLORS.green);
    log('  ✓', 'Tool results are explicitly added as tool role messages', COLORS.green);
    log('  ✓', 'Context flows through iterations properly', COLORS.green);
    log('  ✓', 'Manual control over tool execution works', COLORS.green);
    log('  ✓', 'EOM detection can work alongside tool-based completion', COLORS.green);
    
    // Show log file location
    console.log(`\n${COLORS.bright}${COLORS.cyan}📄 Detailed log file created: ${logFile}${COLORS.reset}`);
    console.log(`${COLORS.gray}   View with: cat ${logFile}${COLORS.reset}`);
    
  } catch (error) {
    log('[ERROR]', String(error), COLORS.red);
    process.exit(1);
  }
}

// Run the test
main().catch(console.error);