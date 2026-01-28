import { describe, expect, it } from "bun:test";
import {
    type NudgeToolPermissions,
    isOnlyToolMode,
    hasToolPermissions,
} from "../types";

describe("NudgeToolPermissions types", () => {
    describe("isOnlyToolMode", () => {
        it("should return true when onlyTools has items", () => {
            const permissions: NudgeToolPermissions = {
                onlyTools: ["fs_read", "fs_write"],
            };
            expect(isOnlyToolMode(permissions)).toBe(true);
        });

        it("should return false when onlyTools is empty", () => {
            const permissions: NudgeToolPermissions = {
                onlyTools: [],
            };
            expect(isOnlyToolMode(permissions)).toBe(false);
        });

        it("should return false when onlyTools is undefined", () => {
            const permissions: NudgeToolPermissions = {};
            expect(isOnlyToolMode(permissions)).toBe(false);
        });

        it("should return false when only allowTools is set", () => {
            const permissions: NudgeToolPermissions = {
                allowTools: ["fs_read"],
            };
            expect(isOnlyToolMode(permissions)).toBe(false);
        });

        it("should return false when only denyTools is set", () => {
            const permissions: NudgeToolPermissions = {
                denyTools: ["shell"],
            };
            expect(isOnlyToolMode(permissions)).toBe(false);
        });
    });

    describe("hasToolPermissions", () => {
        it("should return true for onlyTools", () => {
            const permissions: NudgeToolPermissions = {
                onlyTools: ["fs_read"],
            };
            expect(hasToolPermissions(permissions)).toBe(true);
        });

        it("should return true for allowTools", () => {
            const permissions: NudgeToolPermissions = {
                allowTools: ["fs_read"],
            };
            expect(hasToolPermissions(permissions)).toBe(true);
        });

        it("should return true for denyTools", () => {
            const permissions: NudgeToolPermissions = {
                denyTools: ["shell"],
            };
            expect(hasToolPermissions(permissions)).toBe(true);
        });

        it("should return true for combined permissions", () => {
            const permissions: NudgeToolPermissions = {
                allowTools: ["fs_read"],
                denyTools: ["shell"],
            };
            expect(hasToolPermissions(permissions)).toBe(true);
        });

        it("should return false for empty permissions", () => {
            const permissions: NudgeToolPermissions = {};
            expect(hasToolPermissions(permissions)).toBe(false);
        });

        it("should return false for empty arrays", () => {
            const permissions: NudgeToolPermissions = {
                onlyTools: [],
                allowTools: [],
                denyTools: [],
            };
            expect(hasToolPermissions(permissions)).toBe(false);
        });
    });
});
