import { describe, expect, it, beforeEach, mock } from "bun:test";
import { handleError, withErrorHandling } from "../error-handler";
import { logger } from "../logger";

const mockLogger = {
    error: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
};

mock.module("../logger", () => ({
    logger: mockLogger,
}));

describe("error-handler", () => {
    beforeEach(() => {
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.debug.mockClear();
    });

    describe("handleError", () => {
        it("should log errors with default error level", () => {
            const error = new Error("Test error");
            const result = handleError(error, "Test context");
            
            expect(mockLogger.error).toHaveBeenCalledWith("Test context: Test error");
            expect(result).toBe("Test error");
        });

        it("should log warnings when specified", () => {
            const error = new Error("Warning message");
            handleError(error, "Warning context", { logLevel: "warn" });
            
            expect(mockLogger.warn).toHaveBeenCalledWith("Warning context: Warning message");
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it("should log debug messages when specified", () => {
            const error = new Error("Debug message");
            handleError(error, "Debug context", { logLevel: "debug" });
            
            expect(mockLogger.debug).toHaveBeenCalledWith("Debug context: Debug message");
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it("should handle string errors", () => {
            const result = handleError("String error", "Context");
            
            expect(mockLogger.error).toHaveBeenCalledWith("Context: String error");
            expect(result).toBe("String error");
        });

        it("should handle null/undefined errors", () => {
            const result = handleError(null, "Context");
            
            expect(mockLogger.error).toHaveBeenCalledWith("Context: Unknown error");
            expect(result).toBe("Unknown error");
        });

        it("should rethrow errors when specified", () => {
            const error = new Error("Rethrow test");
            
            expect(() => {
                handleError(error, "Context", { rethrow: true });
            }).toThrow("Rethrow test");
            
            expect(mockLogger.error).toHaveBeenCalledWith("Context: Rethrow test");
        });

        it("should exit process when exitCode is specified", () => {
            const originalExit = process.exit;
            const mockExit = mock(() => {
                throw new Error("Process exit");
            });
            process.exit = mockExit as any;
            
            const error = new Error("Exit test");
            
            expect(() => {
                handleError(error, "Context", { exitCode: 1 });
            }).toThrow("Process exit");
            
            expect(mockExit).toHaveBeenCalledWith(1);
            process.exit = originalExit;
        });
    });

    describe("withErrorHandling", () => {
        it("should return result on success", async () => {
            const fn = mock(() => Promise.resolve("success"));
            const result = await withErrorHandling(fn, "Context");
            
            expect(result).toBe("success");
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it("should handle errors and return undefined by default", async () => {
            const fn = mock(() => Promise.reject(new Error("Async error")));
            const result = await withErrorHandling(fn, "Async context");
            
            expect(result).toBeUndefined();
            expect(mockLogger.error).toHaveBeenCalledWith("Async context: Async error");
        });

        it("should return fallback value on error", async () => {
            const fn = mock(() => Promise.reject(new Error("Fallback test")));
            const result = await withErrorHandling(fn, "Context", { fallback: "default" });
            
            expect(result).toBe("default");
            expect(mockLogger.error).toHaveBeenCalledWith("Context: Fallback test");
        });

        it("should use specified log level", async () => {
            const fn = mock(() => Promise.reject(new Error("Warn test")));
            await withErrorHandling(fn, "Context", { logLevel: "warn" });
            
            expect(mockLogger.warn).toHaveBeenCalledWith("Context: Warn test");
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it("should rethrow errors when specified", async () => {
            const fn = mock(() => Promise.reject(new Error("Rethrow async")));
            
            await expect(
                withErrorHandling(fn, "Context", { rethrow: true })
            ).rejects.toThrow("Rethrow async");
            
            expect(mockLogger.error).toHaveBeenCalledWith("Context: Rethrow async");
        });
    });
});