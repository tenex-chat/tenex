import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import React, { useState, useEffect } from "react";
import { JaegerClient } from "../services/JaegerClient.js";
import type { Trace, TraceSummary } from "../types.js";
import { TraceTree } from "./TraceTree.js";

interface AppProps {
    jaegerUrl?: string;
    serviceName?: string;
}

export function App({
    jaegerUrl = "http://localhost:16686",
    serviceName = "tenex-daemon",
}: AppProps) {
    const [traces, setTraces] = useState<TraceSummary[]>([]);
    const [currentTraceIndex, setCurrentTraceIndex] = useState(0);
    const [currentTrace, setCurrentTrace] = useState<Trace | undefined>();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | undefined>();

    const jaegerClient = new JaegerClient(jaegerUrl);

    // Load traces and first trace on mount
    useEffect(() => {
        loadTracesAndFirst();
    }, []);

    const loadTracesAndFirst = async () => {
        setLoading(true);
        setError(undefined);
        try {
            const fetchedTraces = await jaegerClient.getTraces(serviceName, 50);
            setTraces(fetchedTraces);

            if (fetchedTraces.length > 0) {
                // Load the first (most recent) trace immediately
                const firstTrace = await jaegerClient.getTrace(fetchedTraces[0].traceId);
                setCurrentTrace(firstTrace);
                setCurrentTraceIndex(0);
            }
        } catch (error) {
            setError(error instanceof Error ? error.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    const navigateToTrace = async (index: number) => {
        if (index < 0 || index >= traces.length) return;

        setLoading(true);
        try {
            const trace = await jaegerClient.getTrace(traces[index].traceId);
            setCurrentTrace(trace);
            setCurrentTraceIndex(index);
        } catch (error) {
            setError(error instanceof Error ? error.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    const handleNext = () => {
        if (currentTraceIndex < traces.length - 1) {
            navigateToTrace(currentTraceIndex + 1);
        }
    };

    const handlePrevious = () => {
        if (currentTraceIndex > 0) {
            navigateToTrace(currentTraceIndex - 1);
        }
    };

    const handleRefresh = async () => {
        await loadTracesAndFirst();
    };

    // Handle trace navigation
    useInput((input: string, key: any) => {
        if (loading) return;

        if (input === "n" && !key.shift) {
            handleNext();
        } else if (input === "p" && !key.shift) {
            handlePrevious();
        } else if (input === "r" && !key.shift) {
            handleRefresh();
        } else if (key.leftArrow && key.meta) {
            // Cmd+Left or Alt+Left for previous trace
            handlePrevious();
        } else if (key.rightArrow && key.meta) {
            // Cmd+Right or Alt+Right for next trace
            handleNext();
        }
    });

    // Loading state
    if (loading && !currentTrace) {
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

    // Error state
    if (error && !currentTrace) {
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

    // No traces state
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

    // Show current trace
    if (currentTrace) {
        const currentTraceSummary = traces[currentTraceIndex];
        const ageMs = Date.now() - currentTraceSummary.timestamp;
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
            <Box flexDirection="column">
                {/* Trace metadata header */}
                <Box borderStyle="single" borderColor="cyan" paddingX={1}>
                    <Text bold color="cyan">
                        Trace {currentTraceIndex + 1}/{traces.length}
                    </Text>
                    <Text dimColor> - {ageStr}</Text>
                    <Text> </Text>
                    <Text color="white">{currentTraceSummary.summary}</Text>
                    <Text dimColor> ({currentTraceSummary.duration}ms)</Text>
                </Box>

                {/* Trace hierarchy */}
                <TraceTree
                    rootSpan={currentTrace.rootSpan}
                    traceNavigation={{
                        current: currentTraceIndex + 1,
                        total: traces.length,
                        canGoPrevious: currentTraceIndex > 0,
                        canGoNext: currentTraceIndex < traces.length - 1,
                    }}
                />
            </Box>
        );
    }

    return null;
}
