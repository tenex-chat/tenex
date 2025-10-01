import { tool } from 'ai';
import { z } from 'zod';
import type { ExecutionContext } from '@/agents/execution/types';
import type { AISdkTool } from '@/tools/registry';

/**
 * Example Dynamic Tool: Calculator
 * 
 * This is a test dynamic tool that performs basic arithmetic operations.
 * It demonstrates how to create a dynamic tool following the template.
 */

// Define the input schema for the calculator
const calculatorSchema = z.object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']).describe('The arithmetic operation to perform'),
    a: z.number().describe('First number'),
    b: z.number().describe('Second number'),
});

// Type for the tool input
type CalculatorInput = z.infer<typeof calculatorSchema>;

/**
 * Factory function to create the calculator tool
 */
const createCalculatorTool = (context: ExecutionContext): AISdkTool => {
    // Create the tool using the AI SDK's tool function
    const aiTool = tool({
        description: 'Performs basic arithmetic operations (add, subtract, multiply, divide)',
        
        inputSchema: calculatorSchema,
        
        execute: async (input: CalculatorInput) => {
            const { operation, a, b } = input;
            let result: number;
            
            switch (operation) {
                case 'add':
                    result = a + b;
                    break;
                case 'subtract':
                    result = a - b;
                    break;
                case 'multiply':
                    result = a * b;
                    break;
                case 'divide':
                    if (b === 0) {
                        throw new Error('Division by zero is not allowed');
                    }
                    result = a / b;
                    break;
                default:
                    throw new Error(`Unknown operation: ${operation}`);
            }
            
            // Log the operation
            console.log(`[${context.agent.name}] Calculator: ${a} ${operation} ${b} = ${result}`);
            
            // Optionally publish status if we have the publisher
            if (context.agentPublisher && context.triggeringEvent) {
                try {
                    const conversation = context.getConversation();
                    if (conversation?.history?.[0]) {
                        await context.agentPublisher.conversation(
                            { content: `🧮 Calculated: ${a} ${operation} ${b} = ${result}` },
                            {
                                triggeringEvent: context.triggeringEvent,
                                rootEvent: conversation.history[0],
                                conversationId: context.conversationId,
                            }
                        );
                    }
                } catch (error) {
                    console.warn('Failed to publish calculator status:', error);
                }
            }
            
            return {
                operation,
                a,
                b,
                result,
                message: `The result of ${a} ${operation} ${b} is ${result}`,
            };
        },
    });
    
    // Add human-readable content generation
    Object.defineProperty(aiTool, 'getHumanReadableContent', {
        value: (input: CalculatorInput) => {
            const symbols: Record<string, string> = {
                add: '+',
                subtract: '-',
                multiply: '×',
                divide: '÷',
            };
            return `Calculating: ${input.a} ${symbols[input.operation]} ${input.b}`;
        },
        enumerable: false,
        configurable: true
    });
    
    return aiTool;
};

// Export the factory function as default
export default createCalculatorTool;