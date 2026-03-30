#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { agentStorage, deriveAgentPubkeyFromNsec, type StoredAgent } from "@/agents/AgentStorage";
import { getDTag } from "@/nostr/TagExtractor";
import { getNDK, initNDK, shutdownNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { Nip46SigningService } from "@/services/nip46";
import { NDKEvent } from "@nostr-dev-kit/ndk";

type CliOptions = {
    dryRun: boolean;
    ownerPubkeys: string[];
    projectDTags: string[];
};

type ProjectMigrationPlan = {
    event: NDKEvent;
    projectDTag: string;
    updatedTags: string[][];
    ownerPubkey: string;
    currentAgentPubkeys: string[];
    collaboratorPubkeys: string[];
    unresolvedLegacyAgentEventIds: string[];
    usedLegacyAgentFallback: boolean;
};

type MigrationSummary = {
    scanned: number;
    deleted: number;
    alreadyCurrent: number;
    migrated: number;
    dryRun: number;
    skippedNoDTag: number;
    skippedNoConfiguredOwners: number;
    failed: number;
};

type AgentCandidate = {
    pubkey: string;
    slug: string;
    projectCount: number;
};

type SimilarAgentGroup = {
    agents: AgentCandidate[];
};

const SLUG_SIMILARITY_THRESHOLD = 0.8;

function printUsage(): void {
    console.log(`Usage: bun run scripts/migrate-project-agent-pubkeys.ts [options]

Republish existing kind:31933 projects with:
- lowercase "p" tags for assigned agent pubkeys
- uppercase "P" tags for collaborator pubkeys
- legacy "agent" tags removed

Options:
  --dry-run           Show what would change without requesting signatures
  --owner <pubkey>    Limit to one owner pubkey (repeatable)
  --project <d-tag>   Limit to one project d-tag (repeatable)
  --help              Show this help
`);
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        dryRun: false,
        ownerPubkeys: [],
        projectDTags: [],
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        switch (arg) {
            case "--dry-run":
                options.dryRun = true;
                break;
            case "--owner": {
                const value = argv[++i];
                if (!value) {
                    throw new Error("--owner requires a pubkey");
                }
                options.ownerPubkeys.push(value.trim());
                break;
            }
            case "--project": {
                const value = argv[++i];
                if (!value) {
                    throw new Error("--project requires a d-tag");
                }
                options.projectDTags.push(value.trim());
                break;
            }
            case "--help":
            case "-h":
                printUsage();
                process.exit(0);
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

function isDeletedProject(event: NDKEvent): boolean {
    return event.tags.some((tag) => tag[0] === "deleted");
}

function shortPubkey(pubkey: string): string {
    return pubkey.length <= 16
        ? pubkey
        : `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
}

function normalizeSlug(slug: string): string {
    return slug
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-+/g, "-");
}

function levenshteinDistance(left: string, right: string): number {
    if (left === right) {
        return 0;
    }

    if (left.length === 0) {
        return right.length;
    }

    if (right.length === 0) {
        return left.length;
    }

    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    const current = new Array<number>(right.length + 1).fill(0);

    for (let i = 1; i <= left.length; i++) {
        current[0] = i;

        for (let j = 1; j <= right.length; j++) {
            const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + substitutionCost,
            );
        }

        for (let j = 0; j <= right.length; j++) {
            previous[j] = current[j];
        }
    }

    return previous[right.length];
}

function stringSimilarity(left: string, right: string): number {
    if (!left && !right) {
        return 1;
    }

    const maxLength = Math.max(left.length, right.length);
    if (maxLength === 0) {
        return 1;
    }

    return 1 - (levenshteinDistance(left, right) / maxLength);
}

function slugSimilarity(leftSlug: string, rightSlug: string): number {
    const left = normalizeSlug(leftSlug);
    const right = normalizeSlug(rightSlug);

    if (!left || !right) {
        return 0;
    }

    if (left === right) {
        return 1;
    }

    const flatSimilarity = stringSimilarity(
        left.replace(/-/g, ""),
        right.replace(/-/g, ""),
    );

    const leftTokens = left.split("-");
    const rightTokens = right.split("-");
    const tokenSlots = Math.max(leftTokens.length, rightTokens.length);
    let tokenSimilarityTotal = 0;

    for (let index = 0; index < tokenSlots; index++) {
        tokenSimilarityTotal += stringSimilarity(
            leftTokens[index] ?? "",
            rightTokens[index] ?? "",
        );
    }

    const tokenSimilarity = tokenSlots > 0
        ? tokenSimilarityTotal / tokenSlots
        : 0;

    return (flatSimilarity * 0.65) + (tokenSimilarity * 0.35);
}

function shouldReplaceProject(existing: NDKEvent | undefined, candidate: NDKEvent): boolean {
    if (!existing) {
        return true;
    }

    const existingCreatedAt = existing.created_at ?? 0;
    const candidateCreatedAt = candidate.created_at ?? 0;

    return (
        candidateCreatedAt > existingCreatedAt
        || (
            candidateCreatedAt === existingCreatedAt
            && isDeletedProject(candidate)
            && !isDeletedProject(existing)
        )
    );
}

function normalizeOwners(cliOwners: string[]): string[] {
    const owners = cliOwners.length > 0
        ? cliOwners
        : config.getWhitelistedPubkeys();

    return [...new Set(owners.map((value) => value.trim()).filter(Boolean))];
}

async function fetchLatestProjects(ownerPubkeys: string[], projectDTags: Set<string>): Promise<NDKEvent[]> {
    const ndk = getNDK();
    const events = await ndk.fetchEvents({
        kinds: [31933],
        authors: ownerPubkeys,
    });

    const latestByATag = new Map<string, NDKEvent>();

    for (const event of events) {
        const projectDTag = getDTag(event);
        if (!projectDTag) {
            continue;
        }

        if (projectDTags.size > 0 && !projectDTags.has(projectDTag)) {
            continue;
        }

        const aTag = `31933:${event.pubkey}:${projectDTag}`;
        const existing = latestByATag.get(aTag);
        if (shouldReplaceProject(existing, event)) {
            latestByATag.set(aTag, event);
        }
    }

    return Array.from(latestByATag.values()).sort((left, right) => {
        const byOwner = left.pubkey.localeCompare(right.pubkey);
        if (byOwner !== 0) {
            return byOwner;
        }

        const leftDTag = getDTag(left) ?? "";
        const rightDTag = getDTag(right) ?? "";
        return leftDTag.localeCompare(rightDTag);
    });
}

async function resolveAgentPubkey(agent: StoredAgent | null): Promise<string | null> {
    if (!agent) {
        return null;
    }

    return deriveAgentPubkeyFromNsec(agent.nsec);
}

async function buildCurrentAgentPubkeys(projectDTag: string, event: NDKEvent): Promise<{
    currentAgentPubkeys: string[];
    unresolvedLegacyAgentEventIds: string[];
    usedLegacyAgentFallback: boolean;
}> {
    const localProjectAgentPubkeys = await agentStorage.getProjectAgentPubkeys(projectDTag);

    const legacyOrderedPubkeys: string[] = [];
    const unresolvedLegacyAgentEventIds: string[] = [];
    const seenLegacyPubkeys = new Set<string>();

    for (const tag of event.tags) {
        if (tag[0] !== "agent" || !tag[1]) {
            continue;
        }

        const agent = await agentStorage.getAgentByEventId(tag[1]);
        const pubkey = await resolveAgentPubkey(agent);
        if (!pubkey) {
            unresolvedLegacyAgentEventIds.push(tag[1]);
            continue;
        }

        if (seenLegacyPubkeys.has(pubkey)) {
            continue;
        }

        seenLegacyPubkeys.add(pubkey);
        legacyOrderedPubkeys.push(pubkey);
    }

    if (localProjectAgentPubkeys.length === 0) {
        if (legacyOrderedPubkeys.length > 0) {
            return {
                currentAgentPubkeys: legacyOrderedPubkeys,
                unresolvedLegacyAgentEventIds,
                usedLegacyAgentFallback: true,
            };
        }

        // Safety fallback: preserve existing lowercase p-tags if this project
        // already appears migrated but local byProject membership is empty.
        const existingPTagPubkeys = event.tags
            .filter((tag) => tag[0] === "p" && tag[1])
            .map((tag) => tag[1] as string)
            .filter((value, index, all) => all.indexOf(value) === index);

        return {
            currentAgentPubkeys: existingPTagPubkeys,
            unresolvedLegacyAgentEventIds,
            usedLegacyAgentFallback: false,
        };
    }

    const authoritativeSet = new Set(localProjectAgentPubkeys);
    const currentAgentPubkeys: string[] = [];
    const seenCurrent = new Set<string>();

    // Preserve already-migrated p-tag order when it still matches current local membership.
    for (const tag of event.tags) {
        const pubkey = tag[0] === "p" ? tag[1] : undefined;
        if (!pubkey || !authoritativeSet.has(pubkey) || seenCurrent.has(pubkey)) {
            continue;
        }
        seenCurrent.add(pubkey);
        currentAgentPubkeys.push(pubkey);
    }

    // Preserve legacy agent tag order where possible.
    for (const pubkey of legacyOrderedPubkeys) {
        if (!authoritativeSet.has(pubkey) || seenCurrent.has(pubkey)) {
            continue;
        }
        seenCurrent.add(pubkey);
        currentAgentPubkeys.push(pubkey);
    }

    // Append any remaining local-only memberships.
    for (const pubkey of localProjectAgentPubkeys) {
        if (seenCurrent.has(pubkey)) {
            continue;
        }
        seenCurrent.add(pubkey);
        currentAgentPubkeys.push(pubkey);
    }

    return {
        currentAgentPubkeys,
        unresolvedLegacyAgentEventIds,
        usedLegacyAgentFallback: false,
    };
}

function buildCollaboratorPubkeys(event: NDKEvent, currentAgentPubkeys: string[]): string[] {
    const currentAgentSet = new Set(currentAgentPubkeys);
    const collaborators: string[] = [];
    const seen = new Set<string>();

    for (const tag of event.tags) {
        const [name, value] = tag;
        if (!value) {
            continue;
        }

        if (name === "P") {
            if (!seen.has(value)) {
                seen.add(value);
                collaborators.push(value);
            }
            continue;
        }

        if (name === "p" && !currentAgentSet.has(value)) {
            if (!seen.has(value)) {
                seen.add(value);
                collaborators.push(value);
            }
        }
    }

    return collaborators;
}

function buildUpdatedProjectTags(
    event: NDKEvent,
    collaboratorPubkeys: string[],
    currentAgentPubkeys: string[],
): string[][] {
    const preservedTags = event.tags.filter((tag) => {
        const name = tag[0];
        return name !== "agent" && name !== "p" && name !== "P";
    });

    return [
        ...preservedTags,
        ...collaboratorPubkeys.map((pubkey) => ["P", pubkey]),
        ...currentAgentPubkeys.map((pubkey) => ["p", pubkey]),
    ];
}

function tagsEqual(left: string[][], right: string[][]): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function buildMigrationPlan(event: NDKEvent): Promise<ProjectMigrationPlan | null> {
    const projectDTag = getDTag(event);
    if (!projectDTag) {
        return null;
    }

    const {
        currentAgentPubkeys,
        unresolvedLegacyAgentEventIds,
        usedLegacyAgentFallback,
    } = await buildCurrentAgentPubkeys(projectDTag, event);

    const collaboratorPubkeys = buildCollaboratorPubkeys(event, currentAgentPubkeys);
    const updatedTags = buildUpdatedProjectTags(event, collaboratorPubkeys, currentAgentPubkeys);

    return {
        event,
        projectDTag,
        updatedTags,
        ownerPubkey: event.pubkey,
        currentAgentPubkeys,
        collaboratorPubkeys,
        unresolvedLegacyAgentEventIds,
        usedLegacyAgentFallback,
    };
}

async function collectAgentCandidates(plans: ProjectMigrationPlan[]): Promise<AgentCandidate[]> {
    const projectCounts = new Map<string, Set<string>>();

    for (const plan of plans) {
        for (const pubkey of plan.currentAgentPubkeys) {
            if (!projectCounts.has(pubkey)) {
                projectCounts.set(pubkey, new Set<string>());
            }
            projectCounts.get(pubkey)?.add(plan.projectDTag);
        }
    }

    const candidates: AgentCandidate[] = [];

    for (const [pubkey, projects] of projectCounts.entries()) {
        const agent = await agentStorage.loadAgent(pubkey);
        if (!agent?.slug) {
            continue;
        }

        candidates.push({
            pubkey,
            slug: agent.slug,
            projectCount: projects.size,
        });
    }

    return candidates.sort((left, right) => {
        const bySlug = left.slug.localeCompare(right.slug);
        if (bySlug !== 0) {
            return bySlug;
        }

        return left.pubkey.localeCompare(right.pubkey);
    });
}

function buildSimilarAgentGroups(candidates: AgentCandidate[]): SimilarAgentGroup[] {
    const parent = new Map<string, string>();

    for (const candidate of candidates) {
        parent.set(candidate.pubkey, candidate.pubkey);
    }

    const find = (pubkey: string): string => {
        const currentParent = parent.get(pubkey);
        if (!currentParent || currentParent === pubkey) {
            return pubkey;
        }

        const root = find(currentParent);
        parent.set(pubkey, root);
        return root;
    };

    const union = (left: string, right: string): void => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) {
            parent.set(rightRoot, leftRoot);
        }
    };

    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex++) {
            const left = candidates[leftIndex];
            const right = candidates[rightIndex];
            if (slugSimilarity(left.slug, right.slug) >= SLUG_SIMILARITY_THRESHOLD) {
                union(left.pubkey, right.pubkey);
            }
        }
    }

    const groups = new Map<string, AgentCandidate[]>();
    for (const candidate of candidates) {
        const root = find(candidate.pubkey);
        const existing = groups.get(root) ?? [];
        existing.push(candidate);
        groups.set(root, existing);
    }

    return Array.from(groups.values())
        .filter((group) => group.length > 1)
        .map((agents) => ({
            agents: [...agents].sort((left, right) => {
                if (left.projectCount !== right.projectCount) {
                    return right.projectCount - left.projectCount;
                }
                const bySlug = left.slug.localeCompare(right.slug);
                if (bySlug !== 0) {
                    return bySlug;
                }
                return left.pubkey.localeCompare(right.pubkey);
            }),
        }))
        .sort((left, right) => left.agents[0].slug.localeCompare(right.agents[0].slug));
}

async function promptForAgentMerges(plans: ProjectMigrationPlan[]): Promise<Map<string, string>> {
    const candidates = await collectAgentCandidates(plans);
    const groups = buildSimilarAgentGroups(candidates);

    if (groups.length === 0 || !input.isTTY || !output.isTTY) {
        return new Map<string, string>();
    }

    const rl = createInterface({ input, output });
    const replacements = new Map<string, string>();

    try {
        for (const group of groups) {
            console.log(chalk.bold("\nSimilar agent slugs detected:"));
            group.agents.forEach((agent, index) => {
                console.log(
                    `  ${index + 1}. @${agent.slug} [${shortPubkey(agent.pubkey)}]`
                    + ` - ${agent.projectCount} project(s)`,
                );
            });

            const mergeAnswer = (await rl.question("Merge these into one canonical agent? [y/N]: "))
                .trim()
                .toLowerCase();

            if (mergeAnswer !== "y" && mergeAnswer !== "yes") {
                continue;
            }

            const canonical = group.agents[0];
            for (const agent of group.agents) {
                if (agent.pubkey !== canonical.pubkey) {
                    replacements.set(agent.pubkey, canonical.pubkey);
                }
            }

            console.log(
                chalk.green(
                    `  keeping @${canonical.slug} [${shortPubkey(canonical.pubkey)}] as the canonical agent`
                    + ` because it belongs to the most projects (${canonical.projectCount})`,
                ),
            );
        }
    } finally {
        rl.close();
    }

    return replacements;
}

function resolveReplacement(pubkey: string, replacements: Map<string, string>): string {
    let current = pubkey;
    const visited = new Set<string>();

    while (replacements.has(current) && !visited.has(current)) {
        visited.add(current);
        current = replacements.get(current) ?? current;
    }

    return current;
}

function applyAgentReplacements(plans: ProjectMigrationPlan[], replacements: Map<string, string>): void {
    if (replacements.size === 0) {
        return;
    }

    for (const plan of plans) {
        const dedupedPubkeys: string[] = [];
        const seen = new Set<string>();

        for (const pubkey of plan.currentAgentPubkeys) {
            const resolved = resolveReplacement(pubkey, replacements);
            if (seen.has(resolved)) {
                continue;
            }
            seen.add(resolved);
            dedupedPubkeys.push(resolved);
        }

        plan.currentAgentPubkeys = dedupedPubkeys;
        plan.updatedTags = buildUpdatedProjectTags(
            plan.event,
            plan.collaboratorPubkeys,
            plan.currentAgentPubkeys,
        );
    }
}

function printProjectPlan(plan: ProjectMigrationPlan, dryRun: boolean): void {
    const projectLabel = `${plan.projectDTag} (${plan.ownerPubkey.slice(0, 8)}...)`;
    const action = dryRun ? chalk.yellow("DRY-RUN") : chalk.cyan("MIGRATE");

    console.log(`${action} ${projectLabel}`);
    console.log(`  agents: ${plan.currentAgentPubkeys.length} pubkey(s)`);
    if (plan.collaboratorPubkeys.length > 0) {
        console.log(`  collaborators: ${plan.collaboratorPubkeys.length} pubkey(s)`);
    }

    if (plan.usedLegacyAgentFallback) {
        console.log(chalk.yellow("  using legacy agent-tag order because local byProject membership was empty"));
    }

    if (plan.unresolvedLegacyAgentEventIds.length > 0) {
        console.log(chalk.yellow(`  unresolved legacy agent event IDs: ${plan.unresolvedLegacyAgentEventIds.join(", ")}`));
    }
}

async function signAndPublish(plan: ProjectMigrationPlan): Promise<void> {
    const updatedEvent = new NDKEvent(getNDK(), {
        kind: 31933,
        content: plan.event.content,
        tags: plan.updatedTags,
    });

    const nip46Service = Nip46SigningService.getInstance();
    const result = await nip46Service.signEvent(
        plan.ownerPubkey,
        updatedEvent,
        "migrate_project_agent_pubkeys",
    );

    if (result.outcome !== "signed") {
        const reason = "reason" in result ? result.reason : "unknown";
        throw new Error(`NIP-46 signing failed (${result.outcome}): ${reason}`);
    }

    await updatedEvent.publish();
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));

    await config.loadConfig();
    await agentStorage.initialize();

    const ownerPubkeys = normalizeOwners(options.ownerPubkeys);
    if (ownerPubkeys.length === 0) {
        throw new Error("No owner pubkeys configured. Add whitelistedPubkeys or pass --owner.");
    }

    const nip46Service = Nip46SigningService.getInstance();
    if (!nip46Service.isEnabled()) {
        throw new Error("NIP-46 is disabled. Enable nip46 in config before running this migration.");
    }

    await initNDK();

    const summary: MigrationSummary = {
        scanned: 0,
        deleted: 0,
        alreadyCurrent: 0,
        migrated: 0,
        dryRun: 0,
        skippedNoDTag: 0,
        skippedNoConfiguredOwners: 0,
        failed: 0,
    };

    const projectFilter = new Set(options.projectDTags);
    const latestProjects = await fetchLatestProjects(ownerPubkeys, projectFilter);

    if (latestProjects.length === 0) {
        console.log(chalk.yellow("No matching 31933 projects found."));
        return;
    }

    console.log(chalk.bold(`Found ${latestProjects.length} latest project event(s) to inspect.`));
    console.log("");

    const plans: ProjectMigrationPlan[] = [];

    for (const event of latestProjects) {
        summary.scanned += 1;

        if (!ownerPubkeys.includes(event.pubkey)) {
            summary.skippedNoConfiguredOwners += 1;
            continue;
        }

        if (isDeletedProject(event)) {
            summary.deleted += 1;
            continue;
        }

        const plan = await buildMigrationPlan(event);
        if (!plan) {
            summary.skippedNoDTag += 1;
            continue;
        }
        plans.push(plan);
    }

    const replacements = await promptForAgentMerges(plans);
    applyAgentReplacements(plans, replacements);

    for (const plan of plans) {
        if (tagsEqual(plan.event.tags, plan.updatedTags)) {
            summary.alreadyCurrent += 1;
            continue;
        }

        printProjectPlan(plan, options.dryRun);

        if (options.dryRun) {
            summary.dryRun += 1;
            continue;
        }

        try {
            await signAndPublish(plan);
            console.log(chalk.green("  published updated 31933"));
            summary.migrated += 1;
        } catch (error) {
            summary.failed += 1;
            console.log(chalk.red(`  failed: ${error instanceof Error ? error.message : String(error)}`));
        }

        console.log("");
    }

    console.log(chalk.bold("Summary"));
    console.log(`  scanned: ${summary.scanned}`);
    console.log(`  deleted: ${summary.deleted}`);
    console.log(`  already current: ${summary.alreadyCurrent}`);
    console.log(`  dry-run changes: ${summary.dryRun}`);
    console.log(`  migrated: ${summary.migrated}`);
    console.log(`  failed: ${summary.failed}`);
    console.log(`  missing d-tag: ${summary.skippedNoDTag}`);
}

try {
    await main();
} catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
} finally {
    await shutdownNDK().catch(() => {});
}
