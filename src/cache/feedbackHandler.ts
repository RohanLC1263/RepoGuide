import { QACache } from './qaCache';

export class FeedbackHandler {
    constructor(private cache: QACache) {}

    recordPositive(pairId: number): void {
        this.cache.updateQuality(pairId, 0.1);
        this.cache.incrementHitCount(pairId);
    }

    recordNegative(pairId: number): void {
        this.cache.updateQuality(pairId, -0.2);
    }

    getStaleIds(): number[] {
        return this.cache.getStaleIds();
    }

    hasStale(): boolean {
        return this.getStaleIds().length > 0;
    }
}
