/**
 * StatusPublisher tests using NDK test utilities
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EVENT_KINDS } from "@/llm/types";
import { StatusPublisher } from "../StatusPublisher";
import { 
  TENEXTestFixture,
  withTestEnvironment,
  RelayMock,
  getTestUserWithSigner 
} from "@/test-utils/ndk-test-helpers";
import { NDKKind } from "@nostr-dev-kit/ndk";

describe("StatusPublisher with NDK utilities", () => {
  let publisher: StatusPublisher;
  let fixture: TENEXTestFixture;

  beforeEach(() => {
    fixture = new TENEXTestFixture();
    publisher = new StatusPublisher();
  });

  afterEach(() => {
    publisher.stopPublishing();
    fixture.cleanup();
  });

  describe("status event publishing", () => {
    it("should publish properly signed status events", async () => {
      await withTestEnvironment(async (fixture) => {
        // Setup project context with real signers
        const { user: projectOwner, signer } = await getTestUserWithSigner("alice", fixture.ndk);
        const agent1 = await fixture.getUser("bob");
        const agent2 = await fixture.getUser("carol");

        // Mock project context
        mock.module("@/services", () => ({
          getProjectContext: () => ({
            project: { 
              id: "test-project",
              pubkey: projectOwner.pubkey,
              tagReference: () => ["a", `31933:${projectOwner.pubkey}:test-project`]
            },
            signer,
            agents: new Map([
              ["agent1", { pubkey: agent1.pubkey, name: "Agent 1", slug: "agent1" }],
              ["agent2", { pubkey: agent2.pubkey, name: "Agent 2", slug: "agent2" }],
            ]),
          }),
          isProjectContextInitialized: () => true,
          configService: {
            loadConfig: mock(async () => ({
              llms: {
                configurations: {
                  config1: { model: "gpt-4", provider: "openai" },
                  config2: { model: "claude-3", provider: "anthropic" },
                },
                defaults: {
                  agent1: "config1",
                  agent2: "config2",
                },
              },
            })),
          },
        }));

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        // Create relay for status updates
        const statusRelay = fixture.createMockRelay("wss://status.relay");
        await statusRelay.connect();

        // Start publishing
        await publisher.startPublishing("/test/project");

        // Wait for initial status to be published
        await new Promise(resolve => setTimeout(resolve, 100));

        // Check that status event was sent to relay
        const statusMessage = statusRelay.messageLog.find(
          log => log.direction === "out" && log.message.includes("EVENT")
        );
        expect(statusMessage).toBeDefined();

        // Parse the event from the message
        const [, eventData] = JSON.parse(statusMessage!.message);
        
        // Verify event structure
        expect(eventData.kind).toBe(NDKKind.Text);
        expect(eventData.pubkey).toBe(projectOwner.pubkey);
        expect(eventData.tags).toContainEqual(
          expect.arrayContaining(["status", "online"])
        );
      });
    });

    it("should handle periodic status updates with time control", async () => {
      await withTestEnvironment(async (fixture, timeControl) => {
        const { signer } = await getTestUserWithSigner("dave", fixture.ndk);
        
        // Mock simplified context
        mock.module("@/services", () => ({
          getProjectContext: () => ({
            project: { 
              id: "periodic-project",
              pubkey: "project-pubkey",
              tagReference: () => ["a", "31933:project-pubkey:periodic-project"]
            },
            signer,
            agents: new Map(),
          }),
          isProjectContextInitialized: () => true,
          configService: {
            loadConfig: mock(async () => ({ llms: { configurations: {}, defaults: {} } })),
          },
        }));

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        const relay = fixture.createMockRelay("wss://periodic.relay");
        await relay.connect();

        // Start publishing
        await publisher.startPublishing("/test/project");

        // Capture initial publish count
        const initialCount = relay.messageLog.filter(
          log => log.direction === "out" && log.message.includes("EVENT")
        ).length;

        // Advance time by 30 seconds (default interval)
        timeControl.advance(30000);
        await new Promise(resolve => setImmediate(resolve));

        // Check for additional status update
        const afterAdvanceCount = relay.messageLog.filter(
          log => log.direction === "out" && log.message.includes("EVENT")
        ).length;

        expect(afterAdvanceCount).toBeGreaterThan(initialCount);
      });
    });

    it("should include agent and model information in status", async () => {
      await withTestEnvironment(async (fixture) => {
        const { user: projectOwner, signer } = await getTestUserWithSigner("eve", fixture.ndk);
        const agent1 = await fixture.getUser("alice");
        const agent2 = await fixture.getUser("bob");

        mock.module("@/services", () => ({
          getProjectContext: () => ({
            project: { 
              id: "detailed-project",
              pubkey: projectOwner.pubkey,
              tagReference: () => ["a", `31933:${projectOwner.pubkey}:detailed-project`]
            },
            signer,
            agents: new Map([
              ["analyzer", { pubkey: agent1.pubkey, name: "Analyzer", slug: "analyzer" }],
              ["validator", { pubkey: agent2.pubkey, name: "Validator", slug: "validator" }],
            ]),
          }),
          isProjectContextInitialized: () => true,
          configService: {
            loadConfig: mock(async () => ({
              llms: {
                configurations: {
                  fast: { model: "gpt-4-turbo", provider: "openai" },
                  accurate: { model: "claude-3-opus", provider: "anthropic" },
                },
                defaults: {
                  analyzer: "fast",
                  validator: "accurate",
                },
              },
            })),
          },
        }));

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        const relay = fixture.createMockRelay("wss://detailed.relay");
        await relay.connect();

        await publisher.startPublishing("/test/project");

        // Wait for status event
        await new Promise(resolve => setTimeout(resolve, 100));

        // Find and parse the status event
        const statusMessage = relay.messageLog.find(
          log => log.direction === "out" && log.message.includes("EVENT")
        );
        const [, eventData] = JSON.parse(statusMessage!.message);

        // Verify agent tags
        const agentTags = eventData.tags.filter((tag: string[]) => tag[0] === "agent");
        expect(agentTags).toHaveLength(2);
        expect(agentTags).toContainEqual(["agent", agent1.pubkey, "analyzer"]);
        expect(agentTags).toContainEqual(["agent", agent2.pubkey, "validator"]);

        // Verify model tags
        const modelTags = eventData.tags.filter((tag: string[]) => tag[0] === "model");
        expect(modelTags).toContainEqual(expect.arrayContaining(["model", "fast"]));
        expect(modelTags).toContainEqual(expect.arrayContaining(["model", "accurate"]));
      });
    });

    it("should handle relay failures gracefully", async () => {
      await withTestEnvironment(async (fixture) => {
        const { signer } = await getTestUserWithSigner("alice", fixture.ndk);

        mock.module("@/services", () => ({
          getProjectContext: () => ({
            project: { 
              id: "fail-project",
              pubkey: "project-pubkey",
              tagReference: () => ["a", "31933:project-pubkey:fail-project"]
            },
            signer,
            agents: new Map(),
          }),
          isProjectContextInitialized: () => true,
          configService: {
            loadConfig: mock(async () => ({ llms: { configurations: {}, defaults: {} } })),
          },
        }));

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        // Create failing relay
        const failingRelay = fixture.createMockRelay("wss://failing.relay", {
          failNextPublish: true
        });
        await failingRelay.connect();

        // Start publishing should not throw even if relay fails
        await expect(publisher.startPublishing("/test/project")).resolves.not.toThrow();

        // Publisher should continue running despite relay failure
        expect(publisher.isPublishing()).toBe(true);
      });
    });

    it("should stop publishing on command", async () => {
      await withTestEnvironment(async (fixture) => {
        const { signer } = await getTestUserWithSigner("bob", fixture.ndk);

        mock.module("@/services", () => ({
          getProjectContext: () => ({
            project: { 
              id: "stop-project",
              pubkey: "project-pubkey",
              tagReference: () => ["a", "31933:project-pubkey:stop-project"]
            },
            signer,
            agents: new Map(),
          }),
          isProjectContextInitialized: () => true,
          configService: {
            loadConfig: mock(async () => ({ llms: { configurations: {}, defaults: {} } })),
          },
        }));

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        const relay = fixture.createMockRelay("wss://stop.relay");
        await relay.connect();

        // Start publishing
        await publisher.startPublishing("/test/project");
        expect(publisher.isPublishing()).toBe(true);

        // Count initial events
        const initialCount = relay.messageLog.filter(
          log => log.direction === "out" && log.message.includes("EVENT")
        ).length;

        // Stop publishing
        publisher.stopPublishing();
        expect(publisher.isPublishing()).toBe(false);

        // Wait and verify no new events are published
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const finalCount = relay.messageLog.filter(
          log => log.direction === "out" && log.message.includes("EVENT")
        ).length;

        expect(finalCount).toBe(initialCount);
      });
    });
  });

  describe("queue management", () => {
    it("should update queue status", async () => {
      await withTestEnvironment(async (fixture) => {
        const { signer } = await getTestUserWithSigner("carol", fixture.ndk);

        mock.module("@/services", () => ({
          getProjectContext: () => ({
            project: { 
              id: "queue-project",
              pubkey: "project-pubkey",
              tagReference: () => ["a", "31933:project-pubkey:queue-project"]
            },
            signer,
            agents: new Map(),
          }),
          isProjectContextInitialized: () => true,
          configService: {
            loadConfig: mock(async () => ({ llms: { configurations: {}, defaults: {} } })),
          },
        }));

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        const relay = fixture.createMockRelay("wss://queue.relay");
        await relay.connect();

        await publisher.startPublishing("/test/project");

        // Add items to queue
        publisher.updateQueueStatus(["task-1", "task-2", "task-3"]);

        // Trigger immediate publish
        await publisher.publishStatus();

        // Find the latest status event
        const statusMessages = relay.messageLog.filter(
          log => log.direction === "out" && log.message.includes("EVENT")
        );
        const latestMessage = statusMessages[statusMessages.length - 1];
        const [, eventData] = JSON.parse(latestMessage.message);

        // Verify queue tags
        const queueTags = eventData.tags.filter((tag: string[]) => tag[0] === "queue");
        expect(queueTags).toHaveLength(3);
        expect(queueTags).toContainEqual(["queue", "task-1"]);
        expect(queueTags).toContainEqual(["queue", "task-2"]);
        expect(queueTags).toContainEqual(["queue", "task-3"]);
      });
    });
  });
});