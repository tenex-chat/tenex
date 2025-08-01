import { describe, it, expect, beforeEach, mock } from "bun:test";
import { shellTool } from "../shell";
import type { ExecutionContext } from "@/tools/types";
import { createMockExecutionContext } from "@/test-utils";

// Mock child_process
mock.module("child_process", () => ({
    spawn: mock((command: string, args: string[], options: any) => {
        const mockProcess = {
            stdout: {
                on: mock((event: string, handler: Function) => {
                    if (event === 'data') {
                        // Simulate command output
                        if (command === 'echo' && args[0] === 'Hello World') {
                            handler(Buffer.from('Hello World\n'));
                        } else if (command === 'ls') {
                            handler(Buffer.from('file1.txt\nfile2.txt\n'));
                        }
                    }
                })
            },
            stderr: {
                on: mock((event: string, handler: Function) => {
                    if (event === 'data' && command === 'nonexistent') {
                        handler(Buffer.from('command not found\n'));
                    }
                })
            },
            on: mock((event: string, handler: Function) => {
                if (event === 'close') {
                    // Simulate process exit
                    const code = command === 'nonexistent' ? 127 : 0;
                    setTimeout(() => handler(code), 10);
                }
            }),
            kill: mock()
        };
        return mockProcess;
    })
}));

describe("shellTool", () => {
    let context: ExecutionContext;
    
    beforeEach(() => {
        context = createMockExecutionContext({
            projectPath: "/test/project"
        });
    });
    
    describe("execute", () => {
        it("should execute simple commands", async () => {
            const validated = {
                _brand: "validated" as const,
                value: { command: "echo Hello World" }
            };
            
            const result = await shellTool.execute(validated, context);
            
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toContain("Hello World");
            }
        });
        
        it("should handle command with working directory", async () => {
            const result = await shellTool.execute(
                { 
                    command: "ls",
                    cwd: "/test/dir"
                },
                context
            );
            
            expect(result.success).toBe(true);
            expect(result.output).toContain("file1.txt");
            expect(result.output).toContain("file2.txt");
        });
        
        it("should handle command failures", async () => {
            const result = await shellTool.execute(
                { command: "nonexistent" },
                context
            );
            
            expect(result.success).toBe(false);
            expect(result.error).toContain("command not found");
        });
        
        it("should respect timeout", async () => {
            // Mock a long-running command
            const longProcess = {
                stdout: { on: mock() },
                stderr: { on: mock() },
                on: mock((event: string, handler: Function) => {
                    // Don't call close handler - simulate hanging process
                }),
                kill: mock()
            };
            
            mock.module("child_process", () => ({
                spawn: () => longProcess
            }));
            
            const promise = shellTool.execute(
                { 
                    command: "sleep 10",
                    timeout: 100 // 100ms timeout
                },
                context
            );
            
            // Wait for timeout
            await new Promise(resolve => setTimeout(resolve, 150));
            
            // Verify process was killed
            expect(longProcess.kill).toHaveBeenCalled();
        });
        
        it("should validate required parameters", async () => {
            await expect(async () => {
                await shellTool.execute({} as any, context);
            }).toThrow();
        });
        
        it("should sanitize command output", async () => {
            // Test with command that would produce special characters
            const result = await shellTool.execute(
                { command: "echo Hello World" },
                context
            );
            
            // Output should be clean
            expect(result.output).not.toContain("\r");
            expect(result.output.trim()).toBe("Hello World");
        });
    });
    
    describe("schema validation", () => {
        it("should accept valid parameters", () => {
            const valid = shellTool.schema.safeParse({
                command: "ls -la"
            });
            
            expect(valid.success).toBe(true);
        });
        
        it("should accept command with cwd", () => {
            const valid = shellTool.schema.safeParse({
                command: "npm install",
                cwd: "./src"
            });
            
            expect(valid.success).toBe(true);
        });
        
        it("should accept command with timeout", () => {
            const valid = shellTool.schema.safeParse({
                command: "npm test",
                timeout: 30000
            });
            
            expect(valid.success).toBe(true);
        });
        
        it("should reject empty command", () => {
            const invalid = shellTool.schema.safeParse({
                command: ""
            });
            
            expect(invalid.success).toBe(false);
        });
        
        it("should reject missing command", () => {
            const invalid = shellTool.schema.safeParse({});
            
            expect(invalid.success).toBe(false);
        });
    });
});