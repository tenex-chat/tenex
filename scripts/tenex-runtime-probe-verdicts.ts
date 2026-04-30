import type { Event } from "nostr-tools";
import { evaluateAcpWorker } from "./tenex-runtime-probe-acp-verdicts";
import {
    messageText,
    readAgentContextStates,
    readConversationTranscript,
    type ConversationTranscript,
} from "./tenex-runtime-probe-conversations";
import {
    acpDelegationMcpUserRequest,
    acpProbeModelName,
    agentConfigUpdateModelName,
    agentConfigUpdateSkills,
    delegationUserRequest,
    delegationWorkerCompletionText,
    extractColorChoice,
    includesColorChoice,
    mcpResourceContentText,
    mcpResourceFinalText,
    mcpResourceUpdateId,
    rootAgentsMdInstruction,
    type MockRequestRecord,
    type ScenarioName,
    worktreeAgentsMdInstruction,
} from "./tenex-runtime-probe-scenarios";
import { evaluateShellKillDuplicate } from "./tenex-runtime-probe-shell-verdicts";

type Verdict = { name: string; ok: boolean; detail: string };

type EvaluateContext = {
    pmPubkey: string;
    workerPubkey: string;
    modelName: string;
    conversationDbPath: string;
    mcpProbeRecords?: Array<Record<string, unknown>>;
    workspaceDir?: string;
};

export function evaluate(
    name: ScenarioName,
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const commonVerdicts = [evaluateProjectStatusModelTag(events, context)];

    if (name === "delegation-basic") {
        return [...commonVerdicts, ...evaluateDelegation(events, context)];
    }
    if (name === "same-agent-concurrency") {
        return [...commonVerdicts, ...evaluateSameAgentConcurrency(events, context)];
    }
    if (name === "mcp-tool-basic") {
        return [...commonVerdicts, ...evaluateMcpTool(events, requestRecords, context)];
    }
    if (name === "mcp-resource-basic") {
        return [...commonVerdicts, ...evaluateMcpResource(events, requestRecords, context)];
    }
    if (name === "acp-worker-basic") {
        return [
            evaluateAgentModelAccess(events, context.pmPubkey, "pm", context.modelName),
            evaluateAgentModelAccess(events, context.workerPubkey, "worker", acpProbeModelName),
            ...evaluateAcpWorker(events, context),
        ];
    }
    if (name === "agent-config-reload") {
        return [...commonVerdicts, ...evaluateAcpWorker(events, context)];
    }
    if (name === "acp-delegation-mcp") {
        return [
            evaluateAgentModelAccess(events, context.pmPubkey, "pm", acpProbeModelName),
            evaluateAgentModelAccess(events, context.workerPubkey, "worker", context.modelName),
            ...evaluateAcpDelegationMcp(events, context),
        ];
    }
    if (name === "agent-config-update") {
        return [...commonVerdicts, ...evaluateAgentConfigUpdate(events, context)];
    }
    if (name === "project-membership-reload") {
        return [...commonVerdicts, ...evaluateProjectMembershipReload(events, requestRecords, context)];
    }
    if (name === "shell-kill-duplicate") {
        return [...commonVerdicts, ...evaluateShellKillDuplicate(events, requestRecords, context)];
    }
    if (name === "root-agents-md") {
        return [...commonVerdicts, ...evaluateRootAgentsMd(events, requestRecords, context)];
    }
    return [...commonVerdicts, ...evaluateFsReadAdjustment(events, requestRecords, context)];
}

