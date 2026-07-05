import Parser = require('node-tree-sitter');
import { KnownUnknown } from '../../../semanticProviderContract';
import { IdentityDescriptor, CppProgramHandle } from '../internalModels';
import { IdentityDescriptorBuilder } from './identityDescriptorBuilder';
import { CppNameResolver } from './nameResolver';
import { CppIncludeResolver } from './includeResolver';
import {
    findEnclosingClass,
    findEnclosingFunction,
    functionDeclaratorName,
    isInsideFunctionBody,
    isOutOfClassDefinition,
    unwrapDeclarator,
    unwrapTypeReference
} from '../astHelpers';

export interface CppRelationshipDescriptor {
    source: IdentityDescriptor;
    target: IdentityDescriptor;
    relationshipKind: 'DECLARES' | 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'INSTANTIATES';
    location: { filePath: string; startLine: number; endLine: number };
}

export type CppResolveResult =
    | { type: 'descriptor'; descriptor: CppRelationshipDescriptor }
    | { type: 'unknown'; unknown: KnownUnknown };

/**
 * Per-node relationship rule engine. Unlike every prior provider, DECLARES
 * for a method is frequently a CROSS-FILE relationship: 84.2% of real
 * header-declared methods (confirmed empirically against cpr) are defined
 * out-of-line via `ClassName::method` in a separate .cpp, resolved through
 * the paired-header lookup in CppNameResolver, not same-file AST nesting.
 * EXTENDS supports N base classes (real multiple inheritance, unlike
 * Java's/C#'s single base). IMPLEMENTS is not attempted at all -- an
 * explicit disclosed non-goal, since C++ gives no syntax distinguishing a
 * "pure interface" abstract base from an ordinary concrete one
 * (`base_class_clause` is identical either way; only the base's own
 * members' `= 0` pure-specifiers hint at it, which the derived class's own
 * inheritance syntax can't see). CALLS/INSTANTIATES need the same
 * generic/qualified-reference unwrap fix Go's and Rust's generics needed.
 */
export class CppRelationshipResolver {
    public static resolve(
        node: Parser.SyntaxNode,
        handle: CppProgramHandle,
        nameResolver: CppNameResolver,
        moduleDescriptor: IdentityDescriptor
    ): CppResolveResult[] {
        switch (node.type) {
            case 'class_specifier':
                return this.resolveTypeDeclares(node, 'class', handle, moduleDescriptor);
            case 'struct_specifier':
                return this.resolveTypeDeclares(node, 'class', handle, moduleDescriptor);
            case 'enum_specifier':
                return this.resolveTypeDeclares(node, 'enum', handle, moduleDescriptor);
            case 'function_definition':
                return this.resolveFunctionOrMethodDeclares(node, handle, nameResolver, moduleDescriptor);
            case 'field_declaration':
            case 'declaration':
                return this.resolveInClassMemberDeclares(node, handle, moduleDescriptor);
            case 'preproc_include':
                return this.resolveImports(node, handle, moduleDescriptor);
            case 'call_expression':
                return this.resolveCall(node, handle, nameResolver);
            case 'new_expression':
                return this.resolveInstantiate(node, handle, nameResolver);
            default:
                return [];
        }
    }

