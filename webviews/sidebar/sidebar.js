// @ts-nocheck

const vscode = acquireVsCodeApi();
const messagesDiv = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const resetBtn = document.getElementById('reset');
const sessionBtn = document.getElementById('session-info');
const healthToggleBtn = document.getElementById('health-toggle');
const healthContent = document.getElementById('health-content');
const healthGrid = document.getElementById('health-grid');
const healthFolders = document.getElementById('health-folders');
const rebuildIndexBtn = document.getElementById('rebuild-index');
const viewIndexDetailsBtn = document.getElementById('view-index-details');
const DEFAULT_INPUT_PLACEHOLDER = inputEl.placeholder;

let currentAssistantBlock = null;
let currentAssistantBubble = null;
let currentAssistantFooter = null;
let pendingConfidence = null;
let pendingGateStatus = null;
let isStreaming = false;
let currentInputGating = null;
let currentCacheHitPairId = 0;
let currentAssistantIsCacheHit = false;
let currentFeedbackContext = null;

const SEND_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 8L13 8M13 8L9 4M13 8L9 12"
              stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" fill="none"/>
    </svg>
`;

const STOP_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"></rect>
    </svg>
`;

const feedbackStyle = document.createElement('style');
feedbackStyle.textContent = `
.feedback-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; opacity: 0.8; }
.cache-badge { font-size: 11px; color: var(--vscode-descriptionForeground); }
.feedback-btn { background: none; border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 14px; }
.feedback-btn:hover { background: var(--vscode-button-secondaryBackground); }
.feedback-btn:disabled { opacity: 0.4; cursor: default; }
.nav-card { border: 1px solid var(--vscode-focusBorder, rgba(100,200,100,0.4)); border-radius: 6px; padding: 8px 12px; margin-bottom: 4px; background: rgba(100,200,100,0.06); }
.nav-card-header { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.nav-card-icon { font-size: 14px; color: var(--vscode-textLink-foreground); }
.nav-card-title { flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-card-confidence { font-size: 11px; color: var(--vscode-descriptionForeground); background: rgba(100,200,100,0.15); padding: 1px 6px; border-radius: 3px; }
.nav-card-list { margin-top: 6px; border-top: 1px solid rgba(100,200,100,0.2); padding-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.nav-card-row { font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); padding: 2px 4px; border-radius: 3px; cursor: pointer; color: var(--vscode-descriptionForeground); }
.nav-card-row:hover { background: rgba(100,200,100,0.15); color: var(--vscode-foreground); }
.nav-card-row-primary { color: var(--vscode-foreground); font-weight: 500; }
`;
document.head.appendChild(feedbackStyle);

function scrollToBottom() {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function createBubble(text, role) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;
    messagesDiv.appendChild(div);
    scrollToBottom();
    return div;
}

function createAssistantBlock() {
    const wrapper = document.createElement('div');
    wrapper.className = 'assistant-block';

    const bubble = document.createElement('div');
    bubble.className = 'message assistant';
    wrapper.appendChild(bubble);

    const footer = document.createElement('div');
    footer.className = 'message-meta';
    wrapper.appendChild(footer);

    messagesDiv.appendChild(wrapper);
    scrollToBottom();
    return { wrapper, bubble, footer };
}

