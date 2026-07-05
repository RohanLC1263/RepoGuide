import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');
import { IdentityAuthority } from '../../../../canonicalSymbolIdentity';
import { IdentityDescriptor, RustProgramHandle } from '../internalModels';
import { findEnclosingImplOrTrait, implTraitName, implTypeName } from '../astHelpers';
import { RustSignatureHasher } from './signatureHasher';

export class IdentityDescriptorBuilder {
    public static build(
        node: Parser.SyntaxNode | null,
        name: string,
        entityKind: 'class' | 'interface' | 'enum' | 'function' | 'method' | 'variable' | 'module',
        handle: RustProgramHandle
    ): IdentityDescriptor {
        const qualifiedName = entityKind === 'module' ? '' : this.buildQualifiedName(node, name);
        const signatureHash = this.buildSignatureHash(node, entityKind);
        const identityAuthority: IdentityAuthority = 'parser';

        return {
            package: 'workspace',
            logicalNamespace: handle.modulePath,
            qualifiedName,
            symbolKind: entityKind,
            signatureHash,
            identityOrigin: 'Repository',
            identityAuthority
        };
    }

    /**
     * Rust has no nested-declaration AST for methods (a function_item's
     * enclosing impl/trait block is a sibling structure, not a parent the
     * way Java/C# nest members) -- but for human-readable identity and
     * consistency with the DECLARES model, a method's qualifiedName is
     * still built as "Type.method", derived from the enclosing impl's
     * target type (or the enclosing trait's own name, inside a trait
     * definition itself) rather than AST nesting.
     */
    private static buildQualifiedName(node: Parser.SyntaxNode | null, name: string): string {
        if (node?.type === 'function_item') {
            const enclosing = findEnclosingImplOrTrait(node);
            if (enclosing?.type === 'impl_item') {
                const typeName = implTypeName(enclosing);
                if (typeName) {
                    return `${typeName}.${name}`;
                }
            } else if (enclosing?.type === 'trait_item') {
                const traitName = enclosing.childForFieldName('name')?.text;
                if (traitName) {
                    return `${traitName}.${name}`;
                }
            }
        }
        return name;
    }

    private static buildSignatureHash(node: Parser.SyntaxNode | null, entityKind: string): string {
        if ((entityKind === 'function' || entityKind === 'method') && node) {
            const parametersNode = node.childForFieldName('parameters');
            const params = parametersNode ? RustSignatureHasher.extractParams(parametersNode) : [];
            const returnTypeText = node.childForFieldName('return_type')?.text ?? '';
            return RustSignatureHasher.hash(params, returnTypeText);
        }
        // Types/traits/variables/module have no real "signature" to hash --
        // this is an identity/dedup key, not a structural-comparison hash,
        // matching every previous provider's same honest scoping.
        const digest = crypto.createHash('sha256').update(`kind:${entityKind}`).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }

    /** Convenience for building a trait's own identity (interface_item equivalent), given the trait_item node itself. */
    public static buildForTraitName(traitName: string): string {
        return traitName;
    }
}
