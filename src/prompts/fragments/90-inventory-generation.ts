import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

// Helper function to convert git status codes to descriptions
function getStatusDescription(status: string): string {
  if (status.includes("M")) return "modified";
  if (status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  if (status.includes("R")) return "renamed";
  if (status === "??") return "untracked";
  return status;
}

interface InventoryGenerationArgs {
  repomixContent: string;
  focusFiles?: Array<{ path: string; status: string }>;
}

export const mainInventoryPromptFragment: PromptFragment<InventoryGenerationArgs> = {
  id: "main-inventory-generation",
  priority: 10,
  template: ({ repomixContent, focusFiles }) => {
    const focusSection = focusFiles?.length
      ? `
## Recently Modified Files
The following files were recently modified and should receive special attention in your analysis:
${focusFiles.map((f) => `- ${f.path} (${getStatusDescription(f.status)})`).join("\n")}

Please ensure these areas are accurately reflected in the inventory.
`
      : "";

    return `You are analyzing a codebase to create a comprehensive inventory.${focusSection}

Here is the complete repository content in XML format from repomix:

<repository>
${repomixContent}
</repository>

Please generate a comprehensive inventory in markdown format that includes:

1. **Project Overview**
   - Brief description of what the project does
   - Main technologies and frameworks used
   - Architecture style (if identifiable)

2. **Directory Structure**
   - High-level directory breakdown with purpose of each
   - Key organizational patterns

3. **Significant Files**
   - List of important files with one-line value propositions
   - Focus on entry points, core business logic, configurations
   - Include file paths and brief descriptions

4. **Architectural Insights**
   - Key patterns used in the codebase
   - Data flow and integration points
   - Notable design decisions

5. **High-Complexity Modules** (if any)
   - Identify modules/components that are particularly complex
   - For each complex module, provide: name, file path, reason for complexity

At the end, if you identified any high-complexity modules, provide them in this JSON format:
\`\`\`json
{
  "complexModules": [
    {
      "name": "Module Name",
      "path": "src/path/to/module",
      "reason": "Brief explanation of complexity",
      "suggestedFilename": "MODULE_NAME_GUIDE.md"
    }
  ]
}
\`\`\`

Make the inventory comprehensive but readable, focusing on helping developers quickly understand the codebase structure and purpose.`;
  },
  validateArgs: (args): args is InventoryGenerationArgs => {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as InventoryGenerationArgs).repomixContent === "string"
    );
  },
};

interface ModuleGuideArgs {
  repomixContent: string;
  moduleName: string;
  modulePath: string;
  complexityReason: string;
}

export const moduleGuidePromptFragment: PromptFragment<ModuleGuideArgs> = {
  id: "module-guide-generation",
  priority: 10,
  template: ({ repomixContent, moduleName, modulePath, complexityReason }) => {
    return `You are analyzing a specific complex module in a codebase. Here is the complete repository content in XML format from repomix:

<repository>
${repomixContent}
</repository>

Focus specifically on the module: **${moduleName}** at path: \`${modulePath}\`

This module was identified as complex because: ${complexityReason}

Please generate a comprehensive technical documentation for this module that includes:

1. **Module Overview**
   - Purpose and responsibilities
   - Key interfaces and entry points
   - Dependencies and relationships

2. **Technical Architecture**
   - Internal structure and organization
   - Key classes/functions and their roles
   - Data flow within the module

3. **Implementation Details**
   - Core algorithms or business logic
   - Important patterns or design decisions
   - Configuration and customization points

4. **Integration Points**
   - How other parts of the system interact with this module
   - External dependencies
   - Event flows or communication patterns

5. **Usage Guide**
   - How to properly use this module
   - Example use cases
   - Common patterns and best practices

Focus on documenting how the module works at both a high-level conceptual understanding and detailed technical level. Keep the documentation accessible to developers who need to understand, use, or modify this module.`;
  },
  validateArgs: (args): args is ModuleGuideArgs => {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as ModuleGuideArgs).repomixContent === "string" &&
      typeof (args as ModuleGuideArgs).moduleName === "string" &&
      typeof (args as ModuleGuideArgs).modulePath === "string" &&
      typeof (args as ModuleGuideArgs).complexityReason === "string"
    );
  },
};

interface ComplexModulesExtractionArgs {
  content: string;
}

export const complexModulesExtractionFragment: PromptFragment<ComplexModulesExtractionArgs> = {
  id: "complex-modules-extraction",
  priority: 10,
  template: ({ content }) => {
    return `Extract only the valid JSON array of complex modules from the following text and nothing else. If no JSON is present or no complex modules are mentioned, return an empty array [].

Response format should be exactly:
\`\`\`json
{
  "complexModules": [
    {
      "name": "Module Name", 
      "path": "src/path/to/module",
      "reason": "Brief explanation",
      "suggestedFilename": "MODULE_NAME_GUIDE.md"
    }
  ]
}
\`\`\`

Text to analyze:
${content}`;
  },
  validateArgs: (args): args is ComplexModulesExtractionArgs => {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as ComplexModulesExtractionArgs).content === "string"
    );
  },
};

// Register fragments
fragmentRegistry.register(mainInventoryPromptFragment);
fragmentRegistry.register(moduleGuidePromptFragment);
fragmentRegistry.register(complexModulesExtractionFragment);