function renderNavigationCard(navResult) {
    if (!navResult || !navResult.primaryTarget) {
        return null;
    }

    const card = document.createElement('div');
    card.className = 'nav-card';
    card.dataset.queryId = navResult.queryId || '';

    const header = document.createElement('div');
    header.className = 'nav-card-header';

    const icon = document.createElement('span');
    icon.className = 'nav-card-icon';
    icon.textContent = '->';

    const title = document.createElement('span');
    title.className = 'nav-card-title';
    const primary = navResult.primaryTarget;
    const fileName = primary.filePath.split(/[\\/]/).slice(-2).join('/');
    const symbolPart = primary.symbolName ? ` - ${primary.symbolName}` : '';
    title.textContent = `${fileName}${symbolPart} : ${primary.startLine + 1}-${primary.endLine + 1}`;

    const confidenceBadge = document.createElement('span');
    confidenceBadge.className = 'nav-card-confidence';
    confidenceBadge.textContent = `${Math.round((primary.confidence || 0) * 100)}%`;

    header.appendChild(icon);
    header.appendChild(title);
    header.appendChild(confidenceBadge);
    card.appendChild(header);

    if (Array.isArray(navResult.targets) && navResult.targets.length > 1) {
        const list = document.createElement('div');
        list.className = 'nav-card-list';

        navResult.targets.slice(0, 5).forEach((target, index) => {
            const row = document.createElement('div');
            row.className = `nav-card-row${index === 0 ? ' nav-card-row-primary' : ''}`;
            const filePart = target.filePath.split(/[\\/]/).slice(-2).join('/');
            const symbolSuffix = target.symbolName ? ` [${target.symbolName}]` : '';
            row.textContent = `${index + 1}. ${filePart}${symbolSuffix} : ${target.startLine + 1}-${target.endLine + 1}`;
            row.addEventListener('click', () => {
                vscode.postMessage({ type: 'openFile', value: target });
            });
            list.appendChild(row);
        });

        card.appendChild(list);
    }

    messagesDiv.appendChild(card);
    scrollToBottom();
    return card;
}

function appendCacheFeedbackRow() {
    if (!currentAssistantBlock || (!currentAssistantIsCacheHit && !currentFeedbackContext)) {
        currentCacheHitPairId = 0;
        currentAssistantIsCacheHit = false;
        currentFeedbackContext = null;
        return;
    }

    const existing = currentAssistantBlock.querySelector('.feedback-row');
    if (existing) {
        currentCacheHitPairId = 0;
        currentAssistantIsCacheHit = false;
        currentFeedbackContext = null;
        return;
    }

    const feedbackRow = document.createElement('div');
    feedbackRow.className = 'feedback-row';
    feedbackRow.dataset.pairId = String(currentCacheHitPairId);
    feedbackRow.dataset.sessionId = currentFeedbackContext?.sessionId || '';
    feedbackRow.dataset.queryId = currentFeedbackContext?.queryId || '';
    feedbackRow.dataset.answerId = currentFeedbackContext?.answerId || '';

    const badge = document.createElement('span');
    badge.className = 'cache-badge';
    badge.textContent = currentAssistantIsCacheHit ? 'Instant answer' : 'Was this helpful?';

    const upBtn = document.createElement('button');
    upBtn.className = 'feedback-btn thumbs-up';
    upBtn.dataset.pairId = String(currentCacheHitPairId);
    upBtn.dataset.positive = 'true';
    upBtn.textContent = '+';
    upBtn.disabled = !currentAssistantIsCacheHit;

    const downBtn = document.createElement('button');
    downBtn.className = 'feedback-btn thumbs-down';
    downBtn.dataset.pairId = String(currentCacheHitPairId);
    downBtn.dataset.positive = 'false';
    downBtn.dataset.sessionId = currentFeedbackContext?.sessionId || '';
    downBtn.dataset.queryId = currentFeedbackContext?.queryId || '';
    downBtn.dataset.answerId = currentFeedbackContext?.answerId || '';
    downBtn.textContent = '-';

    feedbackRow.appendChild(badge);
    feedbackRow.appendChild(upBtn);
    feedbackRow.appendChild(downBtn);

    if (currentAssistantFooter) {
        currentAssistantBlock.insertBefore(feedbackRow, currentAssistantFooter);
    } else {
        currentAssistantBlock.appendChild(feedbackRow);
    }

    currentCacheHitPairId = 0;
    currentAssistantIsCacheHit = false;
    currentFeedbackContext = null;
}

