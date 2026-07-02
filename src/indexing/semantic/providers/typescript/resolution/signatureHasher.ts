import * as ts from 'typescript';
import * as crypto from 'crypto';

export class SignatureHasher {
    private static readonly VERSION_PREFIX = 'v1|';

    public static hashSignature(signature: ts.Signature, typeChecker: ts.TypeChecker, isStatic: boolean = false): string {
        const parts: string[] = [];
        parts.push(this.VERSION_PREFIX);
        parts.push(`static:${isStatic}`);

        const decl = signature.getDeclaration();
        if (decl && decl.parameters.length > 0 && decl.parameters[0].name.getText() === 'this') {
            const thisTypeNode = decl.parameters[0].type;
            if (thisTypeNode) {
                const type = typeChecker.getTypeFromTypeNode(thisTypeNode);
                parts.push(`this:${typeChecker.typeToString(type)}`);
            }
        }

        const typeParams = signature.getTypeParameters();
        if (typeParams && typeParams.length > 0) {
            const bounds = typeParams.map(tp => {
                const constraint = tp.getConstraint();
                return constraint ? typeChecker.typeToString(constraint) : 'any';
            });
            parts.push(`typeParams:[${bounds.join(',')}]`);
        }

        const params = signature.getParameters();
        const paramTypes = params.map(p => {
            const type = typeChecker.getTypeOfSymbolAtLocation(p, p.valueDeclaration || p.declarations?.[0] as ts.Node);
            return typeChecker.typeToString(type);
        });
        parts.push(`params:[${paramTypes.join(',')}]`);

        const returnType = signature.getReturnType();
        parts.push(`return:${typeChecker.typeToString(returnType)}`);

        const canonicalString = parts.join('|');
        return crypto.createHash('sha256').update(canonicalString).digest('hex').substring(0, 16);
    }

    public static hashType(type: ts.Type, typeChecker: ts.TypeChecker): string {
        const canonicalString = `${this.VERSION_PREFIX}type:${typeChecker.typeToString(type)}`;
        return crypto.createHash('sha256').update(canonicalString).digest('hex').substring(0, 16);
    }
}
