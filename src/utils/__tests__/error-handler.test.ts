import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { handleError } from "../error-handler";
import { logger } from "../logger";

describe("error-handler", () => {
    let errorSpy: ReturnType<typeof spyOn>;
    let warnSpy: ReturnType<typeof spyOn>;
    let debugSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        errorSpy = spyOn(logger, "error").mockImplementation(() => {});
        warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
        debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy?.mockRestore();
        warnSpy?.mockRestore();
        debugSpy?.mockRestore();
    });

    describe("handleError", () => {
        it("should log errors with default error level", () => {
            const error = new Error("Test error");
            const result = handleError(error, "Test context");

            expect(errorSpy).toHaveBeenCalledWith("Test context: Test error");
            expect(result).toBe("Test error");
        });

        it("should log warnings when specified", () => {
            const error = new Error("Warning message");
            handleError(error, "Warning context", { logLevel: "warn" });

            expect(warnSpy).toHaveBeenCalledWith("Warning context: Warning message");
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it("should log debug messages when specified", () => {
            const error = new Error("Debug message");
            handleError(error, "Debug context", { logLevel: "debug" });

            expect(debugSpy).toHaveBeenCalledWith("Debug context: Debug message");
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it("should handle string errors", () => {
            const result = handleError("String error", "Context");

            expect(errorSpy).toHaveBeenCalledWith("Context: String error");
            expect(result).toBe("String error");
        });

        it("should handle null/undefined errors", () => {
            const result = handleError(null, "Context");

            expect(errorSpy).toHaveBeenCalledWith("Context: Unknown error");
            expect(result).toBe("Unknown error");
        });

        it("should rethrow errors when specified", () => {
            const error = new Error("Rethrow test");

            expect(() => {
                handleError(error, "Context", { rethrow: true });
            }).toThrow("Rethrow test");

            expect(errorSpy).toHaveBeenCalledWith("Context: Rethrow test");
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
});
