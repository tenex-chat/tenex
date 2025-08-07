import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
    handleAsyncError,
    handleSyncError,
    logAndThrow,
    retryWithBackoff
} from "../error-handler";

describe("error-handler", () => {
    beforeEach(() => {
        mock.restore();
    });

    describe("handleAsyncError", () => {
        it("should return result when operation succeeds", async () => {
            const operation = async () => "success";
            const result = await handleAsyncError(operation, {
                operation: "test operation"
            });
            expect(result).toBe("success");
        });

        it("should return fallback when operation fails", async () => {
            const operation = async () => {
                throw new Error("test error");
            };
            const result = await handleAsyncError(
                operation,
                { operation: "test operation" },
                "fallback"
            );
            expect(result).toBe("fallback");
        });

        it("should return undefined when operation fails with no fallback", async () => {
            const operation = async () => {
                throw new Error("test error");
            };
            const result = await handleAsyncError(operation, {
                operation: "test operation"
            });
            expect(result).toBeUndefined();
        });

        it("should handle operations with agent context", async () => {
            const operation = async () => "with-agent";
            const result = await handleAsyncError(operation, {
                operation: "agent operation",
                agent: "test-agent",
                additionalInfo: { customField: "value" }
            });
            expect(result).toBe("with-agent");
        });
    });

    describe("handleSyncError", () => {
        it("should return result when operation succeeds", () => {
            const operation = () => "success";
            const result = handleSyncError(operation, {
                operation: "test operation"
            });
            expect(result).toBe("success");
        });

        it("should return fallback when operation fails", () => {
            const operation = () => {
                throw new Error("test error");
            };
            const result = handleSyncError(
                operation,
                { operation: "test operation" },
                "fallback"
            );
            expect(result).toBe("fallback");
        });

        it("should return undefined when operation fails with no fallback", () => {
            const operation = () => {
                throw new Error("test error");
            };
            const result = handleSyncError(operation, {
                operation: "test operation"
            });
            expect(result).toBeUndefined();
        });
    });

    describe("logAndThrow", () => {
        it("should return result when operation succeeds", async () => {
            const operation = async () => "success";
            const result = await logAndThrow(operation, {
                operation: "test operation"
            });
            expect(result).toBe("success");
        });

        it("should rethrow error when operation fails", async () => {
            const error = new Error("test error");
            const operation = async () => {
                throw error;
            };
            
            await expect(
                logAndThrow(operation, { operation: "test operation" })
            ).rejects.toThrow("test error");
        });

        it("should handle operations with agent context", async () => {
            const operation = async () => "with-agent";
            const result = await logAndThrow(operation, {
                operation: "agent operation",
                agent: "test-agent",
                additionalInfo: { customField: "value" }
            });
            expect(result).toBe("with-agent");
        });
    });

    describe("retryWithBackoff", () => {
        it("should return result on first success", async () => {
            const operation = async () => "success";
            const result = await retryWithBackoff(operation, {
                operation: "test operation"
            });
            expect(result).toBe("success");
        });

        it("should retry on failure and succeed", async () => {
            let attempts = 0;
            const operation = async () => {
                attempts++;
                if (attempts < 2) {
                    throw new Error("temporary failure");
                }
                return "success after retry";
            };
            
            const result = await retryWithBackoff(operation, {
                operation: "test operation",
                maxRetries: 3,
                initialDelay: 10
            });
            
            expect(result).toBe("success after retry");
            expect(attempts).toBe(2);
        });

        it("should throw after max retries", async () => {
            let attempts = 0;
            const operation = async () => {
                attempts++;
                throw new Error("persistent failure");
            };
            
            await expect(
                retryWithBackoff(operation, {
                    operation: "test operation",
                    maxRetries: 2,
                    initialDelay: 10
                })
            ).rejects.toThrow("persistent failure");
            
            expect(attempts).toBe(2);
        });

        it("should use default retry settings", async () => {
            let attempts = 0;
            const operation = async () => {
                attempts++;
                if (attempts < 2) {
                    throw new Error("temporary failure");
                }
                return "success";
            };
            
            const result = await retryWithBackoff(operation, {
                operation: "test operation"
            });
            
            expect(result).toBe("success");
        });

        it("should respect maxDelay", async () => {
            let attempts = 0;
            const startTime = Date.now();
            
            const operation = async () => {
                attempts++;
                if (attempts < 3) {
                    throw new Error("failure");
                }
                return "success";
            };
            
            const result = await retryWithBackoff(operation, {
                operation: "test operation",
                maxRetries: 3,
                initialDelay: 10,
                maxDelay: 20
            });
            
            const duration = Date.now() - startTime;
            expect(result).toBe("success");
            expect(duration).toBeLessThan(100); // Should not take too long with small delays
        });
    });
});