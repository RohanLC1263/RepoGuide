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

/** Messages retained, regardless of size. */
const MAX_MESSAGES = 10;

/**
 * Character ceiling on the retained window, enforced in addition to MAX_MESSAGES --
 * whichever limit binds first wins.
 *
 * WHY A CHARACTER CAP EXISTS AT ALL. This window is not just prompt garnish: its
 * length is subtracted from the evidence budget in buildEvidenceMessages()
 * (`historyChars` -> `deriveEvidenceBudgetChars`), so every character kept here is a
 * character of real repository evidence that does not reach the model. A 10-message
 * cap bounds the count but not the size, and answers run to thousands of characters
 * each, so the window grew without limit in practice: measured at 10.3% of the
 * evidence budget after three exchanges, 27.3% after twelve, and 38.2% by the end of
 * a 38-question session.
 *
 * The consequence was not subtle. Holding the question, the index, the process and
 * the model fixed, and varying only session depth, the pass rate over eight
 * characterised questions fell 6/8 -> 4/8 -> 2/8, and six of those eight flipped
 * outcome on session depth alone. Two identical runs of the same suite were
 * therefore not comparable measurements. 4000 chars is roughly two exchanges of
 * follow-up context -- enough for "it"/"that one" to resolve, which is the only
 * thing this window is actually for -- while bounding the evidence it can displace
 * to under 10%.
 *
 * Oldest-first: the most recent turns are the ones a follow-up refers to.
 */
const MAX_HISTORY_CHARS = 4000;

export class ConversationHistory {
    private history: Message[] = [];
    private locationHistory: MessageLocationEntry[] = [];

    constructor(private accumulator?: ContextAccumulator) {}

    /**
     * Drops whole messages from the front until the window fits MAX_HISTORY_CHARS.
     * Never empties the window: the newest message is always kept, even if it alone
     * exceeds the cap, so a single long answer cannot silently disable follow-up
     * resolution altogether.
     */
    private trimToCharBudget(): void {
        const cost = (m: Message): number => m.content.length + 20; // 20: role/JSON framing, matching buildEvidenceMessages
        let total = this.history.reduce((sum, m) => sum + cost(m), 0);
        while (this.history.length > 1 && total > MAX_HISTORY_CHARS) {
            total -= cost(this.history[0]);
            this.history.shift();
        }
    }

    add(role: 'user' | 'assistant', content: string, locationData?: LocationData[], provenance?: ProvenanceBreakdown): void {
        this.history.push({ role, content, provenance });
        if (this.history.length > MAX_MESSAGES) {
            this.history = this.history.slice(this.history.length - MAX_MESSAGES);
        }
        this.trimToCharBudget();

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
