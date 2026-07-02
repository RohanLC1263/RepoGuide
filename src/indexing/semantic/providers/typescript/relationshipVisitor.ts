import * as ts from 'typescript';
import { ProgramHandle, ResolvedRelationshipObservation } from './internalModels';
import { ProviderDiagnostic, KnownUnknown } from '../../semanticProviderContract';
import { LocationMapper } from './mappers/locationMapper';
import { RelationshipResolver } from './resolution/relationshipResolver';

export class RelationshipVisitor {
    private observations: ResolvedRelationshipObservation[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];
    private locationMapper = new LocationMapper();

    public processNode(node: ts.Node, handle: ProgramHandle): void {
        const sourceFile = handle.sourceFile;
        try {
            const results = RelationshipResolver.resolve(node, handle);
            for (const result of results) {
                if (result.type === 'observation') {
                    this.observations.push(result.observation);
                } else if (result.type === 'unknown') {
                    this.knownUnknowns.push(result.unknown);
                }
            }
        } catch (err: any) {
            this.diagnostics.push({
                code: 'EXT-004',
                severity: 'error',
                message: `Internal error during relationship extraction: ${err.message}`,
                location: this.locationMapper.map(node, sourceFile) as any
            });
        }
    }

    public getResults() {
        return {
            observations: this.observations,
            diagnostics: this.diagnostics,
            knownUnknowns: this.knownUnknowns
        };
    }
}
