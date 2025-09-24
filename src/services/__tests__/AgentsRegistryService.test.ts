import * as os from "node:os";
import * as path from "node:path";
import { promises as nodeFs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentsRegistryService } from "../AgentsRegistryService";

describe("AgentsRegistryService", () => {
  let service: AgentsRegistryService;
  const testRegistryPath = path.join(os.homedir(), ".tenex", "agents-registry-test.json");
  
  beforeEach(async () => {
    // Create a test service instance with a test registry path
    service = new AgentsRegistryService();
    // Override the registry path for testing
    (service as any).registryPath = testRegistryPath;
    
    // Ensure the directory exists
    await nodeFs.mkdir(path.dirname(testRegistryPath), { recursive: true });
  });

  afterEach(async () => {
    // Clean up test registry file
    try {
      await nodeFs.unlink(testRegistryPath);
    } catch {
      // File might not exist, that's ok
    }
  });

  describe("addAgent and getProjectsForAgent", () => {
    it("should add new agent to empty registry", async () => {
      const projectTag = "test-project-123";
      const agentPubkey = "agent-pubkey-456";
      
      // Mock the publish method to avoid actual network calls
      const originalPublish = (service as any).publishSnapshot;
      (service as any).publishSnapshot = async () => {};
      
      await service.addAgent(projectTag, agentPubkey);
      
      const projects = await service.getProjectsForAgent(agentPubkey);
      expect(projects).toEqual([projectTag]);
      
      // Restore original method
      (service as any).publishSnapshot = originalPublish;
    });

    it("should add agent to existing project", async () => {
      const projectTag = "test-project-123";
      const agent1 = "agent-1";
      const agent2 = "agent-2";
      
      // Mock the publish method
      const originalPublish = (service as any).publishSnapshot;
      (service as any).publishSnapshot = async () => {};
      
      await service.addAgent(projectTag, agent1);
      await service.addAgent(projectTag, agent2);
      
      const projectsAgent1 = await service.getProjectsForAgent(agent1);
      const projectsAgent2 = await service.getProjectsForAgent(agent2);
      
      expect(projectsAgent1).toEqual([projectTag]);
      expect(projectsAgent2).toEqual([projectTag]);
      
      // Verify both agents are in the same project
      const registryData = JSON.parse(
        await nodeFs.readFile(testRegistryPath, "utf-8")
      );
      expect(registryData[projectTag]).toHaveLength(2);
      expect(registryData[projectTag]).toEqual([
        { pubkey: agent1 },
        { pubkey: agent2 }
      ]);
      
      // Restore original method
      (service as any).publishSnapshot = originalPublish;
    });

    it("should not add duplicate agent", async () => {
      const projectTag = "test-project-123";
      const agentPubkey = "agent-pubkey-456";
      
      // Mock the publish method
      const originalPublish = (service as any).publishSnapshot;
      let publishCallCount = 0;
      (service as any).publishSnapshot = async () => { publishCallCount++; };
      
      await service.addAgent(projectTag, agentPubkey);
      await service.addAgent(projectTag, agentPubkey); // Try to add duplicate
      
      const projects = await service.getProjectsForAgent(agentPubkey);
      expect(projects).toEqual([projectTag]);
      
      // Verify only one publish happened (not two)
      expect(publishCallCount).toBe(1);
      
      // Verify only one entry in the registry
      const registryData = JSON.parse(
        await nodeFs.readFile(testRegistryPath, "utf-8")
      );
      expect(registryData[projectTag]).toHaveLength(1);
      
      // Restore original method
      (service as any).publishSnapshot = originalPublish;
    });

    it("should handle agent in multiple projects", async () => {
      const project1 = "project-1";
      const project2 = "project-2";
      const project3 = "project-3";
      const sharedAgent = "shared-agent";
      const uniqueAgent = "unique-agent";
      
      // Mock the publish method
      const originalPublish = (service as any).publishSnapshot;
      (service as any).publishSnapshot = async () => {};
      
      await service.addAgent(project1, sharedAgent);
      await service.addAgent(project2, sharedAgent);
      await service.addAgent(project2, uniqueAgent);
      await service.addAgent(project3, uniqueAgent);
      
      const projectsShared = await service.getProjectsForAgent(sharedAgent);
      const projectsUnique = await service.getProjectsForAgent(uniqueAgent);
      
      expect(projectsShared.sort()).toEqual([project1, project2].sort());
      expect(projectsUnique.sort()).toEqual([project2, project3].sort());
      
      // Restore original method
      (service as any).publishSnapshot = originalPublish;
    });

    it("should return empty array for unknown agent", async () => {
      const projects = await service.getProjectsForAgent("unknown-agent");
      expect(projects).toEqual([]);
    });
  });

  describe("registry persistence", () => {
    it("should persist registry to disk", async () => {
      const projectTag = "persistent-project";
      const agentPubkey = "persistent-agent";
      
      // Mock the publish method
      const originalPublish = (service as any).publishSnapshot;
      (service as any).publishSnapshot = async () => {};
      
      await service.addAgent(projectTag, agentPubkey);
      
      // Create a new service instance to test persistence
      const newService = new AgentsRegistryService();
      (newService as any).registryPath = testRegistryPath;
      
      const projects = await newService.getProjectsForAgent(agentPubkey);
      expect(projects).toEqual([projectTag]);
      
      // Restore original method
      (service as any).publishSnapshot = originalPublish;
    });
  });
});