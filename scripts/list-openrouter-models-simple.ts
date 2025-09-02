#!/usr/bin/env bun

import { fetchOpenRouterModels } from "../src/llm/providers/openrouter-models";
import chalk from "chalk";

async function listOpenRouterModelsSimple() {
  console.log(chalk.cyan("Fetching OpenRouter models...\n"));
  
  try {
    const models = await fetchOpenRouterModels();
    
    if (models.length === 0) {
      console.log(chalk.red("Failed to fetch models or no models available."));
      return;
    }
    
    console.log(chalk.green(`Found ${models.length} models:\n`));
    
    // Group models by provider
    const modelsByProvider: Record<string, string[]> = {};
    
    for (const model of models) {
      const provider = model.id.split('/')[0] || 'other';
      if (!modelsByProvider[provider]) {
        modelsByProvider[provider] = [];
      }
      modelsByProvider[provider].push(model.id);
    }
    
    // Sort providers alphabetically
    const sortedProviders = Object.keys(modelsByProvider).sort();
    
    // Display model IDs grouped by provider
    for (const provider of sortedProviders) {
      console.log(chalk.bold.yellow(`\n${provider.toUpperCase()}:`));
      const providerModels = modelsByProvider[provider];
      for (const modelId of providerModels) {
        console.log(`  ${modelId}`);
      }
    }
    
    // Also create a simple text file with just the model IDs
    const modelIds = models.map(m => m.id).join('\n');
    await Bun.write("./openrouter-model-ids.txt", modelIds);
    
    console.log(chalk.green(`\n✅ Model IDs saved to openrouter-model-ids.txt`));
    
  } catch (error) {
    console.error(chalk.red("Error fetching models:"), error);
  }
}

// Run the script
listOpenRouterModelsSimple();