function evaluateAcpDelegationMcp(events: Event[], context: EvaluateContext): Verdict[] {
    const initialUserEvent = events.find(
        (event) => event.kind === 1 && event.content === acpDelegationMcpUserRequest
    );
    const delegation = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "p", context.workerPubkey) &&
            !hasTag(event, "tool")
    );
    const delegateTool = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "delegate")
    );
    const workerCompletion = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            includesColorChoice(event.content)
    );
    const completedDelegationAck = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.toLowerCase().includes("delegat") &&
            !hasTag(event, "tool") &&
            hasTag(event, "status", "completed")
    );
    const storedWorkerCompletion = initialUserEvent
        ? readConversationTranscript(context.conversationDbPath, initialUserEvent.id).messages.find(
              (message) =>
                  message.authorPubkey === context.workerPubkey &&
                  includesColorChoice(messageText(message))
          )
        : undefined;

    return [
        {
            name: "ACP PM emitted delegation event to worker",
            ok: Boolean(delegation),
            detail: "Expected kind:1 from ACP PM with p-tag targeting worker.",
        },
        {
            name: "ACP PM emitted delegate tool event",
            ok: Boolean(delegateTool),
            detail: "Expected ACP MCP delegate call to publish a tool=delegate event.",
        },
        {
            name: "Runtime routed ACP MCP delegation to worker",
            ok: Boolean(workerCompletion),
            detail: "Expected worker kind:1 containing a random-color completion.",
        },
        {
            name: "Store recorded worker completion in parent conversation",
            ok: Boolean(storedWorkerCompletion),
            detail: "Expected parent conversation transcript to contain worker color completion.",
        },
        {
            name: "ACP delegation acknowledgement stayed pending",
            ok: !completedDelegationAck,
            detail: "Expected no ACP delegation acknowledgement to be marked status=completed.",
        },
    ];
}

function evaluateRootAgentsMd(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const promptRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" && record.requestDebug.includes(rootAgentsMdInstruction)
    );
    const completion = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(`${rootAgentsMdInstruction} observed`)
    );

    return [
        {
            name: "Prompt included root AGENTS.md",
            ok: Boolean(promptRequest),
            detail: "Expected the PM model request to contain the root AGENTS.md probe instruction.",
        },
        {
            name: "Prompt ignored worktree-local AGENTS.md",
            ok:
                Boolean(promptRequest) &&
                !promptRequest?.requestDebug.includes(worktreeAgentsMdInstruction),
            detail: "Expected root-only AGENTS.md injection; worktree-local AGENTS.md appeared in the request.",
        },
        {
            name: "Agent completed after matching root instruction",
            ok: Boolean(completion),
            detail: "Expected PM completion from the mock response matched on the root AGENTS.md instruction.",
        },
    ];
}

function evaluateProjectMembershipReload(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const statusEvents = events.filter((event) => event.kind === 24010);
    const statusWithBoth = statusEvents.find((event) => {
        const slugs = statusAgentSlugs(event);
        return slugs.includes("pm") && slugs.includes("worker");
    });
    const statusWithoutWorker = statusEvents.find((event) => {
        const slugs = statusAgentSlugs(event);
        return slugs.includes("pm") && !slugs.includes("worker");
    });
    const pmCompletion = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("membership agent1 active")
    );
    const workerCompletion = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            event.content.includes("membership agent2 active")
    );
    const workerCwdRecord = requestRecords.find(
        (record) =>
            record.agent === "worker" &&
            (record.requestDebug.includes("cwd: $PROJECT_BASE") ||
                (context.workspaceDir !== undefined &&
                    record.requestDebug.includes(`cwd: ${context.workspaceDir}`)))
    );
    const removedWorkerRequest = events.find(
        (event) => event.kind === 1 && event.content === "membership check agent2 after removal"
    );
    const removedWorkerReplies = removedWorkerRequest
        ? events.filter((event) => event.kind === 1 && repliesTo(event, removedWorkerRequest.id))
        : [];

    return [
        {
            name: "Initial agent1 received project membership request",
            ok: Boolean(pmCompletion),
            detail: "Expected pm/agent1 completion before adding agent2.",
        },
        {
            name: "Project status reflected added agent2",
            ok: Boolean(statusWithBoth),
            detail: "Expected a 24010 status with pm and worker agent tags.",
        },
        {
            name: "Added agent2 received direct p-tagged request",
            ok: Boolean(workerCompletion),
            detail: "Expected worker/agent2 completion after 31933 add.",
        },
        {
            name: "Agent prompt used project workspace cwd",
            ok: Boolean(workerCwdRecord),
            detail: `Expected worker prompt to contain cwd: ${context.workspaceDir ?? "<workspace>"}.`,
        },
        {
            name: "Project status reflected removed agent2",
            ok: Boolean(statusWithoutWorker),
            detail: "Expected a 24010 status with pm and without worker after 31933 removal.",
        },
        {
            name: "Removed agent2 direct request was not dispatched",
            ok: Boolean(removedWorkerRequest) && removedWorkerReplies.length === 0,
            detail: `Expected no agent replies to removed agent2 request; saw ${removedWorkerReplies.length}.`,
        },
    ];
}

