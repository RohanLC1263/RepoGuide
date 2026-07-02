import * as crypto from 'crypto';
import { EntitySignature } from './types';
import { SignatureGenerator } from './signatureGenerator';
import { EntityRegistryStore } from './entityRegistryStore';

export class UUIDResolver {
    constructor(private store: EntityRegistryStore) {}

    /**
     * Resolves a deterministic UUID for a given entity signature.
     * If the entity signature is known, returns the existing UUID.
     * If there's an alias pointing to a UUID, returns the aliased UUID.
     * Otherwise, generates a new UUID v4, stores it, and returns it.
     */
    resolveUUID(sig: EntitySignature): string {
        const signatureString = SignatureGenerator.generate(sig);
        const now = Date.now();

        // 1. Check existing records
        const record = this.store.getRecordBySignature(signatureString);
        if (record) {
            this.store.updateLastSeen(record.uuid, now);
            return record.uuid;
        }

        // 2. Check aliases (future-proofing)
        const aliasedUuid = this.store.getAliasResolution(signatureString);
        if (aliasedUuid) {
            this.store.updateLastSeen(aliasedUuid, now);
            return aliasedUuid;
        }

        // 3. Generate new UUID
        const newUuid = crypto.randomUUID();
        this.store.insertRecord({
            uuid: newUuid,
            signature: signatureString,
            entityType: sig.type,
            createdAt: now,
            lastSeenAt: now
        });

        return newUuid;
    }
}
