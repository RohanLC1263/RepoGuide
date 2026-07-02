import { MemoryEvent } from "./memoryEvent";
import { MemoryTimelineStore } from "./memoryTimelineStore";

export class InMemoryTimelineStore implements MemoryTimelineStore {
    private events: MemoryEvent[] = [];

    public async append(event: MemoryEvent): Promise<void> {
        this.events.push(event);
    }

    public async getEvents(memoryId: string): Promise<MemoryEvent[]> {
        return this.events.filter(e => e.memoryId === memoryId);
    }

    public async getAllEvents(): Promise<MemoryEvent[]> {
        return [...this.events];
    }
}