function evaluateAgentConfigUpdate(events: Event[], context: EvaluateContext): Verdict[] {
    const updateEvent = events.find(
        (event) =>
            event.kind === 24020 &&
            event.pubkey !== context.workerPubkey &&
            event.tags.some((tag) => tag[0] === "p" && tag[1] === context.workerPubkey)
    );
    const statusEvents = events.filter((event) => event.kind === 24010);
    const updatedStatus = statusEvents.find((event) =>
        event.tags.some(
            (tag) =>
                tag[0] === "model" &&
                tag[1] === agentConfigUpdateModelName &&
                tag.slice(2).includes("worker")
        )
    );
    const missingSkill = agentConfigUpdateSkills.find(
        (skill) =>
            !updatedStatus?.tags.some(
                (tag) => tag[0] === "skill" && tag[1] === skill && tag.slice(2).includes("worker")
            )
    );

    return [
        {
            name: "Published kind 24020 config update",
            ok: Boolean(updateEvent),
            detail: "Expected a 24020 event p-tagged to worker.",
        },
        {
            name: "Project status reflected updated model",
            ok: Boolean(updatedStatus),
            detail: `Expected a 24010 model tag for ${agentConfigUpdateModelName} containing worker.`,
        },
        {
            name: "Project status reflected updated skills",
            ok: Boolean(updatedStatus) && missingSkill === undefined,
            detail: `Expected 24010 skill tags for ${agentConfigUpdateSkills.join(", ")} containing worker; missing ${missingSkill ?? "<none>"}.`,
        },
    ];
}

function statusAgentSlugs(event: Event): string[] {
    return event.tags
        .filter((tag) => tag[0] === "agent")
        .map((tag) => tag[2])
        .filter((slug): slug is string => typeof slug === "string");
}

function repliesTo(event: Event, parentId: string): boolean {
    return event.tags.some((tag) => tag[0] === "e" && tag[1] === parentId);
}

function evaluateProjectStatusModelTag(events: Event[], context: EvaluateContext): Verdict {
    const statusEvents = events.filter((event) => event.kind === 24010);
    const modelTags = statusEvents
        .flatMap((event) => event.tags)
        .filter((tag) => tag[0] === "model" && tag[1] === context.modelName);
    const expectedAgents = ["pm", "worker"];
    const modelTag = modelTags.find((tag) =>
        expectedAgents.every((agent) => tag.slice(2).includes(agent))
    );

    return {
        name: "Project status publishes model access",
        ok: Boolean(modelTag),
        detail:
            `Expected kind:24010 model tag for ${context.modelName} with pm and worker; ` +
            `saw ${modelTags.length > 0 ? modelTags.map((tag) => JSON.stringify(tag)).join(", ") : "<none>"}.`,
    };
}

function evaluateAgentModelAccess(
    events: Event[],
    pubkey: string,
    slug: string,
    modelName: string
): Verdict {
    const statusEvents = events.filter((event) => event.kind === 24010);
    const modelTags = statusEvents
        .flatMap((event) => event.tags)
        .filter((tag) => tag[0] === "model" && tag[1] === modelName);
    const modelTag = modelTags.find(
        (tag) => tag.slice(2).includes(slug) || tag.slice(2).includes(pubkey)
    );

    return {
        name: `Project status publishes ${slug} model access`,
        ok: Boolean(modelTag),
        detail:
            `Expected kind:24010 model tag for ${modelName} containing ${slug}; ` +
            `saw ${modelTags.length > 0 ? modelTags.map((tag) => JSON.stringify(tag)).join(", ") : "<none>"}.`,
    };
}

