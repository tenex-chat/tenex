import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { determineConfigLocation, getConfigLocationDescription, type ConfigLocationOptions } from "../configLocation";

describe("configLocation utilities", () => {
    let projectConfigExistsSpy: ReturnType<typeof spyOn>;
    let loggerErrorSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        projectConfigExistsSpy = spyOn(configService, "projectConfigExists");
        loggerErrorSpy = spyOn(logger, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        mock.restore();
    });

    describe("determineConfigLocation", () => {
        it("should throw error when both global and project flags are set", async () => {
            const options: ConfigLocationOptions = { global: true, project: true };
            
            await expect(determineConfigLocation(options)).rejects.toThrow("Conflicting configuration flags");
            expect(loggerErrorSpy).toHaveBeenCalledWith("Cannot use both --global and --project flags");
        });

        it("should return false when global flag is set", async () => {
            const options: ConfigLocationOptions = { global: true };
            projectConfigExistsSpy.mockResolvedValue(true);

            const result = await determineConfigLocation(options);
            expect(result).toBe(false);
        });

        it("should return true when project flag is set and project exists", async () => {
            const options: ConfigLocationOptions = { project: true };
            projectConfigExistsSpy.mockResolvedValue(true);

            const result = await determineConfigLocation(options);
            expect(result).toBe(true);
        });

        it("should throw error when project flag is set but no project exists", async () => {
            const options: ConfigLocationOptions = { project: true };
            projectConfigExistsSpy.mockResolvedValue(false);

            await expect(determineConfigLocation(options)).rejects.toThrow("Project configuration not available");
            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Not in a TENEX project directory. Use --global to add to global configuration."
            );
        });

        it("should return true by default when in a project", async () => {
            const options: ConfigLocationOptions = {};
            projectConfigExistsSpy.mockResolvedValue(true);

            const result = await determineConfigLocation(options);
            expect(result).toBe(true);
        });

        it("should return false by default when not in a project", async () => {
            const options: ConfigLocationOptions = {};
            projectConfigExistsSpy.mockResolvedValue(false);

            const result = await determineConfigLocation(options);
            expect(result).toBe(false);
        });

        it("should use provided project path", async () => {
            const options: ConfigLocationOptions = {};
            const customPath = "/custom/project/path";
            projectConfigExistsSpy.mockResolvedValue(true);

            await determineConfigLocation(options, customPath);
            expect(projectConfigExistsSpy).toHaveBeenCalledWith(customPath, "config.json");
        });
    });

    describe("getConfigLocationDescription", () => {
        it("should return 'project' for true", () => {
            expect(getConfigLocationDescription(true)).toBe("project");
        });

        it("should return 'global' for false", () => {
            expect(getConfigLocationDescription(false)).toBe("global");
        });
    });
});