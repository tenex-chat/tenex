import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, type NDKRawEvent } from "@nostr-dev-kit/ndk";

export class NDKAgentDefinition extends NDKEvent {
  static kind = 4199;
  static kinds = [4199];

  constructor(ndk?: NDK, event?: NDKEvent | NDKRawEvent) {
    super(ndk, event);
    this.kind ??= 4199;
  }

  static from(event: NDKEvent): NDKAgentDefinition {
    return new NDKAgentDefinition(event.ndk, event);
  }

  get name(): string | undefined {
    return this.tagValue("title");
  }

  set name(value: string | undefined) {
    this.removeTag("title");
    if (value) this.tags.push(["title", value]);
  }

  get title(): string | undefined {
    return this.tagValue("title");
  }

  set title(value: string | undefined) {
    this.removeTag("title");
    if (value) this.tags.push(["title", value]);
  }

  get description(): string | undefined {
    return this.tagValue("description");
  }

  /**
   * A one-liner description of the agent's purpose or functionality.
   */
  set description(value: string | undefined) {
    this.removeTag("description");
    if (value) this.tags.push(["description", value]);
  }

  get role(): string | undefined {
    return this.tagValue("role");
  }

  /**
   * The expertise and personality for this agent.
   * This shapes how the agent interacts with users and other agents.
   */
  set role(value: string | undefined) {
    this.removeTag("role");
    if (value) this.tags.push(["role", value]);
  }

  get instructions(): string | undefined {
    return this.tagValue("instructions");
  }

  /**
   * Detailed instructions or guidelines for the agent's operation.
   */
  set instructions(value: string | undefined) {
    this.removeTag("instructions");
    if (value) this.tags.push(["instructions", value]);
  }

  get version(): number {
    const val = this.tagValue("ver");
    if (val === undefined) return 1; // Default version if not specified
    return Number.parseInt(val, 10);
  }

  set version(value: number) {
    this.removeTag("ver");
    this.tags.push(["ver", value.toString()]);
  }

  get useCriteria(): string | undefined {
    return this.tagValue("use-criteria");
  }

  /**
   * Criteria for when this agent should be selected or used.
   * This helps with agent routing and selection.
   */
  set useCriteria(value: string | undefined) {
    this.removeTag("use-criteria");
    if (value) this.tags.push(["use-criteria", value]);
  }
}