function evaluateDelegation(events: Event[], context: EvaluateContext): Verdict[] {
    const delegation = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "p", context.workerPubkey)
    );
    const initialUserEvent = events.find(
        (event) => event.kind === 1 && event.content === delegationUserRequest
    );
    const delegateTool = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "delegate")
    );
    const workerCompletion = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            (event.content.includes(delegationWorkerCompletionText) ||
                includesColorChoice(event.content))
    );
    const parentTranscript = initialUserEvent
        ? readConversationTranscript(context.conversationDbPath, initialUserEvent.id)
        : emptyTranscript("<missing-parent>");
    const delegatedTranscript = delegation
        ? readConversationTranscript(context.conversationDbPath, delegation.id)
        : emptyTranscript("<missing-delegation>");
    const storedDelegationRoot = delegatedTranscript.messages.find(
        (message) =>
            message.authorPubkey === context.pmPubkey &&
            message.nostrEventId === delegation?.id
    );
    const storedWorkerCompletion = parentTranscript.messages.find(
        (message) =>
            message.authorPubkey === context.workerPubkey &&
            includesColorChoice(messageText(message))
    );
    const workerColor = storedWorkerCompletion
        ? extractColorChoice(messageText(storedWorkerCompletion))
        : workerCompletion
        ? extractColorChoice(workerCompletion.content)
        : null;
    const parentPmColorReport = parentTranscript.messages.find(
        (message) =>
            message.authorPubkey === context.pmPubkey &&
            extractColorChoice(messageText(message)) !== null
    );
    const parentPmReportedColor = parentPmColorReport
        ? extractColorChoice(messageText(parentPmColorReport))
        : null;
    const delegatedPmColorReport = delegatedTranscript.messages.find(
        (message) =>
            message.authorPubkey === context.pmPubkey &&
            extractColorChoice(messageText(message)) !== null
    );
    const relayPmColorReports = events.filter(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.created_at >= (workerCompletion?.created_at ?? Number.MAX_SAFE_INTEGER) &&
            !hasTag(event, "tool", "delegate") &&
            extractColorChoice(event.content) !== null
    );
    const relayPmObservedWorker = relayPmColorReports[0];
    const pmObservedInParentConversation =
        Boolean(initialUserEvent && relayPmObservedWorker) &&
        hasMarkedTag(relayPmObservedWorker!, "e", initialUserEvent!.id, "root");
    const completedStatus = events.find(
        (event) =>
            event.kind === 1 &&
            (event.pubkey === context.pmPubkey || event.pubkey === context.workerPubkey) &&
            hasTag(event, "status", "completed")
    );
    const delegateToolIndex = delegateTool ? events.indexOf(delegateTool) : -1;
    const workerCompletionIndex = workerCompletion
        ? events.indexOf(workerCompletion)
        : Number.MAX_SAFE_INTEGER;
    const pendingDelegationCompletion =
        delegateToolIndex >= 0
            ? events.find(
                  (event, index) =>
                      index > delegateToolIndex &&
                      index < workerCompletionIndex &&
                      event.kind === 1 &&
                      event.pubkey === context.pmPubkey &&
                      !hasTag(event, "tool") &&
                      hasTag(event, "status", "completed") &&
                      (initialUserEvent
                          ? hasMarkedTag(event, "e", initialUserEvent.id, "root")
                          : true)
              )
            : undefined;
    const pendingDelegationCompletionPTags =
        pendingDelegationCompletion?.tags.filter((tag) => tag[0] === "p") ?? [];

    return [
        {
            name: "PM emitted delegation event to worker",
            ok: Boolean(delegation),
            detail: "Expected kind:1 from PM with p-tag targeting worker.",
        },
        {
            name: "PM emitted delegate tool event",
            ok: Boolean(delegateTool),
            detail: "Expected kind:1 from PM with tool=delegate.",
        },
        {
            name: "Runtime routed delegation to worker",
            ok: Boolean(workerCompletion),
            detail: "Expected worker kind:1 containing scripted random-color completion text.",
        },
        {
            name: "Store recorded delegated conversation root",
            ok: Boolean(storedDelegationRoot),
            detail: "Expected delegated conversation transcript to start from the PM delegation event.",
        },
        {
            name: "Store recorded worker completion in parent conversation",
            ok: Boolean(storedWorkerCompletion),
            detail: "Expected parent conversation transcript to contain worker color completion.",
        },
        {
            name: "Store kept PM color report in parent conversation",
            ok: Boolean(parentPmColorReport) && parentPmReportedColor === workerColor,
            detail: `Expected parent transcript PM report to repeat ${workerColor ?? "<worker color>"}; saw ${parentPmReportedColor ?? "<none>"}.`,
        },
        {
            name: "Store has no PM color report in delegated conversation",
            ok: !delegatedPmColorReport,
            detail: `Expected delegated transcript to not contain PM color report; saw ${delegatedPmColorReport ? messageText(delegatedPmColorReport) : "<none>"}.`,
        },
        {
            name: "Relay PM color report uses parent conversation root",
            ok: pmObservedInParentConversation,
            detail: "Expected PM follow-up to keep the original user event as the root e-tag.",
        },
        {
            name: "Pending delegation completion omits p-tags",
            ok: pendingDelegationCompletionPTags.length === 0,
            detail: pendingDelegationCompletion
                ? `Expected same-turn pending delegation completion to have no p-tags; saw ${pendingDelegationCompletionPTags.map((tag) => tag[1]).join(", ")}.`
                : "No same-turn pending delegation completion was published before worker completion.",
        },
        {
            name: "Agent completion contract includes status=completed",
            ok: Boolean(completedStatus),
            detail: "Expected final completion frame to include status=completed.",
        },
        ...evaluateCacheBreakpoints(context),
    ];
}

