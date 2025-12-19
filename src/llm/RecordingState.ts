import { EventEmitter } from "tseep";

/**
 * Global recording state singleton.
 * Controls whether the flight recorder middleware saves LLM interactions.
 */
class RecordingStateManager extends EventEmitter<{
    "state-changed": (isRecording: boolean) => void;
}> {
    private _isRecording = false;

    get isRecording(): boolean {
        return this._isRecording;
    }

    toggle(): boolean {
        this._isRecording = !this._isRecording;
        this.emit("state-changed", this._isRecording);
        return this._isRecording;
    }

    start(): void {
        if (!this._isRecording) {
            this._isRecording = true;
            this.emit("state-changed", true);
        }
    }

    stop(): void {
        if (this._isRecording) {
            this._isRecording = false;
            this.emit("state-changed", false);
        }
    }
}

export const recordingState = new RecordingStateManager();
