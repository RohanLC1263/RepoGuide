import { RepositoryEntity } from '../../semanticProviderContract';
import { DeclarationExtractionResult } from './internalModels';

export class RepositoryEntityAssembler {
    public assemble(result: DeclarationExtractionResult): RepositoryEntity {
        if (!result.canonicalIdentity) {
            throw new Error(`Cannot assemble RepositoryEntity for ${result.name} without a resolved CanonicalSymbolIdentity`);
        }

        return {
            canonicalId: result.canonicalIdentity,
            name: result.name,
            entityKind: result.entityKind,
            declarationLocation: {
                filePath: result.filePath,
                startLine: result.startLine,
                endLine: result.endLine
            },
            modifiers: result.modifiers,
            visibility: result.visibility,
            documentation: result.documentation
        };
    }
}
