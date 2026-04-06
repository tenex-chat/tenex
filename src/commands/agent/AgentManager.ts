import {
    createPrompt,
    isSpaceKey,
    useKeypress,
    usePrefix,
    useState,
    isDownKey,
    isEnterKey,
    isUpKey,
    makeTheme,
} from "@inquirer/core";
import { cursorHide } from "@inquirer/ansi";
import chalk from "chalk";
import inquirer from "inquirer";
import { agentStorage, deriveAgentPubkeyFromNsec, type StoredAgent } from "@/agents/AgentStorage";
import * as display from "@/commands/config/display";
import { deleteStoredAgent, installAgentFromDefinitionEventId } from "@/services/agents/AgentProvisioningService";
import { projectMembershipPublishService } from "@/services/agents/ProjectMembershipPublishService";
import { config } from "@/services/ConfigService";
import { initNDK } from "@/nostr/ndkClient";
import { inquirerTheme } from "@/utils/cli-theme";

type ManagedAgent = {
    storedAgent: StoredAgent;
    pubkey: string;
    projects: string[];
};

type ListItem = { name: string; value: string; pubkey?: string };
type ActionItem = { name: string; value: string; key: string };
type AgentManagerPromptResult = {
    action: string;
    selectedPubkeys: string[];
};

type MenuConfig = {
    message: string;
    items: ListItem[];
    actions: ActionItem[];
};

type VisibleWindow = {
    start: number;
    end: number;
};

const FALLBACK_VISIBLE_ITEMS = 24;
const MIN_VISIBLE_ITEMS = 8;

const menuTheme = {
    icon: { cursor: inquirerTheme.icon.cursor },
    style: {
        highlight: inquirerTheme.style.highlight,
    },
};

export function getVisibleWindow(
    activeItemIndex: number,
    totalItems: number,
    maxVisibleItems = getAgentListHeight(),
): VisibleWindow {
    if (totalItems <= maxVisibleItems) {
        return { start: 0, end: totalItems };
    }

    const half = Math.floor(maxVisibleItems / 2);
    let start = Math.max(0, activeItemIndex - half);
    const end = Math.min(totalItems, start + maxVisibleItems);

    if (end - start < maxVisibleItems) {
        start = Math.max(0, end - maxVisibleItems);
    }

    return { start, end };
}

export function getAgentListHeight(): number {
    const terminalRows = process.stdout.rows;
    if (!terminalRows || !Number.isFinite(terminalRows)) {
        return FALLBACK_VISIBLE_ITEMS;
    }

    return Math.max(MIN_VISIBLE_ITEMS, Math.floor(terminalRows * 0.6));
}

