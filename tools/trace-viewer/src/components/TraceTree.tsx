import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { TraceSpan } from "../types.js";

interface TreeNode {
    span: TraceSpan;
    depth: number;
    index: number;
    hasChildren: boolean;
}

interface TraceTreeProps {
    rootSpan: TraceSpan;
    onBack?: () => void;
    traceNavigation?: {
        current: number;
        total: number;
        canGoPrevious: boolean;
        canGoNext: boolean;
    };
}

function flattenTree(
    span: TraceSpan,
    depth: number,
    expandedSet: Set<string>,
    index = { current: 0 }
): TreeNode[] {
    const nodes: TreeNode[] = [];

    nodes.push({
        span,
        depth,
        index: index.current++,
        hasChildren: span.children.length > 0,
    });

    if (expandedSet.has(span.spanId) && span.children.length > 0) {
        for (const child of span.children) {
            nodes.push(...flattenTree(child, depth + 1, expandedSet, index));
        }
    }

    return nodes;
}

function getSpanLabel(span: TraceSpan): { label: string; color: string; icon: string } {
    const attrs = span.attributes;

    // Agent execution - now includes agent slug in operation name
    if (span.operationName.includes("agent.execute")) {
        const agentName = attrs["agent.name"] || attrs["agent.slug"] || "Unknown";
        const phase = attrs["conversation.phase"];

        // Extract agent slug from operation name if present
        const agentMatch = span.operationName.match(/^\[([^\]]+)\]/);
        const agentPrefix = agentMatch ? agentMatch[1] : agentName;

        const label = `${agentPrefix} executes${phase ? ` [${phase}]` : ""}`;
        return { label, color: "blue", icon: "🤖" };
    }

    // Event processing
    if (span.operationName === "tenex.event.process") {
        const content = attrs["event.content"];
        const preview = content ? `${content.substring(0, 50)}...` : "Event";
        return { label: preview, color: "cyan", icon: "📨" };
    }

    // LLM call - now includes agent slug in operation name
    if (
        span.operationName.includes("ai.streamText") ||
        span.operationName.includes("ai.generateText")
    ) {
        const model = attrs["ai.model.id"] || "unknown";
        const shortModel = model.split("/").pop() || model;

        // Extract agent slug from operation name if present
        const agentMatch = span.operationName.match(/^\[([^\]]+)\]/);
        const agentPrefix = agentMatch ? `[${agentMatch[1]}] ` : "";

        return { label: `${agentPrefix}LLM: ${shortModel}`, color: "magenta", icon: "🧠" };
    }

    // Tool call - now includes agent slug in operation name
    if (span.operationName.startsWith("[") || span.operationName.includes("ai.toolCall")) {
        // New format: "[agent-slug] ai.toolCall.toolName" or legacy "ai.toolCall"
        const toolName = attrs["ai.toolCall.name"] || "unknown";
        const args = attrs["ai.toolCall.args"];

        // Extract agent slug from operation name if present
        const agentMatch = span.operationName.match(/^\[([^\]]+)\]/);
        const agentPrefix = agentMatch ? `[${agentMatch[1]}] ` : "";

        let preview = toolName;
        if (args) {
            try {
                const parsed = JSON.parse(args);
                const keys = Object.keys(parsed).slice(0, 2);
                if (keys.length > 0) {
                    preview += `(${keys.map((k) => `${k}="${parsed[k]}"`).join(", ")})`;
                }
            } catch {}
        }
        return { label: `${agentPrefix}Tool: ${preview}`, color: "green", icon: "🔧" };
    }

    // Message strategy
    if (span.operationName === "tenex.strategy.build_messages") {
        return { label: "Build messages", color: "yellow", icon: "📝" };
    }

    return { label: span.operationName, color: "white", icon: "•" };
}

