// S15 — Lock acquisition race (unit test, no LLM).
//
// Verifies the Lock state machine under contention. Two near-simultaneous
// dispatches must produce exactly one driver acquisition; the loser must
// observe lock-held and queue. Also verifies parallel-tool finishTool
// transitions ("still-pending" → "reacquired" / "preempted") and the
// onceDriverReleased listener path.

import { Lock } from "../_runtime";
import { log, startClock } from "../_shared";

function assert(name: string, cond: boolean, detail?: string): boolean {
    log(`[assert] ${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
    return cond;
}

async function main(): Promise<void> {
    startClock();
    let allOk = true;

    // ---- (1) Two simultaneous tryAcquire ----
    {
        const lock = new Lock();
        const aOk = lock.tryAcquire("A");
        const bOk = lock.tryAcquire("B");
        allOk = assert("two tryAcquire: A wins, B loses", aOk && !bOk, `aOk=${aOk} bOk=${bOk} driver=${lock.getDriver()}`) && allOk;
        allOk = assert("driver is A", lock.getDriver() === "A") && allOk;
        // tryAcquire is idempotent for same RAL.
        const aAgain = lock.tryAcquire("A");
        allOk = assert("tryAcquire(A) idempotent", aAgain) && allOk;
    }

    // ---- (2) Parallel tools by ONE ral, both finish in order ----
    {
        const lock = new Lock();
        lock.tryAcquire("R1");
        lock.startTool("R1", "X1");
        lock.startTool("R1", "X2");
        allOk = assert("parallel start: driver=null", lock.getDriver() === null) && allOk;
        allOk = assert("parallel start: pending=2", lock.pendingToolCount() === 2) && allOk;
        const r1 = lock.finishTool("R1", "X1");
        allOk = assert("first parallel finish: still-pending", r1 === "still-pending", `got=${r1}`) && allOk;
        const r2 = lock.finishTool("R1", "X2");
        allOk = assert("last parallel finish: reacquired", r2 === "reacquired", `got=${r2}`) && allOk;
        allOk = assert("driver=R1 after reacquire", lock.getDriver() === "R1") && allOk;
    }

    // ---- (3) Preempt: R1 has pending tool, R2 acquires, R1 finishes -> preempted ----
    {
        const lock = new Lock();
        lock.tryAcquire("R1");
        lock.startTool("R1", "X1");
        // R2 dispatch acquires the now-free driver slot.
        const r2Got = lock.tryAcquire("R2");
        allOk = assert("R2 acquires while R1 has pending tool", r2Got) && allOk;
        // R1's tool finishes.
        const r = lock.finishTool("R1", "X1");
        allOk = assert("R1 finishTool with R2 as driver -> preempted", r === "preempted", `got=${r}`) && allOk;
        allOk = assert("driver still R2 after R1 preempt", lock.getDriver() === "R2") && allOk;
    }

    // ---- (4) Two RALs both have pending tools (concurrent background) ----
    {
        const lock = new Lock();
        lock.tryAcquire("R1");
        lock.startTool("R1", "X1");
        lock.tryAcquire("R2"); // R2 streams (no tool yet)
        lock.startTool("R2", "Y1"); // R2 starts its own tool. driver -> null again.
        allOk = assert("two RALs with pending tools: driver=null", lock.getDriver() === null) && allOk;
        allOk = assert("two RALs: pending=2 total", lock.pendingToolCount() === 2) && allOk;
        // R1's tool finishes first. driver=null, R1 has no more pending => reacquire.
        const r1 = lock.finishTool("R1", "X1");
        allOk = assert("R1 finishes first: reacquires (driver was null)", r1 === "reacquired", `got=${r1}`) && allOk;
        // R2's tool finishes. driver=R1 -> preempted (from R2's perspective).
        const r2 = lock.finishTool("R2", "Y1");
        allOk = assert("R2 finishes second: preempted (driver=R1)", r2 === "preempted", `got=${r2}`) && allOk;
    }

    // ---- (5) onceDriverReleased fires exactly once ----
    {
        const lock = new Lock();
        lock.tryAcquire("R1");
        let fires = 0;
        lock.onceDriverReleased(() => fires++);
        lock.releaseDriver("R1");
        allOk = assert("onceDriverReleased: fires once", fires === 1) && allOk;
        // Re-acquire and release again — listener should NOT fire (it was one-shot).
        lock.tryAcquire("R2");
        lock.releaseDriver("R2");
        allOk = assert("onceDriverReleased: not re-fired", fires === 1) && allOk;
    }

    // ---- (6) onceDriverReleased: re-arm pattern ----
    {
        const lock = new Lock();
        lock.tryAcquire("R1");
        let fires = 0;
        const arm = () => lock.onceDriverReleased(() => { fires++; arm(); });
        arm();
        lock.releaseDriver("R1");
        lock.tryAcquire("R2");
        lock.releaseDriver("R2");
        allOk = assert("re-armed listener fires on each release", fires === 2, `fires=${fires}`) && allOk;
    }

    // ---- (7) releaseDriver no-op if not the holder ----
    {
        const lock = new Lock();
        lock.tryAcquire("R1");
        let fires = 0;
        lock.onceDriverReleased(() => fires++);
        lock.releaseDriver("R2"); // not the driver
        allOk = assert("releaseDriver(non-holder): no-op", lock.getDriver() === "R1" && fires === 0) && allOk;
    }

    if (!allOk) {
        log("!! S15 FAILED");
        process.exit(1);
    }
    log("!! S15 PASSED");
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
