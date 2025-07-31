import { PromptBuilder } from "../../core/PromptBuilder";
import "../orchestrator-routing"; // Ensure fragments are registered

describe("Orchestrator Routing Fragments", () => {
    it("should generate orchestrator routing instructions", () => {
        const prompt = new PromptBuilder().add("orchestrator-routing-instructions", {}).build();

        expect(prompt).toContain("## Silent Orchestrator Routing Instructions");
        expect(prompt).toContain("CRITICAL: You Are Invisible");
        expect(prompt).toContain("Pure Routing Rules");
        expect(prompt).toContain("Phase Decision Logic");
        expect(prompt).toContain("Quality Control Guidelines");
        expect(prompt).toContain("EXECUTE Phase Process");
        expect(prompt).toContain("Phase Sequence");
    });
});
