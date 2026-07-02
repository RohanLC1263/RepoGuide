import { ADRStore } from './adrStore';
import { ADREntity, ADRReference, ADRStatus } from './adrTypes';

export class ADRQueryEngine {
    constructor(private store: ADRStore) {}

    public async getADR(id: string): Promise<ADREntity | null> {
        return this.store.getById(id);
    }

    public async listADRs(): Promise<ADREntity[]> {
        return this.store.list();
    }

    public async listByStatus(status: ADRStatus): Promise<ADREntity[]> {
        const all = await this.listADRs();
        return all.filter(adr => adr.status === status);
    }

    public async searchByTitle(query: string): Promise<ADREntity[]> {
        const all = await this.listADRs();
        const lowerQuery = query.toLowerCase();
        return all.filter(adr => adr.title.toLowerCase().includes(lowerQuery));
    }

    public async getReferences(id: string): Promise<ADRReference[]> {
        return this.store.getReferences(id);
    }

    public async listAcceptedADRs(): Promise<ADREntity[]> {
        return this.listByStatus("ACCEPTED");
    }
}