function renderConfidenceFooter(footer, confidence) {
    if (!footer || !confidence) {
        return;
    }

    footer.innerHTML = '';

    const badgesRow = document.createElement('div');
    badgesRow.className = 'badges-row';
    footer.appendChild(badgesRow);

    const badge = document.createElement('span');
    badge.className = `confidence-badge confidence-${confidence.level}`;
    badge.textContent = confidence.level.charAt(0).toUpperCase() + confidence.level.slice(1);
    badgesRow.appendChild(badge);

    const summary = document.createElement('div');
    summary.textContent = `Based on ${confidence.chunkCount} chunks. ${confidence.explanation}`;
    footer.appendChild(summary);

    if (confidence.topFiles && confidence.topFiles.length > 0) {
        const filesRow = document.createElement('div');
        filesRow.className = 'meta-files';
        const prefix = document.createElement('span');
        prefix.textContent = 'Top sources: ';
        filesRow.appendChild(prefix);

        confidence.topFiles.forEach((fileName, index) => {
            const link = document.createElement('span');
            link.className = 'meta-file';
            link.textContent = fileName;
            link.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'openFile',
                    value: confidence.topFilePaths?.[index]
                });
            });
            filesRow.appendChild(link);
        });
        footer.appendChild(filesRow);
    }
}

/** Renders the AnswerGate trust chip beside the confidence badge (shared
 * .badges-row), reusing .confidence-badge's box styling with a gate-status-*
 * color modifier. Always renders something -- an absent gateStatus (the legacy
 * explainSelection path, which never emits a gateStatus token) gets an
 * explicit muted "Unverified" chip rather than silently showing nothing, since
 * that absence is itself an honest signal worth surfacing. The outcome -> chip
 * text/class/title mapping lives in gateStatusRendering.js so it's unit-testable
 * without a DOM. */
function renderGateStatusChip(footer, gateStatus) {
    if (!footer) {
        return;
    }
    let badgesRow = footer.querySelector('.badges-row');
    if (!badgesRow) {
        badgesRow = document.createElement('div');
        badgesRow.className = 'badges-row';
        footer.insertBefore(badgesRow, footer.firstChild);
    }
    const info = RepoGuideGateStatus.deriveGateChipInfo(gateStatus);
    const chip = document.createElement('span');
    chip.className = info.className;
    chip.textContent = info.text;
    chip.title = info.title;
    badgesRow.appendChild(chip);
}

/** Renders the gap/low-coverage disclosure sentence(s) AnswerGate prepended to
 * the answer as a notice bar above the message bubble, instead of leaving them
 * as indistinguishable plain prose at the front of the answer. */
function createGateNoticeBar(notices) {
    const bar = document.createElement('div');
    bar.className = 'gate-notice-bar';
    notices.forEach(notice => {
        const line = document.createElement('div');
        line.textContent = `⚠ ${notice}`;
        bar.appendChild(line);
    });
    return bar;
}

/** Appends `text` to `container`, rendering any embedded AnswerGate
 * fence-verification annotation as a styled callout (inline, positioned exactly
 * where the gate inserted it -- right after the fence it flags) instead of raw
 * blockquote text. */
function appendTextWithAnnotationCallouts(container, text) {
    if (!text) {
        return;
    }
    const segments = RepoGuideGateStatus.splitOnAnnotationMarker(text);
    segments.forEach((segment, index) => {
        if (segment) {
            container.appendChild(document.createTextNode(segment));
        }
        if (index < segments.length - 1) {
            const callout = document.createElement('div');
            callout.className = 'gate-annotation-callout';
            callout.innerHTML = '<span>&#9888;</span> Could not verify this code block against the indexed evidence. It may be paraphrased or illustrative rather than verbatim source.';
            container.appendChild(callout);
        }
    });
}

function populateIndexHealth(data) {
    if (!data) {
        return;
    }

    const formatTime = (value) => value ? new Date(value).toLocaleString() : 'Never indexed';
    const rows = [
        ['Chunks', data.chunkCount],
        ['Files', data.fileCount],
        ['Symbols', data.symbolCount],
        ['Last indexed', formatTime(data.lastIndexedAt)],
        ['Last synced', data.lastSyncedAt ? new Date(data.lastSyncedAt).toLocaleString() : 'Never synced'],
        ['Embedding', data.embeddingModel],
        ['Inference', data.inferenceModel],
        ['Status', RepoGuideGateStatus.deriveIndexHealthStatusText(data)],
        ['MCP', "Available for external agents -- run 'Copy MCP Config' to connect. Restart your MCP client after any reindex (no live reindex path)."]
    ];

    healthGrid.innerHTML = '';
    rows.forEach(([label, value]) => {
        const item = document.createElement('div');
        item.className = 'health-item';
        item.innerHTML = `<strong>${label}</strong><span>${value}</span>`;
        healthGrid.appendChild(item);
    });

    healthFolders.innerHTML = '';
    (data.topFolders || []).forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'health-folder';
        row.innerHTML = `<span>${entry.folder}</span><span>${entry.chunkCount}</span>`;
        healthFolders.appendChild(row);
    });

    applyIndexHealthGating(data);
}

