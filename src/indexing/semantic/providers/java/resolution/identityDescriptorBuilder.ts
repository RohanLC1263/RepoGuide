import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');
import { IdentityAuthority } from '../../../../canonicalSymbolIdentity';
import { IdentityDescriptor, JavaProgramHandle } from '../internalModels';
import { findEnclosingTypeDeclaration, keywordModifiers } from '../astHelpers';
import { JavaSignatureHasher } from './signatureHasher';

export class IdentityDescriptorBuilder {
    public static build(
        node: Parser.SyntaxNode | null,
        name: string,
        entityKind: 'class' | 'interface' | 'enum' | 'method' | 'variable' | 'module',
        handle: JavaProgramHandle
    ): IdentityDescriptor {
        const qualifiedName = entityKind === 'module' ? '' : this.buildQualifiedName(node!, name);
        const signatureHash = this.buildSignatureHash(node, entityKind);
        const identityAuthority: IdentityAuthority = 'parser';

        return {
            package: 'workspace',
            logicalNamespace: handle.packageName,
            qualifiedName,
            symbolKind: entityKind,
            signatureHash,
            identityOrigin: 'Repository',
            identityAuthority
        };
    }

    /** AST-nesting chain only (e.g. "Foo.Inner.innerMethod"), mirroring how Python's builder strips the module path (that's logicalNamespace) from the qualified name. */
    private static buildQualifiedName(node: Parser.SyntaxNode, name: string): string {
        const chain: string[] = [name];
        let enclosing = findEnclosingTypeDeclaration(node);
        while (enclosing) {
            const enclosingName = enclosing.childForFieldName('name')?.text;
            if (enclosingName) {
                chain.unshift(enclosingName);
            }
            enclosing = findEnclosingTypeDeclaration(enclosing);
        }
        return chain.join('.');
    }

    private static buildSignatureHash(node: Parser.SyntaxNode | null, entityKind: 'class' | 'interface' | 'enum' | 'method' | 'variable' | 'module'): string {
        if (entityKind === 'method' && node) {
            const parametersNode = node.childForFieldName('parameters');
            const params = parametersNode ? JavaSignatureHasher.extractParams(parametersNode) : [];
            // constructor_declaration has no `type` field (its "return type" is the class itself).
            const returnTypeText = node.childForFieldName('type')?.text ?? node.type;
            const isStatic = keywordModifiers(node).includes('static');
            return JavaSignatureHasher.hash(params, returnTypeText, isStatic);
        }
        // Classes/interfaces/enums/variables/module have no real "signature"
        // to hash -- this is an identity/dedup key, not a structural-comparison
        // hash, matching Python's same honest scoping.
        const digest = crypto.createHash('sha256').update(`kind:${entityKind}`).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }
}
