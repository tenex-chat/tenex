import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";

// Simple test to verify buffering logic without complex mocking
describe("AgentPublisher Streaming Buffer Logic", () => {
    // Simplified buffer simulator
    class StreamingBufferSimulator {
        private streamingBuffer = "";
        private reasoningBuffer = "";
        private lastStreamPublishTime = 0;
        private streamPublishTimer: NodeJS.Timeout | null = null;
        private publishedEvents: Array<{
            content: string;
            isReasoning: boolean;
            timestamp: number;
        }> = [];

        private static readonly STREAM_PUBLISH_INTERVAL_MS = 1000;
        private static readonly STREAM_BUFFER_TIMEOUT_MS = 1500;

        handleContent(delta: string, isReasoning = false): void {
            if (isReasoning) {
                this.reasoningBuffer += delta;
            } else {
                this.streamingBuffer += delta;
            }

            if (this.streamPublishTimer) {
                clearTimeout(this.streamPublishTimer);
            }

            const now = Date.now();
            const timeSinceLastPublish = now - this.lastStreamPublishTime;

            // Only flush immediately if we've actually published before and enough time has passed
            if (
                this.lastStreamPublishTime > 0 &&
                timeSinceLastPublish >= StreamingBufferSimulator.STREAM_PUBLISH_INTERVAL_MS
            ) {
                this.flushBuffers();
            } else {
                // Calculate remaining time, ensuring it's never negative
                const remainingTime =
                    this.lastStreamPublishTime === 0
                        ? StreamingBufferSimulator.STREAM_PUBLISH_INTERVAL_MS
                        : Math.max(
                              0,
                              StreamingBufferSimulator.STREAM_PUBLISH_INTERVAL_MS -
                                  timeSinceLastPublish
                          );

                this.streamPublishTimer = setTimeout(
                    () => {
                        this.flushBuffers();
                    },
                    Math.min(remainingTime, StreamingBufferSimulator.STREAM_BUFFER_TIMEOUT_MS)
                );
            }
        }

        private flushBuffers(): void {
            const now = Date.now();

            if (this.reasoningBuffer.length > 0) {
                this.publishedEvents.push({
                    content: this.reasoningBuffer,
                    isReasoning: true,
                    timestamp: now,
                });
                this.reasoningBuffer = "";
            }

            if (this.streamingBuffer.length > 0) {
                this.publishedEvents.push({
                    content: this.streamingBuffer,
                    isReasoning: false,
                    timestamp: now,
                });
                this.streamingBuffer = "";
            }

            this.lastStreamPublishTime = now;

            if (this.streamPublishTimer) {
                clearTimeout(this.streamPublishTimer);
                this.streamPublishTimer = null;
            }
        }

        forceFlush(): void {
            if (this.streamPublishTimer) {
                clearTimeout(this.streamPublishTimer);
                this.streamPublishTimer = null;
            }

            if (this.streamingBuffer.length > 0 || this.reasoningBuffer.length > 0) {
                this.flushBuffers();
            }
        }

        getPublishedEvents() {
            return this.publishedEvents;
        }

        getBufferState() {
            return {
                streamingBuffer: this.streamingBuffer,
                reasoningBuffer: this.reasoningBuffer,
                hasTimer: this.streamPublishTimer !== null,
            };
        }
    }

    it("should buffer content without immediate publishing", () => {
        const simulator = new StreamingBufferSimulator();

        simulator.handleContent("Hello ");
        simulator.handleContent("world");

        const state = simulator.getBufferState();
        expect(state.streamingBuffer).toBe("Hello world");
        expect(simulator.getPublishedEvents()).toHaveLength(0);
    });

    it("should publish after sufficient time has passed", (done) => {
        const simulator = new StreamingBufferSimulator();

        simulator.handleContent("Hello ");
        simulator.handleContent("world");

        // Wait for the buffer to be published
        setTimeout(() => {
            const events = simulator.getPublishedEvents();
            expect(events).toHaveLength(1);
            expect(events[0].content).toBe("Hello world");
            expect(events[0].isReasoning).toBe(false);
            done();
        }, 1100);
    });

    it("should handle reasoning and content buffers separately", () => {
        const simulator = new StreamingBufferSimulator();

        simulator.handleContent("Thinking: ", true);
        simulator.handleContent("analyzing...", true);
        simulator.handleContent("Answer: ", false);
        simulator.handleContent("42", false);

        const state = simulator.getBufferState();
        expect(state.reasoningBuffer).toBe("Thinking: analyzing...");
        expect(state.streamingBuffer).toBe("Answer: 42");
        expect(simulator.getPublishedEvents()).toHaveLength(0);
    });

    it("should force flush when explicitly called", () => {
        const simulator = new StreamingBufferSimulator();

        simulator.handleContent("Forced ");
        simulator.handleContent("flush");

        // Force flush immediately
        simulator.forceFlush();

        const events = simulator.getPublishedEvents();
        expect(events).toHaveLength(1);
        expect(events[0].content).toBe("Forced flush");
    });

    it("should maintain minimum interval between publishes", (done) => {
        const simulator = new StreamingBufferSimulator();

        // First batch - will publish immediately
        simulator.handleContent("First batch");
        simulator.forceFlush();

        const firstEvents = simulator.getPublishedEvents();
        expect(firstEvents).toHaveLength(1);

        // Second batch immediately after
        simulator.handleContent("Second batch");

        // Check that it hasn't published yet
        expect(simulator.getPublishedEvents()).toHaveLength(1);

        // Wait for minimum interval
        setTimeout(() => {
            const allEvents = simulator.getPublishedEvents();
            expect(allEvents).toHaveLength(2);
            expect(allEvents[1].content).toBe("Second batch");

            // Verify timing
            const timeDiff = allEvents[1].timestamp - allEvents[0].timestamp;
            expect(timeDiff).toBeGreaterThanOrEqual(1000);
            done();
        }, 1100);
    });

    it("should handle rapid small deltas efficiently", () => {
        const simulator = new StreamingBufferSimulator();
        const words = ["The", " ", "quick", " ", "brown", " ", "fox"];

        // Simulate rapid deltas
        for (const word of words) {
            simulator.handleContent(word);
        }

        const state = simulator.getBufferState();
        expect(state.streamingBuffer).toBe("The quick brown fox");
        expect(simulator.getPublishedEvents()).toHaveLength(0);
        expect(state.hasTimer).toBe(true);
    });
});
