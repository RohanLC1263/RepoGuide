export class RequestQueue {
    private queue: Array<() => void> = [];
    private runningCount = 0;

    constructor(private maxConcurrent: number = 1) {}

    async enqueue<T>(task: () => Promise<T>): Promise<T> {
        const release = await this.acquire();
        try {
            return await task();
        } finally {
            release();
        }
    }

    async acquire(): Promise<() => void> {
        return new Promise(resolve => {
            const start = () => {
                this.runningCount++;
                let released = false;
                resolve(() => {
                    if (released) {
                        return;
                    }
                    released = true;
                    this.runningCount--;
                    this.processNext();
                });
            };

            this.queue.push(start);
            this.processNext();
        });
    }

    private processNext(): void {
        if (this.runningCount >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        const start = this.queue.shift();
        start?.();
    }

    get pendingCount(): number {
        return this.queue.length;
    }

    get isRunning(): boolean {
        return this.runningCount > 0;
    }
}
