#!/usr/bin/env bun

import { fetchOpenRouterModels } from "../src/llm/providers/openrouter-models";
import chalk from "chalk";

async function listOpenRouterModels() {
  console.log(chalk.cyan("Fetching OpenRouter models...\n"));
  
  try {
    const models = await fetchOpenRouterModels();
    
    if (models.length === 0) {
      console.log(chalk.red("Failed to fetch models or no models available."));
      return;
    }
    
    console.log(chalk.green(`Found ${models.length} models:\n`));
    
    // Group models by provider
    const modelsByProvider: Record<string, typeof models> = {};
    
    for (const model of models) {
      // Extract provider from model ID (e.g., "openai/gpt-4" -> "openai")
      const provider = model.id.split('/')[0] || 'other';
      if (!modelsByProvider[provider]) {
        modelsByProvider[provider] = [];
      }
      modelsByProvider[provider].push(model);
    }
    
    // Sort providers alphabetically
    const sortedProviders = Object.keys(modelsByProvider).sort();
    
    // Display models grouped by provider
    for (const provider of sortedProviders) {
      console.log(chalk.bold.yellow(`\n=== ${provider.toUpperCase()} ===`));
      
      const providerModels = modelsByProvider[provider];
      for (const model of providerModels) {
        const pricing = `$${model.pricing.prompt}/$${model.pricing.completion} per 1M tokens`;
        const context = `${(model.context_length / 1000).toFixed(0)}k context`;
        
        console.log(chalk.white(`  ${model.id}`));
        console.log(chalk.gray(`    ${model.name}`));
        console.log(chalk.dim(`    ${context}, ${pricing}`));
        
        if (model.description) {
          // Truncate long descriptions
          const desc = model.description.length > 80 
            ? model.description.substring(0, 77) + "..." 
            : model.description;
          console.log(chalk.dim(`    ${desc}`));
        }
        console.log();
      }
    }
    
    // Also save to a file for reference
    const output = {
      timestamp: new Date().toISOString(),
      count: models.length,
      models: models.map(m => ({
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        pricing: m.pricing
      }))
    };
    
    await Bun.write(
      "./openrouter-models.json", 
      JSON.stringify(output, null, 2)
    );
    
    console.log(chalk.green(`\n✅ Full model list saved to openrouter-models.json`));
    
  } catch (error) {
    console.error(chalk.red("Error fetching models:"), error);
  }
}

// Run the script
listOpenRouterModels();