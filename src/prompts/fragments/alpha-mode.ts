import type { PromptFragment } from "../core/types";

/**
 * Fragment for alpha mode - warns agents about potential bugs and provides bug reporting tools
 */
export const alphaModeFragment: PromptFragment<{ enabled: boolean }> = {
    id: "alpha-mode",
    priority: 5, // Early in prompt, but after agent identity
    template: (data) => {
        if (!data.enabled) return "";

        return `
=== TENEX ALPHA MODE ===

You are running in TENEX Alpha Mode. This is a pre-release version where:
- Tooling may be buggy or incomplete
- Conversation tracking could have issues
- Unexpected behaviors may occur

IMPORTANT: If you encounter bugs, errors, or unexpected behavior, please report them:

1. **Check existing bugs**: Use the \`bug_list\` tool to see if your issue has already been reported
2. **Report new bugs**: Use \`bug_report_create\` with a clear title and detailed description
3. **Add to existing bugs**: Use \`bug_report_add\` to add context, reproduction steps, or observations to existing bug reports

What to report:
- Tool failures or unexpected results
- Conversation tracking issues (lost context, wrong routing)
- System errors or crashes
- Confusing or inconsistent behavior
- Missing functionality that seems like it should exist

Please help improve TENEX by reporting any issues you encounter!

=== END ALPHA MODE ===`;
    },
};
