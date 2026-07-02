import { MemoryValueRepository } from "./memoryValueRepository";
import { TimelineEventEmitter } from "./timelineEventEmitter";

export class DormancyService {
    private readonly DORMANCY_THRESHOLD = 0.3;

    constructor(
        private readonly valueRepository: MemoryValueRepository,
        private readonly timelineEmitter: TimelineEventEmitter
    ) {}

    public async evaluateMemory(memoryId: string): Promise<void> {
        const metadata = await this.valueRepository.getMetadata(memoryId);
        if (!metadata) return;

        if (metadata.status === 'active' && metadata.valueScore < this.DORMANCY_THRESHOLD) {
            await this.transitionToDormant(memoryId, "Value score fell below 0.3 threshold");
        }
    }

    public async transitionToDormant(memoryId: string, reason?: string): Promise<void> {
        await this.valueRepository.markDormant(memoryId);
        await this.timelineEmitter.memoryDormant(memoryId, reason);
    }

    public async reactivateMemory(memoryId: string, reason?: string): Promise<void> {
        const metadata = await this.valueRepository.getMetadata(memoryId);
        if (metadata && metadata.status === 'dormant') {
            await this.valueRepository.markActive(memoryId);
            // Re-evaluating score isn't strictly necessary here, but we'd emit an event. 
            // The prompt says "Timeline records transition" but hasn't explicitly added a 'resurrected' 
            // event yet for V1.5 Phase B, though it was in memoryEvent.ts. We'll emit nothing or log it 
            // unless we decide to use resurrected. The prompt explicitly says: "Do NOT implement resurrected yet."
            // We just activate it. 
        }
    }
}
