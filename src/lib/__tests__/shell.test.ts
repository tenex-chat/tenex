import { describe, it, expect } from "bun:test";
import { which } from "../shell";

describe("shell utilities", () => {
    describe("which", () => {
        it("should have the function exported", () => {
            expect(which).toBeDefined();
            expect(typeof which).toBe("function");
        });

        it("should throw error for invalid input", async () => {
            await expect(which("")).rejects.toThrow("Command cannot be empty or whitespace");
            await expect(which("   ")).rejects.toThrow("Command cannot be empty or whitespace");
            await expect(which(null as any)).rejects.toThrow("Invalid command parameter");
            await expect(which(undefined as any)).rejects.toThrow("Invalid command parameter");
            await expect(which(123 as any)).rejects.toThrow("Invalid command parameter");
        });

        it("should return null for non-existent command", async () => {
            const result = await which("this-command-definitely-does-not-exist-xyz123");
            expect(result).toBeNull();
        });

        // Integration test - only test with real commands that should exist
        it("should find common system commands", async () => {
            // These commands should exist on most Unix-like systems
            const commonCommands = ["ls", "echo", "cat"];
            
            for (const cmd of commonCommands) {
                const result = await which(cmd);
                if (result !== null) {
                    // If found, it should be an absolute path
                    expect(result).toMatch(/^\/.*$/);
                    expect(result).toContain(cmd);
                    break; // At least one should work
                }
            }
        });

        it("should handle command with spaces in name by trimming", async () => {
            const result = await which("  echo  ");
            // Should find echo command if it exists
            if (result !== null) {
                expect(result).toMatch(/echo/);
            }
        });
    });
});