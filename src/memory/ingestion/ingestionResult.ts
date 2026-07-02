export interface IngestionResult {
    accepted: boolean;
    rejectionReason?: string;
    finalState: 'rejected' | 'ephemeral' | 'persistent';
    affectedMemoryId?: string;
}
