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
});
