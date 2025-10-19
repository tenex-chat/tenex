export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, any>;
}

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: number;
  duration: number;
  attributes: Record<string, any>;
  events: SpanEvent[];
  children: TraceSpan[];
}

export interface Trace {
  traceId: string;
  rootSpan: TraceSpan;
  totalDuration: number;
  timestamp: number;
}

export interface TraceSummary {
  traceId: string;
  summary: string;
  duration: number;
  timestamp: number;
}
