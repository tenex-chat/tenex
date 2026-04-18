import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as agentStorageModule from "@/agents/AgentStorage";
import * as projectServices from "@/services/projects";
import type { ToolExecutionContext } from "@/tools/types";
import { z } from "zod";
import { createModifyProjectTool } from "../modify_project";

const OWNER_PUBKEY = "a".repeat(64);
const PROJECT_DTAG = "TENEX-ff3ssq";
const CLAUDE_PUBKEY = "b".repeat(64);
const BUILDER_PUBKEY = "c".repeat(64);

const mockGetAgentBySlug = mock();
const mockDerivePubkey = mock();
const mockPublishMutation = mock();

function createMockContext(): ToolExecutionContext {
    return {
        agent: {
            name: "pm",
            slug: "pm",
            pubkey: OWNER_PUBKEY,
            llmConfig: "claude",
            tools: [],
        } as never,
        conversationId: "conversation-1",
        projectBasePath: "/tmp/project",
        workingDirectory: "/tmp/project",
        currentBranch: "main",
        triggeringEnvelope: { transport: "nostr" } as never,
        getConversation: () => undefined,
        agentPublisher: {} as never,
        ralNumber: 1,
        projectContext: {
            project: {
                dTag: PROJECT_DTAG,
                pubkey: OWNER_PUBKEY,
                tagValue: mock((tag: string) => (tag === "d" ? PROJECT_DTAG : undefined)),
            },
        } as never,
    };
}

const toolCallOpts = (id: string) => ({
    toolCallId: id,
    messages: [],
    abortSignal: undefined as never,
});

describe("modify_project tool", () => {
    let getAgentBySlugSpy: ReturnType<typeof spyOn>;
    let derivePubkeySpy: ReturnType<typeof spyOn>;
    let publishMutationSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        mockGetAgentBySlug.mockReset();
        mockDerivePubkey.mockReset();
        mockPublishMutation.mockReset();

        getAgentBySlugSpy = spyOn(agentStorageModule.agentStorage, "getAgentBySlug")
            .mockImplementation(mockGetAgentBySlug as never);
        derivePubkeySpy = spyOn(agentStorageModule, "deriveAgentPubkeyFromNsec")
            .mockImplementation(mockDerivePubkey as never);
        publishMutationSpy = spyOn(projectServices.projectEventPublishService, "publishMutation")
            .mockImplementation(mockPublishMutation as never);
    });

    afterEach(() => {
        getAgentBySlugSpy?.mockRestore();
        derivePubkeySpy?.mockRestore();
        publishMutationSpy?.mockRestore();
        mock.restore();
    });

    it("resolves add/remove identifiers and delegates the canonical mutation payload", async () => {
        mockGetAgentBySlug.mockImplementation(async (slug: string) => {
            if (slug === "claude-code") return { nsec: "nsec-claude" };
            if (slug === "builder") return { nsec: "nsec-builder" };
            return null;
        });
        mockDerivePubkey.mockImplementation((nsec: string) => {
            if (nsec === "nsec-claude") return CLAUDE_PUBKEY;
            if (nsec === "nsec-builder") return BUILDER_PUBKEY;
            return "";
        });
        mockPublishMutation.mockResolvedValue({
            projectDTag: PROJECT_DTAG,
            outcome: "published",
            eventId: "event-123",
            addedPubkeys: [CLAUDE_PUBKEY],
            removedPubkeys: [BUILDER_PUBKEY],
            updatedFields: ["title", "repo"],
            skipped: [],
        });

        const toolDef = createModifyProjectTool(createMockContext());
        const result = await toolDef.execute({
            add_agents: ["claude-code"],
            remove_agents: ["builder"],
            set: {
                title: "my project",
                repo: "https://repo.example",
            },
        }, toolCallOpts("tc-modify-project-success"));

        expect(mockPublishMutation).toHaveBeenCalledWith({
            ownerPubkey: OWNER_PUBKEY,
            projectDTag: PROJECT_DTAG,
            trigger: "modify_project_31933",
            addAgentPubkeys: [CLAUDE_PUBKEY],
            removeAgentPubkeys: [BUILDER_PUBKEY],
            set: {
                title: "my project",
                repo: "https://repo.example",
            },
        });
        expect(result).toEqual({
            success: true,
            projectDTag: PROJECT_DTAG,
            publishedEventId: "event-123",
            addedPubkeys: [CLAUDE_PUBKEY],
            removedPubkeys: [BUILDER_PUBKEY],
            updatedFields: ["title", "repo"],
            skipped: [],
        });
    });

    it("rejects empty mutations without publishing", async () => {
        const toolDef = createModifyProjectTool(createMockContext());
        const result = await toolDef.execute({}, toolCallOpts("tc-modify-project-empty"));

        expect(result.success).toBe(false);
        expect(result.error).toContain("requires at least one");
        expect(mockPublishMutation).not.toHaveBeenCalled();
    });

    it("rejects unresolved add slugs before publishing", async () => {
        mockGetAgentBySlug.mockResolvedValue(null);

        const toolDef = createModifyProjectTool(createMockContext());
        const result = await toolDef.execute({
            add_agents: ["missing-agent"],
        }, toolCallOpts("tc-modify-project-missing"));

        expect(result.success).toBe(false);
        expect(result.error).toContain("missing-agent");
        expect(mockPublishMutation).not.toHaveBeenCalled();
    });

    it("rejects conflicting add/remove mutations after slug resolution", async () => {
        mockGetAgentBySlug.mockResolvedValue({ nsec: "same-nsec" });
        mockDerivePubkey.mockReturnValue(CLAUDE_PUBKEY);

        const toolDef = createModifyProjectTool(createMockContext());
        const result = await toolDef.execute({
            add_agents: ["claude-code"],
            remove_agents: ["claude-code"],
        }, toolCallOpts("tc-modify-project-conflict"));

        expect(result.success).toBe(false);
        expect(result.error).toContain("Conflicting mutation");
        expect(result.error).toContain(CLAUDE_PUBKEY);
        expect(mockPublishMutation).not.toHaveBeenCalled();
    });

    it("uses an OpenAI-compatible object schema for project metadata updates", () => {
        const toolDef = createModifyProjectTool(createMockContext());
        const jsonSchema = z.toJSONSchema(toolDef.inputSchema as z.ZodType);

        expect(jsonSchema.properties?.set).toMatchObject({
            type: "object",
            properties: {
                image: { type: "string" },
                repo: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
            },
        });
        expect(JSON.stringify(jsonSchema)).not.toContain("prefixItems");
    });
});
