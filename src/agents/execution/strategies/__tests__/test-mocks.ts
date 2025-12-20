import { mock } from "bun:test";

// Mock toolMessageStorage - returns null to test reconstruction fallback
mock.module("@/conversations/persistence/ToolMessageStorage", () => ({
    toolMessageStorage: {
        load: mock((eventId: string) => {
            console.log("[MOCK] toolMessageStorage.load called with:", eventId);
            return Promise.resolve(null);
        }),
        store: mock(() => Promise.resolve()),
    },
}));

// Create shared mock pubkey service instance
const mockPubkeyServiceInstance = {
    getName: mock((pubkey: string) => {
        // Map test pubkeys to readable names
        const nameMap: Record<string, string> = {
            // Common test users
            "user-pubkey-123": "User",
            "user-pubkey-test-789": "User",

            // Test agents
            "agent-a-pubkey-456": "Agent A",
            "agent-b-pubkey-789": "Agent B",
            "claude-code-pubkey-test-123": "Claude Code",
            "project-manager-pubkey-test-123": "Project Manager",
            "nostr-expert-pubkey-test-456": "Nostr Expert",

            // Real-looking test pubkeys
            "68e415c353760d3cbb9b3c3f52627e54307b87f8eefb6dc4f533b1a010442f43": "Project Manager",
            "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7": "Claude Code",
            "b22bfe6faddb0f8aa4f24ea3827fd7610007f6d27cbc4c1fea1ff7404ee5a2e9": "User",

            // Mock scenarios test pubkeys
            "user-pubkey-456": "User",
            "alice-pubkey-456": "Alice",
            "bob-pubkey-789": "Bob",
            "project-manager-pubkey-abc": "Project Manager",
        };
        return nameMap[pubkey] || pubkey.slice(0, 8);
    }),
    getUserProfile: mock(() => null),
};

// Mock the PubkeyService to avoid NDK initialization issues in tests
mock.module("@/services/PubkeyService", () => ({
    PubkeyService: {
        getInstance: () => mockPubkeyServiceInstance,
    },
    getPubkeyService: () => mockPubkeyServiceInstance,
}));

// Mock NDK client to prevent initialization warnings
mock.module("@/nostr/ndkClient", () => ({
    initNDK: mock(() => Promise.resolve()),
    getNDK: mock(() => ({
        fetchEvent: mock(() => null),
        fetchEvents: mock(() => new Set()),
    })),
}));