function evaluateCacheBreakpoints(context: EvaluateContext): Verdict[] {
    if (context.modelName === "mock") {
        return [];
    }
    const states = readAgentContextStates(context.conversationDbPath);

    // Prerequisite: did any turn write tokens to the cache?
    // Without cache_control markers in the request rig does not request caching,
    // so cache_creation_input_tokens is 0 and no hit can ever occur.
    const anyWritten = states.some((s) => {
        if (!s.compactionStateJson) return false;
        try {
            const p = JSON.parse(s.compactionStateJson) as {
                cache_observed?: { written_tokens?: number };
            };
            return (p.cache_observed?.written_tokens ?? 0) > 0;
        } catch {
            return false;
        }
    });

    if (!anyWritten) {
        // rig 0.35 does not add cache_control markers to Anthropic requests by default.
        // Until that is fixed upstream (or we patch rig), cache verdicts cannot be checked.
        return [
            {
                name: "Prompt cache write observed (prerequisite for BreakpointHint)",
                ok: false,
                detail:
                    "cache_creation_input_tokens=0 for all turns — rig does not send cache_control markers, so Anthropic never caches. BreakpointHint verdicts skipped.",
            },
        ];
    }

    const anchored = states.find((s) => s.cacheAnchored);
    const withHints = states.find((s) => {
        if (!s.compactionStateJson) return false;
        try {
            const parsed = JSON.parse(s.compactionStateJson) as {
                breakpoint_hints?: Array<unknown>;
            };
            return Array.isArray(parsed.breakpoint_hints) && parsed.breakpoint_hints.length > 0;
        } catch {
            return false;
        }
    });
    return [
        {
            name: "Prompt cache hit recorded (cache_anchored=true)",
            ok: Boolean(anchored),
            detail: anchored
                ? `Agent ${anchored.agentPubkey.slice(0, 8)} has cache_anchored=true.`
                : "No agent_context_state row has cache_anchored=true.",
        },
        {
            name: "BreakpointHint emitted on cache hit",
            ok: Boolean(withHints),
            detail: withHints
                ? `Agent ${withHints.agentPubkey.slice(0, 8)} has non-empty breakpoint_hints.`
                : "No agent_context_state row has non-empty breakpoint_hints in compaction_state_json.",
        },
    ];
}

function evaluateSameAgentConcurrency(events: Event[], context: EvaluateContext): Verdict[] {
    const firstShell = events.filter(
        (event) => event.pubkey === context.pmPubkey && isShellTool(event, "sleep 2")
    );
    const secondShell = events.filter(
        (event) => event.pubkey === context.pmPubkey && isShellTool(event, "sleep 5")
    );
    const firstObservedSecond = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("First sleep finished while second sleep is still running")
    );
    const secondCompleted = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("Second sleep finished; returning control")
    );
    const unexpectedDefault = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("did not match expected runtime state")
    );

    return [
        {
            name: "Initial execution emitted first shell sleep",
            ok: firstShell.length === 1,
            detail: `Expected exactly one shell tool event with sleep 2, saw ${firstShell.length}.`,
        },
        {
            name: "Follow-up execution saw active first tool and emitted second shell sleep",
            ok: secondShell.length === 1,
            detail: `Expected exactly one shell tool event with sleep 5, saw ${secondShell.length}.`,
        },
        {
            name: "Original execution saw active second tool after first sleep finished",
            ok: Boolean(firstObservedSecond),
            detail:
                "Expected final first execution text proving the active-tool reminder was injected after the first tool result.",
        },
        {
            name: "Follow-up execution completed second sleep",
            ok: Boolean(secondCompleted),
            detail: "Expected final follow-up execution text after second shell result.",
        },
        {
            name: "No mock fallback responses were used",
            ok: !unexpectedDefault,
            detail: "A fallback response means a model turn missed the expected injected runtime state.",
        },
    ];
}