const agentSelectPrompt = createPrompt<AgentManagerPromptResult, MenuConfig>((config, done) => {
    const { items, actions } = config;
    const theme = makeTheme(menuTheme);
    const doneIndex = actions.length;
    const totalNavigable = actions.length + 1 + items.length;
    const [active, setActive] = useState(0);
    const [selectedPubkeys, setSelectedPubkeys] = useState<string[]>([]);
    const prefix = usePrefix({ status: "idle", theme });

    useKeypress((key, rl) => {
        if (isEnterKey(key)) {
            if (active < doneIndex) {
                done({ action: actions[active]?.value ?? "done", selectedPubkeys });
            } else if (active === doneIndex) {
                done({ action: "done", selectedPubkeys });
            } else {
                done({ action: items[active - doneIndex - 1]?.value ?? "done", selectedPubkeys });
            }
        } else if (isUpKey(key) || isDownKey(key)) {
            rl.clearLine(0);
            const offset = isUpKey(key) ? -1 : 1;
            setActive((active + offset + totalNavigable) % totalNavigable);
        } else if (isSpaceKey(key) && active > doneIndex) {
            const item = items[active - doneIndex - 1];
            if (!item?.pubkey) {
                return;
            }

            setSelectedPubkeys(
                selectedPubkeys.includes(item.pubkey)
                    ? selectedPubkeys.filter((pubkey) => pubkey !== item.pubkey)
                    : [...selectedPubkeys, item.pubkey],
            );
        } else {
            const match = actions.find((action) => action.key === key.name);
            if (match) {
                done({ action: match.value, selectedPubkeys });
            }
        }
    });

    const message = theme.style.message(config.message, "idle");
    const cursor = theme.icon.cursor;
    const lines: string[] = [];

    lines.push(`${prefix} ${message}`);

    for (const [i, action] of actions.entries()) {
        const isActive = active === i;
        const pfx = isActive ? `${cursor} ` : "  ";
        lines.push(`${pfx}${chalk.cyan(action.name)}`);
    }

    const donePfx = active === doneIndex ? `${cursor} ` : "  ";
    lines.push(`${donePfx}${display.doneLabel()}`);
    lines.push(`  ${"─".repeat(52)}`);

    if (items.length === 0) {
        lines.push(chalk.dim("  No installed agents"));
    } else {
        const activeItemIndex = Math.max(0, active - doneIndex - 1);
        const { start, end } = getVisibleWindow(activeItemIndex, items.length);

        if (start > 0) {
            lines.push(chalk.dim(`  ↑ ${start} more`));
        }

        for (const [offset, item] of items.slice(start, end).entries()) {
            const idx = doneIndex + 1 + start + offset;
            const isActive = idx === active;
            const pfx = isActive ? `${cursor} ` : "  ";
            const color = isActive ? theme.style.highlight : (text: string) => text;
            const isSelected = item.pubkey ? selectedPubkeys.includes(item.pubkey) : false;
            const check = isSelected ? chalk.green("[x]") : chalk.dim("[ ]");
            lines.push(`${pfx}${check} ${color(item.name)}`);
        }

        if (end < items.length) {
            lines.push(chalk.dim(`  ↓ ${items.length - end} more`));
        }
    }

    const helpParts = [
        `${chalk.bold("↑↓")} ${chalk.dim("navigate")}`,
        `${chalk.bold("space")} ${chalk.dim("select")}`,
        `${chalk.bold("⏎")} ${chalk.dim("select")}`,
    ];
    lines.push(chalk.dim(`  ${helpParts.join(chalk.dim(" • "))}`));

    return `${lines.join("\n")}${cursorHide}`;
});

function compareAgents(a: ManagedAgent, b: ManagedAgent): number {
    const aInactive = a.storedAgent.status === "inactive";
    const bInactive = b.storedAgent.status === "inactive";
    if (aInactive !== bInactive) {
        return aInactive ? 1 : -1;
    }

    return a.storedAgent.slug.localeCompare(b.storedAgent.slug);
}

export function formatProjects(projects: string[]): string {
    return projects.length > 0 ? projects.join(", ") : "none";
}

export function formatManagedAgentLabel(entry: ManagedAgent): string {
    const { storedAgent, projects } = entry;
    const inactiveTag = storedAgent.status === "inactive" ? chalk.dim(" [inactive]") : "";

    return [
        `${storedAgent.slug}${inactiveTag}`,
        chalk.dim(`    role: ${storedAgent.role}`),
        chalk.dim(`    projects: ${formatProjects(projects)}`),
    ].join("\n");
}

export function formatManagedAgentListLine(entry: ManagedAgent): string {
    const { storedAgent, projects } = entry;
    const inactiveTag = storedAgent.status === "inactive" ? chalk.dim("[inactive] ") : "";
    return `${inactiveTag}${storedAgent.slug} ${chalk.dim("·")} ${chalk.dim(`projects: ${formatProjects(projects)}`)}`;
}

export function pickMergeSurvivor(agents: ManagedAgent[]): ManagedAgent {
    if (agents.length === 0) {
        throw new Error("pickMergeSurvivor requires at least one agent");
    }

    return [...agents].sort((a, b) => {
        const projectDelta = b.projects.length - a.projects.length;
        if (projectDelta !== 0) {
            return projectDelta;
        }

        const aInactive = a.storedAgent.status === "inactive";
        const bInactive = b.storedAgent.status === "inactive";
        if (aInactive !== bInactive) {
            return aInactive ? 1 : -1;
        }

        return a.storedAgent.slug.localeCompare(b.storedAgent.slug);
    })[0]!;
}

export function findDuplicateSlugGroups(agents: ManagedAgent[]): ManagedAgent[][] {
    const groups = new Map<string, ManagedAgent[]>();

    for (const agent of agents) {
        const slug = agent.storedAgent.slug;
        const existing = groups.get(slug);
        if (existing) {
            existing.push(agent);
        } else {
            groups.set(slug, [agent]);
        }
    }

    return Array.from(groups.values()).filter((group) => group.length > 1);
}

