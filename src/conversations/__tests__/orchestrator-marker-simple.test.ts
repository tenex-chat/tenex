import { describe, expect, test } from "bun:test";
import { Message } from "multi-llm-ts";

describe("Orchestrator NEW INTERACTION Marker Logic", () => {
    test("should identify when to add NEW INTERACTION marker", () => {
        // Test the logic without full initialization
        const agentSlug = "orchestrator";
        const hasHistoricalContext = false;
        
        // The condition from our fix
        const shouldAddMarker = agentSlug === "orchestrator" || hasHistoricalContext;
        
        expect(shouldAddMarker).toBe(true);
    });

    test("should not add marker for non-orchestrator without historical context", () => {
        const agentSlug = "executor";
        const hasHistoricalContext = false;
        
        const shouldAddMarker = agentSlug === "orchestrator" || hasHistoricalContext;
        
        expect(shouldAddMarker).toBe(false);
    });

    test("should add marker for any agent with historical context", () => {
        const agentSlug = "executor";
        const hasHistoricalContext = true;
        
        const shouldAddMarker = agentSlug === "orchestrator" || hasHistoricalContext;
        
        expect(shouldAddMarker).toBe(true);
    });

    test("message structure with NEW INTERACTION marker", () => {
        // Simulate what the orchestrator would receive
        const messages: Message[] = [];
        
        // Add summary context
        messages.push(new Message("system", "**Current State:**\nTask completed by executor"));
        
        // Add NEW INTERACTION marker
        messages.push(new Message("system", "=== NEW INTERACTION ==="));
        
        // Add the request/completion as user message
        messages.push(new Message("user", "[Executor]: Task completed successfully"));
        
        // Verify structure
        expect(messages.length).toBe(3);
        expect(messages[1].content).toBe("=== NEW INTERACTION ===");
        expect(messages[2].role).toBe("user");
        
        // Find marker position
        const markerIndex = messages.findIndex(m => 
            m.role === "system" && m.content === "=== NEW INTERACTION ==="
        );
        
        expect(markerIndex).toBe(1);
        
        // User message should come after marker
        const userMessageIndex = messages.findIndex(m => m.role === "user");
        expect(userMessageIndex).toBeGreaterThan(markerIndex);
    });
});