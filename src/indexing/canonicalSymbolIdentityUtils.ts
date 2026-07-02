import * as crypto from 'crypto';
import { CanonicalSymbolIdentity } from './canonicalSymbolIdentity';

export function formatUrn(id: CanonicalSymbolIdentity): string {
    return `rg://${id.package}/${id.logicalNamespace}#${id.kind}:${id.qualifiedName}@${id.signatureHash}`;
}

export function parseUrn(urn: string): CanonicalSymbolIdentity {
    const regex = /^rg:\/\/([^\/]+)\/(.+)#([^:]+):([^@]+)@(.+)$/;
    const match = urn.match(regex);
    if (!match) {
        throw new Error(`Invalid CanonicalSymbolIdentity URN format: ${urn}`);
    }

    return {
        package: match[1],
        logicalNamespace: match[2],
        kind: match[3],
        qualifiedName: match[4],
        signatureHash: match[5]
    , identityOrigin: 'Synthetic', identityAuthority: 'compiler'};
}

export function computeSignatureHash(params: string[], returnType: string, constraints: string[] = []): string {
    const normalized = `${constraints.join(',')}|${params.join(',')}|${returnType}`;
    return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 8);
}