    /**
     * Called once per class_specifier/struct_specifier that has a
     * base_class_clause (see relationshipVisitor.ts), not routed through
     * the generic switch. base_class_clause is already a flat list of base
     * references, so multiple inheritance naturally produces multiple
     * EXTENDS edges with no design change beyond iterating the list.
     */
    public static resolveBaseClasses(classNode: Parser.SyntaxNode, handle: CppProgramHandle, nameResolver: CppNameResolver, moduleDescriptor: IdentityDescriptor): CppResolveResult[] {
        if (isInsideFunctionBody(classNode)) {
            return [];
        }
        const name = classNode.childForFieldName('name')?.text;
        const baseClause = classNode.namedChildren.find(c => c.type === 'base_class_clause');
        if (!name || !baseClause) {
            return [];
        }
        const sourceDescriptor = IdentityDescriptorBuilder.build(classNode, name, 'class', handle);
        const loc = this.locationOf(classNode, handle);

        const results: CppResolveResult[] = [];
        for (const child of baseClause.namedChildren) {
            if (child.type === 'access_specifier') {
                continue;
            }
            const baseName = unwrapTypeReference(child).text;
            const targetNode = nameResolver.resolveClass(baseName);
            if (!targetNode) {
                results.push({ type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, 'Base class', `"${baseName}" is not declared in this file or its paired header -- cross-file base-class resolution beyond a same-basename header/.cpp pair is out of scope.`) });
                continue;
            }
            const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, baseName, 'class', handle);
            results.push({ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'EXTENDS', location: loc } });
        }
        return results;
    }

    private static resolveTypeDeclares(node: Parser.SyntaxNode, kind: 'class' | 'enum', handle: CppProgramHandle, moduleDescriptor: IdentityDescriptor): CppResolveResult[] {
        if (isInsideFunctionBody(node)) {
            return [];
        }
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return [];
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(node, name, kind, handle);
        const loc = this.locationOf(node, handle);
        return [{ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
    }

    /**
     * A function_definition is a free function, an inline in-class method,
     * or an out-of-class `ClassName::method` definition -- the latter is
     * the common real-world shape (confirmed 84.2% empirically) and the
     * only one needing the cross-file (header-pairing) class lookup.
     */
    private static resolveFunctionOrMethodDeclares(node: Parser.SyntaxNode, handle: CppProgramHandle, nameResolver: CppNameResolver, moduleDescriptor: IdentityDescriptor): CppResolveResult[] {
        if (isInsideFunctionBody(node)) {
            return [];
        }
        const functionDeclarator = unwrapDeclarator(node.childForFieldName('declarator'));
        if (!functionDeclarator || functionDeclarator.type !== 'function_declarator') {
            return [];
        }
        const name = functionDeclaratorName(functionDeclarator);
        if (!name) {
            return [];
        }
        const loc = this.locationOf(node, handle);

        if (isOutOfClassDefinition(functionDeclarator)) {
            const nameField = functionDeclarator.childForFieldName('declarator');
            const scopeNode = nameField?.childForFieldName('scope');
            const className = scopeNode ? unwrapTypeReference(scopeNode).text : null;
            if (!className) {
                return [];
            }
            const targetDescriptor = IdentityDescriptorBuilder.build(node, name, 'method', handle);
            const classNode = nameResolver.resolveClass(className);
            if (!classNode) {
                return [{ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Out-of-line method target', `"${className}" is not declared in this file or its paired header (if one was resolved) -- cross-file class resolution beyond a same-basename header/.cpp pair is out of scope.`) }];
            }
            const sourceDescriptor = IdentityDescriptorBuilder.build(classNode, className, 'class', handle);
            return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
        }

        const enclosingClass = findEnclosingClass(node);
        if (enclosingClass) {
            const className = enclosingClass.childForFieldName('name')?.text;
            if (!className) {
                return [];
            }
            const targetDescriptor = IdentityDescriptorBuilder.build(node, name, 'method', handle);
            const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingClass, className, 'class', handle);
            return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
        }

        const targetDescriptor = IdentityDescriptorBuilder.build(node, name, 'function', handle);
        return [{ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
    }

    /** In-class prototype-only members: bodyless method prototypes (incl. constructor/destructor) and member variables -- always same-file, since a class body's own members live in the file that declares the class. */
    private static resolveInClassMemberDeclares(node: Parser.SyntaxNode, handle: CppProgramHandle, moduleDescriptor: IdentityDescriptor): CppResolveResult[] {
        const enclosingClass = findEnclosingClass(node);
        if (!enclosingClass || isInsideFunctionBody(node)) {
            return [];
        }
        const className = enclosingClass.childForFieldName('name')?.text;
        if (!className) {
            return [];
        }
        const loc = this.locationOf(node, handle);
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingClass, className, 'class', handle);

        const functionDeclarator = unwrapDeclarator(node.childForFieldName('declarator'));
        if (functionDeclarator?.type === 'function_declarator') {
            const name = functionDeclaratorName(functionDeclarator);
            if (!name) {
                return [];
            }
            const targetDescriptor = IdentityDescriptorBuilder.build(node, name, 'method', handle);
            return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
        }
        if (node.type === 'field_declaration' && node.childForFieldName('declarator')?.type === 'field_identifier') {
            const name = node.childForFieldName('declarator')!.text;
            const targetDescriptor = IdentityDescriptorBuilder.build(node, name, 'variable', handle);
            return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
        }
        return [];
    }

    /**
     * `#include` is a preprocessor directive resolved via compiler
     * include-path search order, not fully derivable from the file alone --
     * a disclosed approximation (see CppIncludeResolver). Angle-bracket
     * includes (`<string>`) are stdlib/external and silently out of scope,
     * matching every provider's "don't flag stdlib" tier.
     */
    private static resolveImports(node: Parser.SyntaxNode, handle: CppProgramHandle, moduleDescriptor: IdentityDescriptor): CppResolveResult[] {
        const stringLiteral = node.namedChildren.find(c => c.type === 'string_literal');
        if (!stringLiteral) {
            return [];
        }
        const includePath = stringLiteral.namedChildren.find(c => c.type === 'string_content')?.text;
        if (!includePath) {
            return [];
        }
        const loc = this.locationOf(node, handle);
        const resolvedFile = CppIncludeResolver.resolveQuotedInclude(includePath, handle.filePath, handle.workspaceRoot);
        if (!resolvedFile) {
            return [{ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Unresolved Include', `Could not resolve "${includePath}" under this file's own directory or the workspace's conventional include/src roots -- #include resolution depends on build-system-specific -I flags this parser can't see.`) }];
        }
        const targetDescriptor: IdentityDescriptor = {
            package: 'workspace',
            logicalNamespace: includePath.replace(/\.(h|hpp)$/, '').split('/').join('::'),
            qualifiedName: '',
            symbolKind: 'module',
            signatureHash: 'v1|0000000000000000',
            identityOrigin: 'Repository',
            identityAuthority: 'parser'
        };
        return [{ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'IMPORTS', location: loc } }];
    }

    private static resolveCall(node: Parser.SyntaxNode, handle: CppProgramHandle, nameResolver: CppNameResolver): CppResolveResult[] {
        const fn = node.childForFieldName('function');
        const context = fn ? this.enclosingFunctionContext(node, handle) : null;
        if (!fn || !context) {
            return [];
        }
        const loc = this.locationOf(node, handle);

        let targetNode: Parser.SyntaxNode | null = null;
        if (fn.type === 'field_expression') {
            const receiver = fn.childForFieldName('argument')?.text;
            const methodName = fn.childForFieldName('field')?.text;
            if (receiver === 'this' && methodName && context.enclosingClassName) {
                targetNode = nameResolver.resolveMethodOnClass(context.enclosingClassName, methodName);
            }
        } else if (fn.type === 'qualified_identifier') {
            const scopeNode = fn.childForFieldName('scope');
            const className = scopeNode ? unwrapTypeReference(scopeNode).text : null;
            const methodName = fn.childForFieldName('name')?.text;
            if (className && methodName) {
                targetNode = nameResolver.resolveMethodOnClass(className, methodName);
            }
        } else if (fn.type === 'identifier') {
            const bareName = fn.text;
            if (context.enclosingClassName) {
                targetNode = nameResolver.resolveMethodOnClass(context.enclosingClassName, bareName);
            }
            if (!targetNode) {
                targetNode = nameResolver.resolveFreeFunction(bareName);
            }
        }
        if (!targetNode) {
            return []; // unresolved calls are common (stdlib/external, or through an arbitrary object) -- not flagged as KnownUnknown to avoid noise, matching every previous provider's tier
        }
        const described = this.describeResolvedFunction(targetNode);
        if (!described) {
            return [];
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, described.name, described.kind, handle);
        return [{ type: 'descriptor', descriptor: { source: context.sourceDescriptor, target: targetDescriptor, relationshipKind: 'CALLS', location: loc } }];
    }

    /**
     * `new_expression` is its own unambiguous node type (confirmed via
     * direct testing), but array-new (`new T[n]`) needs filtering out via
     * the presence of a `new_declarator` sibling instead of `argument_list`
     * -- the same "confirm unambiguous, filter if needed" tier as Go's
     * composite_literal check. Primitive scalar `new` (`new int(5)`) is
     * filtered by the raw node TYPE (`primitive_type`/`sized_type_specifier`),
     * not a name-text heuristic, since a real class name could just as
     * easily be all-lowercase.
     */
    private static resolveInstantiate(node: Parser.SyntaxNode, handle: CppProgramHandle, nameResolver: CppNameResolver): CppResolveResult[] {
        const hasArrayNewDeclarator = node.namedChildren.some(c => c.type === 'new_declarator');
        if (hasArrayNewDeclarator) {
            return [];
        }
        const rawTypeNode = node.namedChildren.find(c => c.type !== 'argument_list');
        if (!rawTypeNode || rawTypeNode.type === 'primitive_type' || rawTypeNode.type === 'sized_type_specifier') {
            return [];
        }
        const typeName = unwrapTypeReference(rawTypeNode).text;

        const context = this.enclosingFunctionContext(node, handle);
        if (!context) {
            return [];
        }
        const loc = this.locationOf(node, handle);

        const targetNode = nameResolver.resolveClass(typeName);
        if (!targetNode) {
            return [{ type: 'unknown', unknown: this.knownUnknown(context.sourceDescriptor, loc, 'Unresolved Instantiation', `"${typeName}" is not declared in this file or its paired header -- cross-file type resolution beyond a same-basename header/.cpp pair is out of scope.`) }];
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, typeName, 'class', handle);
        return [{ type: 'descriptor', descriptor: { source: context.sourceDescriptor, target: targetDescriptor, relationshipKind: 'INSTANTIATES', location: loc } }];
    }

    /** Resolves the nearest enclosing function_definition's own identity + owning-class name (if any), shared by resolveCall and resolveInstantiate. */
    private static enclosingFunctionContext(node: Parser.SyntaxNode, handle: CppProgramHandle): { sourceDescriptor: IdentityDescriptor; enclosingClassName: string | null } | null {
        const enclosingFn = findEnclosingFunction(node);
        if (!enclosingFn) {
            return null;
        }
        const functionDeclarator = unwrapDeclarator(enclosingFn.childForFieldName('declarator'));
        if (!functionDeclarator || functionDeclarator.type !== 'function_declarator') {
            return null;
        }
        const enclosingName = functionDeclaratorName(functionDeclarator);
        if (!enclosingName) {
            return null;
        }

        let enclosingClassName: string | null = null;
        let enclosingKind: 'method' | 'function' = 'function';
        if (isOutOfClassDefinition(functionDeclarator)) {
            const nameField = functionDeclarator.childForFieldName('declarator');
            const scopeNode = nameField?.childForFieldName('scope');
            enclosingClassName = scopeNode ? unwrapTypeReference(scopeNode).text : null;
            enclosingKind = 'method';
        } else {
            const enclosingClassNode = findEnclosingClass(enclosingFn);
            if (enclosingClassNode) {
                enclosingClassName = enclosingClassNode.childForFieldName('name')?.text ?? null;
                enclosingKind = 'method';
            }
        }
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingFn, enclosingName, enclosingKind, handle);
        return { sourceDescriptor, enclosingClassName };
    }

    private static describeResolvedFunction(node: Parser.SyntaxNode): { name: string; kind: 'method' | 'function' } | null {
        const functionDeclarator = unwrapDeclarator(node.childForFieldName('declarator'));
        if (!functionDeclarator || functionDeclarator.type !== 'function_declarator') {
            return null;
        }
        const name = functionDeclaratorName(functionDeclarator);
        if (!name) {
            return null;
        }
        const kind = isOutOfClassDefinition(functionDeclarator) || findEnclosingClass(node) ? 'method' : 'function';
        return { name, kind };
    }

    private static locationOf(node: Parser.SyntaxNode, handle: CppProgramHandle) {
        return { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
    }

    private static knownUnknown(source: IdentityDescriptor, location: { filePath: string; startLine: number; endLine: number }, construct: string, reason: string): KnownUnknown {
        return {
            id: `ku-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            source: {
                package: source.package,
                logicalNamespace: source.logicalNamespace,
                kind: source.symbolKind,
                qualifiedName: source.qualifiedName,
                signatureHash: source.signatureHash,
                identityOrigin: source.identityOrigin,
                identityAuthority: source.identityAuthority
            },
            sourceLocation: location,
            unsupportedConstruct: construct,
            reason,
            evidence: [],
            recommendedHandling: 'Requires cross-file resolution beyond a same-basename header/.cpp pair, out of scope for the current tier.'
        };
    }
}
