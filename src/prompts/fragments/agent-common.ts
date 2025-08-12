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
    projectTitle: string;
    projectOwnerPubkey: string;
}): string {
  const parts: string[] = [];

  // Identity
  parts.push(buildAgentIdentity(args.name, args.role));

  // Instructions
  if (args.instructions) {
    parts.push(`## Your Instructions\n${args.instructions}`);
  }

  // Project context
  parts.push(
    [
      "## Project Context",
      `- Title: "${args.projectTitle}"`,
      `- Owner pubkey: "${args.projectOwnerPubkey}"`,
    ].join("\n")
  );

  return parts.join("\n\n");
}