/** Updates the input-gating state from live index-health data -- detailed
 * indexing progress/status lives in the Index Health panel only; this keeps
 * the send button/textarea gated in sync with core indexing only (not
 * annotation) -- see deriveInputGatingState in gateStatusRendering.js. */
function applyIndexHealthGating(data) {
    currentInputGating = RepoGuideGateStatus.deriveInputGatingState(data);
    applyInputDisabledState();
}

/** Single source of truth for whether the textarea/send button are disabled --
 * combines the in-flight-streaming lock with the indexing gate so neither
 * caller can accidentally clobber the other's disabled state. */
function applyInputDisabledState() {
    const blocked = !isStreaming && !!(currentInputGating && currentInputGating.disabled);
    inputEl.disabled = isStreaming || blocked;
    inputEl.placeholder = (currentInputGating && currentInputGating.placeholder) || DEFAULT_INPUT_PLACEHOLDER;
    sendBtn.disabled = blocked;
    if (!isStreaming) {
        sendBtn.title = blocked ? (currentInputGating.sendTitle || 'Not ready yet') : 'Send message';
    }
}

function showThinkingIndicator() {
    if (document.getElementById('thinking-indicator')) {
        return;
    }
    const indicator = document.createElement('div');
    indicator.id = 'thinking-indicator';
    indicator.className = 'thinking';
    indicator.innerHTML = `
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
    `;
    messagesDiv.appendChild(indicator);
    scrollToBottom();
}

/** Progress text for decomposed (multi-part) answers, rendered next to the
 * thinking dots so the user sees which part is running instead of a silent
 * multi-minute wait. Cleared automatically when the indicator is removed. */
function updateProgressStatus(progress) {
    showThinkingIndicator();
    const indicator = document.getElementById('thinking-indicator');
    if (!indicator) {
        return;
    }
    let label = indicator.querySelector('.progress-label');
    if (!label) {
        label = document.createElement('span');
        label.className = 'progress-label';
        label.style.cssText = 'margin-left:8px;font-size:11px;color:var(--vscode-descriptionForeground);';
        indicator.appendChild(label);
    }
    if (progress.stage === 'decomposed') {
        label.textContent = `Breaking this down into ${progress.total} parts…`;
    } else if (progress.stage === 'sub_start') {
        label.textContent = `Part ${progress.index}/${progress.total}: ${progress.question}`;
    } else if (progress.stage === 'sub_done') {
        label.textContent = `Part ${progress.index}/${progress.total} ${progress.outcome === 'block' ? 'could not be verified' : 'verified'}.`;
    } else if (progress.stage === 'merging') {
        label.textContent = `Combining ${progress.parts} verified part${progress.parts > 1 ? 's' : ''}…`;
    }
    scrollToBottom();
}

function hideThinkingIndicator() {
    const indicator = document.getElementById('thinking-indicator');
    if (indicator) {
        indicator.remove();
    }
}

function appendCancellationNote() {
    const note = document.createElement('div');
    note.className = 'cancelled-note';
    note.textContent = 'Generation stopped.';
    messagesDiv.appendChild(note);
    scrollToBottom();
}

function setStreamingState(streaming) {
    isStreaming = streaming;
    if (streaming) {
        sendBtn.innerHTML = STOP_ICON;
        sendBtn.title = 'Stop generating';
        sendBtn.classList.add('streaming');
        showThinkingIndicator();
    } else {
        sendBtn.innerHTML = SEND_ICON;
        sendBtn.classList.remove('streaming');
        hideThinkingIndicator();
    }
    applyInputDisabledState();
    if (!streaming && !inputEl.disabled) {
        inputEl.focus();
    }
}

