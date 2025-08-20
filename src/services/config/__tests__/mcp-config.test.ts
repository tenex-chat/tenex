import { describe, expect, it } from "bun:test";
import type { MCPServerConfig, TenexMCP } from "../types";
import { MCPServerConfigSchema, TenexMCPSchema } from "../types";

describe("MCP Configuration Types", () => {
  describe("MCPServerConfigSchema", () => {
    it("should validate a minimal server config", () => {
      const config: MCPServerConfig = {
        command: "node",
        args: ["server.js"],
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(config);
      }
    });

    it("should validate a full server config", () => {
      const config: MCPServerConfig = {
        command: "python",
        args: ["-m", "server", "--port", "8080"],
        env: {
          API_KEY: "secret",
          DEBUG: "true",
        },
        description: "Test MCP server",
        allowedPaths: ["/path1", "/path2"],
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(config);
      }
    });

    it("should reject missing required fields", () => {
      const invalidConfigs = [
        { args: ["server.js"] }, // Missing command
        { command: "node" }, // Missing args
        {}, // Missing both
      ];

      for (const config of invalidConfigs) {
        const result = MCPServerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
      }
    });

    it("should reject invalid field types", () => {
      const invalidConfigs = [
        {
          command: 123, // Should be string
          args: ["server.js"],
        },
        {
          command: "node",
          args: "server.js", // Should be array
        },
        {
          command: "node",
          args: ["server.js"],
          env: "API_KEY=secret", // Should be object
        },
        {
          command: "node",
          args: ["server.js"],
          allowedPaths: "/path1", // Should be array
        },
      ];

      for (const config of invalidConfigs) {
        const result = MCPServerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
      }
    });

    it("should accept empty arrays for args and allowedPaths", () => {
      const config: MCPServerConfig = {
        command: "standalone-server",
        args: [],
        allowedPaths: [],
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept complex environment variables", () => {
      const config: MCPServerConfig = {
        command: "node",
        args: ["server.js"],
        env: {
          API_KEY: "secret_key_123",
          PORT: "8080",
          DEBUG: "true",
          EMPTY_VAR: "",
          SPECIAL_CHARS: "!@#$%^&*()",
          PATH: "/usr/local/bin:/usr/bin",
        },
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.env).toEqual(config.env);
      }
    });

    it("should handle args with special characters", () => {
      const config: MCPServerConfig = {
        command: "python",
        args: [
          "-m",
          "server",
          "--config=/path/with spaces/config.json",
          "--token=abc@123!def",
          "--flag",
        ],
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.args).toEqual(config.args);
      }
    });
  });

  describe("TenexMCPSchema", () => {
    it("should validate minimal MCP config", () => {
      const config: TenexMCP = {
        servers: {},
        enabled: true,
      };

      const result = TenexMCPSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should validate MCP config with multiple servers", () => {
      const config: TenexMCP = {
        servers: {
          server1: {
            command: "node",
            args: ["server1.js"],
          },
          server2: {
            command: "python",
            args: ["server2.py"],
            description: "Python server",
          },
          "complex-name-123": {
            command: "bun",
            args: ["server.ts"],
            allowedPaths: ["/app"],
          },
        },
        enabled: true,
      };

      const result = TenexMCPSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data.servers)).toHaveLength(3);
      }
    });

    it("should default enabled to true if not specified", () => {
      const config = {
        servers: {
          test: {
            command: "node",
            args: ["test.js"],
          },
        },
      };

      const result = TenexMCPSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
      }
    });

    it("should accept disabled MCP", () => {
      const config: TenexMCP = {
        servers: {
          test: {
            command: "node",
            args: ["test.js"],
          },
        },
        enabled: false,
      };

      const result = TenexMCPSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
      }
    });

    it("should reject invalid server configurations", () => {
      const config = {
        servers: {
          "invalid-server": {
            command: "node",
            // Missing args
          },
        },
        enabled: true,
      };

      const result = TenexMCPSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should reject non-object servers field", () => {
      const invalidConfigs = [
        { servers: "not-an-object", enabled: true },
        { servers: ["array"], enabled: true },
        { servers: null, enabled: true },
      ];

      for (const config of invalidConfigs) {
        const result = TenexMCPSchema.safeParse(config);
        expect(result.success).toBe(false);
      }
    });

    it("should handle server names with various characters", () => {
      const config: TenexMCP = {
        servers: {
          simple: { command: "node", args: ["1.js"] },
          "with-dashes": { command: "node", args: ["2.js"] },
          with_underscores: { command: "node", args: ["3.js"] },
          WITH_CAPS: { command: "node", args: ["4.js"] },
          numbers123: { command: "node", args: ["5.js"] },
          "mix-123_ABC": { command: "node", args: ["6.js"] },
        },
        enabled: true,
      };

      const result = TenexMCPSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data.servers)).toHaveLength(6);
      }
    });
  });

  describe("Configuration merging scenarios", () => {
    it("should validate merged global and project configs", () => {
      const globalConfig: TenexMCP = {
        servers: {
          "global-server": {
            command: "node",
            args: ["global.js"],
            description: "Global server",
          },
        },
        enabled: true,
      };

      const projectConfig: TenexMCP = {
        servers: {
          "project-server": {
            command: "python",
            args: ["project.py"],
            allowedPaths: ["/project"],
          },
        },
        enabled: true,
      };

      // Simulate merge
      const mergedServers = {
        ...globalConfig.servers,
        ...projectConfig.servers,
      };

      const mergedConfig: TenexMCP = {
        servers: mergedServers,
        enabled: projectConfig.enabled,
      };

      const result = TenexMCPSchema.safeParse(mergedConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data.servers)).toContain("global-server");
        expect(Object.keys(result.data.servers)).toContain("project-server");
      }
    });

    it("should validate override scenario", () => {
      const globalConfig: TenexMCP = {
        servers: {
          "shared-server": {
            command: "node",
            args: ["global-version.js"],
            description: "Global version",
          },
        },
        enabled: true,
      };

      const projectConfig: TenexMCP = {
        servers: {
          "shared-server": {
            command: "bun",
            args: ["project-version.ts"],
            description: "Project version",
            allowedPaths: ["/project"],
          },
        },
        enabled: true,
      };

      // Project should override global
      const mergedServers = {
        ...globalConfig.servers,
        ...projectConfig.servers,
      };

      const mergedConfig: TenexMCP = {
        servers: mergedServers,
        enabled: projectConfig.enabled,
      };

      const result = TenexMCPSchema.safeParse(mergedConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        const sharedServer = result.data.servers["shared-server"];
        expect(sharedServer.command).toBe("bun");
        expect(sharedServer.description).toBe("Project version");
      }
    });
  });

  describe("Edge cases and security", () => {
    it("should handle very long values", () => {
      const longString = "a".repeat(1000);
      const config: MCPServerConfig = {
        command: "node",
        args: [longString],
        description: longString,
        allowedPaths: [longString],
        env: {
          LONG_VAR: longString,
        },
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should handle empty strings", () => {
      const config: MCPServerConfig = {
        command: "node",
        args: ["", "arg2", ""],
        description: "",
        allowedPaths: [""],
        env: {
          EMPTY: "",
        },
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should validate paths with special characters", () => {
      const config: MCPServerConfig = {
        command: "node",
        args: ["server.js"],
        allowedPaths: [
          "/home/user/my project",
          "/path/with/@special/chars",
          "C:\\Windows\\Path",
          "../relative/path",
          "./current/path",
          "~/home/path",
        ],
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowedPaths).toHaveLength(6);
      }
    });

    it("should handle numeric string values in env", () => {
      const config: MCPServerConfig = {
        command: "node",
        args: ["server.js"],
        env: {
          PORT: "8080",
          WORKERS: "4",
          TIMEOUT: "30000",
          FLOAT_VALUE: "3.14",
          NEGATIVE: "-1",
        },
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        // All env values should remain as strings
        expect(typeof result.data.env?.PORT).toBe("string");
        expect(result.data.env?.PORT).toBe("8080");
      }
    });
  });
});
