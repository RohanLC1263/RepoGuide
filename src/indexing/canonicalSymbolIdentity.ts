export type IdentityAuthority = 'compiler' | 'parser' | 'heuristic' | 'generated' | 'external';

export type IdentityOrigin = 'Repository' | 'ExternalDependency' | 'Builtin' | 'Ambient' | 'Synthetic';

export interface DeclarationLocation {
    filePath: string;
    startOffset: number;
    endOffset: number;
    line: number;
    character: number;
}

export interface IdentityEvolution {
    previousIdentities?: CanonicalSymbolIdentity[];
    supersededBy?: CanonicalSymbolIdentity;
    introducedCommit?: string;
    removedCommit?: string;
}

export interface CanonicalSymbolIdentity {
    package: string;
    logicalNamespace: string;
    kind: string;
    qualifiedName: string;
    signatureHash: string;
    identityOrigin: IdentityOrigin;
    identityAuthority: IdentityAuthority;
}
