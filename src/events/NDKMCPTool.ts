import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, type NDKRawEvent } from "@nostr-dev-kit/ndk";

export class NDKMCPTool extends NDKEvent {
  static kind = 4200;
  static kinds = [4200];

  constructor(ndk?: NDK, event?: NDKEvent | NDKRawEvent) {
    super(ndk, event);
    this.kind ??= 4200;
  }

  static from(event: NDKEvent): NDKMCPTool {
    return new NDKMCPTool(event.ndk, event);
  }

  get name(): string | undefined {
    return this.tagValue("name");
  }

  set name(value: string | undefined) {
    this.removeTag("name");
    if (value) this.tags.push(["name", value]);
  }

  get description(): string | undefined {
    return this.tagValue("description");
  }

  set description(value: string | undefined) {
    this.removeTag("description");
    if (value) this.tags.push(["description", value]);
  }

  get command(): string | undefined {
    return this.tagValue("command");
  }

  set command(value: string | undefined) {
    this.removeTag("command");
    if (value) this.tags.push(["command", value]);
  }

  get image(): string | undefined {
    return this.tagValue("image");
  }

  set image(value: string | undefined) {
    this.removeTag("image");
    if (value) this.tags.push(["image", value]);
  }

  get slug(): string {
    const name = this.name || "unnamed";
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
}
