#!/usr/bin/env bun

import { agentStorage } from "@/agents/AgentStorage";
import { readJsonFile } from "@/lib/fs";
import { getProjectSchedulesPath } from "@/services/scheduling";
import type { ScheduledTask } from "@/services/scheduling";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

async function main(): Promise<void> {
    const nsec = process.env.NSEC;
    if (!nsec) {
        throw new Error("NSEC is required");
    }

    const signer = new NDKPrivateKeySigner(nsec);
    await agentStorage.initialize();

    const currentAgent = await agentStorage.loadAgent(signer.pubkey);
    const projectIds = (await agentStorage.getAgentProjects(signer.pubkey)).sort();
    const projects: Array<{
        projectId: string;
        scheduleFile: string;
        schedules: ScheduledTask[];
    }> = [];

    for (const projectId of projectIds) {
        const scheduleFile = getProjectSchedulesPath(projectId);
        const schedules = await readJsonFile<ScheduledTask[]>(scheduleFile);
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
                agent: currentAgent?.slug ?? signer.pubkey,
                agentPubkey: signer.pubkey,
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
