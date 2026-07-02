export interface MemoryEvent {
    eventId: string;
    memoryId: string;
    eventType:
        | "created"
        | "promoted"
        | "merged"
        | "staled"
        | "resurrected"
        | "dormant"
        | "archived";
    timestamp: string;
    reason?: string;
}
