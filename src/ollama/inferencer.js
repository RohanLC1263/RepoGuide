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
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLANNING_MODEL_OPTIONS = exports.INFERENCE_MODEL_OPTIONS = void 0;
exports.streamChat = streamChat;
var vscode = __importStar(require("vscode"));
var performanceConfig_1 = require("../config/performanceConfig");
exports.INFERENCE_MODEL_OPTIONS = {
    num_ctx: 8192,
    num_gpu: 99,
    temperature: 0
};
exports.PLANNING_MODEL_OPTIONS = {
    num_ctx: 4096,
    num_gpu: 0,
    temperature: 0
};
var STREAM_CHAT_TIMEOUT_MS = 240000;
function streamChat(messages, model, signal, keepAlive) {
    return __asyncGenerator(this, arguments, function streamChat_1() {
        var config, ollamaUrl, timeoutId, abortHandler, innerController, body, requestUrl, response, stream, decoder, buffer, _a, _b, _c, chunk, newlineIndex, line, parsed, parseError_1, e_1_1, e_2;
        var _d, e_1, _e, _f;
        var _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    if (!model) {
                        model = (0, performanceConfig_1.getProfile)().inferenceModel;
                    }
                    model = model.trim();
                    config = vscode.workspace.getConfiguration('repoguide');
                    ollamaUrl = config.get('ollamaUrl', 'http://localhost:11434');
                    _h.label = 1;
                case 1:
                    _h.trys.push([1, 24, 25, 26]);
                    body = { model: model, messages: messages, stream: true };
                    if (keepAlive) {
                        body.keep_alive = keepAlive;
                    }
                    body.options = exports.INFERENCE_MODEL_OPTIONS;
                    requestUrl = "".concat(ollamaUrl, "/api/chat");
                    innerController = new AbortController();
                    timeoutId = setTimeout(function () {
                        console.warn("[Warn] streamChat timeout after ".concat(STREAM_CHAT_TIMEOUT_MS / 1000, "s"));
                        innerController === null || innerController === void 0 ? void 0 : innerController.abort();
                    }, STREAM_CHAT_TIMEOUT_MS);
                    abortHandler = function () { return innerController === null || innerController === void 0 ? void 0 : innerController.abort(); };
                    signal === null || signal === void 0 ? void 0 : signal.addEventListener('abort', abortHandler, { once: true });
                    if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                        innerController.abort();
                    return [4 /*yield*/, __await(fetch(requestUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body),
                            signal: innerController.signal
                        }))];
                case 2:
                    response = _h.sent();
                    if (!response.ok) {
                        throw new Error("Ollama chat failed: ".concat(response.statusText));
                    }
                    if (!response.body) {
                        throw new Error('No response body from Ollama');
                    }
                    stream = response.body;
                    decoder = new TextDecoder();
                    buffer = '';
                    _h.label = 3;
                case 3:
                    _h.trys.push([3, 17, 18, 23]);
                    _a = true, _b = __asyncValues(stream);
                    _h.label = 4;
                case 4: return [4 /*yield*/, __await(_b.next())];
                case 5:
                    if (!(_c = _h.sent(), _d = _c.done, !_d)) return [3 /*break*/, 16];
                    _f = _c.value;
                    _a = false;
                    chunk = _f;
                    buffer += decoder.decode(chunk, { stream: true });
                    newlineIndex = void 0;
                    _h.label = 6;
                case 6:
                    if (!((newlineIndex = buffer.indexOf('\n')) !== -1)) return [3 /*break*/, 15];
                    line = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 1);
                    if (!line) return [3 /*break*/, 14];
                    _h.label = 7;
                case 7:
                    _h.trys.push([7, 13, , 14]);
                    parsed = JSON.parse(line);
                    if (!((_g = parsed.message) === null || _g === void 0 ? void 0 : _g.content)) return [3 /*break*/, 10];
                    return [4 /*yield*/, __await(parsed.message.content)];
                case 8: return [4 /*yield*/, _h.sent()];
                case 9:
                    _h.sent();
                    _h.label = 10;
                case 10:
                    if (!parsed.done) return [3 /*break*/, 12];
                    return [4 /*yield*/, __await(void 0)];
                case 11: return [2 /*return*/, _h.sent()];
                case 12:
                    if (parsed.error) {
                        throw new Error("Ollama stream error: ".concat(parsed.error));
                    }
                    return [3 /*break*/, 14];
                case 13:
                    parseError_1 = _h.sent();
                    // Re-throw Ollama-level errors
                    if (parseError_1 instanceof Error && parseError_1.message.startsWith('Ollama stream error:')) {
                        throw parseError_1;
                    }
                    // Skip unparseable lines (partial chunks, status messages)
                    console.warn("RepoGuide: Skipped unparseable stream chunk: ".concat(line.substring(0, 100)));
                    return [3 /*break*/, 14];
                case 14: return [3 /*break*/, 6];
                case 15:
                    _a = true;
                    return [3 /*break*/, 4];
                case 16: return [3 /*break*/, 23];
                case 17:
                    e_1_1 = _h.sent();
                    e_1 = { error: e_1_1 };
                    return [3 /*break*/, 23];
                case 18:
                    _h.trys.push([18, , 21, 22]);
                    if (!(!_a && !_d && (_e = _b.return))) return [3 /*break*/, 20];
                    return [4 /*yield*/, __await(_e.call(_b))];
                case 19:
                    _h.sent();
                    _h.label = 20;
                case 20: return [3 /*break*/, 22];
                case 21:
                    if (e_1) throw e_1.error;
                    return [7 /*endfinally*/];
                case 22: return [7 /*endfinally*/];
                case 23: return [3 /*break*/, 26];
                case 24:
                    e_2 = _h.sent();
                    if (e_2.name === 'AbortError') {
                        throw e_2;
                    }
                    if (e_2 instanceof Error) {
                        throw new Error("Chat stream failed: ".concat(e_2.message));
                    }
                    throw e_2;
                case 25:
                    if (timeoutId)
                        clearTimeout(timeoutId);
                    if (abortHandler && signal)
                        signal.removeEventListener('abort', abortHandler);
                    return [7 /*endfinally*/];
                case 26: return [2 /*return*/];
            }
        });
    });
}
