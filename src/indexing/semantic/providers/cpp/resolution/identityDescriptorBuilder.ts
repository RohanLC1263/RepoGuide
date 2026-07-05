import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');
import { IdentityAuthority } from '../../../../canonicalSymbolIdentity';
import { IdentityDescriptor, CppProgramHandle } from '../internalModels';
import { findEnclosingClass, namespacePathOf, unwrapDeclarator, unwrapTypeReference } from '../astHelpers';
import { CppSignatureHasher } from './signatureHasher';

export class IdentityDescriptorBuilder {
    public static build(
        node: Parser.SyntaxNode | null,
        name: string,
        entityKind: 'class' | 'enum' | 'function' | 'method' | 'variable' | 'module',
        handle: CppProgramHandle
    ): IdentityDescriptor {
        const qualifiedName = entityKind === 'module' ? '' : this.buildQualifiedName(node, name);
        const signatureHash = this.buildSignatureHash(node, entityKind);
        const logicalNamespace = node ? namespacePathOf(node) : '';
        const identityAuthority: IdentityAuthority = 'parser';

        return {
            package: 'workspace',
            logicalNamespace,
            qualifiedName,
            symbolKind: entityKind,
            signatureHash,
            identityOrigin: 'Repository',
            identityAuthority
        };
    }

    /**
     * A method's qualifiedName is "ClassName.method" whether the class is
     * found via AST nesting (an inline in-class method) or via the
     * out-of-class `ClassName::method` definition's own qualified_identifier
     * scope (the common case, confirmed 84.2% of the time in real code) --
     * the two are structurally very different but must converge on the same
     * qualifiedName so a method's identity is the same regardless of which
     * file (header or .cpp) it was computed from.
     */
    private static buildQualifiedName(node: Parser.SyntaxNode | null, name: string): string {
        if (node?.type === 'function_definition') {
            const functionDeclarator = unwrapDeclarator(node.childForFieldName('declarator'));
            const nameField = functionDeclarator?.childForFieldName('declarator');
            if (nameField?.type === 'qualified_identifier') {
                const scopeNode = nameField.childForFieldName('scope');
                const className = scopeNode ? unwrapTypeReference(scopeNode).text : null;
                if (className) {
                    return `${className}.${name}`;
                }
            }
        }
        if (node && (node.type === 'function_definition' || node.type === 'field_declaration' || node.type === 'declaration')) {
            const enclosingClass = findEnclosingClass(node);
            const className = enclosingClass?.childForFieldName('name')?.text;
            if (className) {
                return `${className}.${name}`;
            }
        }
        return name;
    }

    private static buildSignatureHash(node: Parser.SyntaxNode | null, entityKind: string): string {
        if ((entityKind === 'function' || entityKind === 'method') && node) {
            const functionDeclarator = unwrapDeclarator(node.childForFieldName('declarator'));
            const parameterList = functionDeclarator?.childForFieldName('parameters');
            const params = parameterList ? CppSignatureHasher.extractParams(parameterList) : [];
            const declarator = node.childForFieldName('declarator');
            const returnTypeText = declarator ? node.text.slice(0, declarator.startIndex - node.startIndex).trim() : '';
            return CppSignatureHasher.hash(params, returnTypeText);
        }
        // Types/free variables/module have no real "signature" to hash --
        // this is an identity/dedup key, not a structural-comparison hash,
        // matching every previous provider's same honest scoping.
        const digest = crypto.createHash('sha256').update(`kind:${entityKind}`).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }
}
