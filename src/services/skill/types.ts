/**
 * Skill types — local-only skill bundles installed on disk.
 *
 * Skills are instruction bundles loaded from the agent/project/shared/built-in
 * skill directories. They can be injected into agent system prompts and may
 * declare tools via SKILL.md frontmatter.
 */

/**
 * Result describing a file that lives inside a skill directory.
 */
export interface SkillFileInstallResult {
    /** Relative path within the skill directory */
    relativePath: string;
    /** Absolute path on disk */
    absolutePath: string;
    /** Whether the file is readable / valid */
    success: boolean;
    /** Error message when the file could not be loaded */
    error?: string;
}

/**
 * Context used when resolving the effective local skill set.
 *
 * Resolution precedence is:
 * 1. agent home (`$TENEX_BASE_DIR/home/<agent-short-pubkey>/skills`)
 * 2. agent-project (`<projectPath>/.agents/<agent-short-pubkey>/skills`)
 * 3. project shared (`<projectPath>/.agents/skills`)
 * 4. shared (`~/.agents/skills`)
 * 5. built-in (bundled with source)
 */
export interface SkillLookupContext {
    /** Agent pubkey whose home-scoped and agent-project skills should be considered */
    agentPubkey?: string;
    /** Project repository base path for project-scoped skills */
    projectPath?: string;
}

/**
 * Individual skill data with content, name, and attached files
 */
export type SkillStoreScope = "agent" | "agent-project" | "project" | "shared" | "built-in";

/**
 * Individual skill data with content, name, and attached files
 */
export interface SkillData {
    /** Local authoritative skill ID (directory name in the effective local skill set) */
    identifier: string;
    /** Short description from SKILL.md frontmatter, when available */
    description?: string;
    /** The skill content/instructions */
    content: string;
    /** The skill name/label from SKILL.md frontmatter */
    name?: string;
    /** List of installed files for this skill */
    installedFiles: SkillFileInstallResult[];
    /**
     * Absolute path to this skill's local directory.
     * Used by SkillToolLoader to locate the tools/ subdirectory.
     */
    /** Which skill store scope this skill was loaded from */
    scope?: SkillStoreScope;
    localDir?: string;
    /**
     * Tool names declared in the skill's SKILL.md frontmatter.
     * Informational — used for prompt display (Provides: / Unlocks: labels).
     * The actual tool objects are in loadedTools (populated at RAL setup time).
     */
    toolNames?: string[];
    /**
     * Loaded AI SDK tool implementations from the skill's tools/ directory.
     * Populated by SkillToolLoader at RAL setup time (not during fetchSkills).
     * Undefined for content-only skills or before loading.
     */
    loadedTools?: Record<string, import("ai").Tool>;
}

/**
 * Tool permissions extracted from skill event tags.
 * Used to modify an agent's available tools during execution.
 *
 * Precedence: only-tool > allow-tool/deny-tool
 */
export interface SkillToolPermissions {
    /**
     * If set, the agent gets EXACTLY these tools (and nothing else).
     * This is the highest priority - completely overrides allow/deny and agent defaults.
     * Tag format: ["only-tool", "tool_name"]
     */
    onlyTools?: string[];

    /**
     * Tools to enable (add to agent's default set).
     * Ignored if onlyTools is set.
     * Tag format: ["allow-tool", "tool_name"]
     */
    allowTools?: string[];

    /**
     * Tools to disable (remove from agent's default set).
     * Ignored if onlyTools is set.
     * Tag format: ["deny-tool", "tool_name"]
     */
    denyTools?: string[];
}

/**
 * Result from fetching skills with their attached files.
 * Contains both the concatenated content for system prompt injection
 * and the individual skill data with file information.
 */
export interface SkillResult {
    /** Individual skill data for rendering in the fragment */
    skills: SkillData[];

    /** Concatenated content from all skills (for backward compatibility) */
    content: string;

    /** Tool permissions aggregated across all active skills */
    toolPermissions: SkillToolPermissions;
}
