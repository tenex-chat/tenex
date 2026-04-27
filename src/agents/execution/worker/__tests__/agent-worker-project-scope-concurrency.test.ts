import { describe, expect, it } from "bun:test";
import type { AgentWorkerProtocolMessage } from "@/events/runtime/AgentWorkerProtocol";
import { AgentWorkerExecutionFailure, type ProjectScopeBootstrapResult } from "../bootstrap";
import {
    getProjectScopeAdmission,
    isProjectScopeBusyFailure,
    shouldDisposeProjectScopeAfterExecutionFailure,
} from "../agent-worker";

type ExecuteMessage = Extract<AgentWorkerProtocolMessage, { type: "execute" }>;

describe("agent worker project scope concurrency", () => {
    it("reuses the cached scope for the same project identity", () => {
        const scope = projectScope("project-a", "/work/a", "/meta/a");

        expect(
            getProjectScopeAdmission(scope, execute("project-a", "/work/a", "/meta/a"), 1)
        ).toBe("reuse");
    });

    it("allows scope replacement for a different project only when no executions are active", () => {
        const scope = projectScope("project-a", "/work/a", "/meta/a");

        expect(
            getProjectScopeAdmission(scope, execute("project-b", "/work/b", "/meta/b"), 0)
        ).toBe("replace");
    });

    it("fails a different project while executions are active without marking the scope disposable", () => {
        const scope = projectScope("project-a", "/work/a", "/meta/a");

        let thrown: unknown;
        try {
            getProjectScopeAdmission(scope, execute("project-b", "/work/b", "/meta/b"), 1);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(AgentWorkerExecutionFailure);
        expect(thrown).toMatchObject({
            code: "project_scope_busy",
            retryable: true,
        });
        expect(isProjectScopeBusyFailure(thrown)).toBe(true);
    });

    it("does not treat ordinary execution failures as project-scope busy rejections", () => {
        const error = new AgentWorkerExecutionFailure(
            "agent_execution_failed",
            "executor failed",
            false
        );

        expect(isProjectScopeBusyFailure(error)).toBe(false);
    });

    it("defers project-scope cleanup for ordinary failures while sibling executions are active", () => {
        const error = new AgentWorkerExecutionFailure(
            "agent_execution_failed",
            "executor failed",
            false
        );

        expect(shouldDisposeProjectScopeAfterExecutionFailure(error, 2)).toBe(false);
        expect(shouldDisposeProjectScopeAfterExecutionFailure(error, 1)).toBe(true);
    });
});

function projectScope(
    projectId: string,
    projectBasePath: string,
    metadataPath: string
): ProjectScopeBootstrapResult {
    return {
        scope: {
            projectId,
            projectBasePath,
            metadataPath,
        } as ProjectScopeBootstrapResult["scope"],
        cleanup: async () => {},
    };
}

function execute(
    projectId: string,
    projectBasePath: string,
    metadataPath: string
): ExecuteMessage {
    return {
        type: "execute",
        projectId,
        projectBasePath,
        metadataPath,
    } as ExecuteMessage;
}
