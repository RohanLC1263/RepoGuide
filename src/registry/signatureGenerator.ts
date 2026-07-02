import { EntitySignature } from './types';

export class SignatureGenerator {
    /**
     * Generates a deterministic V1 string signature for an entity.
     * Format: filePath::symbol::type
     */
    static generate(sig: EntitySignature): string {
        const normalizedFilePath = sig.filePath.replace(/\\/g, '/').toLowerCase();
        const symbolPart = sig.symbol ? sig.symbol : 'block';
        return `${normalizedFilePath}::${symbolPart}::${sig.type}`;
    }
}
