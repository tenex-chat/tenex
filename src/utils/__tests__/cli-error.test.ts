import { describe, expect, it, spyOn } from "bun:test";
import { handleCliError } from "../cli-error";
import { logger } from "../logger";

describe("CLI Error Handler", () => {
    describe("handleCliError", () => {
        it("should log error message and exit with code 1", () => {
            const mockExit = spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit called");
            });
            const mockLogError = spyOn(logger, "error").mockImplementation(() => {});

            const error = new Error("Test error");

            expect(() => handleCliError(error)).toThrow("process.exit called");

            expect(mockLogError).toHaveBeenCalledWith("Test error");
            expect(mockExit).toHaveBeenCalledWith(1);

            mockExit.mockRestore();
            mockLogError.mockRestore();
        });

        it("should log error with context when provided", () => {
            const mockExit = spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit called");
            });
            const mockLogError = spyOn(logger, "error").mockImplementation(() => {});

            const error = new Error("Test error");

            expect(() => handleCliError(error, "Command failed")).toThrow("process.exit called");

            expect(mockLogError).toHaveBeenCalledWith("Command failed: Test error");
            expect(mockExit).toHaveBeenCalledWith(1);

            mockExit.mockRestore();
            mockLogError.mockRestore();
        });

        it("should handle string errors", () => {
            const mockExit = spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit called");
            });
            const mockLogError = spyOn(logger, "error").mockImplementation(() => {});

            expect(() => handleCliError("String error")).toThrow("process.exit called");

            expect(mockLogError).toHaveBeenCalledWith("String error");
            expect(mockExit).toHaveBeenCalledWith(1);

            mockExit.mockRestore();
            mockLogError.mockRestore();
        });

        it("should use custom exit code when provided", () => {
            const mockExit = spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit called");
            });
            const mockLogError = spyOn(logger, "error").mockImplementation(() => {});

            expect(() => handleCliError("Error", undefined, 2)).toThrow("process.exit called");

            expect(mockExit).toHaveBeenCalledWith(2);

            mockExit.mockRestore();
            mockLogError.mockRestore();
        });
    });
});
