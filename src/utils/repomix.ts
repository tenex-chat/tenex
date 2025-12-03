export interface RepomixResult {
    content: string;
    size: number;
    lines: number;
    cleanup: () => void;
}
