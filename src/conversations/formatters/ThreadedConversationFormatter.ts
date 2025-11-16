import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { MessageFormatter } from "./utils/MessageFormatter";
import { TimestampFormatter } from "./utils/TimestampFormatter";
import { TreeBuilder } from "./utils/TreeBuilder";
import { TreeRenderer } from "./utils/TreeRenderer";

export interface ThreadNode {
    event: NDKEvent;
    agent?: string; // Agent name/identifier
    timestamp: Date;
    content: string;
    toolCall?: {
        name: string;
        args?: string;
    };
    children: ThreadNode[];
    depth: number;
}

export interface FormatterOptions {
    includeTimestamps: boolean;
    timestampFormat: "relative" | "absolute" | "time-only";
    maxDepth?: number;
    includeToolCalls: boolean;
    treeStyle: "ascii" | "unicode" | "markdown";
    compactMode: boolean; // Single-line per message
    currentAgentPubkey?: string; // The agent we're formatting for (to show "you")
}

export class ThreadedConversationFormatter {
    private treeBuilder: TreeBuilder;
    private messageFormatter: MessageFormatter;
    private timestampFormatter: TimestampFormatter;
    private treeRenderer: TreeRenderer;

    constructor() {
        this.treeBuilder = new TreeBuilder();
        this.messageFormatter = new MessageFormatter();
        this.timestampFormatter = new TimestampFormatter();
        this.treeRenderer = new TreeRenderer();
    }

    /**
     * Build tree structure from flat event list
     */
    async buildThreadTree(events: NDKEvent[]): Promise<ThreadNode[]> {
        return this.treeBuilder.buildFromEvents(events);
    }

    /**
     * Format single thread as ASCII/Unicode tree
     */
    formatThread(root: ThreadNode, options?: FormatterOptions): string {
        const opts = this.getDefaultOptions(options);
        return this.renderNode(root, opts, "", true);
    }

    /**
     * Extract agent-specific participation branches
     */
    extractAgentBranches(tree: ThreadNode[], agentPubkey: string): ThreadNode[] {
        const relevantNodes: ThreadNode[] = [];

        for (const root of tree) {
            const extractedBranch = this.extractRelevantBranch(root, agentPubkey);
            if (extractedBranch) {
                relevantNodes.push(extractedBranch);
            }
        }

        return relevantNodes;
    }

    /**
     * Format branches where the agent participated, excluding the active branch
     * This is the main entry point for getting "other threads" context
     */
    public async formatOtherBranches(
        allEvents: NDKEvent[],
        agentPubkey: string,
        activeBranchIds: Set<string>
    ): Promise<string | null> {
        // 1. Build complete conversation tree from all events
        const completeTree = await this.buildThreadTree(allEvents);

        // 2. Prune the active branch from the tree
        const prunedTree = this.pruneBranch(completeTree, activeBranchIds);

        // 3. Extract branches where agent participated from the pruned tree
        const agentBranches = this.extractRelevantBranches(prunedTree, agentPubkey);

        // 4. If no relevant branches found, return null
        if (agentBranches.length === 0) {
            return null;
        }

        // 5. Format the branches into a string
        const options: FormatterOptions = {
            includeTimestamps: true,
            timestampFormat: "time-only",
            includeToolCalls: true,
            treeStyle: "ascii",
            compactMode: true,
            currentAgentPubkey: agentPubkey, // Pass the agent we're formatting for
        };

        const result: string[] = [];
        for (let i = 0; i < agentBranches.length; i++) {
            if (i > 0) {
                result.push("\n" + "─".repeat(60) + "\n");
            }
            result.push(this.formatThread(agentBranches[i], options));
        }

        return result.join("\n");
    }

    /**
     * Remove all nodes that are part of the active branch
     * Returns a new tree with the active branch pruned out
     */
    private pruneBranch(tree: ThreadNode[], activeBranchIds: Set<string>): ThreadNode[] {
        const prunedRoots: ThreadNode[] = [];

        for (const root of tree) {
            const prunedNode = this.pruneNode(root, activeBranchIds);
            if (prunedNode) {
                prunedRoots.push(prunedNode);
            }
        }

        return prunedRoots;
    }

