import { describe, expect, it } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { isVoiceMode } from "../20-voice-mode";

describe("isVoiceMode", () => {
  it("should return true when event has voice mode tag", () => {
    const mockEvent = {
      tagValue: (key: string) => (key === "mode" ? "voice" : undefined),
    } as NDKEvent;

    expect(isVoiceMode(mockEvent)).toBe(true);
  });

  it("should return false when event has different mode tag", () => {
    const mockEvent = {
      tagValue: (key: string) => (key === "mode" ? "text" : undefined),
    } as NDKEvent;

    expect(isVoiceMode(mockEvent)).toBe(false);
  });

  it("should return false when event has no mode tag", () => {
    const mockEvent = {
      tagValue: (_key: string) => undefined,
    } as NDKEvent;

    expect(isVoiceMode(mockEvent)).toBe(false);
  });

  it("should return false when event is undefined", () => {
    expect(isVoiceMode(undefined)).toBe(false);
  });
});
