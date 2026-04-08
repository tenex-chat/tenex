#!/usr/bin/env node
// team-roster.js — prints full team roster with pubkeys and use criteria
// Inputs: $TENEX_BASE_DIR (required), $PROJECT_ID (optional)

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const tenexBaseDir =
    process.env.TENEX_BASE_DIR ?? path.join(os.homedir(), ".tenex");
const projectId = process.env.PROJECT_ID ?? null;

async function readJson(filePath) {
    try {
        const content = await fs.readFile(filePath, "utf-8");
        return JSON.parse(content);
    } catch {
        return null;
    }
}

async function loadTeams() {
    const globalTeamsPath = path.join(tenexBaseDir, "teams.json");
    const globalData = await readJson(globalTeamsPath);
    const teams = globalData?.teams ?? {};

    if (projectId) {
        const projectTeamsPath = path.join(
            tenexBaseDir,
            "projects",
            projectId,
            "teams.json"
        );
        const projectData = await readJson(projectTeamsPath);
        if (projectData?.teams) {
            // Per-project teams fully replace global teams with the same name
            for (const [name, team] of Object.entries(projectData.teams)) {
                teams[name] = team;
            }
        }
    }

    return teams;
}

async function loadAgentIndex() {
    const indexPath = path.join(tenexBaseDir, "agents", "index.json");
    const data = await readJson(indexPath);
    if (!data) {
        process.stderr.write(
            `Error: could not read ${indexPath}\n`
        );
        process.exit(1);
    }
    return data;
}

async function loadAgentData(pubkey) {
    const agentPath = path.join(tenexBaseDir, "agents", `${pubkey}.json`);
    return readJson(agentPath);
}

function shortPubkey(pubkey) {
    return pubkey.slice(0, 8);
}

function useCriteriaText(agentData) {
    if (!agentData) return "(no use criteria)";
    const text = agentData.useCriteria ?? agentData.description ?? agentData.role;
    return text ? text : "(no use criteria)";
}

async function main() {
    const teams = await loadTeams();
    const agentIndex = await loadAgentIndex();
    const bySlug = agentIndex.bySlug ?? {};

    // Collect all slugs that appear in any team
    const teamMemberSlugs = new Set();
    for (const team of Object.values(teams)) {
        for (const slug of team.members ?? []) {
            teamMemberSlugs.add(slug);
        }
    }

    // Determine which project agents to show as unaffiliated
    // Use byProject[projectId] if available, otherwise all slugs in bySlug
    let projectSlugs;
    if (projectId && agentIndex.byProject?.[projectId]) {
        projectSlugs = agentIndex.byProject[projectId];
    } else {
        projectSlugs = Object.keys(bySlug);
    }

    console.log(`Project: ${projectId ?? "global"}`);
    console.log("Teams:");

    for (const [teamName, team] of Object.entries(teams)) {
        const members = team.members ?? [];
        console.log(`\n  ${teamName} — ${team.description ?? ""} [${members.length} agents]`);
        for (const slug of members) {
            const pubkey = bySlug[slug]?.pubkey ?? bySlug[slug];
            const pubkeyStr = typeof pubkey === "string" ? pubkey : null;
            const agentData = pubkeyStr ? await loadAgentData(pubkeyStr) : null;
            const short = pubkeyStr ? shortPubkey(pubkeyStr) : "unknown";
            const criteria = useCriteriaText(agentData);
            console.log(`    * ${slug} (${short}) — ${criteria}`);
        }
    }

    const unaffiliated = projectSlugs.filter((slug) => !teamMemberSlugs.has(slug));
    if (unaffiliated.length > 0) {
        console.log("\nUnaffiliated agents (not in any team):");
        for (const slug of unaffiliated) {
            const pubkey = bySlug[slug]?.pubkey ?? bySlug[slug];
            const pubkeyStr = typeof pubkey === "string" ? pubkey : null;
            const agentData = pubkeyStr ? await loadAgentData(pubkeyStr) : null;
            const short = pubkeyStr ? shortPubkey(pubkeyStr) : "unknown";
            const criteria = useCriteriaText(agentData);
            console.log(`  * ${slug} (${short}) — ${criteria}`);
        }
    }
}

main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
});
