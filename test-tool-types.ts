import { tool, type Tool } from 'ai';
import { z } from 'zod';

const testSchema = z.object({
  name: z.string(),
  age: z.number().optional(),
});

// This should work
const testTool = tool({
  description: "Test tool",
  parameters: testSchema,
  execute: async (input) => {
    return `Hello ${input.name}`;
  }
});

console.log("Tool created successfully");