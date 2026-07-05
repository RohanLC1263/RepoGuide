import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');
import { IdentityAuthority } from '../../../../canonicalSymbolIdentity';
import { IdentityDescriptor, GoProgramHandle } from '../internalModels';
import { receiverTypeName } from '../astHelpers';
import { GoSignatureHasher } from './signatureHasher';

export class IdentityDescriptorBuilder {
    public static build(
        node: Parser.SyntaxNode | null,
        name: string,
        entityKind: 'class' | 'interface' | 'function' | 'method' | 'variable' | 'module',
        handle: GoProgramHandle
    ): IdentityDescriptor {
        const qualifiedName = entityKind === 'module' ? '' : this.buildQualifiedName(node, name, entityKind);
        const signatureHash = this.buildSignatureHash(node, entityKind);
        const identityAuthority: IdentityAuthority = 'parser';

        return {
            package: 'workspace',
            logicalNamespace: handle.importPath,
            qualifiedName,
            symbolKind: entityKind,
            signatureHash,
            identityOrigin: 'Repository',
            identityAuthority
        };
    }

    /**
     * Go has no nested-declaration AST to walk (methods aren't nested
     * inside their struct's own declaration the way Java/C#/Python nest
     * members) -- but for human-readable identity and consistency with
     * the DECLARES model (struct DECLARES method), a method's qualifiedName
     * is still built as "ReceiverType.MethodName", derived from its
     * receiver clause rather than AST nesting.
     */
    private static buildQualifiedName(node: Parser.SyntaxNode | null, name: string, entityKind: string): string {
        if (entityKind === 'method' && node) {
            const receiver = receiverTypeName(node);
            if (receiver) {
                return `${receiver}.${name}`;
            }
        }
        return name;
    }

    private static buildSignatureHash(node: Parser.SyntaxNode | null, entityKind: string): string {
        if ((entityKind === 'function' || entityKind === 'method') && node) {
            const parametersNode = node.childForFieldName('parameters');
            const params = parametersNode ? GoSignatureHasher.extractParams(parametersNode) : [];
            const resultText = node.childForFieldName('result')?.text ?? '';
            return GoSignatureHasher.hash(params, resultText);
        }
        // Types/variables/module have no real "signature" to hash -- this is
        // an identity/dedup key, not a structural-comparison hash, matching
        // every previous provider's same honest scoping.
        const digest = crypto.createHash('sha256').update(`kind:${entityKind}`).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }
}
