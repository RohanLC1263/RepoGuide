import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');
import { IdentityAuthority } from '../../../../canonicalSymbolIdentity';
import { IdentityDescriptor, CSharpProgramHandle } from '../internalModels';
import { findEnclosingTypeDeclaration, keywordModifiers, methodReturnTypeNode } from '../astHelpers';
import { CSharpSignatureHasher } from './signatureHasher';

export class IdentityDescriptorBuilder {
    public static build(
        node: Parser.SyntaxNode | null,
        name: string,
        entityKind: 'class' | 'interface' | 'enum' | 'method' | 'variable' | 'module',
        handle: CSharpProgramHandle
    ): IdentityDescriptor {
        const qualifiedName = entityKind === 'module' ? '' : this.buildQualifiedName(node!, name);
        const signatureHash = this.buildSignatureHash(node, entityKind);
        const identityAuthority: IdentityAuthority = 'parser';

        return {
            package: 'workspace',
            logicalNamespace: handle.namespaceName,
            qualifiedName,
            symbolKind: entityKind,
            signatureHash,
            identityOrigin: 'Repository',
            identityAuthority
        };
    }

    /** AST-nesting chain only (e.g. "Foo.Inner.innerMethod"). */
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
            const params = parametersNode ? CSharpSignatureHasher.extractParams(parametersNode) : [];
            // constructor_declaration has no return type at all (its "return type" is the class itself).
            const returnTypeText = node.type === 'method_declaration' ? (methodReturnTypeNode(node)?.text ?? '') : node.type;
            const isStatic = keywordModifiers(node).includes('static');
            return CSharpSignatureHasher.hash(params, returnTypeText, isStatic);
        }
        // Classes/interfaces/enums/variables/module have no real "signature"
        // to hash -- this is an identity/dedup key, not a structural-comparison
        // hash, matching Java's/Python's same honest scoping.
        const digest = crypto.createHash('sha256').update(`kind:${entityKind}`).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }
}
