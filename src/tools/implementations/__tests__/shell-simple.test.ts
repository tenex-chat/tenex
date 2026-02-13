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

    // Table-driven tests for optional parameter combinations
    const optionalParamCases = [
        { name: "omitting cwd", input: { command: "echo test1" }, expected: "test1" },
        { name: "omitting timeout", input: { command: "echo test2" }, expected: "test2" },
        { name: "omitting both cwd and timeout", input: { command: "echo test3" }, expected: "test3" },
        { name: "explicit null for cwd", input: { command: "echo test4", cwd: null }, expected: "test4" },
        { name: "explicit null for timeout", input: { command: "echo test5", timeout: null }, expected: "test5" },
    ] as const;

    for (const { name, input, expected } of optionalParamCases) {
        it(`should allow ${name}`, async () => {
            const result = await shellTool.execute(input);
            expect(result).toContain(expected);
        });
    }

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

describe("shellTool - schema validation", () => {
    const mockContext = createMockExecutionEnvironment({
        workingDirectory: tmpdir(),
        projectBasePath: tmpdir(),
    });
    const shellTool = createShellTool(mockContext);

    // Access the inputSchema for direct validation testing
    // This tests what the AI SDK will validate before calling execute
    const schema = shellTool.inputSchema;

    describe("optional parameters pass schema validation", () => {
        it("should validate when only command is provided", () => {
            const result = schema.safeParse({ command: "echo test" });
            expect(result.success).toBe(true);
        });

        it("should validate when cwd is omitted", () => {
            const result = schema.safeParse({ command: "echo test", timeout: 5000 });
            expect(result.success).toBe(true);
        });

        it("should validate when timeout is omitted", () => {
            const result = schema.safeParse({ command: "echo test", cwd: "/tmp" });
            expect(result.success).toBe(true);
        });

        it("should validate with explicit null values", () => {
            const result = schema.safeParse({ command: "echo test", cwd: null, timeout: null });
            expect(result.success).toBe(true);
        });
    });

    describe("timeout coercion from numeric strings", () => {
        it("should coerce string '60000' to number 60000", () => {
            const result = schema.safeParse({ command: "echo test", timeout: "60000" });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.timeout).toBe(60000);
            }
        });

        it("should coerce string '5000' to number 5000", () => {
            const result = schema.safeParse({ command: "echo test", timeout: "5000" });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.timeout).toBe(5000);
            }
        });

        it("should preserve undefined when timeout is not provided", () => {
            const result = schema.safeParse({ command: "echo test" });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.timeout).toBeUndefined();
            }
        });

        it("should preserve null when timeout is explicitly null", () => {
            const result = schema.safeParse({ command: "echo test", timeout: null });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.timeout).toBeNull();
            }
        });

        it("should preserve actual numbers", () => {
            const result = schema.safeParse({ command: "echo test", timeout: 30000 });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.timeout).toBe(30000);
            }
        });

        it("should reject invalid non-numeric strings", () => {
            const result = schema.safeParse({ command: "echo test", timeout: "not-a-number" });
            expect(result.success).toBe(false);
        });

        it("should treat empty string timeout as undefined (not zero)", () => {
            const result = schema.safeParse({ command: "echo test", timeout: "" });
            expect(result.success).toBe(true);
            if (result.success) {
                // Empty string should become undefined, not 0
                expect(result.data.timeout).toBeUndefined();
            }
        });

        it("should treat whitespace-only string timeout as undefined", () => {
            const result = schema.safeParse({ command: "echo test", timeout: "   " });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.timeout).toBeUndefined();
            }
        });
    });

    describe("required command parameter", () => {
        it("should fail validation when command is missing", () => {
            const result = schema.safeParse({});
            expect(result.success).toBe(false);
        });

        it("should allow empty string command (schema validates structure, not semantics)", () => {
            // Empty string is technically valid by schema, but meaningless
            // Semantic validation (rejecting empty commands) would happen at execute time
            const result = schema.safeParse({ command: "" });
            expect(result.success).toBe(true);
        });
    });
});
