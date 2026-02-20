import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * RAG collections attribution fragment - shows agents which RAG collections
 * they have contributed to and their document counts.
 *
 * This fragment leverages the provenance tracking metadata (agent_pubkey)
 * added during document ingestion to surface personalized collection stats.
 */
interface RAGCollectionStats {
    name: string;
    agentDocCount: number;
    totalDocCount: number;
}

interface RAGCollectionsArgs {
    /** The agent's public key for filtering contributions */
    agentPubkey: string;
    /** Pre-fetched collection statistics (avoids async in template) */
    collections: RAGCollectionStats[];
}

export const ragCollectionsFragment: PromptFragment<RAGCollectionsArgs> = {
    id: "rag-collections",
    priority: 29, // After agent-directed-monitoring (28), before worktree-context (30)
    template: ({ collections }) => {
        // Filter to only collections where the agent has contributions
        const agentCollections = collections.filter((c) => c.agentDocCount > 0);

        if (agentCollections.length === 0) {
            return ""; // No RAG contributions - omit section entirely
        }

        const parts: string[] = [];
        parts.push("## Your RAG Collections\n");
        parts.push("Collections you've contributed to:");

        for (const collection of agentCollections) {
            parts.push(
                `- \`${collection.name}\` — ${collection.agentDocCount} docs by you (${collection.totalDocCount} total)`
            );
        }

        return parts.join("\n");
    },
    expectedArgs: "{ agentPubkey: string, collections: RAGCollectionStats[] }",
};

// Register the fragment
fragmentRegistry.register(ragCollectionsFragment);
