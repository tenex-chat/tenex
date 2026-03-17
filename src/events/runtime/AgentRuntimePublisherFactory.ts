import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";
import type { AgentRuntimePublisher } from "@/events/runtime/AgentRuntimePublisher";

export type AgentRuntimePublisherFactory = (agent: RuntimePublishAgent) => AgentRuntimePublisher;
