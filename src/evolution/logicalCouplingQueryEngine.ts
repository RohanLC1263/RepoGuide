import { LogicalCouplingStore } from './logicalCouplingStore';
import { LogicalCouplingEdge, LogicalCouplingQueryEngineApi } from './logicalCouplingTypes';

export class LogicalCouplingQueryEngine implements LogicalCouplingQueryEngineApi {
    constructor(private store: LogicalCouplingStore) {}

    public getCoupledFiles(path: string): LogicalCouplingEdge[] {
        return this.store.getCouplings(path);
    }

    public getStrongestCouplings(limit: number = 10): LogicalCouplingEdge[] {
        return this.store.getStrongestCouplings(limit);
    }

    public getCoupling(source: string, target: string): LogicalCouplingEdge | null {
        return this.store.getCoupling(source, target);
    }

    public getEvidence(edgeId: string): string[] {
        return this.store.getEvidenceForEdge(edgeId);
    }
}