function evaluateFsReadAdjustment(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const correctionText = "actually, only read 4 times total";
    const fsReadEvents = events.filter(
        (event) => event.pubkey === context.pmPubkey && isFsReadTool(event)
    );
    const readPaths = fsReadEvents
        .map(toolArgPath)
        .filter((value): value is string => Boolean(value));
    const expectedPaths = ["file-1.txt", "file-2.txt", "file-3.txt", "file-4.txt"];
    const turnThreeRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.turn === 3 &&
            record.toolCalls?.includes("fs_read")
    );
    const injectedFourthReadRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.turn === 4 &&
            record.toolCalls?.includes("fs_read") &&
            record.requestDebug.includes(correctionText) &&
            record.requestDebug.includes("injected-user-messages") &&
            record.requestDebug.includes("content-file-3")
    );
    const finalRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.turn === 5 &&
            record.content?.includes("Read 4 files total after adjustment") &&
            record.requestDebug.includes(correctionText) &&
            record.requestDebug.includes("content-file-4")
    );
    const finalEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("Read 4 files total after adjustment")
    );
    const unexpectedDefault = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("FS read adjustment probe did not match expected message state")
    );

    return [
        {
            name: "Agent read exactly the first four requested files",
            ok:
                readPaths.length === expectedPaths.length &&
                expectedPaths.every((expected, index) => readPaths[index] === expected),
            detail: `Expected ${expectedPaths.join(", ")}, saw ${readPaths.join(", ") || "<none>"}.`,
        },
        {
            name: "Correction arrived during third model generation",
            ok: Boolean(turnThreeRequest) && !turnThreeRequest?.requestDebug.includes(correctionText),
            detail:
                "Expected the third model request to have started before the correction was injected.",
        },
        {
            name: "Next agent loop received injected correction in messages array",
            ok: Boolean(injectedFourthReadRequest),
            detail:
                "Expected the fourth-read model request to contain the injected-user-messages reminder and correction text.",
        },
        {
            name: "Agent stopped after reading file 4",
            ok: Boolean(finalRequest) && Boolean(finalEvent) && !readPaths.includes("file-5.txt"),
            detail:
                "Expected a final response after file-4.txt and no fs_read call for file-5.txt.",
        },
        {
            name: "No mock fallback responses were used",
            ok: !unexpectedDefault,
            detail: "A fallback response means a model turn missed the expected injected message state.",
        },
    ];
}

function evaluateMcpTool(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const toolEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "mcp__probe__answer_probe")
    );
    const finalEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("MCP probe final: tool output accepted")
    );
    const callRecord = context.mcpProbeRecords?.find(
        (record) => record.event === "call_tool" && record.toolName === "answer_probe"
    );
    const listRecord = context.mcpProbeRecords?.find((record) => record.event === "list_tools");
    const finalRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.turn === 2 &&
            record.requestDebug.includes("MCP probe answered: project-context")
    );
    const unexpectedDefault = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("MCP probe mock response did not match expected runtime state")
    );

    return [
        {
            name: "Runtime exposed project MCP tool to agent",
            ok: Boolean(toolEvent),
            detail: "Expected PM tool event for mcp__probe__answer_probe.",
        },
        {
            name: "Runtime listed MCP tools from project server",
            ok: Boolean(listRecord),
            detail: "Expected MCP probe server log to include tools/list.",
        },
        {
            name: "MCP server ran in project working directory",
            ok: Boolean(callRecord) && callRecord?.cwd === context.workspaceDir,
            detail: `Expected MCP call cwd ${context.workspaceDir}, saw ${String(callRecord?.cwd ?? "<none>")}.`,
        },
        {
            name: "Agent received MCP tool result on next model turn",
            ok: Boolean(finalRequest) && Boolean(finalEvent),
            detail: "Expected second PM turn and final relay event after MCP tool result.",
        },
        {
            name: "No mock fallback responses were used",
            ok: !unexpectedDefault,
            detail: "A fallback response means a model turn missed the expected MCP result.",
        },
    ];
}

