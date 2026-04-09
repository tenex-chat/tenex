import { describe, expect, it, mock } from "bun:test";
import { projectContextFragment } from "../08-project-context";

mock.module("@/services/ConfigService", () => ({
    config: {
        getConfigPath: () => "/tenex/projects",
    },
}));

mock.module("@/services/ingress/TransportBindingStoreService", () => ({
    getTransportBindingStore: () => ({
        listBindingsForAgentProject: () => [],
    }),
}));

mock.module("@/services/identity", () => ({
    getIdentityBindingStore: () => ({
        getBinding: () => undefined,
    }),
}));

mock.module("@/services/telegram/TelegramChatContextStoreService", () => ({
    getTelegramChatContextStore: () => ({
        getContext: () => undefined,
    }),
}));

mock.module("@/utils/git/worktree", () => ({
    listWorktrees: async () => [],
    loadWorktreeMetadata: async () => ({}),
}));

mock.module("@/lib/agent-home", () => ({
    getAgentProjectInjectedFiles: () => [],
}));

mock.module("@/utils/logger", () => ({
    logger: {
        warn: () => {},
        debug: () => {},
        info: () => {},
        error: () => {},
    },
}));

describe("project-context fragment — $PROJECT_BASE path rendering", () => {
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
});
