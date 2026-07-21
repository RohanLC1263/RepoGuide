import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { LogicalUnit, LogicalUnitType } from '../indexing/logicalUnitTypes';
import { FactRecord } from '../indexing/factTypes';
import {
    ProgramGraph,
    ProgramGraphNode,
    ProgramGraphEdge,
    ProgramGraphNodeType,
    ProgramGraphEdgeType
} from './programGraphTypes';

/**
 * Builds a ProgramGraph from existing LogicalUnitStore and FactStore data.
 * Does not re-parse any source files.
 */
export class ProgramGraphBuilder {

    async build(
        unitStore: LogicalUnitStore,
        factStore: FactStore,
        repoRoot: string
    ): Promise<ProgramGraph> {
        const nodes: Record<string, ProgramGraphNode> = {};
        const edges: ProgramGraphEdge[] = [];
        const symbolCache = new Map<string, string[]>(); // symbol name → unit IDs

        // Step 1: Load all unit indexes
        const allUnits = await unitStore.listIndexes({ limit: Number.POSITIVE_INFINITY });

        // Step 2: Create file nodes and unit nodes
        const fileNodes = new Set<string>();
        for (const unit of allUnits) {
            // File node (synthetic)
            const fileNodeId = `file::${unit.filePath}`;
            if (!fileNodes.has(fileNodeId)) {
                fileNodes.add(fileNodeId);
                const fileStem = unit.filePath.split(/[\\/]/).pop()?.split('.')[0] || undefined;
                nodes[fileNodeId] = {
                    id: fileNodeId,
                    type: 'file',
                    symbol: fileStem,
                    filePath: unit.filePath,
                    role: unit.role
                };
            }

            // Unit node
            const nodeType = mapUnitTypeToGraphNodeType(unit.type);
            nodes[unit.id] = {
                id: unit.id,
                uuid: unit.uuid,
                type: nodeType,
                symbol: unit.symbol,
                filePath: unit.filePath,
                startLine: unit.startLine,
                endLine: unit.endLine,
                role: unit.role
            };

            // Index symbol → node IDs for resolution
            if (unit.symbol) {
                const key = unit.symbol.toLowerCase();
                if (!symbolCache.has(key)) {
                    symbolCache.set(key, []);
                }
                symbolCache.get(key)!.push(unit.id);
            }

            // Contains edge: file → unit
            edges.push({
                from: fileNodeId,
                to: unit.id,
                type: 'contains',
                weight: 1.0
            });
        }

        // Step 3: Containment edges from parentUnitId (unit → child unit)
        for (const unit of allUnits) {
            // Load full unit to get parentUnitId and metadata
            const fullUnit = await unitStore.getUnit(unit.id);
            if (!fullUnit) continue;

            if (fullUnit.parentUnitId && nodes[fullUnit.parentUnitId]) {
                edges.push({
                    from: fullUnit.parentUnitId,
                    to: unit.id,
                    type: 'contains',
                    weight: 1.0
                });
            }

            // Reads edges from metadata
            if (fullUnit.metadata?.readsSymbols) {
                for (const sym of fullUnit.metadata.readsSymbols) {
                    const targetIds = symbolCache.get(sym.toLowerCase());
                    if (targetIds) {
                        for (const targetId of targetIds.slice(0, 3)) {
                            if (targetId !== unit.id) {
                                edges.push({
                                    from: unit.id,
                                    to: targetId,
                                    type: 'reads',
                                    weight: 0.8
                                });
                            }
                        }
                    }
                }
            }

            // Assigns edges from metadata
            if (fullUnit.metadata?.writesSymbols) {
                for (const sym of fullUnit.metadata.writesSymbols) {
                    const targetIds = symbolCache.get(sym.toLowerCase());
                    if (targetIds) {
                        for (const targetId of targetIds.slice(0, 3)) {
                            if (targetId !== unit.id) {
                                edges.push({
                                    from: unit.id,
                                    to: targetId,
                                    type: 'assigns',
                                    weight: 0.7
                                });
                            }
                        }
                    }
                }
            }
        }

        // Step 4: Build edges from facts
        const edgeFacts = await this.loadEdgeFacts(factStore);
        for (const fact of edgeFacts) {
            this.addFactEdge(fact, edges, nodes, symbolCache);
        }

        return {
            version: '1.0.0',
            builtAt: new Date().toISOString(),
            repoRoot,
            nodeCount: Object.keys(nodes).length,
            edgeCount: edges.length,
            nodes,
            edges
        };
    }