    /**
     * Recursively prune a node and its children
     * Returns null if the entire subtree should be removed
     */
    private pruneNode(node: ThreadNode, activeBranchIds: Set<string>): ThreadNode | null {
        // If this node is in the active branch
        if (activeBranchIds.has(node.event.id)) {
            // Check if ANY child is NOT in the active branch
            // If so, we need to keep this node but prune only active children
            const hasNonActiveBranches = node.children.some(
                (child) => !this.isEntireBranchActive(child, activeBranchIds)
            );

            if (hasNonActiveBranches) {
                // Keep this node but prune children selectively
                const prunedChildren: ThreadNode[] = [];
                for (const child of node.children) {
                    const prunedChild = this.pruneNode(child, activeBranchIds);
                    if (prunedChild) {
                        prunedChildren.push(prunedChild);
                    }
                }

                // Return the node with only non-active children
                return {
                    ...node,
                    children: prunedChildren,
                };
            } else {
                // This node and ALL its descendants are in the active branch
                return null;
            }
        }

        // Node is not in active branch - keep it and recursively prune children
        const prunedChildren: ThreadNode[] = [];
        for (const child of node.children) {
            const prunedChild = this.pruneNode(child, activeBranchIds);
            if (prunedChild) {
                prunedChildren.push(prunedChild);
            }
        }

        // Return the node with pruned children
        return {
            ...node,
            children: prunedChildren,
        };
    }

    /**
     * Check if an entire branch (node and all descendants) is in the active branch
     */
    private isEntireBranchActive(node: ThreadNode, activeBranchIds: Set<string>): boolean {
        if (!activeBranchIds.has(node.event.id)) {
            return false;
        }

        // Check all children recursively
        for (const child of node.children) {
            if (!this.isEntireBranchActive(child, activeBranchIds)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Extract branches where the agent participated (similar to extractAgentBranches)
     * but works on already pruned tree
     */
    private extractRelevantBranches(tree: ThreadNode[], agentPubkey: string): ThreadNode[] {
        const relevantNodes: ThreadNode[] = [];

        for (const root of tree) {
            const extractedBranch = this.extractRelevantBranch(root, agentPubkey);
            if (extractedBranch) {
                relevantNodes.push(extractedBranch);
            }
        }

        return relevantNodes;
    }

    private extractRelevantBranch(node: ThreadNode, agentPubkey: string): ThreadNode | null {
        // Check if this node or any descendant involves the agent
        const involvedInBranch = this.isAgentInvolvedInBranch(node, agentPubkey);

        if (!involvedInBranch) {
            return null;
        }

        // If agent is involved in this branch, return the ENTIRE branch with all descendants
        // This preserves full context of conversations the agent participated in
        return this.cloneNode(node);
    }

    private cloneNode(node: ThreadNode): ThreadNode {
        return {
            ...node,
            children: node.children.map((child) => this.cloneNode(child)),
        };
    }

    private isAgentInvolvedInBranch(node: ThreadNode, agentPubkey: string): boolean {
        // Check if this node is from the agent
        if (node.event.pubkey === agentPubkey) {
            return true;
        }

        // Check if any child branch has agent involvement
        for (const child of node.children) {
            if (this.isAgentInvolvedInBranch(child, agentPubkey)) {
                return true;
            }
        }

        return false;
    }

    private renderNode(
        node: ThreadNode,
        options: FormatterOptions,
        prefix: string,
        isLast: boolean
    ): string {
        const lines: string[] = [];

        // Format the current node
        const message = this.messageFormatter.format(node, options);
        const timestamp = options.includeTimestamps
            ? this.timestampFormatter.format(node.timestamp, options.timestampFormat)
            : "";

        // Add "(you)" if this is the current agent
        let agentName = node.agent || "Unknown";
        if (options.currentAgentPubkey && node.event.pubkey === options.currentAgentPubkey) {
            agentName = `${agentName} (you)`;
        }

        const connector = this.treeRenderer.getConnector(options.treeStyle, isLast);

        // Handle multi-line messages by joining with ⏎ separator
        const inlineMessage = message.replace(/\n/g, " ⏎ ");
        lines.push(`${prefix}${connector}${agentName}${timestamp}: ${inlineMessage}`);

        // Render children with appropriate prefixes
        const childPrefix = prefix + this.treeRenderer.getChildPrefix(options.treeStyle, isLast);
        if (node.children.length > 0 && (!options.maxDepth || node.depth < options.maxDepth)) {
            for (const [index, child] of node.children.entries()) {
                const isLastChild = index === node.children.length - 1;
                lines.push(this.renderNode(child, options, childPrefix, isLastChild));
            }
        }

        return lines.join("\n");
    }

    private getDefaultOptions(options?: Partial<FormatterOptions>): FormatterOptions {
        return {
            includeTimestamps: true,
            timestampFormat: "time-only",
            includeToolCalls: true,
            treeStyle: "ascii",
            compactMode: true,
            ...options,
        };
    }
}
