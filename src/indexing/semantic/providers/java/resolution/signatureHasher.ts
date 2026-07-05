import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');

export interface JavaParamInfo {
    name: string;
    typeText: string;
    kind: 'normal' | 'vararg';
}

/**
 * Syntactic-only signature hash (no type checker to resolve/normalize
 * types) -- matches Python's signatureHasher tier. Disclosed limitation:
 * `java.util.List<String>` vs an imported bare `List<String>` hash
 * differently since there's no type resolution to normalize them. Two
 * overloads of the same method name get distinct hashes because each has
 * its own real parameter list, keeping their CanonicalSymbolIdentity
 * distinct (verified in pythonSemanticProvider.test.ts's Python precedent
 * and re-verified here in javaSemanticProvider.test.ts).
 */
export class JavaSignatureHasher {
    public static hash(params: JavaParamInfo[], returnTypeText: string, isStatic: boolean): string {
        const paramPart = params.map(p => `${p.name}:${p.typeText}:${p.kind}`).join(',');
        const canonical = `static:${isStatic}|return:${returnTypeText}|params:${paramPart}`;
        const digest = crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }

    public static extractParams(parametersNode: Parser.SyntaxNode): JavaParamInfo[] {
        const params: JavaParamInfo[] = [];
        for (const child of parametersNode.namedChildren) {
            if (child.type === 'formal_parameter') {
                const name = child.childForFieldName('name')?.text;
                const type = child.childForFieldName('type')?.text;
                if (name && type) {
                    params.push({ name, typeText: type, kind: 'normal' });
                }
            } else if (child.type === 'spread_parameter') {
                const typeNode = child.namedChildren[0];
                const declarator = child.namedChildren[1];
                if (typeNode && declarator) {
                    params.push({ name: declarator.text, typeText: typeNode.text, kind: 'vararg' });
                }
            }
        }
        return params;
    }
}