function sendQuestion() {
    const val = inputEl.value.trim();
    if (!val) {
        return;
    }
    if (currentInputGating && currentInputGating.disabled) {
        // Defense in depth -- the send button/textarea should already be
        // disabled with sendTitle as the reason, so this path is only
        // reachable via a race between an indexing-state change and an
        // in-flight keypress. Never let it silently proceed as a normal query.
        return;
    }

    createBubble(val, 'user');
    inputEl.value = '';
    currentAssistantBlock = null;
    currentAssistantBubble = null;
    currentAssistantFooter = null;
    pendingConfidence = null;
    pendingGateStatus = null;
    currentCacheHitPairId = 0;
    currentAssistantIsCacheHit = false;
    currentFeedbackContext = null;
    setStreamingState(true);

    vscode.postMessage({ type: 'question', value: val });
}

function cancelStream() {
    vscode.postMessage({ type: 'cancel' });
    setStreamingState(false);
    appendCancellationNote();
}

inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !isStreaming) {
        e.preventDefault();
        sendQuestion();
    }
    if (e.key === 'Escape' && isStreaming) {
        e.preventDefault();
        cancelStream();
    }
});

sendBtn.addEventListener('click', () => {
    if (isStreaming) {
        cancelStream();
    } else {
        sendQuestion();
    }
});

resetBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'reset' });
    messagesDiv.innerHTML = '';
    setStreamingState(false);
});

sessionBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'getSessionInfo' });
});

healthToggleBtn.addEventListener('click', () => {
    healthContent.classList.toggle('open');
});

rebuildIndexBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'resync' });
});

viewIndexDetailsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'viewIndexDetails' });
});

document.addEventListener('click', (e) => {
    const btn = e.target.closest('.feedback-btn');
    if (!btn) return;
    const pairId = Number(btn.dataset.pairId);
    const positive = btn.dataset.positive === 'true';
    if (pairId > 0) {
        vscode.postMessage({ type: 'cacheFeedback', pairId, positive });
    }
    if (!positive && btn.dataset.sessionId && btn.dataset.queryId && btn.dataset.answerId) {
        vscode.postMessage({
            type: 'answerFeedback',
            positive,
            sessionId: btn.dataset.sessionId,
            queryId: btn.dataset.queryId,
            answerId: btn.dataset.answerId
        });
    }
    btn.disabled = true;
    btn.textContent = positive ? 'OK' : 'NO';
});

