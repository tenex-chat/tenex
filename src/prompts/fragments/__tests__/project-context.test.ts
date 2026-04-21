import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { config } from "@/services/ConfigService";
import { projectContextFragment } from "../08-project-context";
import * as transportModule from "@/services/ingress/TransportBindingStoreService";
import * as identityModule from "@/services/identity";
import * as telegramChatContextModule from "@/services/telegram/TelegramChatContextStoreService";
import * as worktreeModule from "@/utils/git/worktree";

mock.module("@/utils/logger", () => ({
    logger: {
        warn: () => {},
        debug: () => {},
        info: () => {},
        error: () => {},
    },
}));

describe("project-context fragment — $PROJECT_BASE path rendering", () => {
    beforeEach(() => {
        spyOn(config, "getConfigPath").mockReturnValue("/tenex/projects");
        spyOn(transportModule, "getTransportBindingStore").mockReturnValue({
            listBindingsForAgentProject: () => [],
        } as any);
        spyOn(identityModule, "getIdentityBindingStore").mockReturnValue({
            getBinding: () => undefined,
        } as any);
        spyOn(telegramChatContextModule, "getTelegramChatContextStore").mockReturnValue({
            getContext: () => undefined,
        } as any);
        spyOn(worktreeModule, "listWorktrees").mockResolvedValue([]);
        spyOn(worktreeModule, "loadWorktreeMetadata").mockResolvedValue({} as any);
    });

    const mockAgent = {
        pubkey: "abcd1234567890ef",
        slug: "test-agent",
        name: "Test Agent",
        role: "developer",
    };

    const baseArgs = {
        agent: mockAgent as never,
        projectTitle: "Test Project",
        projectOwnerPubkey: "owner1234567890abcdef",
    };

    it("renders root path as $PROJECT_BASE", async () => {
        const result = await projectContextFragment.template({
            ...baseArgs,
            projectBasePath: "/test-root-exact",
            workingDirectory: "/test-root-exact",
        });
        expect(result).toContain("cwd: $PROJECT_BASE");
    });

    it("renders child path as $PROJECT_BASE/child", async () => {
        const result = await projectContextFragment.template({
            ...baseArgs,
            projectBasePath: "/test-child-path",
            workingDirectory: "/test-child-path/src",
        });
        expect(result).toContain("cwd: $PROJECT_BASE/src");
    });

    it("renders path inside .worktrees/ as $PROJECT_BASE/.worktrees/branchName", async () => {
        const result = await projectContextFragment.template({
            ...baseArgs,
            projectBasePath: "/test-worktree-path",
            projectDocsPath: "/test-worktree-path/.worktrees/feature-branch/docs",
        });
        expect(result).toContain("project docs: $PROJECT_BASE/.worktrees/feature-branch/docs");
    });

    it("does not rewrite a sibling path outside the project root", async () => {
        const result = await projectContextFragment.template({
            ...baseArgs,
            projectBasePath: "/test-sibling-project",
            workingDirectory: "/other-project/subdir",
        });
        expect(result).toContain("cwd: /other-project/subdir");
        expect(result).not.toContain("cwd: $PROJECT_BASE");
    });

    it("does not rewrite a path that traverses above the project root", async () => {
        const result = await projectContextFragment.template({
            ...baseArgs,
            projectBasePath: "/parent/test-project",
            workingDirectory: "/parent/sibling",
        });
        expect(result).toContain("cwd: /parent/sibling");
        expect(result).not.toContain("cwd: $PROJECT_BASE");
    });

    it("renders runtime status for remote and offline coworkers", async () => {
        const result = await projectContextFragment.template({
            ...baseArgs,
            agentRuntimeInfo: [
                {
                    pubkey: mockAgent.pubkey,
                    slug: mockAgent.slug,
                    name: mockAgent.name,
                    role: mockAgent.role,
                    runtimeStatus: "local-online",
                },
                {
                    pubkey: "remote-agent-pubkey",
                    slug: "remote-agent",
                    name: "Remote Agent",
                    role: "developer",
                    useCriteria: "Use remotely",
                    runtimeStatus: "remote-online",
                    backendPubkey: "feedface1234567890",
                },
                {
                    pubkey: "offline-agent-pubkey",
                    slug: "offline-agent",
                    name: "Offline Agent",
                    role: "developer",
                    useCriteria: "Use later",
                    runtimeStatus: "offline",
                },
            ],
        });

        expect(result).toContain("* remote-agent [remote backend feedfa] - Use remotely");
        expect(result).toContain("* offline-agent [offline] - Use later");
    });
});
