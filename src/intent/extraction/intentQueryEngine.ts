import { IntentStore } from './intentStore';
import { IntentEntity, IntentType, IntentEvidence } from './intentTypes';

export class IntentQueryEngine {
    constructor(private store: IntentStore) {}

    public getIntent(id: string): IntentEntity | null {
        return this.store.getIntent(id);
    }

    public listIntents(): IntentEntity[] {
        return this.store.listIntents();
    }

    public getIntentsByType(type: IntentType): IntentEntity[] {
        const all = this.store.listIntents();
        return all.filter(intent => intent.type === type);
    }

    public searchTopic(topic: string): IntentEntity[] {
        const all = this.store.listIntents();
        const lowerTopic = topic.toLowerCase();
        return all.filter(intent => intent.canonicalTopic.toLowerCase().includes(lowerTopic));
    }

    public getEvidence(intentId: string): IntentEvidence[] {
        return this.store.getEvidenceForIntent(intentId);
    }
}
