import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');

export interface CppParamInfo {
    typeText: string;
    declaratorShape: string;
}

/**
 * Syntactic-only signature hash (no compiler to resolve/normalize types),
 * matching every previous provider's tier. A parameter's `type` field gives
 * the base type text without pointer/reference decoration (confirmed via
 * direct testing: `const std::string&` yields a `type` field of just
 * `"std::string"`), so the declarator's own node type (`pointer_declarator`/
 * `reference_declarator`/plain `identifier`) is folded in separately to
 * keep by-value/by-pointer/by-reference overloads distinguishable.
 */
export class CppSignatureHasher {
    public static hash(params: CppParamInfo[], returnTypeText: string): string {
        const paramPart = params.map(p => `${p.typeText}:${p.declaratorShape}`).join(',');
        const canonical = `return:${returnTypeText}|params:${paramPart}`;
        const digest = crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }

    public static extractParams(parameterList: Parser.SyntaxNode): CppParamInfo[] {
        const params: CppParamInfo[] = [];
        for (const child of parameterList.namedChildren) {
            if (child.type !== 'parameter_declaration' && child.type !== 'optional_parameter_declaration' && child.type !== 'variadic_parameter_declaration') {
                continue;
            }
            const typeText = child.childForFieldName('type')?.text ?? '';
            const declaratorShape = child.childForFieldName('declarator')?.type ?? '';
            params.push({ typeText, declaratorShape });
        }
        return params;
    }
}
