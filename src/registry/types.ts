export interface EntitySignature {
    filePath: string;
    symbol?: string;
    type: string;
}

export interface EntityRecord {
    uuid: string;
    signature: string;
    entityType: string;
    createdAt: number;
    lastSeenAt: number;
}

export interface RegistryMetrics {
    registryHits: number;
    registryMisses: number;
    newUuidCount: number;
    signatureCollisions: number;
    aliasResolutions: number;
}
