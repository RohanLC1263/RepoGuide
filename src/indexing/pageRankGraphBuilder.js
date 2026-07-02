"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PageRankGraphBuilder = void 0;
var fs = __importStar(require("fs"));
var path = __importStar(require("path"));
var Parser = require("node-tree-sitter");
var languageDetector_1 = require("./languageDetector");
var BUILT_INS = new Set([
    'constructor', 'prototype', 'length', 'toString', 'valueOf',
    'call', 'apply', 'bind', 'get', 'set', 'has', 'delete', 'clear'
]);
var DOM_GLOBALS = new Set([
    'open', 'send', 'close', 'write', 'read', 'error',
    'data', 'then', 'catch', 'next', 'done'
]);
function isTestFile(filePath) {
    var lower = filePath.toLowerCase();
    var parts = lower.split('/');
    if (parts.includes('test') || parts.includes('tests') || parts.includes('__tests__'))
        return true;
    if (parts.includes('docs') || parts.includes('examples'))
        return true;
    if (lower.endsWith('.test.ts') || lower.endsWith('.test.js') || lower.endsWith('.spec.ts') || lower.endsWith('.spec.js'))
        return true;
    if (lower.includes('.test.') || lower.includes('.spec.'))
        return true;
    if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts'))
        return true;
    return false;
}
function isGenericIdentifier(ident) {
    if (ident.length < 4)
        return true;
    if (BUILT_INS.has(ident))
        return true;
    if (DOM_GLOBALS.has(ident))
        return true;
    return false;
}
function normalizePath(p, workspaceRoot) {
    var normalized = p.replace(/\\/g, '/');
    var root = workspaceRoot.replace(/\\/g, '/');
    return normalized.toLowerCase().startsWith(root.toLowerCase() + '/') ? normalized.slice(root.length + 1) : normalized;
}
var PageRankGraphBuilder = /** @class */ (function () {
    function PageRankGraphBuilder(repoguideDir, workspaceRoot, symbolIndex) {
        this.repoguideDir = repoguideDir;
        this.workspaceRoot = workspaceRoot;
        this.symbolIndex = symbolIndex;
        this.cache = {};
        this.graphPath = path.join(repoguideDir, 'pagerank_graph.json');
        this.cachePath = path.join(repoguideDir, 'pagerank_cache.json');
    }
    PageRankGraphBuilder.prototype.init = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _a, _b, _c, e_1;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        if (!fs.existsSync(this.cachePath)) return [3 /*break*/, 4];
                        _d.label = 1;
                    case 1:
                        _d.trys.push([1, 3, , 4]);
                        _a = this;
                        _c = (_b = JSON).parse;
                        return [4 /*yield*/, fs.promises.readFile(this.cachePath, 'utf8')];
                    case 2:
                        _a.cache = _c.apply(_b, [_d.sent()]);
                        return [3 /*break*/, 4];
                    case 3:
                        e_1 = _d.sent();
                        this.cache = {};
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    PageRankGraphBuilder.prototype.saveCache = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, fs.promises.writeFile(this.cachePath, JSON.stringify(this.cache), 'utf8')];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    PageRankGraphBuilder.prototype.extractIdentifiers = function (content, language) {
        var identifiers = new Set();
        var LanguageModule = (0, languageDetector_1.getTreeSitterLanguage)(language);
        if (LanguageModule) {
            var parser = new Parser();
            try {
                parser.setLanguage(LanguageModule);
                var tree = parser.parse(content);
                function processNode(node) {
                    if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') {
                        if (node.text.length >= 3) {
                            identifiers.add(node.text);
                        }
                    }
                    for (var i = 0; i < node.childCount; i++) {
                        var child = node.child(i);
                        if (child) {
                            processNode(child);
                        }
                    }
                }
                processNode(tree.rootNode);
                return Array.from(identifiers);
            }
            catch (e) { }
        }
        var words = content.match(/[A-Za-z_$][\w$]*/g);
        if (words) {
            for (var _i = 0, words_1 = words; _i < words_1.length; _i++) {
                var w = words_1[_i];
                if (w.length >= 3)
                    identifiers.add(w);
            }
        }
        return Array.from(identifiers);
    };
    PageRankGraphBuilder.prototype.updateFile = function (filePath, content, language) {
        return __awaiter(this, void 0, void 0, function () {
            var relPath;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        relPath = normalizePath(filePath, this.workspaceRoot);
                        this.cache[relPath] = this.extractIdentifiers(content, language);
                        return [4 /*yield*/, this.saveCache()];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    PageRankGraphBuilder.prototype.removeFile = function (filePath) {
        return __awaiter(this, void 0, void 0, function () {
            var relPath;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        relPath = normalizePath(filePath, this.workspaceRoot);
                        delete this.cache[relPath];
                        return [4 /*yield*/, this.saveCache()];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    PageRankGraphBuilder.prototype.clearAll = function () {
        return __awaiter(this, void 0, void 0, function () {
            var e_2, e_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        this.cache = {};
                        if (!fs.existsSync(this.cachePath)) return [3 /*break*/, 4];
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs.promises.unlink(this.cachePath)];
                    case 2:
                        _a.sent();
                        return [3 /*break*/, 4];
                    case 3:
                        e_2 = _a.sent();
                        return [3 /*break*/, 4];
                    case 4:
                        if (!fs.existsSync(this.graphPath)) return [3 /*break*/, 8];
                        _a.label = 5;
                    case 5:
                        _a.trys.push([5, 7, , 8]);
                        return [4 /*yield*/, fs.promises.unlink(this.graphPath)];
                    case 6:
                        _a.sent();
                        return [3 /*break*/, 8];
                    case 7:
                        e_3 = _a.sent();
                        return [3 /*break*/, 8];
                    case 8: return [2 /*return*/];
                }
            });
        });
    };
    PageRankGraphBuilder.prototype.buildGraph = function (allFiles_1) {
        return __awaiter(this, arguments, void 0, function (allFiles, seedFiles) {
            var edgesMap, nodes, validFiles, _i, validFiles_1, file, dfMap, cachedFilesCount, _a, _b, _c, fromRelFile, identifiers, _d, _e, ident, threshold, _f, _g, _h, fromRelFile, identifiers, _j, identifiers_1, ident, definedIn1, lowerIdent, definedIn2, titleIdent, definedIn3, allDefs, uniqueDefs, _k, allDefs_1, def, definedIn, _l, definedIn_1, def, toRelFile, edgeKey, edge, edges, _m, edges_1, edge, d, maxIterations, tol, N, initialScore, _o, validFiles_2, file, outEdges, _p, validFiles_3, file, _q, edges_2, edge, pVector, normalizedSeeds, _r, validFiles_4, file, _s, validFiles_5, file, iter, diff, newScores, danglingSum, _t, validFiles_6, file, _u, validFiles_7, file, score, outDegree, _v, _w, target, _x, validFiles_8, file, _y, validFiles_9, file, graph;
            var _this = this;
            if (seedFiles === void 0) { seedFiles = []; }
            return __generator(this, function (_z) {
                switch (_z.label) {
                    case 0:
                        edgesMap = new Map();
                        nodes = {};
                        validFiles = new Set(allFiles
                            .map(function (f) { return normalizePath(f, _this.workspaceRoot); })
                            .filter(function (f) { return !isTestFile(f); }));
                        for (_i = 0, validFiles_1 = validFiles; _i < validFiles_1.length; _i++) {
                            file = validFiles_1[_i];
                            nodes[file] = { pagerank_score: 0, out_degree: 0, in_degree: 0 };
                        }
                        dfMap = new Map();
                        cachedFilesCount = 0;
                        for (_a = 0, _b = Object.entries(this.cache); _a < _b.length; _a++) {
                            _c = _b[_a], fromRelFile = _c[0], identifiers = _c[1];
                            if (!validFiles.has(fromRelFile))
                                continue;
                            cachedFilesCount++;
                            for (_d = 0, _e = new Set(identifiers); _d < _e.length; _d++) {
                                ident = _e[_d];
                                dfMap.set(ident, (dfMap.get(ident) || 0) + 1);
                            }
                        }
                        threshold = cachedFilesCount * 0.3;
                        // Generate edges
                        for (_f = 0, _g = Object.entries(this.cache); _f < _g.length; _f++) {
                            _h = _g[_f], fromRelFile = _h[0], identifiers = _h[1];
                            if (!validFiles.has(fromRelFile))
                                continue;
                            for (_j = 0, identifiers_1 = identifiers; _j < identifiers_1.length; _j++) {
                                ident = identifiers_1[_j];
                                if (isGenericIdentifier(ident))
                                    continue;
                                if ((dfMap.get(ident) || 0) > threshold)
                                    continue;
                                definedIn1 = this.symbolIndex.lookup(ident) || [];
                                lowerIdent = ident.toLowerCase();
                                definedIn2 = ident !== lowerIdent ? (this.symbolIndex.lookup(lowerIdent) || []) : [];
                                titleIdent = ident.charAt(0).toUpperCase() + ident.slice(1);
                                definedIn3 = ident !== titleIdent ? (this.symbolIndex.lookup(titleIdent) || []) : [];
                                allDefs = __spreadArray(__spreadArray(__spreadArray([], definedIn1, true), definedIn2, true), definedIn3, true);
                                uniqueDefs = new Map();
                                for (_k = 0, allDefs_1 = allDefs; _k < allDefs_1.length; _k++) {
                                    def = allDefs_1[_k];
                                    uniqueDefs.set(def.filePath, def);
                                }
                                definedIn = Array.from(uniqueDefs.values());
                                for (_l = 0, definedIn_1 = definedIn; _l < definedIn_1.length; _l++) {
                                    def = definedIn_1[_l];
                                    toRelFile = normalizePath(def.filePath, this.workspaceRoot);
                                    if (!validFiles.has(toRelFile))
                                        continue;
                                    if (fromRelFile === toRelFile)
                                        continue; // Skip self-loops
                                    edgeKey = "".concat(fromRelFile, "->").concat(toRelFile);
                                    edge = edgesMap.get(edgeKey);
                                    if (!edge) {
                                        edge = { from: fromRelFile, to: toRelFile, weight: 0, symbols: [] };
                                        edgesMap.set(edgeKey, edge);
                                    }
                                    if (!edge.symbols.includes(ident)) {
                                        edge.symbols.push(ident);
                                        edge.weight += 1;
                                    }
                                }
                            }
                        }
                        edges = Array.from(edgesMap.values());
                        for (_m = 0, edges_1 = edges; _m < edges_1.length; _m++) {
                            edge = edges_1[_m];
                            nodes[edge.from].out_degree += edge.weight;
                            nodes[edge.to].in_degree += edge.weight;
                        }
                        d = 0.85;
                        maxIterations = 100;
                        tol = 1e-6;
                        N = validFiles.size;
                        if (N > 0) {
                            initialScore = 1.0 / N;
                            for (_o = 0, validFiles_2 = validFiles; _o < validFiles_2.length; _o++) {
                                file = validFiles_2[_o];
                                nodes[file].pagerank_score = initialScore;
                            }
                            outEdges = {};
                            for (_p = 0, validFiles_3 = validFiles; _p < validFiles_3.length; _p++) {
                                file = validFiles_3[_p];
                                outEdges[file] = [];
                            }
                            for (_q = 0, edges_2 = edges; _q < edges_2.length; _q++) {
                                edge = edges_2[_q];
                                outEdges[edge.from].push({ to: edge.to, weight: edge.weight });
                            }
                            pVector = {};
                            normalizedSeeds = seedFiles.map(function (f) { return normalizePath(f, _this.workspaceRoot); }).filter(function (f) { return validFiles.has(f); });
                            if (normalizedSeeds.length > 0) {
                                for (_r = 0, validFiles_4 = validFiles; _r < validFiles_4.length; _r++) {
                                    file = validFiles_4[_r];
                                    pVector[file] = normalizedSeeds.includes(file) ? 1.0 / normalizedSeeds.length : 0.0;
                                }
                            }
                            else {
                                for (_s = 0, validFiles_5 = validFiles; _s < validFiles_5.length; _s++) {
                                    file = validFiles_5[_s];
                                    pVector[file] = 1.0 / N;
                                }
                            }
                            for (iter = 0; iter < maxIterations; iter++) {
                                diff = 0;
                                newScores = {};
                                danglingSum = 0;
                                for (_t = 0, validFiles_6 = validFiles; _t < validFiles_6.length; _t++) {
                                    file = validFiles_6[_t];
                                    newScores[file] = 0;
                                    if (nodes[file].out_degree === 0) {
                                        danglingSum += nodes[file].pagerank_score;
                                    }
                                }
                                for (_u = 0, validFiles_7 = validFiles; _u < validFiles_7.length; _u++) {
                                    file = validFiles_7[_u];
                                    score = nodes[file].pagerank_score;
                                    if (nodes[file].out_degree > 0) {
                                        outDegree = nodes[file].out_degree;
                                        for (_v = 0, _w = outEdges[file]; _v < _w.length; _v++) {
                                            target = _w[_v];
                                            newScores[target.to] += d * score * (target.weight / outDegree);
                                        }
                                    }
                                }
                                for (_x = 0, validFiles_8 = validFiles; _x < validFiles_8.length; _x++) {
                                    file = validFiles_8[_x];
                                    newScores[file] += (1.0 - d) * pVector[file] + d * danglingSum * pVector[file];
                                    diff += Math.abs(newScores[file] - nodes[file].pagerank_score);
                                }
                                for (_y = 0, validFiles_9 = validFiles; _y < validFiles_9.length; _y++) {
                                    file = validFiles_9[_y];
                                    nodes[file].pagerank_score = newScores[file];
                                }
                                if (diff < tol) {
                                    break;
                                }
                            }
                        }
                        graph = {
                            nodes: nodes,
                            edges: edges,
                            computed_at: new Date().toISOString(),
                            total_files: validFiles.size
                        };
                        return [4 /*yield*/, fs.promises.writeFile(this.graphPath, JSON.stringify(graph, null, 2), 'utf8')];
                    case 1:
                        _z.sent();
                        return [2 /*return*/, graph];
                }
            });
        });
    };
    return PageRankGraphBuilder;
}());
exports.PageRankGraphBuilder = PageRankGraphBuilder;
