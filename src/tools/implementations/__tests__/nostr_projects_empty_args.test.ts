import { z } from "zod";
import { nostrProjectsTool } from "../nostr_projects";

describe("nostr_projects tool with empty arguments", () => {
  it("should accept empty object", () => {
    const result = nostrProjectsTool.parameters.validate({});
    expect(result.ok).toBe(true);
  });

  it("should accept object with undefined pubkey", () => {
    const result = nostrProjectsTool.parameters.validate({ pubkey: undefined });
    expect(result.ok).toBe(true);
  });

  it("should accept object with valid pubkey", () => {
    const result = nostrProjectsTool.parameters.validate({
      pubkey: "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7",
    });
    expect(result.ok).toBe(true);
  });

  it("should verify schema allows empty object directly", () => {
    // The schema should allow an empty object since pubkey is optional
    const schema = z.object({
      pubkey: z.string().optional(),
    });

    const emptyObjResult = schema.safeParse({});
    expect(emptyObjResult.success).toBe(true);

    const undefinedPubkeyResult = schema.safeParse({ pubkey: undefined });
    expect(undefinedPubkeyResult.success).toBe(true);
  });
});
