export type ADRStatus = "PROPOSED" | "ACCEPTED" | "SUPERSEDED" | "DEPRECATED" | "REJECTED";

export interface ADREntity {
    id: string;
    number?: string;
    title: string;
    status: ADRStatus;
    context: string;
    decision: string;
    consequences: string;
    createdAt?: Date;
    updatedAt?: Date;
    sourcePath: string;
    sourceHash: string; // Used for incremental sync
    repositoryId: string;
    parserConfidence: "HIGH" | "LOW";
    rawContent: string;
}

export interface ADRReference {
    sourceAdrId: string;
    targetAdrId: string;
    relation: "SUPERSEDES" | "SUPERSEDED_BY" | "REFERENCES";
}

export interface ADRSyncStats {
    adrsProcessed: number;
    referencesProcessed: number;
    durationMs: number;
}
