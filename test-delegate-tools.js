const { getDefaultToolsForAgent } = require('./dist/agents/constants.js');

// Test different agent types
const agents = [
    { name: "Orchestrator", isOrchestrator: true, isBuiltIn: true, slug: "orchestrator" },
    { name: "Executor", isOrchestrator: false, isBuiltIn: true, slug: "executor" },
    { name: "Planner", isOrchestrator: false, isBuiltIn: true, slug: "planner" },
    { name: "Project Manager", isOrchestrator: false, isBuiltIn: true, slug: "project-manager" },
    { name: "Custom Agent", isOrchestrator: false, isBuiltIn: false, slug: "custom-agent" }
];

console.log("Agent Tool Configuration Test:\n");
console.log("=".repeat(50));

agents.forEach(agent => {
    const tools = getDefaultToolsForAgent(agent);
    const hasDelegate = tools.includes("delegate");
    
    console.log(`\n${agent.name} (${agent.slug}):`);
    console.log(`  Has delegate tool: ${hasDelegate ? '✅ YES' : '❌ NO'}`);
    console.log(`  Total tools: ${tools.length}`);
    if (tools.length > 0) {
        console.log(`  Tools: ${tools.join(', ')}`);
    }
});

console.log("\n" + "=".repeat(50));
console.log("\n✅ Summary: Only project-manager should have delegate tool");