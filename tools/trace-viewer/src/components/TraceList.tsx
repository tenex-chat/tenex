import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import React, { useState, useEffect } from "react";
import type { TraceSummary } from "../types.js";

interface TraceListProps {
    traces: TraceSummary[];
    loading: boolean;
    error?: string;
    onSelect: (traceId: string) => void;
    onRefresh: () => void;
}

export function TraceList({ traces, loading, error, onSelect, onRefresh }: TraceListProps) {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useInput((input: string, key: any) => {
        if (loading) return;

        // Quit
        if (input === "q") {
            process.exit(0);
        }

        // Refresh
        if (input === "r") {
            onRefresh();
            return;
        }

        // Navigation
        if (key.upArrow) {
            setSelectedIndex(Math.max(0, selectedIndex - 1));
        } else if (key.downArrow) {
            setSelectedIndex(Math.min(traces.length - 1, selectedIndex + 1));
        } else if (key.return) {
            // Select trace
            if (traces[selectedIndex]) {
                onSelect(traces[selectedIndex].traceId);
            }
        }
    });

    // Reset selection if traces change
    useEffect(() => {
        if (selectedIndex >= traces.length) {
            setSelectedIndex(Math.max(0, traces.length - 1));
        }
    }, [traces.length, selectedIndex]);

    if (loading) {
        return (
            <Box flexDirection="column">
                <Box borderStyle="single" borderColor="gray" paddingX={1}>
                    <Text bold color="cyan">
                        TENEX Trace Viewer
                    </Text>
                    <Text dimColor> - Loading traces...</Text>
                </Box>
                <Box marginTop={1} paddingX={2}>
                    <Text color="green">
                        <Spinner type="dots" />
                    </Text>
                    <Text> Loading traces from Jaeger...</Text>
                </Box>
            </Box>
        );
    }

    if (error) {
        return (
            <Box flexDirection="column">
                <Box borderStyle="single" borderColor="red" paddingX={1}>
                    <Text bold color="red">
                        Error
                    </Text>
                </Box>
                <Box marginTop={1} paddingX={2} flexDirection="column">
                    <Text color="red">Failed to load traces:</Text>
                    <Text color="red">{error}</Text>
                    <Box marginTop={1}>
                        <Text dimColor>Press 'r' to retry, 'q' to quit</Text>
                    </Box>
                </Box>
            </Box>
        );
    }

    if (traces.length === 0) {
        return (
            <Box flexDirection="column">
                <Box borderStyle="single" borderColor="gray" paddingX={1}>
                    <Text bold color="cyan">
                        TENEX Trace Viewer
                    </Text>
                </Box>
                <Box marginTop={1} paddingX={2} flexDirection="column">
                    <Text color="yellow">No traces found</Text>
                    <Box marginTop={1}>
                        <Text dimColor>Make sure TENEX is running and processing events.</Text>
                    </Box>
                    <Text dimColor>Press 'r' to refresh, 'q' to quit</Text>
                </Box>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
                <Text bold color="cyan">
                    TENEX Trace Viewer
                </Text>
                <Text dimColor>
                    {" "}
                    - Select a trace to view (↑↓ to navigate, Enter to select, r to refresh, q to
                    quit)
                </Text>
            </Box>

            <Box flexDirection="column" marginTop={1}>
                {traces.map((trace, idx) => {
                    const isSelected = idx === selectedIndex;
                    const ageMs = Date.now() - trace.timestamp;
                    const ageSeconds = Math.floor(ageMs / 1000);
                    const ageMinutes = Math.floor(ageSeconds / 60);
                    const ageHours = Math.floor(ageMinutes / 60);

                    let ageStr = "";
                    if (ageHours > 0) {
                        ageStr = `${ageHours}h ago`;
                    } else if (ageMinutes > 0) {
                        ageStr = `${ageMinutes}m ago`;
                    } else {
                        ageStr = `${ageSeconds}s ago`;
                    }

                    return (
                        <Box key={trace.traceId}>
                            <Text backgroundColor={isSelected ? "blue" : undefined}>
                                <Text>{isSelected ? "→ " : "  "}</Text>
                                <Text color="gray">[{ageStr}]</Text>
                                <Text> </Text>
                                <Text color="white">{trace.summary}</Text>
                                <Text dimColor> ({trace.duration}ms)</Text>
                            </Text>
                        </Box>
                    );
                })}
            </Box>

            <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
                <Text dimColor>
                    Showing {traces.length} recent traces | Selected:{" "}
                    <Text color="cyan">
                        {selectedIndex + 1}/{traces.length}
                    </Text>
                </Text>
            </Box>
        </Box>
    );
}
