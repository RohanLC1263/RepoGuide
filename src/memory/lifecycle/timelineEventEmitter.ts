import { MemoryEvent } from "./memoryEvent";
import { MemoryTimelineStore } from "./memoryTimelineStore";

export class TimelineEventEmitter {
    constructor(private readonly store: MemoryTimelineStore) {}

    private generateEventId(): string {
        return `evt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }

    private async emit(memoryId: string, eventType: MemoryEvent['eventType'], reason?: string): Promise<void> {
        const event: MemoryEvent = {
            eventId: this.generateEventId(),
            memoryId,
            eventType,
            timestamp: new Date().toISOString(),
            reason
        };
        await this.store.append(event);
    }

    public async memoryCreated(memoryId: string, reason?: string): Promise<void> {
        await this.emit(memoryId, "created", reason);
    }

    public async memoryPromoted(memoryId: string, reason?: string): Promise<void> {
        await this.emit(memoryId, "promoted", reason);
    }

    public async memoryMerged(existingMemoryId: string, candidateId: string): Promise<void> {
        await this.emit(existingMemoryId, "merged", `Merged with candidate ${candidateId}`);
    }

    public async memoryStaled(memoryId: string, reason?: string): Promise<void> {
        await this.emit(memoryId, "staled", reason);
    }

    public async memoryDormant(memoryId: string, reason?: string): Promise<void> {
        await this.emit(memoryId, "dormant", reason);
    }
}
