"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
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
exports.CommunityClustering = void 0;
var fs = __importStar(require("fs"));
var path = __importStar(require("path"));
var inferencer_1 = require("../ollama/inferencer");
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
var CommunityClustering = /** @class */ (function () {
    function CommunityClustering(repoguideDir, outputChannel) {
        this.repoguideDir = repoguideDir;
        this.outputChannel = outputChannel;
        this.graphPath = path.join(repoguideDir, 'pagerank_graph.json');
        this.hashesPath = path.join(repoguideDir, 'file_hashes.json');
        this.annotationsDir = path.join(repoguideDir, 'annotations');
        this.outputPath = path.join(repoguideDir, 'community_summaries.json');
    }
    CommunityClustering.prototype.getAnnotation = function (filePath, hashes) {
        var hash = hashes[filePath];
        if (!hash)
            return null;
        var p = path.join(this.annotationsDir, "".concat(hash, ".json"));
        if (!fs.existsSync(p))
            return null;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
        catch (_a) {
            return null;
        }
    };
    CommunityClustering.prototype.detectCommunities = function (graph) {
        var allFiles = Object.keys(graph.nodes).filter(function (f) { return !isTestFile(f); });
        if (allFiles.length === 0)
            return [];
        // Step 1: Remove hub nodes (top 5%)
        var sortedByRank = __spreadArray([], allFiles, true).sort(function (a, b) { var _a, _b; return (((_a = graph.nodes[b]) === null || _a === void 0 ? void 0 : _a.pagerank_score) || 0) - (((_b = graph.nodes[a]) === null || _b === void 0 ? void 0 : _b.pagerank_score) || 0); });
        var hubCount = Math.floor(allFiles.length * 0.05);
        var hubNodes = new Set(sortedByRank.slice(0, hubCount));
        var nonHubFiles = allFiles.filter(function (f) { return !hubNodes.has(f); });
        // Step 2: Cluster by directory proximity
        var dirClusters = new Map();
        for (var _i = 0, nonHubFiles_1 = nonHubFiles; _i < nonHubFiles_1.length; _i++) {
            var f = nonHubFiles_1[_i];
            var dir = path.dirname(f);
            if (!dirClusters.has(dir))
                dirClusters.set(dir, []);
            dirClusters.get(dir).push(f);
        }
        var clusters = Array.from(dirClusters.values());
        // Map to quickly find edges
        var adjacency = new Map();
        for (var _a = 0, allFiles_1 = allFiles; _a < allFiles_1.length; _a++) {
            var f = allFiles_1[_a];
            adjacency.set(f, new Set());
        }
        for (var _b = 0, _c = graph.edges; _b < _c.length; _b++) {
            var edge = _c[_b];
            if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
                adjacency.get(edge.from).add(edge.to);
                adjacency.get(edge.to).add(edge.from); // undirected for connection strength
            }
        }
        // Merge clusters with > 3 cross-directory edges
        var merged = true;
        while (merged) {
            merged = false;
            for (var i = 0; i < clusters.length; i++) {
                for (var j = i + 1; j < clusters.length; j++) {
                    var crossEdges = 0;
                    var c1 = clusters[i];
                    var c2 = clusters[j];
                    for (var _d = 0, c1_1 = c1; _d < c1_1.length; _d++) {
                        var f1 = c1_1[_d];
                        for (var _e = 0, c2_1 = c2; _e < c2_1.length; _e++) {
                            var f2 = c2_1[_e];
                            if (adjacency.get(f1).has(f2))
                                crossEdges++;
                        }
                    }
                    if (crossEdges > 3) {
                        clusters[i] = __spreadArray(__spreadArray([], c1, true), c2, true);
                        clusters.splice(j, 1);
                        merged = true;
                        break;
                    }
                }
                if (merged)
                    break;
            }
        }
        // Step 3: Enforce max community size (20)
        var splitClusters = [];
        for (var _f = 0, clusters_1 = clusters; _f < clusters_1.length; _f++) {
            var cluster = clusters_1[_f];
            if (cluster.length > 20) {
                var remaining = __spreadArray([], cluster, true);
                var _loop_1 = function () {
                    remaining.sort(function (a, b) { var _a, _b; return (((_a = graph.nodes[b]) === null || _a === void 0 ? void 0 : _a.pagerank_score) || 0) - (((_b = graph.nodes[a]) === null || _b === void 0 ? void 0 : _b.pagerank_score) || 0); });
                    var seed = remaining[0];
                    var newCluster = new Set([seed]);
                    var added = true;
                    while (added && newCluster.size < 20) {
                        added = false;
                        for (var _k = 0, remaining_1 = remaining; _k < remaining_1.length; _k++) {
                            var f = remaining_1[_k];
                            if (newCluster.has(f))
                                continue;
                            var connects = false;
                            for (var _l = 0, newCluster_1 = newCluster; _l < newCluster_1.length; _l++) {
                                var inCluster = newCluster_1[_l];
                                if (adjacency.get(f).has(inCluster)) {
                                    connects = true;
                                    break;
                                }
                            }
                            if (connects) {
                                newCluster.add(f);
                                added = true;
                                if (newCluster.size >= 20)
                                    break;
                            }
                        }
                    }
                    if (newCluster.size === 1) {
                        for (var i = 1; i < Math.min(20, remaining.length); i++) {
                            newCluster.add(remaining[i]);
                        }
                    }
                    splitClusters.push(Array.from(newCluster));
                    remaining = remaining.filter(function (f) { return !newCluster.has(f); });
                };
                while (remaining.length > 20) {
                    _loop_1();
                }
                if (remaining.length > 0)
                    splitClusters.push(remaining);
            }
            else {
                splitClusters.push(cluster);
            }
        }
        // Step 4: Add hubs back to their most relevant community
        for (var _g = 0, hubNodes_1 = hubNodes; _g < hubNodes_1.length; _g++) {
            var hub = hubNodes_1[_g];
            var bestClusterIdx = -1;
            var maxConnections = -1;
            for (var i = 0; i < splitClusters.length; i++) {
                if (splitClusters[i].length >= 20)
                    continue;
                var connections = 0;
                for (var _h = 0, _j = splitClusters[i]; _h < _j.length; _h++) {
                    var f = _j[_h];
                    if (adjacency.get(hub).has(f))
                        connections++;
                }
                if (connections > maxConnections && connections > 0) {
                    maxConnections = connections;
                    bestClusterIdx = i;
                }
            }
            if (bestClusterIdx !== -1) {
                splitClusters[bestClusterIdx].push(hub);
            }
            else {
                var placed = false;
                for (var i = 0; i < splitClusters.length; i++) {
                    if (splitClusters[i].length < 20) {
                        splitClusters[i].push(hub);
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    splitClusters.push([hub]);
                }
            }
        }
        // Return communities >= 3 files
        return splitClusters.filter(function (c) { return c.length >= 3; });
    };
    CommunityClustering.prototype.generateSummaryForCommunity = function (community, graph, hashes) {
        return __awaiter(this, void 0, void 0, function () {
            var sortedFiles, centralFile, annotations, _i, _a, f, ann, systemPrompt, userPrompt, messages, raw, _b, _c, _d, chunk, e_1_1, firstBrace, lastBrace, parsed, e_2;
            var _e, e_1, _f, _g;
            return __generator(this, function (_h) {
                switch (_h.label) {
                    case 0:
                        sortedFiles = __spreadArray([], community, true).sort(function (a, b) {
                            var _a, _b;
                            var scoreA = ((_a = graph.nodes[a]) === null || _a === void 0 ? void 0 : _a.pagerank_score) || 0;
                            var scoreB = ((_b = graph.nodes[b]) === null || _b === void 0 ? void 0 : _b.pagerank_score) || 0;
                            return scoreB - scoreA;
                        });
                        centralFile = sortedFiles[0];
                        annotations = [];
                        for (_i = 0, _a = sortedFiles.slice(0, 6); _i < _a.length; _i++) {
                            f = _a[_i];
                            ann = this.getAnnotation(f, hashes);
                            if (ann)
                                annotations.push(ann);
                        }
                        systemPrompt = "You are a strict software architect. You must respond with ONLY a JSON object. No text before or after. No markdown. No explanation. Start your response with { and end it with }. You MUST explicitly name specific classes or functions in your summary.";
                        userPrompt = "I have a community of related files. The central file is ".concat(centralFile, ".\nHere are annotations for up to 6 key files in this community:\n\n").concat(JSON.stringify(annotations, null, 2), "\n\nProduce this exact JSON describing the community's architectural role:\n{\n  \"name\": \"A short descriptive name for this module/community (max 40 chars)\",\n  \"summary\": \"An architectural description of what this module does. YOU MUST EXPLICITLY NAME AT LEAST TWO SPECIFIC CLASSES OR FUNCTIONS FROM THE ANNOTATIONS.\"\n}\n\nRules:\n- The name should be derived from the central file's role.\n- The summary MUST explicitly mention specific classes, functions, or concepts from the annotations.\n- Do NOT use generic placeholder language (e.g. \"This module handles logic\" or \"Provides utility functions\").\n- ONLY output the JSON.");
                        messages = [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt }
                        ];
                        raw = '';
                        _h.label = 1;
                    case 1:
                        _h.trys.push([1, 14, , 15]);
                        _h.label = 2;
                    case 2:
                        _h.trys.push([2, 7, 8, 13]);
                        _b = true, _c = __asyncValues((0, inferencer_1.streamChat)(messages));
                        _h.label = 3;
                    case 3: return [4 /*yield*/, _c.next()];
                    case 4:
                        if (!(_d = _h.sent(), _e = _d.done, !_e)) return [3 /*break*/, 6];
                        _g = _d.value;
                        _b = false;
                        chunk = _g;
                        raw += chunk;
                        _h.label = 5;
                    case 5:
                        _b = true;
                        return [3 /*break*/, 3];
                    case 6: return [3 /*break*/, 13];
                    case 7:
                        e_1_1 = _h.sent();
                        e_1 = { error: e_1_1 };
                        return [3 /*break*/, 13];
                    case 8:
                        _h.trys.push([8, , 11, 12]);
                        if (!(!_b && !_e && (_f = _c.return))) return [3 /*break*/, 10];
                        return [4 /*yield*/, _f.call(_c)];
                    case 9:
                        _h.sent();
                        _h.label = 10;
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        if (e_1) throw e_1.error;
                        return [7 /*endfinally*/];
                    case 12: return [7 /*endfinally*/];
                    case 13:
                        raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
                        firstBrace = raw.indexOf('{');
                        lastBrace = raw.lastIndexOf('}');
                        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
                            raw = raw.substring(firstBrace, lastBrace + 1);
                        }
                        parsed = JSON.parse(raw);
                        return [2 /*return*/, {
                                name: parsed.name || 'Unknown Module',
                                central_file: centralFile,
                                files: community,
                                summary: parsed.summary || 'Summary unavailable.',
                                generated_at: new Date().toISOString()
                            }];
                    case 14:
                        e_2 = _h.sent();
                        this.outputChannel.appendLine("[Warn] Community LLM failed for central file ".concat(centralFile, ": ").concat(e_2));
                        return [2 /*return*/, {
                                name: 'Fallback Module',
                                central_file: centralFile,
                                files: community,
                                summary: "Community centered around ".concat(centralFile, "."),
                                generated_at: new Date().toISOString()
                            }];
                    case 15: return [2 /*return*/];
                }
            });
        });
    };
    CommunityClustering.prototype.clusterAndSummarize = function () {
        return __awaiter(this, arguments, void 0, function (force) {
            var graph, _a, _b, hashes, _c, _d, existing, _e, _f, e_3, currentEdges, oldEdges, diff, communities, output, i, _i, communities_1, comm, summary;
            if (force === void 0) { force = false; }
            return __generator(this, function (_g) {
                switch (_g.label) {
                    case 0:
                        if (!fs.existsSync(this.graphPath) || !fs.existsSync(this.hashesPath)) {
                            return [2 /*return*/];
                        }
                        _b = (_a = JSON).parse;
                        return [4 /*yield*/, fs.promises.readFile(this.graphPath, 'utf8')];
                    case 1:
                        graph = _b.apply(_a, [_g.sent()]);
                        _d = (_c = JSON).parse;
                        return [4 /*yield*/, fs.promises.readFile(this.hashesPath, 'utf8')];
                    case 2:
                        hashes = _d.apply(_c, [_g.sent()]);
                        existing = null;
                        if (!fs.existsSync(this.outputPath)) return [3 /*break*/, 6];
                        _g.label = 3;
                    case 3:
                        _g.trys.push([3, 5, , 6]);
                        _f = (_e = JSON).parse;
                        return [4 /*yield*/, fs.promises.readFile(this.outputPath, 'utf8')];
                    case 4:
                        existing = _f.apply(_e, [_g.sent()]);
                        return [3 /*break*/, 6];
                    case 5:
                        e_3 = _g.sent();
                        return [3 /*break*/, 6];
                    case 6:
                        currentEdges = graph.edges ? graph.edges.length : 0;
                        if (!force && existing && existing.graph_edges_at_computation !== undefined) {
                            oldEdges = existing.graph_edges_at_computation;
                            diff = Math.abs(currentEdges - oldEdges);
                            if (oldEdges > 0 && (diff / oldEdges) <= 0.10) {
                                this.outputChannel.appendLine("[Info] Skipping community clustering (edges changed by <= 10%).");
                                return [2 /*return*/];
                            }
                        }
                        communities = this.detectCommunities(graph);
                        this.outputChannel.appendLine("Detected ".concat(communities.length, " communities."));
                        output = {
                            communities: [],
                            total_communities: communities.length,
                            computed_at: new Date().toISOString(),
                            graph_edges_at_computation: currentEdges
                        };
                        i = 0;
                        _i = 0, communities_1 = communities;
                        _g.label = 7;
                    case 7:
                        if (!(_i < communities_1.length)) return [3 /*break*/, 10];
                        comm = communities_1[_i];
                        return [4 /*yield*/, this.generateSummaryForCommunity(comm, graph, hashes)];
                    case 8:
                        summary = _g.sent();
                        output.communities.push(__assign({ id: "comm_".concat(i++) }, summary));
                        _g.label = 9;
                    case 9:
                        _i++;
                        return [3 /*break*/, 7];
                    case 10: return [4 /*yield*/, fs.promises.writeFile(this.outputPath, JSON.stringify(output, null, 2), 'utf8')];
                    case 11:
                        _g.sent();
                        this.outputChannel.appendLine("Wrote community summaries to ".concat(this.outputPath));
                        return [2 /*return*/];
                }
            });
        });
    };
    return CommunityClustering;
}());
exports.CommunityClustering = CommunityClustering;