export class AgentManager {
    private duplicateMergePromptDismissed = false;

    async showMainMenu(): Promise<void> {
        await config.loadConfig();
        let agents = await this.loadAgents();
        agents = await this.offerAutoMergeForDuplicateSlugs(agents);

        display.blank();
        display.step(0, 0, "Agent Manager");
        display.context("Install agents from kind:4199 events, inspect current memberships, or permanently delete stored agents.");

        const items: ListItem[] = agents.map((entry) => ({
            name: formatManagedAgentListLine(entry),
            value: `agent:${entry.pubkey}`,
            pubkey: entry.pubkey,
        }));

        const actions: ActionItem[] = [
            { name: `Install from 4199 event ${chalk.dim("(a)")}`, value: "install", key: "a" },
            { name: `Delete selected ${chalk.dim("(x)")}`, value: "delete-selected", key: "x" },
            { name: `Merge selected ${chalk.dim("(m)")}`, value: "merge-selected", key: "m" },
        ];

        const result = await agentSelectPrompt({
            message: `Agents ${chalk.dim(`(${agents.length})`)}`,
            items,
            actions,
        });
        const { action, selectedPubkeys } = result;

        if (action === "done") {
            return;
        }

        if (action === "install") {
            await this.installFromEvent();
            await this.showMainMenu();
            return;
        }

        if (action === "delete-selected") {
            await this.bulkDeleteAgents(agents, selectedPubkeys);
            await this.showMainMenu();
            return;
        }

        if (action === "merge-selected") {
            await this.bulkMergeAgents(agents, selectedPubkeys);
            await this.showMainMenu();
            return;
        }

        if (action.startsWith("delete:")) {
            const pubkey = action.slice("delete:".length);
            await this.confirmAndDelete(pubkey);
            await this.showMainMenu();
            return;
        }

        if (action.startsWith("agent:")) {
            const pubkey = action.slice("agent:".length);
            await this.showAgentDetail(pubkey);
            await this.showMainMenu();
        }
    }

    private async loadAgents(): Promise<ManagedAgent[]> {
        await agentStorage.initialize();
        const storedAgents = await agentStorage.getAllStoredAgents();
        const managedAgents: ManagedAgent[] = [];
        const projectVisibility = new Map<string, boolean>();

        for (const storedAgent of storedAgents) {
            const pubkey = deriveAgentPubkeyFromNsec(storedAgent.nsec);
            const projects = await agentStorage.getAgentProjects(pubkey);
            const visibleProjects: string[] = [];

            for (const projectId of projects) {
                if (!projectVisibility.has(projectId)) {
                    const visibility = await projectMembershipPublishService.getProjectVisibility(projectId);
                    projectVisibility.set(projectId, visibility !== "deleted");
                }

                if (projectVisibility.get(projectId)) {
                    visibleProjects.push(projectId);
                }
            }

            managedAgents.push({
                storedAgent,
                pubkey,
                projects: visibleProjects,
            });
        }

        managedAgents.sort(compareAgents);
        return managedAgents;
    }

    private async installFromEvent(): Promise<void> {
        const { eventId } = await inquirer.prompt([{
            type: "input",
            name: "eventId",
            message: "4199 event id:",
            validate: (input: string) => input.trim().length > 0 || "Event id is required",
            theme: inquirerTheme,
        }]);

        const { slugOverride } = await inquirer.prompt([{
            type: "input",
            name: "slugOverride",
            message: "Override slug (optional):",
            theme: inquirerTheme,
        }]);

        await initNDK();
        const result = await installAgentFromDefinitionEventId(eventId.trim(), {
            slugOverride: slugOverride.trim() || undefined,
        });

        display.blank();
        if (result.created) {
            display.success(`Installed "${result.storedAgent.name}" (${result.storedAgent.slug})`);
        } else {
            display.success(`Updated "${result.storedAgent.name}" (${result.storedAgent.slug})`);
        }
    }