    private async loadEdgeFacts(factStore: FactStore): Promise<FactRecord[]> {
        const edgeFactTypes = [
            'call_site', 'instantiation', 'import',
            'fallback_chain', 'dependency_injection',
            'calls_method', 'implements_interface'
        ] as const;

        const allFacts: FactRecord[] = [];
        for (const ft of edgeFactTypes) {
            // No cap: a fixed { limit: 5000 } silently dropped the tail of each
            // edge-fact type on large repos (queryFacts orders by confidence,
            // filePath, startLine, so alphabetically-later files fell off). On
            // CraftConnect there are 12k+ call_site and 7k+ calls_method facts,
            // and app/main.py's call_site facts sorted past position 5000 -- so
            // its call/instantiation edges were never built. queryFacts skips the
            // SQL LIMIT clause entirely when limit is POSITIVE_INFINITY. These
            // rows are small; loading all of them is cheap relative to the rest
            // of indexing.
            const facts = await factStore.findByType(ft, { limit: Number.POSITIVE_INFINITY });
            allFacts.push(...facts);
        }
        return allFacts;
    }

    private addFactEdge(
        fact: FactRecord,
        edges: ProgramGraphEdge[],
        nodes: Record<string, ProgramGraphNode>,
        symbolCache: Map<string, string[]>
    ): void {
        const sourceId = fact.unitId;
        if (!nodes[sourceId]) return;

        const symbolStr = typeof fact.value === 'string'
            ? fact.value
            : (fact.symbol || '');

        switch (fact.factType) {
            case 'call_site': {
                const calleeSymbol = symbolStr.split('.').pop() || symbolStr;
                const targetIds = symbolCache.get(calleeSymbol.toLowerCase());
                if (targetIds) {
                    for (const targetId of targetIds.slice(0, 3)) {
                        if (targetId !== sourceId) {
                            edges.push({
                                from: sourceId,
                                to: targetId,
                                type: 'calls',
                                weight: 0.8,
                                metadata: { callee: symbolStr }
                            });
                        }
                    }
                }
                break;
            }
            case 'calls_method': {
                // symbolStr is Object.method. Let's link to the method symbol.
                const calleeSymbol = symbolStr.split('.').pop() || symbolStr;
                const targetIds = symbolCache.get(calleeSymbol.toLowerCase());
                if (targetIds) {
                    for (const targetId of targetIds.slice(0, 3)) {
                        if (targetId !== sourceId) {
                            edges.push({
                                from: sourceId,
                                to: targetId,
                                type: 'calls_method',
                                weight: 0.9,
                                metadata: { method: calleeSymbol, fullCall: symbolStr }
                            });
                        }
                    }
                }
                break;
            }
            case 'implements_interface': {
                const interfaceSymbol = symbolStr.split('.').pop() || symbolStr;
                const targetIds = symbolCache.get(interfaceSymbol.toLowerCase());
                if (targetIds) {
                    for (const targetId of targetIds.slice(0, 3)) {
                        if (targetId !== sourceId) {
                            edges.push({
                                from: sourceId,
                                to: targetId,
                                type: 'implements_interface',
                                weight: 1.0,
                                metadata: { interface: interfaceSymbol }
                            });
                        }
                    }
                }
                break;
            }
            case 'instantiation': {
                // The class being instantiated lives in fact.value.instantiatedClass
                // (instantiation facts are valueKind 'ast_node', so fact.value is the
                // object { instantiatedClass, args } and the generic symbolStr fallback
                // above degrades to fact.symbol -- the LHS *variable* name, e.g. `story`
                // in `story = StoryGenerationAgent()`). Resolving on the variable name
                // only ever linked by accidental collision (e.g. `factStore = new
                // FactStore()` where the var lowercases to the class). Resolve on the
                // real class name; keep the LHS variable as edge metadata.
                const instantiatedClass = fact.value && typeof fact.value === 'object' && !Array.isArray(fact.value)
                    ? (fact.value as { instantiatedClass?: unknown }).instantiatedClass
                    : undefined;
                const classRef = typeof instantiatedClass === 'string' && instantiatedClass.length > 0
                    ? instantiatedClass
                    : symbolStr;
                const className = classRef.split('.').pop() || classRef;
                const targetIds = symbolCache.get(className.toLowerCase());
                if (targetIds) {
                    for (const targetId of targetIds.slice(0, 3)) {
                        if (targetId !== sourceId) {
                            edges.push({
                                from: sourceId,
                                to: targetId,
                                type: 'instantiates',
                                weight: 0.85,
                                metadata: { className: classRef, assignedTo: fact.symbol }
                            });
                        }
                    }
                }
                break;
            }
            case 'import': {
                // Import edges: source unit → file node of imported module
                const importText = fact.sourceText || '';
                // Try to find a matching file node
                for (const nodeId of Object.keys(nodes)) {
                    if (nodeId.startsWith('file::') && importText.length > 0) {
                        const filePath = nodeId.slice(6);
                        const lastPart = filePath.split('/').pop()?.replace(/\.\w+$/, '') || '';
                        if (lastPart && importText.toLowerCase().includes(lastPart.toLowerCase())) {
                            edges.push({
                                from: sourceId,
                                to: nodeId,
                                type: 'imports',
                                weight: 0.7,
                                metadata: { importText: importText.slice(0, 200) }
                            });
                            break; // One import edge per fact
                        }
                    }
                }
                break;
            }
            case 'fallback_chain': {
                // Fallback edges: create edges between the source unit and other units
                // in the same file that represent the fallback targets
                if (Array.isArray(fact.value)) {
                    for (const fallbackSymbol of fact.value) {
                        if (typeof fallbackSymbol !== 'string') continue;
                        const targetIds = symbolCache.get(fallbackSymbol.toLowerCase());
                        if (targetIds) {
                            for (const targetId of targetIds.slice(0, 2)) {
                                if (targetId !== sourceId) {
                                    edges.push({
                                        from: sourceId,
                                        to: targetId,
                                        type: 'fallback_to',
                                        weight: 0.75,
                                        metadata: { fallbackSymbol }
                                    });
                                }
                            }
                        }
                    }
                }
                break;
            }
            case 'dependency_injection': {
                const diSymbol = symbolStr;
                const targetIds = symbolCache.get(diSymbol.toLowerCase());
                if (targetIds) {
                    for (const targetId of targetIds.slice(0, 3)) {
                        if (targetId !== sourceId) {
                            edges.push({
                                from: sourceId,
                                to: targetId,
                                type: 'reads',
                                weight: 0.8,
                                metadata: { injectedParam: diSymbol }
                            });
                        }
                    }
                }
                break;
            }
        }
    }
}

function mapUnitTypeToGraphNodeType(unitType: LogicalUnitType): ProgramGraphNodeType {
    switch (unitType) {
        case 'function': return 'function';
        case 'method': return 'method';
        case 'class': return 'class';
        case 'constant_block': return 'constant';
        case 'import_block': return 'import';
        case 'prompt_template': return 'prompt_template';
        case 'config_block': return 'assignment';
        case 'branch': return 'logical_unit';
        case 'whole_file_fallback': return 'logical_unit';
        default: return 'logical_unit';
    }
}