function evaluateMcpResource(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const listToolEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "mcp_list_resources")
    );
    const readToolEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "mcp_resource_read")
    );
    const subscribeToolEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "mcp_subscribe")
    );
    const notificationEvent = events.find(
        (event) =>
            event.kind === 1 &&
            hasTag(event, "mcp-subscription") &&
            hasTag(event, "p", context.pmPubkey) &&
            event.content.includes(mcpResourceUpdateId)
    );
    const finalEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(mcpResourceFinalText)
    );
    const listRecord = context.mcpProbeRecords?.find(
        (record) => record.event === "list_resources"
    );
    const initialReadRecord = context.mcpProbeRecords?.find(
        (record) => record.event === "read_resource" && record.uri === "mcp://probe/context"
    );
    const subscribeRecord = context.mcpProbeRecords?.find(
        (record) => record.event === "subscribe_resource" && record.uri === "mcp://probe/context"
    );
    const updateReadRecord = context.mcpProbeRecords
        ?.filter((record) => record.event === "read_resource" && record.uri === "mcp://probe/context")
        .at(1);
    const readResultRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.requestDebug.includes(mcpResourceContentText) &&
            record.toolCalls?.includes("mcp_subscribe")
    );
    const updateRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" && record.requestDebug.includes(mcpResourceUpdateId)
    );
    const unexpectedDefault = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("MCP resource probe mock response did not match")
    );

    return [
        {
            name: "MCP skill exposed resource tools to agent",
            ok: Boolean(listToolEvent) && Boolean(readToolEvent) && Boolean(subscribeToolEvent),
            detail: "Expected PM tool events for mcp_list_resources, mcp_resource_read, and mcp_subscribe.",
        },
        {
            name: "Runtime listed MCP resources from project server",
            ok: Boolean(listRecord),
            detail: "Expected MCP probe server log to include resources/list.",
        },
        {
            name: "Agent received MCP resource read result",
            ok: Boolean(initialReadRecord) && Boolean(readResultRequest),
            detail: "Expected resources/read result to appear in the next PM model request.",
        },
        {
            name: "Runtime subscribed to MCP resource updates",
            ok: Boolean(subscribeRecord),
            detail: "Expected MCP probe server log to include resources/subscribe.",
        },
        {
            name: "Subscription update was delivered to the conversation",
            ok: Boolean(updateReadRecord) && Boolean(notificationEvent) && Boolean(updateRequest),
            detail: "Expected resource update notification, runtime read, and PM model request containing the update.",
        },
        {
            name: "Agent completed after MCP subscription update",
            ok: Boolean(finalEvent),
            detail: "Expected PM final response after receiving the subscription update.",
        },
        {
            name: "No mock fallback responses were used",
            ok: !unexpectedDefault,
            detail: "A fallback response means a model turn missed the expected MCP resource state.",
        },
    ];
}

function isShellTool(event: Event, commandNeedle: string): boolean {
    return (
        event.kind === 1 &&
        hasTag(event, "tool", "shell") &&
        (tagValue(event, "tool-args") ?? "").includes(commandNeedle)
    );
}

function isFsReadTool(event: Event): boolean {
    return event.kind === 1 && hasTag(event, "tool", "fs_read");
}

function toolArgPath(event: Event): string | undefined {
    try {
        const args = JSON.parse(tagValue(event, "tool-args") ?? "{}") as { path?: unknown };
        return typeof args.path === "string" ? args.path : undefined;
    } catch {
        return undefined;
    }
}

function hasTag(event: Event, name: string, value?: string): boolean {
    return event.tags.some((tag) => tag[0] === name && (value === undefined || tag[1] === value));
}

function hasMarkedTag(event: Event, name: string, value: string, marker: string): boolean {
    return event.tags.some((tag) => tag[0] === name && tag[1] === value && tag[3] === marker);
}

function emptyTranscript(conversationId: string): ConversationTranscript {
    return { conversationId, messages: [] };
}

function tagValue(event: Event, name: string): string | undefined {
    return event.tags.find((tag) => tag[0] === name)?.[1];
}
