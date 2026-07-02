export class RepoguideTestUtils {
    private static testMode = false;

    public static enableTestMode(): void {
        this.testMode = true;
    }

    public static disableTestMode(): void {
        this.testMode = false;
    }

    public static isTestMode(): boolean {
        return this.testMode;
    }

    public static schedule(callback: () => void, ms: number): NodeJS.Timeout {
        return setTimeout(callback, this.testMode ? 0 : ms);
    }
}
