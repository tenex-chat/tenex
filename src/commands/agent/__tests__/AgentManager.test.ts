import { describe, expect, it } from "vitest";
import {
    findDuplicateSlugGroups,
    formatManagedAgentLabel,
    formatManagedAgentListLine,
    formatProjects,
    getAgentListHeight,
    getVisibleWindow,
    pickMergeSurvivor,
} from "@/commands/agent/AgentManager";
import type { StoredAgent } from "@/agents/AgentStorage";

function createAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
    return {
        nsec: "nsec1test",
        slug: "builder",
        name: "Builder",
        role: "engineer",
        status: "active",
        ...overrides,
    };
}

describe("AgentManager helpers", () => {
    it("formats empty project memberships explicitly", () => {
        expect(formatProjects([])).toBe("none");
    });

    it("formats the agent list label with memberships and status", () => {
        const label = formatManagedAgentLabel({
            storedAgent: createAgent({ status: "inactive", eventId: "abcdef1234567890" }),
            pubkey: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            projects: ["proj-a", "proj-b"],
        });

        expect(label).toContain("builder");
        expect(label).toContain("projects: proj-a, proj-b");
        expect(label).not.toContain("Builder");
        expect(label).not.toContain("4199:");
        expect(label).not.toContain("pubkey:");
    });

    it("formats a compact one-line entry for the main list", () => {
        const line = formatManagedAgentListLine({
            storedAgent: createAgent({ eventId: "abcdef1234567890" }),
            pubkey: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            projects: ["proj-a", "proj-b"],
        });

        expect(line).toContain("builder");
        expect(line).toContain("projects: proj-a, proj-b");
        expect(line).not.toContain("Builder");
        expect(line).not.toContain("4199:");
    });

    it("centers the visible window around the active item when possible", () => {
        expect(getVisibleWindow(7, 20, 10)).toEqual({ start: 2, end: 12 });
    });

    it("pins the visible window to the end of the list near the bottom", () => {
        expect(getVisibleWindow(19, 20, 10)).toEqual({ start: 10, end: 20 });
    });

    it("uses a 24-line fallback when terminal height is unavailable", () => {
        const originalRows = process.stdout.rows;
        Object.defineProperty(process.stdout, "rows", {
            configurable: true,
            value: undefined,
        });

        try {
            expect(getAgentListHeight()).toBe(24);
        } finally {
            Object.defineProperty(process.stdout, "rows", {
                configurable: true,
                value: originalRows,
            });
        }
    });

    it("formats merged project sets without duplicates", () => {
        const merged = Array.from(new Set([
            ...["proj-a", "proj-b"],
            ...["proj-b", "proj-c"],
        ]));

        expect(formatProjects(merged)).toBe("proj-a, proj-b, proj-c");
    });

    it("picks the merge survivor with the most projects", () => {
        const survivor = pickMergeSurvivor([
            {
                storedAgent: createAgent({ slug: "dup-a" }),
                pubkey: "a",
                projects: ["proj-a"],
            },
            {
                storedAgent: createAgent({ slug: "dup-b" }),
                pubkey: "b",
                projects: ["proj-a", "proj-b", "proj-c"],
            },
        ]);

        expect(survivor.pubkey).toBe("b");
    });

    it("finds duplicate slug groups on load", () => {
        const groups = findDuplicateSlugGroups([
            {
                storedAgent: createAgent({ slug: "same" }),
                pubkey: "a",
                projects: ["proj-a"],
            },
            {
                storedAgent: createAgent({ slug: "same" }),
                pubkey: "b",
                projects: ["proj-b"],
            },
            {
                storedAgent: createAgent({ slug: "other" }),
                pubkey: "c",
                projects: ["proj-c"],
            },
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]?.map((entry) => entry.pubkey)).toEqual(["a", "b"]);
    });
});