    private async showAgentDetail(pubkey: string): Promise<void> {
        while (true) {
            const entry = await this.getManagedAgent(pubkey);
            if (!entry) {
                display.blank();
                display.hint("Agent no longer exists.");
                return;
            }

            display.blank();
            display.step(0, 0, entry.storedAgent.slug);
            display.context(`Name: ${entry.storedAgent.name}`);
            display.context(`Role: ${entry.storedAgent.role}`);
            display.context(`Status: ${entry.storedAgent.status ?? "active"}`);
            display.context(`Projects: ${formatProjects(entry.projects)}`);

            const { action } = await inquirer.prompt([{
                type: "select",
                name: "action",
                message: "Agent",
                choices: [
                    { name: "Assign to projects", value: "assign-projects" },
                    { name: "Delete permanently", value: "delete" },
                    { name: "Back", value: "back" },
                ],
                theme: inquirerTheme,
            }]);

            if (action === "back") {
                return;
            }

            if (action === "assign-projects") {
                await this.assignAgentToProjects(pubkey);
                continue;
            }

            if (action === "delete") {
                await this.confirmAndDelete(pubkey);
                return;
            }
        }
    }

    private async assignAgentToProjects(pubkey: string): Promise<void> {
        const entry = await this.getManagedAgent(pubkey);
        if (!entry) {
            display.blank();
            display.hint("Agent no longer exists.");
            return;
        }

        const availableProjects = await projectMembershipPublishService.listAssignableProjectDTags();
        const currentProjects = new Set(entry.projects);
        const choices = Array.from(new Set([...availableProjects, ...entry.projects]))
            .sort((a, b) => a.localeCompare(b))
            .map((projectId) => ({
                name: projectId,
                value: projectId,
                checked: currentProjects.has(projectId),
            }));

        if (choices.length === 0) {
            display.blank();
            display.hint("No projects available to assign.");
            return;
        }

        const { selectedProjects } = await inquirer.prompt([{
            type: "checkbox",
            name: "selectedProjects",
            message: "Assigned to projects",
            pageSize: getAgentListHeight(),
            choices,
            theme: inquirerTheme,
        }]);

        const selectedProjectIds = selectedProjects as string[];
        const selectedProjectSet = new Set(selectedProjectIds);
        const projectIdsToAdd = selectedProjectIds.filter((projectId) => !currentProjects.has(projectId));
        const projectIdsToRemove = entry.projects.filter((projectId) => !selectedProjectSet.has(projectId));

        if (projectIdsToAdd.length === 0 && projectIdsToRemove.length === 0) {
            display.blank();
            display.hint("No project changes.");
            return;
        }

        for (const projectId of projectIdsToAdd) {
            await agentStorage.addAgentToProject(pubkey, projectId);
        }

        for (const projectId of projectIdsToRemove) {
            await agentStorage.removeAgentFromProject(pubkey, projectId);
        }

        await projectMembershipPublishService.syncManyProjectMemberships([
            ...projectIdsToAdd,
            ...projectIdsToRemove,
        ]);

        display.blank();
        display.success(`Updated projects for ${entry.storedAgent.slug}`);
        display.context(`Projects: ${formatProjects(selectedProjectIds)}`);
    }

    private async bulkDeleteAgents(agents: ManagedAgent[], selectedPubkeys: string[]): Promise<void> {
        if (agents.length === 0 || selectedPubkeys.length === 0) {
            display.blank();
            display.hint("Select one or more agents first.");
            return;
        }
        const selectedAgents = agents.filter((entry) => selectedPubkeys.includes(entry.pubkey));
        const { confirmed } = await inquirer.prompt([{
            type: "confirm",
            name: "confirmed",
            message: `Permanently delete ${selectedAgents.length} agent${selectedAgents.length === 1 ? "" : "s"}?`,
            default: false,
            theme: inquirerTheme,
        }]);

        if (!confirmed) {
            return;
        }

        const affectedProjectIds = Array.from(new Set(selectedAgents.flatMap((entry) => entry.projects)));

        let deletedCount = 0;
        for (const agent of selectedAgents) {
            const deleted = await deleteStoredAgent(agent.pubkey, { quiet: true });
            if (deleted) {
                deletedCount++;
            }
        }

        await projectMembershipPublishService.syncManyProjectMemberships(affectedProjectIds);

        display.blank();
        display.success(`Deleted ${deletedCount} agent${deletedCount === 1 ? "" : "s"}`);
    }

