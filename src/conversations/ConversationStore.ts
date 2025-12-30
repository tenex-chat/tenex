/**
 * ConversationStore - Single source of truth for conversation state
 *
 * This class manages persistent storage of conversation messages, RAL lifecycle,
 * and message visibility rules. Nostr events hydrate the store, and the store
 * is used to build messages for agent execution.
 *
 * File location: ~/.tenex/projects/{projectId}/conversations/{conversationId}.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { ModelMessage } from "ai";

export interface ConversationEntry {
    pubkey: string;
    ral?: number; // Only for agent messages
    message: ModelMessage;
    eventId?: string; // If published to Nostr
}

export interface Injection {
    targetRal: { pubkey: string; ral: number };
    role: "user" | "system";
    content: string;
    queuedAt: number;
}

interface RalTracker {
    id: number;
}

interface ConversationState {
    activeRal: Record<string, RalTracker[]>;
    nextRalNumber: Record<string, number>;
    injections: Injection[];
    messages: ConversationEntry[];
}

export class ConversationStore {
    private basePath: string;
    private projectId: string | null = null;
    private conversationId: string | null = null;
    private state: ConversationState = {
        activeRal: {},
        nextRalNumber: {},
        injections: [],
        messages: [],
    };
    private eventIdSet: Set<string> = new Set();

    constructor(basePath: string) {
        this.basePath = basePath;
    }

    private getFilePath(): string {
        if (!this.projectId || !this.conversationId) {
            throw new Error("Must call load() before accessing file");
        }
        return join(
            this.basePath,
            "projects",
            this.projectId,
            "conversations",
            `${this.conversationId}.json`
        );
    }

    private ensureDirectory(): void {
        const dir = join(
            this.basePath,
            "projects",
            this.projectId!,
            "conversations"
        );
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    load(projectId: string, conversationId: string): void {
        this.projectId = projectId;
        this.conversationId = conversationId;

        const filePath = this.getFilePath();
        if (existsSync(filePath)) {
            const content = readFileSync(filePath, "utf-8");
            const loaded = JSON.parse(content);
            // Ensure all required fields exist (handle old/corrupt state files)
            this.state = {
                activeRal: loaded.activeRal ?? {},
                nextRalNumber: loaded.nextRalNumber ?? {},
                injections: loaded.injections ?? [],
                messages: loaded.messages ?? [],
            };
            // Rebuild eventId set
            this.eventIdSet = new Set(
                this.state.messages
                    .filter((m) => m.eventId)
                    .map((m) => m.eventId!)
            );
        } else {
            this.state = {
                activeRal: {},
                nextRalNumber: {},
                injections: [],
                messages: [],
            };
            this.eventIdSet = new Set();
        }
    }

    async save(): Promise<void> {
        this.ensureDirectory();
        const filePath = this.getFilePath();
        writeFileSync(filePath, JSON.stringify(this.state, null, 2));
    }

    // RAL Lifecycle

    createRal(agentPubkey: string): number {
        // Get next RAL number
        const nextNum = (this.state.nextRalNumber[agentPubkey] || 0) + 1;
        this.state.nextRalNumber[agentPubkey] = nextNum;

        // Add to active RALs
        if (!this.state.activeRal[agentPubkey]) {
            this.state.activeRal[agentPubkey] = [];
        }
        this.state.activeRal[agentPubkey].push({ id: nextNum });

        return nextNum;
    }

    /**
     * Register an externally-assigned RAL number as active.
     * Use this when the RAL number is managed externally (e.g., by RALRegistry).
     */
    ensureRalActive(agentPubkey: string, ralNumber: number): void {
        if (!this.state.activeRal[agentPubkey]) {
            this.state.activeRal[agentPubkey] = [];
        }

        // Only add if not already active
        if (!this.isRalActive(agentPubkey, ralNumber)) {
            this.state.activeRal[agentPubkey].push({ id: ralNumber });

            // Update nextRalNumber if this number is higher
            const currentNext = this.state.nextRalNumber[agentPubkey] || 0;
            if (ralNumber >= currentNext) {
                this.state.nextRalNumber[agentPubkey] = ralNumber;
            }
        }
    }

    completeRal(agentPubkey: string, ralNumber: number): void {
        const activeRals = this.state.activeRal[agentPubkey];
        if (activeRals) {
            this.state.activeRal[agentPubkey] = activeRals.filter(
                (r) => r.id !== ralNumber
            );
        }
    }

    isRalActive(agentPubkey: string, ralNumber: number): boolean {
        const activeRals = this.state.activeRal[agentPubkey] || [];
        return activeRals.some((r) => r.id === ralNumber);
    }

    getActiveRals(agentPubkey: string): number[] {
        const activeRals = this.state.activeRal[agentPubkey] || [];
        return activeRals.map((r) => r.id);
    }

    // Message Operations

    addMessage(entry: ConversationEntry): void {
        this.state.messages.push(entry);
        if (entry.eventId) {
            this.eventIdSet.add(entry.eventId);
        }
    }

    getAllMessages(): ConversationEntry[] {
        return this.state.messages;
    }

    setEventId(messageIndex: number, eventId: string): void {
        if (messageIndex >= 0 && messageIndex < this.state.messages.length) {
            this.state.messages[messageIndex].eventId = eventId;
            this.eventIdSet.add(eventId);
        }
    }

    hasEventId(eventId: string): boolean {
        return this.eventIdSet.has(eventId);
    }

    // Injection Operations

    addInjection(injection: Injection): void {
        this.state.injections.push(injection);
    }

    getPendingInjections(agentPubkey: string, ralNumber: number): Injection[] {
        return this.state.injections.filter(
            (i) =>
                i.targetRal.pubkey === agentPubkey &&
                i.targetRal.ral === ralNumber
        );
    }

    consumeInjections(agentPubkey: string, ralNumber: number): Injection[] {
        const toConsume = this.getPendingInjections(agentPubkey, ralNumber);

        // Remove from injections
        this.state.injections = this.state.injections.filter(
            (i) =>
                !(
                    i.targetRal.pubkey === agentPubkey &&
                    i.targetRal.ral === ralNumber
                )
        );

        // Add to messages
        for (const injection of toConsume) {
            this.addMessage({
                pubkey: agentPubkey, // Injection appears as coming from the target agent context
                ral: ralNumber,
                message: { role: injection.role, content: injection.content },
            });
        }

        return toConsume;
    }

    // Message Building

    buildMessagesForRal(
        agentPubkey: string,
        ralNumber: number
    ): ModelMessage[] {
        const activeRals = new Set(this.getActiveRals(agentPubkey));
        const result: ModelMessage[] = [];

        // Collect messages from other active RALs for summaries
        const otherActiveRalMessages: Map<number, ConversationEntry[]> =
            new Map();

        for (const entry of this.state.messages) {
            // User messages - include all
            if (!entry.ral) {
                result.push(entry.message);
                continue;
            }

            // Same agent
            if (entry.pubkey === agentPubkey) {
                if (entry.ral === ralNumber) {
                    // Current RAL - include
                    result.push(entry.message);
                } else if (activeRals.has(entry.ral)) {
                    // Other active RAL - collect for summary
                    if (!otherActiveRalMessages.has(entry.ral)) {
                        otherActiveRalMessages.set(entry.ral, []);
                    }
                    otherActiveRalMessages.get(entry.ral)!.push(entry);
                } else {
                    // Completed RAL - include all
                    result.push(entry.message);
                }
            } else {
                // Other agent - include only text outputs
                const textContent = this.extractTextContent(entry.message);
                if (textContent) {
                    result.push({
                        role: "assistant",
                        content: textContent,
                    });
                }
            }
        }

        // Add summaries for other active RALs
        for (const [ral] of otherActiveRalMessages) {
            const summary = this.buildRalSummary(agentPubkey, ral);
            result.push({
                role: "system",
                content: summary,
            });
        }

        return result;
    }

    buildRalSummary(agentPubkey: string, ralNumber: number): string {
        const lines: string[] = [
            `You have another reason-act-loop (#${ralNumber}) executing:`,
            "",
        ];

        for (const entry of this.state.messages) {
            if (entry.pubkey !== agentPubkey || entry.ral !== ralNumber) {
                continue;
            }

            const message = entry.message;
            if (message.role !== "assistant") continue;

            const content = message.content;
            if (typeof content === "string") {
                lines.push(`[text-output] ${content}`);
            } else if (Array.isArray(content)) {
                for (const part of content) {
                    if (part.type === "text") {
                        lines.push(`[text-output] ${part.text}`);
                    } else if (part.type === "tool-call") {
                        const args = this.formatToolArgs((part as any).args || (part as any).input);
                        lines.push(`[tool ${part.toolName}] ${args}`);
                    }
                }
            }
        }

        return lines.join("\n");
    }

    private extractTextContent(message: ModelMessage): string | null {
        if (message.role !== "assistant") return null;

        const content = message.content;
        if (typeof content === "string") {
            return content;
        }

        if (Array.isArray(content)) {
            const textParts = content
                .filter((part): part is { type: "text"; text: string } =>
                    part.type === "text"
                )
                .map((part) => part.text);

            if (textParts.length === 0) return null;
            return textParts.join("");
        }

        return null;
    }

    private formatToolArgs(args: unknown): string {
        if (!args || typeof args !== "object") return "";

        const pairs: string[] = [];
        for (const [key, value] of Object.entries(args)) {
            if (typeof value === "string") {
                pairs.push(`${key}="${value}"`);
            } else {
                pairs.push(`${key}=${JSON.stringify(value)}`);
            }
        }
        return pairs.join(", ");
    }
}
