import { ContextAccumulator } from './contextAccumulator';
import { LocationData } from './responseParser';
import { ProvenanceBreakdown } from './provenanceTypes';

export interface Message {
    role: 'user' | 'assistant';
    content: string;
    /** Present on assistant messages — records what evidence tiers the answer drew from. */
    provenance?: ProvenanceBreakdown;
}

interface MessageLocationEntry {
    role: 'user' | 'assistant';
    locationData: LocationData[];
}

export class ConversationHistory {
    private history: Message[] = [];
    private locationHistory: MessageLocationEntry[] = [];

    constructor(private accumulator?: ContextAccumulator) {}

    add(role: 'user' | 'assistant', content: string, locationData?: LocationData[], provenance?: ProvenanceBreakdown): void {
        this.history.push({ role, content, provenance });
        if (this.history.length > 10) {
            this.history = this.history.slice(this.history.length - 10);
        }

        if (locationData && locationData.length > 0) {
            this.locationHistory.push({ role, locationData });
            if (this.locationHistory.length > 10) {
                this.locationHistory = this.locationHistory.slice(this.locationHistory.length - 10);
            }
        }
    }

    getMessages(): Message[] {
        return this.history;
    }

    getLocationHistory(): Array<{ role: 'user' | 'assistant'; locationData: LocationData[] }> {
        return this.locationHistory;
    }

    clear(): void {
        this.history = [];
        this.locationHistory = [];
        this.accumulator?.clear();
    }
}