    private async bulkMergeAgents(agents: ManagedAgent[], selectedPubkeys: string[]): Promise<void> {
        if (agents.length < 2 || selectedPubkeys.length < 2) {
            display.blank();
            display.hint("Select at least 2 agents first.");
            return;
        }
        const selectedAgents = agents.filter((entry) => selectedPubkeys.includes(entry.pubkey));
        await this.mergeAgents(selectedAgents, true);
    }

    private async offerAutoMergeForDuplicateSlugs(agents: ManagedAgent[]): Promise<ManagedAgent[]> {
        if (this.duplicateMergePromptDismissed) {
            return agents;
        }

        const duplicateGroups = findDuplicateSlugGroups(agents);
        if (duplicateGroups.length === 0) {
            return agents;
        }

        const summary = duplicateGroups
            .map((group) => `${group[0]?.storedAgent.slug} (${group.length})`)
            .join(", ");

        const { shouldMerge } = await inquirer.prompt([{
            type: "confirm",
            name: "shouldMerge",
            message: `Detected duplicate slugs: ${summary}. Auto-merge them now?`,
            default: true,
            theme: inquirerTheme,
        }]);

        if (!shouldMerge) {
            this.duplicateMergePromptDismissed = true;
            return agents;
        }

        for (const group of duplicateGroups) {
            await this.mergeAgents(group, false);
        }

        display.blank();
        display.success(`Auto-merged ${duplicateGroups.length} duplicate slug group${duplicateGroups.length === 1 ? "" : "s"}`);
        return this.loadAgents();
    }

    private async mergeAgents(agents: ManagedAgent[], confirm = true): Promise<void> {
        if (agents.length < 2) {
            return;
        }

        const survivor = pickMergeSurvivor(agents);
        const mergedProjectIds = Array.from(new Set(agents.flatMap((entry) => entry.projects)));
        const agentsToDelete = agents.filter((entry) => entry.pubkey !== survivor.pubkey);

        if (confirm) {
            const { confirmed } = await inquirer.prompt([{
                type: "confirm",
                name: "confirmed",
                message: `Keep ${survivor.storedAgent.slug} and merge ${mergedProjectIds.length} project${mergedProjectIds.length === 1 ? "" : "s"} from ${agentsToDelete.length} other agent${agentsToDelete.length === 1 ? "" : "s"}?`,
                default: false,
                theme: inquirerTheme,
            }]);

            if (!confirmed) {
                return;
            }
        }

        for (const projectId of mergedProjectIds) {
            await agentStorage.addAgentToProject(survivor.pubkey, projectId);
        }

        for (const [index, agent] of agentsToDelete.entries()) {
            const isLast = index === agentsToDelete.length - 1;
            await deleteStoredAgent(agent.pubkey, {
                publishInventory: isLast,
                quiet: true,
            });
        }

        await projectMembershipPublishService.syncManyProjectMemberships(mergedProjectIds);

        if (confirm) {
            display.blank();
            display.success(`Merged ${agents.length} agents into ${survivor.storedAgent.slug}`);
            display.context(`Projects: ${formatProjects(mergedProjectIds)}`);
        }
    }

    private async confirmAndDelete(pubkey: string): Promise<void> {
        const entry = await this.getManagedAgent(pubkey);
        if (!entry) {
            display.blank();
            display.hint("Agent no longer exists.");
            return;
        }

        const { confirmed } = await inquirer.prompt([{
            type: "confirm",
            name: "confirmed",
            message: `Permanently delete ${entry.storedAgent.slug} from storage?`,
            default: false,
            theme: inquirerTheme,
        }]);

        if (!confirmed) {
            return;
        }

        const affectedProjectIds = [...entry.projects];
        await deleteStoredAgent(pubkey, { quiet: true });
        await projectMembershipPublishService.syncManyProjectMemberships(affectedProjectIds);
        display.blank();
        display.success(`Deleted "${entry.storedAgent.name}" (${entry.storedAgent.slug})`);
    }

    private async getManagedAgent(pubkey: string): Promise<ManagedAgent | null> {
        await agentStorage.initialize();
        const storedAgent = await agentStorage.loadAgent(pubkey);
        if (!storedAgent) {
            return null;
        }

        return {
            storedAgent,
            pubkey,
            projects: await agentStorage.getAgentProjects(pubkey),
        };
    }
}
