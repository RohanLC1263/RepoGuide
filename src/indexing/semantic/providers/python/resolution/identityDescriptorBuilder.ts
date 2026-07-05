import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');
import { IdentityAuthority } from '../../../../canonicalSymbolIdentity';
import { IdentityDescriptor, PythonProgramHandle } from '../internalModels';
import { decoratorNames, findEnclosingDefinition } from '../astHelpers';
import { PythonSignatureHasher } from './signatureHasher';

export class IdentityDescriptorBuilder {
    public static build(
        node: Parser.SyntaxNode | null,
        name: string,
        entityKind: 'class' | 'function' | 'method' | 'variable' | 'module',
        handle: PythonProgramHandle
    ): IdentityDescriptor {
        const qualifiedName = entityKind === 'module' ? '' : this.buildQualifiedName(node!, name);
        const signatureHash = this.buildSignatureHash(node, entityKind);
        const identityAuthority: IdentityAuthority = 'parser';

        return {
            package: this.derivePackage(handle.filePath),
            logicalNamespace: handle.modulePath,
            qualifiedName,
            symbolKind: entityKind,
            signatureHash,
            identityOrigin: 'Repository',
            identityAuthority
        };
    }

    /** AST-nesting chain only (e.g. "Foo.method"), mirroring CPython's own __qualname__ convention -- deliberately excludes the module path (that's logicalNamespace), matching how TS's builder strips getFullyQualifiedName's file-path prefix. */
    private static buildQualifiedName(node: Parser.SyntaxNode, name: string): string {
        const chain: string[] = [name];
        let enclosing = findEnclosingDefinition(node);
        while (enclosing) {
            const enclosingName = enclosing.childForFieldName('name')?.text;
            if (enclosingName) {
                chain.unshift(enclosingName);
            }
            enclosing = findEnclosingDefinition(enclosing);
        }
        return chain.join('.');
    }

    private static buildSignatureHash(node: Parser.SyntaxNode | null, entityKind: 'class' | 'function' | 'method' | 'variable' | 'module'): string {
        if ((entityKind === 'function' || entityKind === 'method') && node) {
            const parametersNode = node.childForFieldName('parameters');
            const params = parametersNode ? PythonSignatureHasher.extractParams(parametersNode) : [];
            const returnTypeHint = node.childForFieldName('return_type')?.text ?? '';
            const decorators = decoratorNames(node);
            let binding: 'instance' | 'static' | 'classmethod' = entityKind === 'method' ? 'instance' : 'static';
            if (decorators.includes('staticmethod')) binding = 'static';
            else if (decorators.includes('classmethod')) binding = 'classmethod';
            return PythonSignatureHasher.hash(params, returnTypeHint, binding, decorators);
        }
        // Classes and module/class-level variables have no real "signature" to
        // hash -- this is an identity/dedup key, not a structural-comparison
        // hash, and is honestly scoped as such rather than invented.
        const digest = crypto.createHash('sha256').update(`kind:${entityKind}`).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }

    private static derivePackage(filePath: string): string {
        const normalized = filePath.split(/[\\/]/).join('/');
        const marker = 'site-packages/';
        const idx = normalized.indexOf(marker);
        if (idx !== -1) {
            const rest = normalized.slice(idx + marker.length);
            return rest.split('/')[0] || 'workspace';
        }
        return 'workspace';
    }
}
