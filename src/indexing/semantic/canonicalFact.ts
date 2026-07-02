import * as crypto from 'crypto';
import { EvidenceReference } from './semanticProviderContract';

export type FactType = 'ENTITY' | 'RELATIONSHIP' | 'UNKNOWN';

export interface CanonicalFact {
    readonly factId: string;
    readonly factType: FactType;
    readonly payload: Record<string, any>;
}

export interface FactObservation {
    readonly observationId: string;
    readonly factId: string;
    readonly provenance: string;
    readonly evidence: EvidenceReference[];
}

export class CanonicalFactFactory {
    public static createFact(factType: FactType, payload: Record<string, any>): CanonicalFact {
        const factId = this.hashFact(factType, payload);
        const fact = { factId, factType, payload };
        return this.deepFreeze(fact);
    }

    public static createObservation(factId: string, provenance: string, evidence: EvidenceReference[]): FactObservation {
        const observationId = this.hashObservation(factId, provenance, evidence);
        const obs = { observationId, factId, provenance, evidence };
        return this.deepFreeze(obs);
    }

    public static hashFact(factType: FactType, payload: Record<string, any>): string {
        const payloadString = this.serializePayload(payload);
        return crypto.createHash('sha256')
            .update(factType)
            .update('|')
            .update(payloadString)
            .digest('hex');
    }

    public static hashObservation(factId: string, provenance: string, evidence: EvidenceReference[]): string {
        const evidenceString = this.serializeEvidence(evidence);
        return crypto.createHash('sha256')
            .update(factId)
            .update('|')
            .update(provenance)
            .update('|')
            .update(evidenceString)
            .digest('hex');
    }

    private static serializePayload(payload: any, visited = new Set<any>()): string {
        if (payload === null) {
            return 'null';
        }
        if (payload === undefined) {
            return 'undefined';
        }
        if (typeof payload === 'function' || typeof payload === 'symbol') {
            throw new Error(`Unsupported payload type: ${typeof payload}`);
        }
        if (typeof payload !== 'object') {
            return String(payload);
        }

        if (payload instanceof Date || payload instanceof Map || payload instanceof Set || payload instanceof WeakMap || payload instanceof WeakSet || payload instanceof Promise) {
            throw new Error(`Unsupported complex object in payload: ${payload.constructor?.name}`);
        }

        if (visited.has(payload)) {
            throw new Error('Cyclic reference detected during serialization');
        }
        visited.add(payload);

        if (Array.isArray(payload)) {
            const arrStr = '[' + payload.map(item => this.serializePayload(item, visited)).join(',') + ']';
            visited.delete(payload);
            return arrStr;
        }

        const keys = Object.keys(payload).sort();
        const parts = keys.map(k => `${k}:${this.serializePayload(payload[k], visited)}`);
        visited.delete(payload);
        return '{' + parts.join(',') + '}';
    }

    private static serializeEvidence(evidence: EvidenceReference[]): string {
        const sortedEvidence = [...(evidence || [])].sort((a, b) => {
            const aStr = `${a.id}|${a.type}|${a.location?.filePath}|${a.location?.startLine}|${a.location?.endLine}`;
            const bStr = `${b.id}|${b.type}|${b.location?.filePath}|${b.location?.startLine}|${b.location?.endLine}`;
            return aStr.localeCompare(bStr);
        });
        
        return sortedEvidence.map(e => `${e.id}|${e.type}|${e.location?.filePath}|${e.location?.startLine}|${e.location?.endLine}`).join(';');
    }

    private static deepFreeze<T>(obj: T, visited = new Set<any>()): T {
        if (obj === null || typeof obj !== 'object') {
            return obj;
        }

        if (visited.has(obj)) {
            return obj; // prevent infinite recursion on cyclic refs
        }
        visited.add(obj);

        Object.keys(obj as any).forEach(prop => {
            const val = (obj as any)[prop];
            if (typeof val === 'object' && val !== null) {
                this.deepFreeze(val, visited);
            }
        });

        return Object.freeze(obj);
    }
}
