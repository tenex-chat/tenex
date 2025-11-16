import { beforeEach, describe, expect, it, mock } from "bun:test";
import { formatConfigScope, resolveConfigScope } from "../cli-config-scope";

// Mock the ConfigService
mock.module("@/services/ConfigService", () => ({
    configService: {
        projectConfigExists: mock(async (path: string, _configFile: string) =>
            path.includes("project")
        ),
        getGlobalPath: mock(() => "/home/user/.tenex"),
    },
}));

describe("CLI Config Scope", () => {
    describe("resolveConfigScope", () => {
        beforeEach(() => {
            mock.restore();
        });

        it("should reject conflicting flags", async () => {
            const scope = await resolveConfigScope({ project: true, global: true }, "/any/path");
            expect(scope.error).toBe("Cannot use both --project and --global flags");
            expect(scope.isGlobal).toBe(false);
            expect(scope.isProject).toBe(false);
        });

        it("should use global config when --global flag is set", async () => {
            const scope = await resolveConfigScope({ global: true }, "/any/path");
            expect(scope.isGlobal).toBe(true);
            expect(scope.isProject).toBe(false);
            expect(scope.basePath).toBe("/home/user/.tenex");
            expect(scope.error).toBeUndefined();
        });

        it("should use project config when --project flag is set and in project", async () => {
            const scope = await resolveConfigScope({ project: true }, "/my/project");
            expect(scope.isGlobal).toBe(false);
            expect(scope.isProject).toBe(true);
            expect(scope.basePath).toBe("/my/project");
            expect(scope.error).toBeUndefined();
        });

        it("should error when --project flag is set but not in project", async () => {
            const scope = await resolveConfigScope({ project: true }, "/not/a/tenex/dir");
            expect(scope.error).toBe(
                "Not in a TENEX project directory. Run 'tenex project init' first."
            );
            expect(scope.isGlobal).toBe(false);
            expect(scope.isProject).toBe(false);
        });

        it("should default to project config when in project directory", async () => {
            const scope = await resolveConfigScope({}, "/my/project");
            expect(scope.isGlobal).toBe(false);
            expect(scope.isProject).toBe(true);
            expect(scope.basePath).toBe("/my/project");
            expect(scope.error).toBeUndefined();
        });

        it("should default to global config when not in project directory", async () => {
            const scope = await resolveConfigScope({}, "/not/a/tenex/dir");
            expect(scope.isGlobal).toBe(true);
            expect(scope.isProject).toBe(false);
            expect(scope.basePath).toBe("/home/user/.tenex");
            expect(scope.error).toBeUndefined();
        });
    });

    describe("formatConfigScope", () => {
        it("should format error messages", () => {
            const scope = {
                basePath: "",
                isGlobal: false,
                isProject: false,
                error: "Test error message",
            };
            expect(formatConfigScope(scope)).toBe("Test error message");
        });

        it("should format global configuration", () => {
            const scope = {
                basePath: "/home/user/.tenex",
                isGlobal: true,
                isProject: false,
            };
            expect(formatConfigScope(scope)).toBe("global configuration");
        });

        it("should format project configuration", () => {
            const scope = {
                basePath: "/my/project",
                isGlobal: false,
                isProject: true,
            };
            expect(formatConfigScope(scope)).toBe("project configuration at /my/project");
        });

        it("should handle unknown configuration", () => {
            const scope = {
                basePath: "",
                isGlobal: false,
                isProject: false,
            };
            expect(formatConfigScope(scope)).toBe("configuration");
        });
    });
});
