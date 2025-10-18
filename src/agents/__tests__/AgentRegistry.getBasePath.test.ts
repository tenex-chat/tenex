import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "../AgentRegistry";

describe("AgentRegistry.getBasePath", () => {
  it("should return the project path directly, not its parent", () => {
    const projectPath = "/Users/test/.tenex/projects/my-project-abc123";
    const registry = new AgentRegistry(projectPath);

    const basePath = registry.getBasePath();

    // Should return the project path itself, not the parent directory
    expect(basePath).toBe(projectPath);
    expect(basePath).toBe("/Users/test/.tenex/projects/my-project-abc123");
    expect(basePath).not.toBe("/Users/test/.tenex/projects");
  });

  it("should work with various project path formats", () => {
    const testCases = [
      "/home/user/.tenex/projects/project-id",
      "/Users/pablo/tenex/Wikifreedia-56xgs8",
      "/var/projects/test-project",
    ];

    for (const projectPath of testCases) {
      const registry = new AgentRegistry(projectPath);
      expect(registry.getBasePath()).toBe(projectPath);
    }
  });

  it("should provide correct base path for execution context", () => {
    // This is the actual directory structure used in ProjectRuntime
    const projectsBase = "/Users/test/.tenex/projects";
    const dTag = "Wikifreedia-56xgs8";
    const projectPath = path.join(projectsBase, dTag);

    const registry = new AgentRegistry(projectPath);
    const basePath = registry.getBasePath();

    // The base path should be the working directory where Claude Code operates
    expect(basePath).toBe("/Users/test/.tenex/projects/Wikifreedia-56xgs8");

    // It should NOT be the parent directory
    expect(basePath).not.toBe("/Users/test/.tenex/projects");
  });
});
