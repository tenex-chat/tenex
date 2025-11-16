import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { logger } from "../logger";

describe("Logger", () => {
    let consoleLogSpy: ReturnType<typeof spyOn>;
    let consoleErrorSpy: ReturnType<typeof spyOn>;
    let consoleWarnSpy: ReturnType<typeof spyOn>;
    const originalEnv = process.env;

    beforeEach(() => {
        consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
        consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        process.env = originalEnv;
    });

    describe("log levels", () => {
        it("should respect LOG_LEVEL environment variable", () => {
            process.env.LOG_LEVEL = "error";
            logger.info("should not appear");
            expect(consoleLogSpy).not.toHaveBeenCalled();

            logger.error("should appear");
            expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        });

        it("should log info messages at default level", () => {
            delete process.env.LOG_LEVEL;
            logger.info("info message");
            expect(consoleLogSpy).toHaveBeenCalledTimes(1);
        });

        it("should log error messages at any level", () => {
            process.env.LOG_LEVEL = "silent";
            logger.error("error message");
            expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        });

        it("should log warning messages at warn level and above", () => {
            process.env.LOG_LEVEL = "warn";
            logger.warn("warning message");
            expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
        });

        it("should respect DEBUG environment variable", () => {
            process.env.DEBUG = "false";
            process.env.LOG_LEVEL = "debug";
            logger.debug("should not appear");
            expect(consoleLogSpy).not.toHaveBeenCalled();

            process.env.DEBUG = "true";
            logger.debug("should appear");
            expect(consoleLogSpy).toHaveBeenCalledTimes(1);
        });

        it("should log success messages at info level", () => {
            process.env.LOG_LEVEL = "info";
            logger.success("success message");
            expect(consoleLogSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe("logger object", () => {
        it("should provide all standard methods", () => {
            process.env.DEBUG = "true";
            process.env.LOG_LEVEL = "debug";

            logger.info("info");
            logger.success("success");
            logger.warning("warning");
            logger.error("error");
            logger.debug("debug");

            expect(consoleLogSpy).toHaveBeenCalledTimes(3);
            expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        });

        it("should support additional arguments", () => {
            const extraData = { foo: "bar" };
            logger.info("message", extraData);
            expect(consoleLogSpy).toHaveBeenCalledTimes(1);
            expect(consoleLogSpy.mock.calls[0][1]).toEqual(extraData);
        });
    });
});
