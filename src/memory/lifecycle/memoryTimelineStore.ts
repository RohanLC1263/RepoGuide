import { MemoryEvent } from "./memoryEvent";

export interface MemoryTimelineStore {
    append(event: MemoryEvent): Promise<void>;
    getEvents(memoryId: string): Promise<MemoryEvent[]>;
    getAllEvents(): Promise<MemoryEvent[]>;
}