window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'confidence') {
        pendingConfidence = msg.data;
    } else if (msg.type === 'feedbackContext') {
        currentFeedbackContext = msg.data;
    } else if (msg.type === 'answerMetadata') {
        console.debug('RepoGuide answer metadata', msg.data);
    } else if (msg.type === 'answerProvenance') {
        console.debug('RepoGuide answer provenance', msg.data);
    } else if (msg.type === 'navigationResult') {
        hideThinkingIndicator();
        renderNavigationCard(msg.data);
    } else if (msg.type === 'progressUpdate') {
        updateProgressStatus(msg.data);
    } else if (msg.type === 'gateStatus') {
        pendingGateStatus = msg.data;
    } else if (msg.type === 'token') {
        hideThinkingIndicator();
        if (!currentAssistantBubble) {
            const block = createAssistantBlock();
            currentAssistantBlock = block.wrapper;
            currentAssistantBubble = block.bubble;
            currentAssistantFooter = block.footer;
            if (pendingConfidence) {
                renderConfidenceFooter(currentAssistantFooter, pendingConfidence);
            }
            renderGateStatusChip(currentAssistantFooter, pendingGateStatus);
            if (pendingGateStatus && pendingGateStatus.outcome === 'block') {
                currentAssistantBubble.classList.add('error');
            }
        }
        const tokenValue = typeof msg.value === 'string' ? msg.value : '';
        const trimmedToken = tokenValue.trim();
        if (trimmedToken.startsWith('{"__type":"navigationResult"')) {
            return;
        }
        if (trimmedToken.startsWith('{"__type":"feedbackContext"')) {
            try {
                currentFeedbackContext = JSON.parse(trimmedToken);
            } catch {
                currentFeedbackContext = null;
            }
            return;
        }
        if (trimmedToken.startsWith('{"__type":"answerMetadata"')) {
            try {
                const meta = JSON.parse(trimmedToken).metadata;
                if (meta.intents && meta.intents.includes('what_this_project_does')) {
                    const card = document.createElement('div');
                    card.style.border = '1px solid var(--rg-border)';
                    card.style.borderRadius = '6px';
                    card.style.padding = '8px 12px';
                    card.style.marginBottom = '12px';
                    card.style.backgroundColor = 'var(--vscode-editorWidget-background)';
                    card.innerHTML = `<div style="font-weight:600;margin-bottom:4px;color:var(--vscode-textLink-foreground);">Project overview</div>`;
                    currentAssistantBlock.insertBefore(card, currentAssistantBubble);
                }
            } catch (e) {
                console.error(e);
            }
            return;
        }
        if (trimmedToken.startsWith('{"__type":"answerProvenance"')) {
            try {
                const prov = JSON.parse(trimmedToken).provenance;
                if (!prov || !prov.claims || prov.claims.length === 0) return;
                
                const footer = document.createElement('div');
                footer.style.marginTop = '12px';
                footer.style.paddingTop = '8px';
                footer.style.borderTop = '1px dashed var(--rg-border)';
                footer.style.fontSize = '11px';
                
                const title = document.createElement('div');
                title.style.fontWeight = '600';
                title.style.marginBottom = '6px';
                title.style.color = 'var(--rg-muted)';
                title.textContent = 'Sources';
                footer.appendChild(title);
                
                const list = document.createElement('ul');
                list.style.margin = '0';
                list.style.paddingLeft = '16px';
                list.style.color = 'var(--vscode-descriptionForeground)';
                
                prov.claims.forEach(c => {
                    const li = document.createElement('li');
                    li.style.marginBottom = '4px';
                    
                    const files = (c.files || []).map(f => `<span class="meta-file" onclick="vscode.postMessage({ type: 'openFile', filePath: '${f.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' })">${f.split(/[/\\]/).pop()}</span>`).join(', ');
                    
                    li.innerHTML = `<strong>${c.source_type}</strong>: ${c.claim} ${files ? `(${files})` : ''}`;
                    if (c.warning) {
                        li.innerHTML += ` <span style="color:var(--vscode-testing-iconQueued); margin-left:4px;" title="${c.warning}">&#9888;</span>`;
                    }
                    list.appendChild(li);
                });
                
                footer.appendChild(list);
                currentAssistantBlock.appendChild(footer);
            } catch (e) {
                console.error(e);
            }
            return;
        }
        if (trimmedToken.startsWith('{"__type":"cacheHit"')) {
            try {
                const marker = JSON.parse(trimmedToken);
                currentCacheHitPairId = Number(marker.pairId) || 0;
                currentAssistantIsCacheHit = true;
            } catch {
                currentCacheHitPairId = 0;
                currentAssistantIsCacheHit = false;
            }
            return;
        }

        let currentText = (currentAssistantBubble.dataset.rawText || "") + tokenValue;

        // Handle [DEGRADED_PREAMBLE] intercept on raw text
        const degradedMatch = currentText.match(/\[DEGRADED_PREAMBLE\]([\s\S]*?)\[\/DEGRADED_PREAMBLE\]/);
        if (degradedMatch) {
            currentText = currentText.replace(degradedMatch[0], '').trimStart();
            
            if (!currentAssistantBlock.querySelector('.degraded-preamble')) {
                const degradedDiv = document.createElement('div');
                degradedDiv.className = 'degraded-preamble';
                degradedDiv.style.border = '1px solid var(--vscode-editorWarning-foreground, #cca700)';
                degradedDiv.style.borderLeft = '4px solid var(--vscode-editorWarning-foreground, #cca700)';
                degradedDiv.style.backgroundColor = 'rgba(204, 167, 0, 0.1)';
                degradedDiv.style.padding = '8px 12px';
                degradedDiv.style.marginBottom = '12px';
                degradedDiv.style.borderRadius = '4px';
                degradedDiv.style.fontSize = '12px';
                
                const header = document.createElement('div');
                header.style.fontWeight = 'bold';
                header.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
                header.style.marginBottom = '6px';
                header.innerHTML = '&#9888; Understanding degraded';
                
                const content = document.createElement('div');
                content.style.whiteSpace = 'pre-wrap';
                content.textContent = degradedMatch[1].trim();
                
                degradedDiv.appendChild(header);
                degradedDiv.appendChild(content);
                
                currentAssistantBlock.insertBefore(degradedDiv, currentAssistantBubble);
            }
        }

        // Strip AnswerGate's gap/low-coverage prepend sentence(s) off the front of
        // the answer and render them as a notice bar above the bubble, instead of
        // leaving them as indistinguishable plain prose glued to the model's own
        // text. Both can stack on one answer -- extractGatePrepends handles that.
        const { notices: gateNotices, remaining: textAfterPrepends } = RepoGuideGateStatus.extractGatePrepends(currentText);
        if (gateNotices.length > 0) {
            currentText = textAfterPrepends;
            if (!currentAssistantBlock.querySelector('.gate-notice-bar')) {
                currentAssistantBlock.insertBefore(createGateNoticeBar(gateNotices), currentAssistantBubble);
            }
        }

        currentAssistantBubble.dataset.rawText = currentText;
        currentAssistantBubble.innerHTML = '';

        const parts = currentText.split(/___CITE___(.*?)___CITE_END___/g);
        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 0) {
                appendTextWithAnnotationCallouts(currentAssistantBubble, parts[i]);
            } else {
                const [file, start, end, display] = parts[i].split('|');
                const link = document.createElement('a');
                link.href = '#';
                link.className = 'evidence-citation';
                link.textContent = display;
                link.title = `Open ${file} at line ${start}`;
                link.style.color = 'var(--vscode-textLink-foreground)';
                link.style.textDecoration = 'none';
                link.style.cursor = 'pointer';
                link.onclick = (e) => {
                    e.preventDefault();
                    vscode.postMessage({
                        command: 'openFile',
                        file: file,
                        line_start: parseInt(start, 10),
                        line_end: parseInt(end, 10)
                    });
                };
                currentAssistantBubble.appendChild(link);
            }
        }
        
        scrollToBottom();
    } else if (msg.type === 'done') {
        setStreamingState(false);
        appendCacheFeedbackRow();
        currentAssistantBlock = null;
        currentAssistantBubble = null;
        currentAssistantFooter = null;
        pendingConfidence = null;
        pendingGateStatus = null;
    } else if (msg.type === 'error') {
        setStreamingState(false);
        createBubble(`Error: ${msg.value}`, 'assistant error');
        currentAssistantBlock = null;
        currentAssistantBubble = null;
        currentAssistantFooter = null;
        pendingConfidence = null;
        pendingGateStatus = null;
        currentCacheHitPairId = 0;
        currentAssistantIsCacheHit = false;
        currentFeedbackContext = null;
    } else if (msg.type === 'cancelled') {
        setStreamingState(false);
        currentCacheHitPairId = 0;
        currentAssistantIsCacheHit = false;
        currentFeedbackContext = null;
    } else if (msg.type === 'addMessage') {
        currentAssistantBlock = null;
        currentAssistantBubble = null;
        currentAssistantFooter = null;
        currentCacheHitPairId = 0;
        currentAssistantIsCacheHit = false;
        currentFeedbackContext = null;
        createBubble(msg.value, msg.role);
    } else if (msg.type === 'systemMessage') {
        currentAssistantBlock = null;
        currentAssistantBubble = null;
        currentAssistantFooter = null;
        currentCacheHitPairId = 0;
        currentAssistantIsCacheHit = false;
        currentFeedbackContext = null;
        createBubble(msg.text || msg.value, 'system');
    } else if (msg.type === 'indexHealth') {
        populateIndexHealth(msg.data);
    }
});

vscode.postMessage({ type: 'ready' });
