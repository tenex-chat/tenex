import { describe, expect, it } from "bun:test";
import { loadAllSkillTools } from "../SkillToolLoader";
import type { SkillData } from "../types";
import type { ToolExecutionContext } from "@/tools/types";

function createBuiltInSkill(identifier: string): SkillData {
    return {
        identifier,
        content: "",
        installedFiles: [],
        localDir: `/tmp/copied-tenex-skills/built-in/${identifier}`,
        scope: "built-in",
    };
}

function createToolContext(): ToolExecutionContext {
    return {
        agent: {
            name: "Explorer",
            pubkey: "a".repeat(64),
            slug: "explore-agent",
            category: "worker",
            llmConfig: "mock-model",
            tools: [],
        },
        conversationId: "conversation-id",
        projectBasePath: "/tmp/project",
        workingDirectory: "/tmp/project",
        currentBranch: "main",
        triggeringEnvelope: { transport: "nostr" },
        getConversation: () => undefined,
        agentPublisher: {},
        ralNumber: 1,
        projectContext: {},
    } as ToolExecutionContext;
}

describe("SkillToolLoader", () => {
    it("loads built-in skill tools from bundled source instead of copied skill files", async () => {
        const tools = await loadAllSkillTools(
            [
                createBuiltInSkill("read-access"),
                createBuiltInSkill("shell"),
            ],
            createToolContext()
        );

        expect(Object.keys(tools).sort()).toEqual([
            "fs_glob",
            "fs_grep",
            "fs_read",
            "schedule_task",
            "shell",
        ]);
    });
});
