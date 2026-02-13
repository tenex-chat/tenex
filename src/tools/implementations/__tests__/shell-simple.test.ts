import { describe, expect, it } from "bun:test";
import { createShellTool } from "../shell";
import { createMockExecutionEnvironment } from "@/test-utils";
import { tmpdir } from "os";

describe("shellTool - simple test", () => {
    // Create tool instance using factory with mock context
    // Use real tmpdir so shell commands can actually execute
    const mockContext = createMockExecutionEnvironment({
        workingDirectory: tmpdir(),
        projectBasePath: tmpdir(),
    });
    const shellTool = createShellTool(mockContext);

    it("should have correct metadata", () => {
        expect(shellTool.description).toContain("Execute shell commands");
    });

    it("should have execute function", () => {
        expect(typeof shellTool.execute).toBe("function");
    });

    it("should execute simple command", async () => {
        const result = await shellTool.execute({
            command: "echo test",
            cwd: null,
            timeout: null,
        });

        expect(result).toContain("test");
    });

    it("should handle command with timeout parameter", async () => {
        const result = await shellTool.execute({
            command: "echo hello",
            cwd: null,
            timeout: 60000,
        });

        expect(result).toContain("hello");
    });

    it("should allow omitting cwd parameter entirely", async () => {
        // cwd should be truly optional - not requiring explicit null
        const result = await shellTool.execute({
            command: "echo optional-cwd-test",
        });

        expect(result).toContain("optional-cwd-test");
    });

    it("should allow omitting timeout parameter entirely", async () => {
        // timeout should be truly optional - not requiring explicit null
        const result = await shellTool.execute({
            command: "echo optional-timeout-test",
        });

        expect(result).toContain("optional-timeout-test");
    });

    it("should allow omitting both cwd and timeout parameters", async () => {
        // Both should be optional - minimal required input is just command
        const result = await shellTool.execute({
            command: "echo minimal-params-test",
        });

        expect(result).toContain("minimal-params-test");
    });

    it("should work with run_in_background without cwd or timeout", async () => {
        // Create a mock context with getConversation that returns getProjectId
        const backgroundMockContext = createMockExecutionEnvironment({
            workingDirectory: tmpdir(),
            projectBasePath: tmpdir(),
            getConversation: () => ({
                getProjectId: () => "test-project-id-123456789012345678901234567890",
            }),
        });
        const backgroundShellTool = createShellTool(backgroundMockContext);

        // Background processes should work without cwd or timeout
        const result = await backgroundShellTool.execute({
            command: "echo background-test",
            run_in_background: true,
        });

        // Background tasks return a structured object
        expect(result).toHaveProperty("type", "background-task");
        expect(result).toHaveProperty("taskId");
        expect(result).toHaveProperty("message");
    });
});
