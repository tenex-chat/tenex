// Common utility functions for agent prompts

export function buildAgentIdentity(name: string, role?: string): string {
    const parts = ["# Your Identity\n", `Your name: ${name}`];
    if (role) parts.push(`Your role: ${role}`);
    parts.push("");

    return parts.join("\n");
}

export function buildAgentPrompt(args: {
    name: string;
    role?: string;
    instructions: string;
    projectName?: string;
}): string {
    const parts: string[] = [];

    // Identity
    parts.push(buildAgentIdentity(args.name, args.role));

    // Instructions
    if (args.instructions) {
        parts.push(`## Your Instructions\n${args.instructions}`);
    }

    // Project context
    if (args.projectName) {
        parts.push(`## Project Context\n- Project Name: "${args.projectName}"`);
    }

    return parts.join("\n\n");
}
