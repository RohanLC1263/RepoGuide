"use strict";
/**
 * repoguideLogger.ts — Phase 11.2
 *
 * Structured output logger for RepoGuide. Replaces ad-hoc console.log /
 * outputChannel.appendLine calls with a singleton that writes to:
 *   1. VS Code OutputChannel "RepoGuide"
 *   2. Daily-rotating log file: .repoguide/logs/repoguide-YYYY-MM-DD.log
 *
 * Provides specialized methods for stage lifecycle, artifact writes,
 * query tracing, repair events, and error reporting — all with
 * timestamps and structured formatting.
 */
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RepoGuideLogger = void 0;
var fs = __importStar(require("fs"));
var path = __importStar(require("path"));
var vscode = __importStar(require("vscode"));
// ── ETA tracker ────────────────────────────────────────────────────────────
var ETATracker = /** @class */ (function () {
    function ETATracker() {
        this.windowSize = 10;
        this.durations = [];
        this.lastTickMs = 0;
    }
    ETATracker.prototype.reset = function () {
        this.durations = [];
        this.lastTickMs = 0;
    };
    ETATracker.prototype.tick = function () {
        var now = Date.now();
        if (this.lastTickMs > 0) {
            var elapsed = now - this.lastTickMs;
            this.durations.push(elapsed);
            if (this.durations.length > this.windowSize) {
                this.durations.shift();
            }
        }
        this.lastTickMs = now;
    };
    ETATracker.prototype.getETA = function (remaining) {
        if (this.durations.length === 0 || remaining <= 0) {
            return '';
        }
        var avgMs = this.durations.reduce(function (a, b) { return a + b; }, 0) / this.durations.length;
        var etaMs = avgMs * remaining;
        var avgSec = (avgMs / 1000).toFixed(1);
        if (etaMs < 60000) {
            return "ETA: ".concat(Math.ceil(etaMs / 1000), "s (avg ").concat(avgSec, "s each)");
        }
        return "ETA: ".concat(Math.ceil(etaMs / 60000), "min (avg ").concat(avgSec, "s each)");
    };
    return ETATracker;
}());
// ── Logger ─────────────────────────────────────────────────────────────────
var RepoGuideLogger = /** @class */ (function () {
    function RepoGuideLogger(outputChannel) {
        this.logDir = null;
        this.currentLogDate = null;
        this.logStream = null;
        this.debugEnabled = false;
        this.etaTrackers = new Map();
        this.outputChannel = outputChannel;
    }
    // ── Singleton access ───────────────────────────────────────────────────
    RepoGuideLogger.init = function (outputChannel, repoguideDir) {
        if (RepoGuideLogger.instance) {
            // Re-initialize with new output channel if needed
            RepoGuideLogger.instance.outputChannel = outputChannel;
            if (repoguideDir) {
                RepoGuideLogger.instance.setLogDir(repoguideDir);
            }
            return RepoGuideLogger.instance;
        }
        var logger = new RepoGuideLogger(outputChannel);
        if (repoguideDir) {
            logger.setLogDir(repoguideDir);
        }
        logger.debugEnabled = vscode.workspace
            .getConfiguration('repoguide')
            .get('debugLogging', false);
        RepoGuideLogger.instance = logger;
        return logger;
    };
    RepoGuideLogger.get = function () {
        if (!RepoGuideLogger.instance) {
            // Fallback: create with a temporary output channel.
            // This should not happen in normal operation.
            var ch = vscode.window.createOutputChannel('RepoGuide');
            return RepoGuideLogger.init(ch);
        }
        return RepoGuideLogger.instance;
    };
    /**
     * Returns the underlying OutputChannel so existing code that
     * passes `outputChannel` to sub-components can pass this instead.
     */
    RepoGuideLogger.prototype.getOutputChannel = function () {
        return this.outputChannel;
    };
    // ── Configuration ──────────────────────────────────────────────────────
    RepoGuideLogger.prototype.setLogDir = function (repoguideDir) {
        this.logDir = path.join(repoguideDir, 'logs');
        try {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        catch ( /* */_a) { /* */ }
    };
    RepoGuideLogger.prototype.setDebug = function (enabled) {
        this.debugEnabled = enabled;
    };
    // ── Core write ─────────────────────────────────────────────────────────
    RepoGuideLogger.prototype.timestamp = function () {
        var d = new Date();
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        var ss = String(d.getSeconds()).padStart(2, '0');
        return "".concat(hh, ":").concat(mm, ":").concat(ss);
    };
    RepoGuideLogger.prototype.write = function (level, message) {
        var ts = this.timestamp();
        var prefix = level === 'INFO'
            ? "[RepoGuide] [".concat(ts, "]")
            : "[RepoGuide] [".concat(ts, "] [").concat(level, "]");
        var line = "".concat(prefix, " ").concat(message);
        this.outputChannel.appendLine(line);
        this.writeToFile(line);
    };
    RepoGuideLogger.prototype.writeToFile = function (line) {
        var _a;
        if (!this.logDir) {
            return;
        }
        var today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        if (today !== this.currentLogDate) {
            this.rotateLogFile(today);
        }
        try {
            (_a = this.logStream) === null || _a === void 0 ? void 0 : _a.write(line + '\n');
        }
        catch ( /* non-critical */_b) { /* non-critical */ }
    };
    RepoGuideLogger.prototype.rotateLogFile = function (date) {
        var _a;
        try {
            (_a = this.logStream) === null || _a === void 0 ? void 0 : _a.end();
        }
        catch ( /* */_b) { /* */ }
        this.currentLogDate = date;
        var logPath = path.join(this.logDir, "repoguide-".concat(date, ".log"));
        try {
            this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
        }
        catch (_c) {
            this.logStream = null;
        }
        // Clean up logs older than 7 days
        this.cleanOldLogs();
    };
    RepoGuideLogger.prototype.cleanOldLogs = function () {
        if (!this.logDir) {
            return;
        }
        try {
            var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            for (var _i = 0, _a = fs.readdirSync(this.logDir); _i < _a.length; _i++) {
                var file = _a[_i];
                if (!file.startsWith('repoguide-') || !file.endsWith('.log')) {
                    continue;
                }
                var dateStr = file.replace('repoguide-', '').replace('.log', '');
                var fileDate = new Date(dateStr).getTime();
                if (!isNaN(fileDate) && fileDate < cutoff) {
                    fs.unlinkSync(path.join(this.logDir, file));
                }
            }
        }
        catch ( /* non-critical */_b) { /* non-critical */ }
    };
    // ── Public API: general log levels ─────────────────────────────────────
    RepoGuideLogger.prototype.debug = function (message) {
        if (this.debugEnabled) {
            this.write('DEBUG', message);
        }
    };
    RepoGuideLogger.prototype.info = function (message) {
        this.write('INFO', message);
    };
    RepoGuideLogger.prototype.warn = function (message) {
        this.write('WARN', message);
    };
    RepoGuideLogger.prototype.error = function (message) {
        this.write('ERROR', message);
    };
    // ── Public API: stage lifecycle ────────────────────────────────────────
    RepoGuideLogger.prototype.stageStart = function (stageName, totalItems) {
        var count = totalItems !== undefined ? " (".concat(totalItems, " files)") : '';
        this.write('INFO', "Stage started: ".concat(stageName).concat(count));
        // Reset ETA tracker for this stage
        var tracker = new ETATracker();
        this.etaTrackers.set(stageName, tracker);
    };
    RepoGuideLogger.prototype.stageProgress = function (opts) {
        var _a;
        var tracker = this.etaTrackers.get(opts.stageName);
        tracker === null || tracker === void 0 ? void 0 : tracker.tick();
        var pctComplete = opts.total > 0
            ? ((opts.current / opts.total) * 100).toFixed(1)
            : '0.0';
        var failedStr = opts.failed ? ", ".concat(opts.failed, " failed") : '';
        var cachedStr = opts.cached ? ", ".concat(opts.cached, " cached") : '';
        var remaining = opts.total - opts.current;
        var eta = (_a = tracker === null || tracker === void 0 ? void 0 : tracker.getETA(remaining)) !== null && _a !== void 0 ? _a : '';
        var etaStr = eta ? " \u2014 ".concat(eta) : '';
        this.write('INFO', "Stage progress: ".concat(opts.stageName, " ").concat(opts.current, "/").concat(opts.total) +
            " (".concat(pctComplete, "% complete").concat(failedStr).concat(cachedStr, ")").concat(etaStr));
    };
    RepoGuideLogger.prototype.stageComplete = function (stageName, stats) {
        var parts = [];
        if ((stats === null || stats === void 0 ? void 0 : stats.total) !== undefined) {
            parts.push("".concat(stats.total, " files"));
        }
        if (stats === null || stats === void 0 ? void 0 : stats.failed) {
            parts.push("".concat(stats.failed, " failed"));
        }
        if ((stats === null || stats === void 0 ? void 0 : stats.durationSec) !== undefined) {
            var dur = stats.durationSec >= 60
                ? "".concat((stats.durationSec / 60).toFixed(1), "min")
                : "".concat(stats.durationSec.toFixed(1), "s");
            parts.push(dur);
        }
        var detail = parts.length > 0 ? " (".concat(parts.join(', '), ")") : '';
        this.write('INFO', "Stage complete: ".concat(stageName).concat(detail));
        this.etaTrackers.delete(stageName);
    };
    RepoGuideLogger.prototype.stageFailed = function (stageName, error, context) {
        var msg = error instanceof Error ? error.message : error;
        var ctx = context ? " ".concat(context) : '';
        this.write('ERROR', "Stage failed: ".concat(stageName).concat(ctx, " \u2014 ").concat(msg));
        this.etaTrackers.delete(stageName);
    };
    // ── Public API: artifact writes ────────────────────────────────────────
    RepoGuideLogger.prototype.artifactWritten = function (opts) {
        var parts = [];
        if (opts.stats) {
            for (var _i = 0, _a = Object.entries(opts.stats); _i < _a.length; _i++) {
                var _b = _a[_i], k = _b[0], v = _b[1];
                parts.push("".concat(v, " ").concat(k));
            }
        }
        if (opts.sizeBytes !== undefined) {
            parts.push(formatBytes(opts.sizeBytes));
        }
        var detail = parts.length > 0 ? " (".concat(parts.join(', '), ")") : '';
        this.write('INFO', "Artifact written: ".concat(opts.artifactName).concat(detail));
    };
    // ── Public API: query tracing ──────────────────────────────────────────
    RepoGuideLogger.prototype.queryLog = function (opts) {
        var intentStr = opts.intent ? " (intent: ".concat(opts.intent, ")") : '';
        this.write('INFO', "Query: \"".concat(opts.query, "\"").concat(intentStr));
        if (opts.retrievalSources && opts.retrievalSources.length > 0) {
            this.write('INFO', "Retrieval: ".concat(opts.retrievalSources.join(' + ')));
        }
        if (opts.answerTimeMs !== undefined) {
            var timeSec = (opts.answerTimeMs / 1000).toFixed(1);
            var tokens = opts.tokenCount ? ", ".concat(opts.tokenCount, " tokens") : '';
            this.write('INFO', "Answer generated (".concat(timeSec, "s").concat(tokens, ")"));
        }
    };
    // ── Public API: repair events ──────────────────────────────────────────
    RepoGuideLogger.prototype.repairLog = function (opts) {
        switch (opts.action) {
            case 'queued': {
                var blame = opts.blameScore !== undefined
                    ? " (blame ".concat(opts.blameScore.toFixed(2), ")")
                    : '';
                this.write('INFO', "Repair queued: ".concat(opts.repairType, " ").concat(opts.target).concat(blame));
                break;
            }
            case 'started':
                this.write('INFO', "Repair started: ".concat(opts.repairType, " ").concat(opts.target));
                break;
            case 'complete': {
                var dur = opts.durationSec !== undefined
                    ? " (".concat(opts.durationSec.toFixed(1), "s)")
                    : '';
                this.write('INFO', "Repair complete: ".concat(opts.target).concat(dur));
                break;
            }
            case 'failed': {
                var err = opts.error ? " \u2014 ".concat(opts.error) : '';
                this.write('ERROR', "Repair failed: ".concat(opts.target).concat(err));
                break;
            }
        }
    };
    // ── Disposal ───────────────────────────────────────────────────────────
    RepoGuideLogger.prototype.dispose = function () {
        var _a;
        try {
            (_a = this.logStream) === null || _a === void 0 ? void 0 : _a.end();
        }
        catch ( /* */_b) { /* */ }
        this.logStream = null;
        RepoGuideLogger.instance = null;
    };
    RepoGuideLogger.instance = null;
    return RepoGuideLogger;
}());
exports.RepoGuideLogger = RepoGuideLogger;
// ── Helpers ────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
    if (bytes < 1024) {
        return "".concat(bytes, "B");
    }
    if (bytes < 1024 * 1024) {
        return "".concat((bytes / 1024).toFixed(1), "KB");
    }
    return "".concat((bytes / (1024 * 1024)).toFixed(1), "MB");
}