export function TraceTree({ rootSpan, onBack, traceNavigation }: TraceTreeProps) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set([rootSpan.spanId]));
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [showDetail, setShowDetail] = useState(false);

    const flatNodes = flattenTree(rootSpan, 0, expanded);
    const selectedNode = flatNodes[selectedIndex];

    useInput((input: string, key: any) => {
        if (showDetail) {
            // In detail view
            if (input === "q" || key.escape) {
                setShowDetail(false);
            }
            return;
        }

        // Back to list or quit
        if (input === "b" || key.escape) {
            if (onBack) {
                onBack();
            } else {
                process.exit(0);
            }
            return;
        }

        // Quit app
        if (input === "q") {
            process.exit(0);
        }

        // Tree navigation
        if (key.upArrow) {
            setSelectedIndex(Math.max(0, selectedIndex - 1));
        } else if (key.downArrow) {
            setSelectedIndex(Math.min(flatNodes.length - 1, selectedIndex + 1));
        } else if (key.rightArrow || input === " ") {
            if (selectedNode?.hasChildren) {
                setExpanded((prev) => new Set([...prev, selectedNode.span.spanId]));
            }
        } else if (key.leftArrow) {
            if (selectedNode && expanded.has(selectedNode.span.spanId)) {
                setExpanded((prev) => {
                    const next = new Set(prev);
                    next.delete(selectedNode.span.spanId);
                    return next;
                });
            }
        } else if (key.return) {
            setShowDetail(true);
        } else if (input === "e") {
            // Expand all
            const allSpanIds = new Set<string>();
            function collectIds(span: TraceSpan) {
                allSpanIds.add(span.spanId);
                span.children.forEach(collectIds);
            }
            collectIds(rootSpan);
            setExpanded(allSpanIds);
        } else if (input === "c") {
            // Collapse all
            setExpanded(new Set([rootSpan.spanId]));
        }
    });

    if (showDetail && selectedNode) {
        return <SpanDetail span={selectedNode.span} />;
    }

    const navHelp = traceNavigation
        ? `n/p next/prev trace (${traceNavigation.current}/${traceNavigation.total}), `
        : "";

    const backHelp = onBack ? "b/ESC back, " : "";

    const helpText = ` - ${navHelp}↑↓ navigate, →/Space expand, ← collapse, Enter details, e/c expand/collapse all, ${backHelp}r refresh, q quit`;

    return (
        <Box flexDirection="column">
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
                <Text bold color="cyan">
                    TENEX Trace Viewer
                </Text>
                <Text dimColor>{helpText}</Text>
            </Box>

            <Box flexDirection="column" marginTop={1}>
                {flatNodes.map((node, idx) => {
                    const isSelected = idx === selectedIndex;
                    const isExpanded = expanded.has(node.span.spanId);
                    const { label, color, icon } = getSpanLabel(node.span);
                    const durationMs = node.span.duration / 1000;

                    return (
                        <Box key={node.span.spanId}>
                            <Text backgroundColor={isSelected ? "blue" : undefined}>
                                <Text>{" ".repeat(node.depth * 2)}</Text>
                                {node.hasChildren && <Text>{isExpanded ? "▼" : "▶"} </Text>}
                                {!node.hasChildren && <Text> </Text>}
                                <Text>{icon} </Text>
                                <Text color={color}>{label}</Text>
                                <Text dimColor> ({durationMs.toFixed(1)}ms)</Text>
                                {node.span.events.length > 0 && (
                                    <Text dimColor> • {node.span.events.length} events</Text>
                                )}
                            </Text>
                        </Box>
                    );
                })}
            </Box>

            <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
                <Text dimColor>
                    Selected:{" "}
                    <Text color="cyan">
                        {selectedNode ? getSpanLabel(selectedNode.span).label : "None"}
                    </Text>
                    {" | "}
                    Duration:{" "}
                    <Text color="yellow">
                        {selectedNode ? (selectedNode.span.duration / 1000).toFixed(1) : "0"}ms
                    </Text>
                    {traceNavigation && (
                        <>
                            {" | "}
                            Trace:{" "}
                            <Text color="cyan">
                                {traceNavigation.current}/{traceNavigation.total}
                            </Text>
                            {traceNavigation.canGoPrevious && <Text color="green"> ← p</Text>}
                            {traceNavigation.canGoNext && <Text color="green"> n →</Text>}
                        </>
                    )}
                </Text>
            </Box>
        </Box>
    );
}

function SpanDetail({ span }: { span: TraceSpan }) {
    const { label, color } = getSpanLabel(span);

    return (
        <Box flexDirection="column">
            <Box borderStyle="double" borderColor="cyan" paddingX={1}>
                <Text bold color="cyan">
                    Span Details
                </Text>
                <Text dimColor> - Press q or ESC to go back</Text>
            </Box>

            <Box flexDirection="column" marginTop={1} paddingX={2}>
                <Text bold color={color}>
                    {label}
                </Text>
                <Text dimColor>Operation: {span.operationName}</Text>
                <Text dimColor>Span ID: {span.spanId}</Text>
                <Text dimColor>Duration: {(span.duration / 1000).toFixed(2)}ms</Text>

                {Object.keys(span.attributes).length > 0 && (
                    <Box flexDirection="column" marginTop={1}>
                        <Text bold underline>
                            Attributes:
                        </Text>
                        {Object.entries(span.attributes).map(([key, value]) => {
                            let displayValue = String(value);
                            if (typeof value === "string" && value.length > 100) {
                                displayValue = `${value.substring(0, 100)}...`;
                            }
                            return (
                                <Box key={key}>
                                    <Text color="gray"> • </Text>
                                    <Text color="yellow">{key}</Text>
                                    <Text>: </Text>
                                    <Text color="green">{displayValue}</Text>
                                </Box>
                            );
                        })}
                    </Box>
                )}

                {span.events.length > 0 && (
                    <Box flexDirection="column" marginTop={1}>
                        <Text bold underline>
                            Events ({span.events.length}):
                        </Text>
                        {span.events.map((event, idx) => (
                            <Box key={idx} flexDirection="column" marginLeft={2} marginTop={1}>
                                <Text color="cyan">📌 {event.name}</Text>
                                {Object.entries(event.attributes).map(([key, value]) => {
                                    let displayValue = String(value);
                                    if (typeof value === "string" && value.length > 200) {
                                        displayValue = `${value.substring(0, 200)}...`;
                                    }
                                    return (
                                        <Box key={key} marginLeft={2}>
                                            <Text color="gray"> • </Text>
                                            <Text color="yellow">{key}</Text>
                                            <Text>: </Text>
                                            <Text color="green">{displayValue}</Text>
                                        </Box>
                                    );
                                })}
                            </Box>
                        ))}
                    </Box>
                )}

                {span.children.length > 0 && (
                    <Box marginTop={1}>
                        <Text bold underline>
                            Children: {span.children.length} spans
                        </Text>
                    </Box>
                )}
            </Box>
        </Box>
    );
}
