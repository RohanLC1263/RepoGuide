import { ADRCodeLinkStore } from './adrCodeLinkStore';
import { ADRCodeLink, ADRCodeEvidence } from './adrCodeLinkTypes';
import { ADRQueryEngine } from '../adr/adrQueryEngine';
import { ProgramGraphStore } from '../../store/programGraphStore';
import { ADREntity } from '../adr/adrTypes';
import { ProgramGraphNode } from '../../graph/programGraphTypes';

export interface GoverningADRResult {
    adr: ADREntity;
    link: ADRCodeLink;
    evidence: ADRCodeEvidence[];
}

export interface GovernedNodeResult {
    node: ProgramGraphNode;
    link: ADRCodeLink;
    evidence: ADRCodeEvidence[];
}

export class ADRCodeQueryEngine {
    constructor(
        private store: ADRCodeLinkStore,
        private adrQueryEngine: ADRQueryEngine,
        private graphStore: ProgramGraphStore
    ) {}

    public async getGoverningADRs(nodeId: string): Promise<GoverningADRResult[]> {
        const links = this.store.getLinksForNode(nodeId);
        const results: GoverningADRResult[] = [];

        for (const link of links) {
            const adr = await this.adrQueryEngine.getADR(link.adrId);
            if (adr) {
                const evidence = this.store.getEvidenceForLink(link.id);
                results.push({ adr, link, evidence });
            }
        }

        return results.sort((a, b) => b.link.score - a.link.score);
    }

    public getGovernedNodes(adrId: string): GovernedNodeResult[] {
        const links = this.store.getLinksForADR(adrId);
        const results: GovernedNodeResult[] = [];

        for (const link of links) {
            const node = this.graphStore.getNode(link.nodeId);
            if (node) {
                const evidence = this.store.getEvidenceForLink(link.id);
                results.push({ node, link, evidence });
            }
        }

        return results.sort((a, b) => b.link.score - a.link.score);
    }
}
