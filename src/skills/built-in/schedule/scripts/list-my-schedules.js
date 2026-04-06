#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const TENEX_BASE_DIR = process.env.TENEX_BASE_DIR
    || process.env.TENEX_BASE_PATH
    || path.join(homedir(), ".tenex");

async function fileExists(filePath) {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function readJsonFile(filePath) {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
}

function getAgentEntry(index, slug) {
    const entry = index.bySlug?.[slug];
    if (!entry?.pubkey || !Array.isArray(entry.projectIds)) {
        throw new Error(`Agent slug not found in ${path.join(TENEX_BASE_DIR, "agents", "index.json")}: ${slug}`);
    }

    return entry;
}

function getScheduleFile(projectId) {
    return path.join(TENEX_BASE_DIR, "projects", projectId, "schedules.json");
}

async function main() {
    const agentSlug = process.argv[2];
    if (!agentSlug) {
        throw new Error("Usage: node src/skills/built-in/schedule/scripts/list-my-schedules.js <agent-slug>");
    }

    const agentIndexPath = path.join(TENEX_BASE_DIR, "agents", "index.json");
    if (!(await fileExists(agentIndexPath))) {
        throw new Error(`Agent index not found: ${agentIndexPath}`);
    }

    const index = await readJsonFile(agentIndexPath);
    const agentEntry = getAgentEntry(index, agentSlug);
    const projectIds = [...agentEntry.projectIds].sort((left, right) => left.localeCompare(right));
    const projects = [];

    for (const projectId of projectIds) {
        const scheduleFile = getScheduleFile(projectId);
        if (!(await fileExists(scheduleFile))) {
            continue;
        }

        const schedules = await readJsonFile(scheduleFile);
        if (!Array.isArray(schedules) || schedules.length === 0) {
            continue;
        }

        projects.push({
            projectId,
            scheduleFile,
            schedules,
        });
    }

    console.log(
        JSON.stringify(
            {
                agent: agentSlug,
                agentPubkey: agentEntry.pubkey,
                projectCount: projectIds.length,
                projectsWithSchedules: projects.length,
                scheduleCount: projects.reduce(
                    (total, project) => total + project.schedules.length,
                    0
                ),
                projects,
            },
            null,
            2
        )
    );
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
