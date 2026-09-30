// ── Firefox MV2 compatibility shim ──────────────────────────
var browser = (typeof browser !== "undefined") ? browser : chrome;

// ── Shared username helper ────────────────────────────────────
// Reads the logged-in user's display name from the page DOM.
// Used by recordSent() and the "Contact TSSW Team" panel.
function _getUsername() {
    const el = document.querySelector('.username.username-hide-on-mobile')
            || document.querySelector('.username');
    return el ? el.textContent.trim() : 'Unknown User';
}

// ===============================
// LIST STATUS API
// ===============================
const _WARMUP_API_BASE   = "http://203.161.41.70:5013";
let _listStatusCache      = {};
let _listStatusPoller     = null;
let _listStatusApiDown    = false;
let _stopAfterCurrentDrop = false;

async function getListStatus(listName) {
    try {
        const resp = await fetch(`${_WARMUP_API_BASE}/GetStatus`, {
            method : "POST",
            headers: { "Content-Type": "application/json" },
            body   : JSON.stringify({ List_name: listName })
        });
        return await resp.json(); // { list_name, sent, limit, remaining }
    } catch (e) {
        console.warn('[getListStatus] Error:', e);
        return null;
    }
}

async function recordSent(listName, howManySents) {
    try {
        const resp = await fetch(`${_WARMUP_API_BASE}/actually_out`, {
            method : "POST",
            headers: { "Content-Type": "application/json" },
            body   : JSON.stringify({ List_name: listName, how_many_sents: howManySents, added_by: _getUsername() })
        });
        const data = await resp.json();
        console.log('[recordSent] OK:', data); // { status, list_name, added, new_total }
        return data;
    } catch (e) {
        console.warn('[recordSent] Error:', e);
        return null;
    }
}

// ── Difference Between In and Out ────────────────────────────
// Called after each drop's queue read + Sheets save.
// If TOTAL IN > TOTAL OUT (i.e. some emails remain in queue),
// the difference is reported back to the API so the quota
// tracking stays accurate.
async function _reportInOutDifference(listName, amount) {
    try {
        const resp = await fetch(`${_WARMUP_API_BASE}/actually_out_after_in`, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({
                List_name     : listName,
                Add_Remaining : amount,
                added_by      : _getUsername()
            })
        });
        const data = await resp.json();
        console.log('[InOutDiff] OK:', data);
        return data;
    } catch (e) {
        console.warn('[InOutDiff] Error:', e);
        return null;
    }
}

// Refresh the list-status cache immediately after recordSent so that
// subsequent groups see accurate remaining values without waiting for the
// next poller tick (every 3 s).
async function _refreshListStatusCache(listName) {
    if (!listName) return;
    try {
        const freshStatus = await getListStatus(listName);
        if (!freshStatus) return;
        const _n = v => {
            if (typeof v === 'number') return v;
            const s = String(v).trim().toLowerCase();
            return (s === 'unlimited' || s === 'no limit' || s === 'no_limit') ? Infinity : (parseFloat(v) || 0);
        };
        _listStatusCache[listName] = {
            ...freshStatus,
            remaining: _n(freshStatus.remaining),
            limit    : _n(freshStatus.limit),
            sent     : typeof freshStatus.sent === 'number' ? freshStatus.sent : (parseFloat(freshStatus.sent) || 0)
        };
        updateListStatusCard();
    } catch (e) {
        console.warn('[_refreshListStatusCache] Error:', e);
    }
}

function startListStatusPoller(ispEntries) {
    stopListStatusPoller();
    if (!ispEntries || ispEntries.length === 0) return;
    const warmupNames = ispEntries
        .filter(e => e.mode === 'warmup' && e.value)
        .map(e => e.value);
    if (warmupNames.length === 0) return;
    async function poll() {
        for (const name of warmupNames) {
            const status = await getListStatus(name);
            if (status === null) {
                // API unreachable — warn and keep the process running
                if (!_listStatusApiDown) {
                    _listStatusApiDown = true;
                    console.warn('[listStatusPoller] GetStatus API unreachable — process continues.');
                }
                updateListStatusCard();
                continue;
            }
            // API responded — clear the warning if it was showing
            if (_listStatusApiDown) {
                _listStatusApiDown = false;
            }
            // Normalise unlimited/no-limit responses so all numeric comparisons work.
            // The API may return strings like 'unlimited' or 'no limit' for lists
            // that have no quota cap.  We replace them with Infinity so that every
            // check (> 0, <= 0, typeof === 'number') behaves correctly throughout.
            const _normalise = v => {
                if (typeof v === 'number') return v;
                const s = String(v).trim().toLowerCase();
                return (s === 'unlimited' || s === 'no limit' || s === 'no_limit') ? Infinity : (parseFloat(v) || 0);
            };
            _listStatusCache[name] = {
                ...status,
                remaining: _normalise(status.remaining),
                limit    : _normalise(status.limit),
                sent     : typeof status.sent === 'number' ? status.sent : (parseFloat(status.sent) || 0)
            };
        }
        updateListStatusCard();
    }
    poll(); // immediate first call
    _listStatusPoller = setInterval(poll, 3000);
}

function stopListStatusPoller() {
    if (_listStatusPoller) { clearInterval(_listStatusPoller); _listStatusPoller = null; }
    _listStatusCache = {};
    removeListStatusCard();
}

// ── Quota helper ─────────────────────────────────────────────
// Returns the cached remaining value for a warmup list name.
//   • Infinity  → unlimited (API said so)
//   • number>0  → quota remaining
//   • 0         → exhausted
//   • null      → not in cache yet (unknown — caller should wait)
function _getCachedRemaining(listName) {
    if (!listName) return Infinity;
    const s = _listStatusCache[listName];
    if (!s) return null; // cache miss — unknown
    return s.remaining;  // already normalised (number or Infinity)
}

// Wait up to maxWaitMs for a list's status to appear in the cache.
// Returns the remaining value once known, or Infinity on timeout
// (conservative: if we can't get data, don't block sending).
async function _waitForCacheReady(listName, maxWaitMs = 8000) {
    if (!listName) return Infinity;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const r = _getCachedRemaining(listName);
        if (r !== null) return r;
        await new Promise(res => setTimeout(res, 300));
    }
    // Timeout: do a direct API call as last resort
    console.warn(`[_waitForCacheReady] Cache miss timeout for "${listName}" — doing direct API call`);
    const status = await getListStatus(listName);
    if (status === null) return Infinity; // API unreachable — be conservative
    const _normalise = v => {
        if (typeof v === 'number') return v;
        const s = String(v).trim().toLowerCase();
        return (s === 'unlimited' || s === 'no limit' || s === 'no_limit') ? Infinity : (parseFloat(v) || 0);
    };
    const remaining = _normalise(status.remaining);
    _listStatusCache[listName] = {
        ...status,
        remaining,
        limit: _normalise(status.limit),
        sent : typeof status.sent === 'number' ? status.sent : (parseFloat(status.sent) || 0)
    };
    return remaining;
}

// ===============================
// LIST STATUS CARD
// ===============================

let _listStatusCardEl = null;

function updateListStatusCard() {
    const entries = Object.values(_listStatusCache);
    if (entries.length === 0 && !_listStatusApiDown) { removeListStatusCard(); return; }

    // Inject styles once
    if (!document.getElementById('__list_status_card_styles__')) {
        const st = document.createElement('style');
        st.id = '__list_status_card_styles__';
        st.textContent = `
            #__list_status_card__ {
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 999998;
                width: 300px;
                font-family: 'Segoe UI', system-ui, sans-serif;
                animation: __lsc_in__ 0.3s cubic-bezier(0.34,1.56,0.64,1);
            }
            @keyframes __lsc_in__ {
                from { opacity:0; transform:translateX(30px) scale(0.95); }
                to   { opacity:1; transform:translateX(0) scale(1); }
            }
            #__list_status_card__ .lsc-card {
                background: linear-gradient(135deg,#1a1f35 0%,#242b45 100%);
                border: 1px solid rgba(99,102,241,0.3);
                border-radius: 14px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.06) inset;
                overflow: hidden;
            }
            #__list_status_card__ .lsc-header {
                display: flex; align-items: center; gap: 8px;
                padding: 9px 13px;
                background: rgba(99,102,241,0.1);
                border-bottom: 1px solid rgba(99,102,241,0.18);
            }
            #__list_status_card__ .lsc-dot {
                width: 7px; height: 7px; border-radius: 50%;
                background: #818cf8; box-shadow: 0 0 5px #818cf8;
                animation: __lsc_pulse__ 2s infinite; flex-shrink: 0;
            }
            @keyframes __lsc_pulse__ { 0%,100%{opacity:1} 50%{opacity:0.3} }
            #__list_status_card__ .lsc-title {
                font-size: 10px; font-weight: 700;
                letter-spacing: 0.08em; text-transform: uppercase; color: #818cf8;
                flex: 1;
            }
            #__list_status_card__ .lsc-updated {
                font-size: 9px; color: #374151;
                letter-spacing: 0.03em;
            }
            #__list_status_card__ .lsc-body {
                padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
            }
            #__list_status_card__ .lsc-row {
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.06);
                border-radius: 9px; padding: 8px 10px;
            }
            #__list_status_card__ .lsc-name {
                font-size: 11px; font-weight: 700; color: #c4b5fd;
                font-family: 'Consolas', monospace;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                margin-bottom: 5px;
            }
            #__list_status_card__ .lsc-stats {
                display: flex; gap: 6px; flex-wrap: wrap;
            }
            #__list_status_card__ .lsc-stat {
                display: flex; flex-direction: column; align-items: center;
                flex: 1; min-width: 56px;
                background: rgba(255,255,255,0.04); border-radius: 7px; padding: 4px 6px;
            }
            #__list_status_card__ .lsc-stat-val {
                font-size: 13px; font-weight: 700;
                font-family: 'Consolas', monospace;
            }
            #__list_status_card__ .lsc-stat-lbl {
                font-size: 8px; font-weight: 600;
                text-transform: uppercase; letter-spacing: 0.06em; color: #4b5563;
                margin-top: 1px;
            }
            #__list_status_card__ .lsc-stat.remaining .lsc-stat-val { color: #4ade80; }
            #__list_status_card__ .lsc-stat.sent      .lsc-stat-val { color: #60a5fa; }
            #__list_status_card__ .lsc-stat.limit     .lsc-stat-val { color: #9ca3af; }
            #__list_status_card__ .lsc-stat.remaining.low .lsc-stat-val { color: #fbbf24; }
            #__list_status_card__ .lsc-stat.remaining.empty .lsc-stat-val { color: #f87171; }
            #__list_status_card__ .lsc-bar-wrap {
                margin-top: 5px; height: 3px;
                background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden;
            }
            #__list_status_card__ .lsc-bar {
                height: 100%; border-radius: 3px;
                transition: width 0.6s ease;
            }
            #__list_status_card__ .lsc-api-warn {
                margin: 4px 0 2px; padding: 7px 10px;
                background: rgba(251,191,36,0.10);
                border: 1px solid rgba(251,191,36,0.35);
                border-radius: 8px;
                color: #fbbf24;
                font-size: 10px;
                font-weight: 600;
                line-height: 1.4;
                text-align: center;
            }
        `;
        document.head.appendChild(st);
    }

    // Create the card element once
    if (!_listStatusCardEl || !_listStatusCardEl.isConnected) {
        const wrap = document.createElement('div');
        wrap.id = '__list_status_card__';
        wrap.innerHTML = `<div class="lsc-card">
            <div class="lsc-header">
                <div class="lsc-dot"></div>
                <span class="lsc-title">📋 List Quota</span>
                <span class="lsc-updated" id="__lsc_updated__"></span>
            </div>
            <div class="lsc-body" id="__lsc_body__"></div>
        </div>`;
        document.body.appendChild(wrap);
        _listStatusCardEl = wrap;
    }

    // Build rows
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('__lsc_updated__').textContent =
        `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const body = document.getElementById('__lsc_body__');
    if (!body) return;

    body.innerHTML = entries.map(s => {
        const remaining = s.remaining != null ? s.remaining : 0;
        const sent      = s.sent      != null ? s.sent      : 0;
        const limit     = s.limit     != null ? s.limit     : 0;

        // Infinity means unlimited — treat as always-full bar, always green
        const isUnlimited = !isFinite(remaining) || !isFinite(limit);
        const pct = isUnlimited ? 100 : (limit > 0 ? Math.min(100, Math.round((remaining / limit) * 100)) : 0);

        let remClass = 'remaining';
        if (!isUnlimited && remaining <= 0)               remClass = 'remaining empty';
        else if (!isUnlimited && remaining < limit * 0.15) remClass = 'remaining low';

        // Bar colour: green → amber → red (unlimited is always green)
        let barColor = '#4ade80';
        if (!isUnlimited && pct < 30) barColor = '#fbbf24';
        if (!isUnlimited && pct < 10) barColor = '#f87171';

        const fmtVal = v => isFinite(v) ? Number(v).toLocaleString('en-US') : '∞';

        const name = (s.list_name || '').length > 26
            ? (s.list_name || '').slice(0, 24) + '…'
            : (s.list_name || '');

        return `<div class="lsc-row">
            <div class="lsc-name" title="${s.list_name || ''}">${name}</div>
            <div class="lsc-stats">
                <div class="lsc-stat ${remClass}">
                    <span class="lsc-stat-val">${fmtVal(remaining)}</span>
                    <span class="lsc-stat-lbl">Remaining</span>
                </div>
                <div class="lsc-stat sent">
                    <span class="lsc-stat-val">${fmtVal(sent)}</span>
                    <span class="lsc-stat-lbl">Sent</span>
                </div>
                <div class="lsc-stat limit">
                    <span class="lsc-stat-val">${fmtVal(limit)}</span>
                    <span class="lsc-stat-lbl">Limit</span>
                </div>
            </div>
            <div class="lsc-bar-wrap">
                <div class="lsc-bar" style="width:${pct}%;background:${barColor};"></div>
            </div>
        </div>`;
    }).join('') + (_listStatusApiDown
        ? `<div class="lsc-api-warn">⚠️ GetListStatus of your warmup Lists is unreacheable, dont worry the process is continued...</div>`
        : '');
}

function removeListStatusCard() {
    if (_listStatusCardEl && _listStatusCardEl.isConnected) {
        _listStatusCardEl.remove();
    }
    _listStatusCardEl = null;
}

// ===============================
// KEEP-ALIVE SYSTEM
// ===============================
let _keepAliveInterval = null;
let _isProcessRunning  = false;

// ===============================
// LICENSE CHECK SYSTEM
// ===============================
const _LICENSE_API_URL      = 'http://203.161.41.70:5112/check-extension';
const _LICENSE_EXT_NAME     = 'IPs Warmup Extension';
let   _licenseExtVersion    = null; // resolved once at first check
let   _licenseCheckInterval = null;

// Read the version from popup.html's .ph-badge text (e.g. "v5" → "5")
async function _resolveExtensionVersion() {
    if (_licenseExtVersion !== null) return _licenseExtVersion;
    try {
        const url      = (typeof browser !== 'undefined' ? browser : chrome).runtime.getURL('popup.html');
        const resp     = await fetch(url);
        const html     = await resp.text();
        const match    = html.match(/class="ph-badge"[^>]*>\s*v?([\d.]+)\s*</i);
        if (match) {
            _licenseExtVersion = match[1];
            console.log(`[License] Detected version from popup.html: ${_licenseExtVersion}`);
        } else {
            _licenseExtVersion = 'unknown';
            console.warn('[License] Could not parse version from popup.html badge — using "unknown"');
        }
    } catch (err) {
        _licenseExtVersion = 'unknown';
        console.warn('[License] Failed to fetch popup.html for version:', err.message);
    }
    return _licenseExtVersion;
}

async function _checkLicenseOnce() {
    try {
        const version  = await _resolveExtensionVersion();
        const response = await fetch(_LICENSE_API_URL, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify({
                'Extension Name': _LICENSE_EXT_NAME,
                'Version'       : version,
                'mailer'        : _getUsername()
            })
        });
        const data = await response.json();
        console.log(`[License] Status: ${data.status} (v${version})`);
        return data.status === 'allow';
    } catch (err) {
        // Network error — allow to continue (don't stop on connectivity issues)
        console.warn('[License] Check failed (network error) — allowing:', err.message);
        return true;
    }
}

function startLicenseChecker() {
    if (_licenseCheckInterval) return;
    console.log('[License] Starting periodic license check (every 3s)…');
    _licenseCheckInterval = setInterval(async () => {
        if (!_isProcessRunning) return;
        const allowed = await _checkLicenseOnce();
        if (!allowed) {
            console.warn('[License] ⛔ Disallowed by server — stopping process immediately.');
            sendStatus('⛔ Extension license revoked — process stopped by server.');
            _handleStop();
            stopLicenseChecker();
        }
    }, 3000);
}

function stopLicenseChecker() {
    if (_licenseCheckInterval) {
        clearInterval(_licenseCheckInterval);
        _licenseCheckInterval = null;
    }
    console.log('[License] Checker stopped.');
}

// ===============================
// PROCESS CONTROL STATE
// ===============================
let _processState         = "running";
let _resumeResolvers      = [];
let _pausedCountdownSecs  = null;
let _pausedCountdownLabel = null;
let _pausedCountdownDrop  = null;
let _pausedCountdownTotal = null;
let _pauseStartedAt       = null;   // wall-clock ms when the process was paused



// -------------------------------------------------------
// Verify that the ISP Profile select shows the expected value.
// Retries up to maxRetries times if it has silently reverted
// (e.g. after a page reload triggered by Data Provider/Profile).
// -------------------------------------------------------
async function _verifyIspSelection(drop, entry, maxRetries = 3) {
    const kw = (entry && entry.value || '').trim();
    if (!kw) return true; // nothing to check

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await _waitForPageLoad(10000);

        const ispSel = document.getElementById('data_profile_isps');
        if (!ispSel) {
            sendStatus(`Drop ${drop}: ⚠️ ISP Profile select not found — retrying (${attempt}/${maxRetries})…`);
            await new Promise(r => setTimeout(r, 1500));
            continue;
        }

        const selectedOpt  = ispSel.options[ispSel.selectedIndex];
        const selectedText = (selectedOpt ? selectedOpt.text : '').trim();

        if (selectedText === kw) {
            sendStatus(`Drop ${drop}: ✅ ISP Profile confirmed: "${kw}"`);
            return true;
        }

        // Selection reverted — try to re-select
        sendStatus(
            `Drop ${drop}: ⚠️ ISP Profile mismatch — expected "${kw}", ` +
            `got "${selectedText}" (attempt ${attempt}/${maxRetries}) — re-selecting…`
        );

        const opt = Array.from(ispSel.options).find(o => o.text.trim() === kw);
        if (opt) {
            ispSel.value = opt.value;
            ispSel.dispatchEvent(new Event('change', { bubbles: true }));
            await _waitForPageLoad(15000);
            await _waitForListsCount(15000);
        } else {
            sendStatus(`Drop ${drop}: ⚠️ Option "${kw}" not in ISP Profile select yet (attempt ${attempt}/${maxRetries})…`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    // Final check after all retries
    const ispSel     = document.getElementById('data_profile_isps');
    const selectedOpt  = ispSel && ispSel.options[ispSel.selectedIndex];
    const selectedText = (selectedOpt ? selectedOpt.text : '').trim();
    if (selectedText !== kw) {
        sendStatus(`Drop ${drop}: ❌ ISP Profile still not "${kw}" after ${maxRetries} retries (current: "${selectedText}") — proceeding.`);
        return false;
    }
    return true;
}



// Notifiers woken up immediately on any state change (pause/stop/resume).
// Used by wait() to break out of sleep early.
let _stateChangeNotifiers = [];

function _notifyStateChange() {
    const notifiers = _stateChangeNotifiers.splice(0);
    notifiers.forEach(r => r());
}

class ProcessStoppedError extends Error {
    constructor() { super("Process stopped by user."); this.name = "ProcessStoppedError"; }
}

async function checkPauseOrStop() {
    if (_processState === "stopped") throw new ProcessStoppedError();
    if (_processState === "paused") {
        console.log('[Control] Process paused — waiting for resume…');
        await new Promise(resolve => _resumeResolvers.push(resolve));
        if (_processState === "stopped") throw new ProcessStoppedError();
    }
}

function startKeepAlive() {
    if (_keepAliveInterval) return;
    _isProcessRunning = true;
    console.log('[KeepAlive] Starting (setInterval only)...');
    _keepAliveInterval = setInterval(() => {
        if (!_isProcessRunning) return;
        browser.runtime.sendMessage({ type: "HEARTBEAT", timestamp: Date.now() })
            .catch(() => {});
    }, 5000);
    startLicenseChecker();
}

function stopKeepAlive() {
    _isProcessRunning = false;
    if (_keepAliveInterval) {
        clearInterval(_keepAliveInterval);
        _keepAliveInterval = null;
    }
    stopLicenseChecker();
    console.log('[KeepAlive] Stopped.');
}

// ===============================
// TELEGRAM REMOTE STOP LISTENER (via server SSE)
// ===============================
let _telegramSseSource = null;
const SSE_URL = 'http://203.161.41.70:6005/api/telegram-stop-listen';

function startTelegramListener(chatId) {
    if (_telegramSseSource) stopTelegramListener();
    if (!chatId) return;

    _telegramSseSource = new EventSource(SSE_URL);

    _telegramSseSource.addEventListener('stop', (event) => {
        try {
            const data = JSON.parse(event.data);
            // Only act if this stop command is for our chat
            if (String(data.chatId) === String(chatId)) {
                console.log('[Telegram SSE] Stop command received for our chat!');
                if (typeof _handleStop === 'function') {
                    _handleStop();
                    stopTelegramListener();
                }
            }
        } catch (e) {
            console.warn('[Telegram SSE] Failed to parse stop event:', e);
        }
    });

    _telegramSseSource.addEventListener('ping', () => {
        // Keepalive ping from server — no action needed
    });

    _telegramSseSource.onerror = (err) => {
        console.warn('[Telegram SSE] Connection error — will auto-reconnect:', err);
        // EventSource reconnects automatically on error
    };

    console.log('[Telegram SSE] Listening for stop commands on chat:', chatId);
}

function stopTelegramListener() {
    if (_telegramSseSource) {
        _telegramSseSource.close();
        _telegramSseSource = null;
        console.log('[Telegram SSE] Stopped listening.');
    }
}






document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _isProcessRunning) {
        console.log('[KeepAlive] Tab visible again — running safety cleanup…');
        _safeCleanupOrphanBackdrops();
    }
});

function _safeCleanupOrphanBackdrops() {
    const hasOpenModal =
        !!document.querySelector('.modal.in') ||
        !!document.querySelector('.modal.show');
    if (!hasOpenModal) {
        document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
        // Also hide any modal stuck at display:block without .in/.show
        document.querySelectorAll('.modal').forEach(el => {
            el.style.display = 'none';
            el.setAttribute('aria-hidden', 'true');
            el.removeAttribute('aria-modal');
        });
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('padding-right');
        document.body.style.removeProperty('overflow');
    }
}

function _forceCloseAllModals() {
    // Remove all backdrop overlays
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());

    // Hide any modal still visible (display:block) regardless of .in/.show class
    // These invisible full-page overlays block all clicks and keyboard input
    document.querySelectorAll('.modal').forEach(el => {
        el.classList.remove('in', 'show', 'fade');
        el.style.cssText += ';display:none!important;';
        el.setAttribute('aria-hidden', 'true');
        el.removeAttribute('aria-modal');
    });

    // Restore body to fully interactive state.
    // Bootstrap 3 sets overflow:hidden + padding-right both via .modal-open class
    // AND as inline styles. We must clear both the class and the inline styles.
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('padding-right');
    document.body.style.removeProperty('overflow');

    // Belt-and-suspenders: if Bootstrap's transition callback fires AFTER us and
    // re-applies overflow:hidden, the MutationObserver in _startBodyGuardian()
    // will catch and undo it within one animation frame.
}

// ── Body guardian ─────────────────────────────────────────────
// Watches <body> for Bootstrap silently re-adding overflow:hidden or
// .modal-open while no modal is actually open, and immediately undoes it.
let _bodyGuardian = null;

function _startBodyGuardian() {
    if (_bodyGuardian) return;
    _bodyGuardian = new MutationObserver(() => {
        // Only act when there is no genuinely open modal
        const hasOpenModal =
            !!document.querySelector('.modal.in') ||
            !!document.querySelector('.modal.show');
        if (hasOpenModal) return;

        let fixed = false;
        if (document.body.classList.contains('modal-open')) {
            document.body.classList.remove('modal-open');
            fixed = true;
        }
        if (document.body.style.overflow === 'hidden') {
            document.body.style.removeProperty('overflow');
            fixed = true;
        }
        if (fixed) {
            // Also sweep any leftover backdrops
            document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
        }
    });
    _bodyGuardian.observe(document.body, {
        attributes      : true,
        attributeFilter : ['class', 'style']
    });
}

function _stopBodyGuardian() {
    if (_bodyGuardian) {
        _bodyGuardian.disconnect();
        _bodyGuardian = null;
    }
}

// Robust modal-close helper: clicks the button, waits for the modal AND
// backdrop to vanish, then calls _forceCloseAllModals() as a safety net.
// Returns after everything is gone (or after maxWaitMs at the latest).
async function _closeModalAndWait(closeBtn, maxWaitMs = 10000) {
    if (closeBtn) closeBtn.click();

    const INTERVAL = 200;
    const deadline = Date.now() + maxWaitMs;
    await new Promise(resolve => {
        const t = setInterval(() => {
            const modal    = document.querySelector('.modal.in, .modal.show');
            const backdrop = document.querySelector('.modal-backdrop');
            if ((!modal && !backdrop) || Date.now() >= deadline) {
                clearInterval(t);
                resolve();
            }
        }, INTERVAL);
    });

    // Final sweep — clears anything Bootstrap left behind
    _forceCloseAllModals();

    // Give Bootstrap's own JS one tick to finish, then verify body is clean
    await new Promise(r => setTimeout(r, 120));
    _forceCloseAllModals();
}

// ===============================
// Utilities
// ===============================

// Interruptible wait — resolves early when paused or stopped so that
// checkPauseOrStop() can react at the next await point without waiting
// for the full delay to elapse.
function wait(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => {
        let timer = null;
        const notifier = () => { clearTimeout(timer); resolve(); };
        _stateChangeNotifiers.push(notifier);
        timer = setTimeout(() => {
            const idx = _stateChangeNotifiers.indexOf(notifier);
            if (idx !== -1) _stateChangeNotifiers.splice(idx, 1);
            resolve();
        }, ms);
    });
}

function randomDelay(min = 8000, max = 12000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Core interruptible poll loop ──────────────────────────────
// Polls `condition()` every `interval` ms, honouring pause/stop.
// Throws ProcessStoppedError instantly on stop.
// Blocks (without ticking elapsed) while paused, then resumes polling.
async function _pollUntil(condition, interval, timeout, timeoutMsg) {
    let elapsed = 0;
    while (true) {
        if (_processState === 'stopped') throw new ProcessStoppedError();
        if (_processState === 'paused') {
            // Block until resumed or stopped; don't tick elapsed while paused
            await new Promise(r => _resumeResolvers.push(r));
            if (_processState === 'stopped') throw new ProcessStoppedError();
            continue;
        }
        const result = condition();
        if (result) return result;
        elapsed += interval;
        if (elapsed >= timeout) throw new Error(timeoutMsg);
        await new Promise(resolve => {
            let t = null;
            const notifier = () => { clearTimeout(t); resolve(); };
            _stateChangeNotifiers.push(notifier);
            t = setTimeout(() => {
                const idx = _stateChangeNotifiers.indexOf(notifier);
                if (idx !== -1) _stateChangeNotifiers.splice(idx, 1);
                resolve();
            }, interval);
        });
    }
}

function waitForElement(selector, timeout = 30000) {
    return _pollUntil(
        () => document.querySelector(selector),
        300, timeout, "Element not found: " + selector
    );
}

function waitForElementVisible(selector, timeout = 30000) {
    return _pollUntil(
        () => { const el = document.querySelector(selector); return (el && !el.disabled) ? el : null; },
        300, timeout, "Element not found / disabled: " + selector
    );
}

function waitForCommandItem(text, timeout = 30000) {
    return _pollUntil(
        () => Array.from(document.querySelectorAll(".ms-list .ms-elem-selectable")).find(el => el.innerText.trim() === text) || null,
        300, timeout, "Command item not found: " + text
    );
}

function waitForChildElement(parent, selector, timeout = 30000) {
    return _pollUntil(
        () => parent.querySelector(selector),
        300, timeout, "Child element not found: " + selector
    );
}

function waitForModalReady(timeout = 90000) {
    return _pollUntil(
        () => {
            const modal = document.querySelector(".modal.in, .modal.show");
            if (!modal) return null;
            return (modal.querySelector(".modal-content") || modal.querySelector(".modal-body")) ? modal : null;
        },
        400, timeout, "Modal did not become ready."
    );
}

async function safeClickChild(parent, selector, extraWait = 400) {
    const el = await waitForChildElement(parent, selector);
    await wait(extraWait);
    el.click();
    return el;
}

async function executeRunCommandModal(label, repeatClicks = 1) {
    const form = await waitForElement('#run-cmd-form', 30000);

    const chk = await waitForElementVisible('#check-cmd-by-server', 15000);
    if (!chk.checked) { chk.click(); await wait(600); }

    const submitBtn = await waitForChildElement(form, "button[type='submit']", 15000);
    await wait(800);

    // First click
    submitBtn.click();
    if (label) sendStatus(`${label} — executing… (click 1/${repeatClicks})`);

    // Extra clicks spaced 5 s apart
    for (let i = 2; i <= repeatClicks; i++) {
        await wait(5000);
        submitBtn.click();
        if (label) sendStatus(`${label} — executing… (click ${i}/${repeatClicks})`);
    }

    const dismissBtn = await new Promise(resolve => {
        const TIMEOUT  = 90000;
        const INTERVAL = 500;
        let elapsed = 0;
        const timer = setInterval(() => {
            const btn =
                form.querySelector("button[data-dismiss='modal']") ||
                document.querySelector(".modal.in button[data-dismiss='modal']") ||
                document.querySelector(".modal.show button[data-dismiss='modal']");
            if (btn) { clearInterval(timer); resolve(btn); return; }
            elapsed += INTERVAL;
            if (elapsed >= TIMEOUT) { clearInterval(timer); resolve(null); }
        }, INTERVAL);
    });

    await wait(6000);

    await _closeModalAndWait(dismissBtn, 10000);
    await wait(800);
}

// ── DELETE: exactly 2 clicks with 20 s between them ──────────
async function executeDeleteTwoClicks(drop, displayTotal) {
    const form = await waitForElement('#run-cmd-form', 30000);

    const chk = await waitForElementVisible('#check-cmd-by-server', 15000);
    if (!chk.checked) { chk.click(); await wait(600); }

    const submitBtn = await waitForChildElement(form, "button[type='submit']", 15000);
    await wait(800);

    // Click 1
    submitBtn.click();
    sendStatus(`Drop ${drop}: DELETE — click 1/2…`);
    updateMainCard(drop, displayTotal, `Running <strong>DELETE</strong> — click <strong>1/2</strong>…`, 'red', '🗑️');

    // Wait 20 seconds between the two clicks
    await wait(20000);

    // Click 2
    submitBtn.click();
    sendStatus(`Drop ${drop}: DELETE — click 2/2…`);
    updateMainCard(drop, displayTotal, `Running <strong>DELETE</strong> — click <strong>2/2</strong>…`, 'red', '🗑️');

    const dismissBtn = await new Promise(resolve => {
        const TIMEOUT  = 90000;
        const INTERVAL = 500;
        let elapsed = 0;
        const timer = setInterval(() => {
            const btn =
                form.querySelector("button[data-dismiss='modal']") ||
                document.querySelector(".modal.in button[data-dismiss='modal']") ||
                document.querySelector(".modal.show button[data-dismiss='modal']");
            if (btn) { clearInterval(timer); resolve(btn); return; }
            elapsed += INTERVAL;
            if (elapsed >= TIMEOUT) { clearInterval(timer); resolve(null); }
        }, INTERVAL);
    });

    await wait(6000);
    await _closeModalAndWait(dismissBtn, 10000);
    await wait(800);
}

function sendStatus(text) {
    browser.runtime.sendMessage({ type: "STATUS_UPDATE", text });
}

function bgMessage(msg) {
    return new Promise(resolve => browser.runtime.sendMessage(msg, resolve));
}

function fmtTime(s) {
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + 'h ' + String(m).padStart(2,'0') + 'm ' + String(sec).padStart(2,'0') + 's';
    if (m > 0) return m + 'm ' + String(sec).padStart(2,'0') + 's';
    return sec + 's';
}

let _deployTabId           = null;
let _useMultiMonitorCmds   = false;
let _rateCheckIps          = 0;
let _telegramChatId        = null;
let _effectiveProcessType = null;
let _ipServerMap      = {};

// ── Stop Deferred IPs (tolerance-fail skip for exactly one drop) ────────────
let _deferredIpsEnabled    = false;
let _deferredUntilDrop     = {}; // { ip -> dropNumber it must be skipped for }
let _deferredMustComplete  = false; // "Deferred IPs must Complete all drops" option
let _ipDropCount           = {};    // { ip -> number of drops it participated in }

// ===============================
// OVERLAY CARD UI
// ===============================

let _overlayEl      = null;
let _countdownTimer = null;
let _mainCard       = null;

function ensureOverlay() {
    if (document.getElementById('__deploy_overlay__')) {
        _overlayEl = document.getElementById('__deploy_overlay__');
        return;
    }
    const style = document.createElement('style');
    style.id = '__deploy_styles__';
    style.textContent = `
        #__deploy_overlay__ {
            position:fixed; top:20px; right:20px; z-index:999999; width:320px;
            font-family:'Segoe UI',system-ui,sans-serif;
            display:flex; flex-direction:column; gap:10px; pointer-events:none;
        }
        .deploy-card {
            background:linear-gradient(135deg,#1a1f35 0%,#242b45 100%);
            border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:14px 16px;
            box-shadow:0 8px 32px rgba(0,0,0,0.45),0 1px 0 rgba(255,255,255,0.06) inset;
            color:#e8eaf0; pointer-events:all;
            animation:deployCardIn 0.3s cubic-bezier(0.34,1.56,0.64,1);
        }
        @keyframes deployCardIn {
            from{opacity:0;transform:translateX(40px) scale(0.95);}
            to  {opacity:1;transform:translateX(0)    scale(1);}
        }
        .deploy-card.fade-out{animation:deployCardOut 0.35s ease forwards;}
        @keyframes deployCardOut{to{opacity:0;transform:translateX(40px) scale(0.93);}}
        .deploy-card .dc-header{display:flex;align-items:center;gap:8px;margin-bottom:9px;}
        .deploy-card .dc-icon{
            width:28px;height:28px;border-radius:8px;
            display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;
        }
        .deploy-card .dc-icon.blue  {background:rgba(59,130,246,0.22);}
        .deploy-card .dc-icon.green {background:rgba(34,197,94,0.2);}
        .deploy-card .dc-icon.amber {background:rgba(245,158,11,0.2);}
        .deploy-card .dc-icon.red   {background:rgba(239,68,68,0.2);}
        .deploy-card .dc-icon.purple{background:rgba(168,85,247,0.2);}
        .deploy-card .dc-title{
            font-size:11px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:#94a3b8;
        }
        .deploy-card .dc-badge{
            margin-left:auto;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;
            background:rgba(255,255,255,0.08);color:#94a3b8;letter-spacing:0.04em;white-space:nowrap;
        }
        .deploy-card .dc-body{font-size:13px;color:#cbd5e1;line-height:1.55;}
        .deploy-card .dc-body strong{color:#f1f5f9;}
        .deploy-card .dc-progress-wrap{
            margin-top:10px;background:rgba(255,255,255,0.06);border-radius:6px;overflow:hidden;height:5px;
        }
        .deploy-card .dc-progress-bar{height:100%;border-radius:6px;transition:width 0.6s ease;}
        .deploy-card .dc-progress-bar.blue  {background:linear-gradient(90deg,#3b82f6,#60a5fa);}
        .deploy-card .dc-progress-bar.green {background:linear-gradient(90deg,#22c55e,#4ade80);}
        .deploy-card .dc-progress-bar.amber {background:linear-gradient(90deg,#f59e0b,#fbbf24);}
        .deploy-card .dc-progress-bar.purple{background:linear-gradient(90deg,#a855f7,#c084fc);}
        .deploy-card .dc-progress-bar.red   {background:linear-gradient(90deg,#ef4444,#f87171);}

        /* ── Process control bar ───────────────────────────────── */
        #__deploy_ctrl_bar__ {
            display:flex; gap:8px;
            background:linear-gradient(135deg,#1a1f35 0%,#242b45 100%);
            border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:10px 14px;
            box-shadow:0 8px 32px rgba(0,0,0,0.45);
            pointer-events:all;
            animation:deployCardIn 0.3s cubic-bezier(0.34,1.56,0.64,1);
        }
        #__deploy_ctrl_bar__ button {
            flex:1; padding:8px 6px; border:none; border-radius:9px;
            font-size:11px; font-weight:700; cursor:pointer; letter-spacing:0.04em;
            transition:opacity 0.15s, transform 0.1s;
            font-family:'Segoe UI',system-ui,sans-serif;
        }
        #__deploy_ctrl_bar__ button:hover  { opacity:0.85; transform:translateY(-1px); }
        #__deploy_ctrl_bar__ button:active { transform:translateY(0); }
        #__ctrl_pause_btn__ {
            background:linear-gradient(135deg,#f59e0b,#fbbf24);
            color:#1a1000;
            box-shadow:0 3px 10px rgba(245,158,11,0.35);
        }
        #__ctrl_resume_btn__ {
            background:linear-gradient(135deg,#22c55e,#4ade80);
            color:#001a00;
            box-shadow:0 3px 10px rgba(34,197,94,0.35);
            display:none;
        }
        #__ctrl_stop_btn__ {
            background:linear-gradient(135deg,#ef4444,#f87171);
            color:#fff;
            box-shadow:0 3px 10px rgba(239,68,68,0.35);
        }
        #__deploy_ctrl_bar__.paused #__ctrl_pause_btn__  { display:none; }
        #__deploy_ctrl_bar__.paused #__ctrl_resume_btn__ { display:block; }
        #__deploy_pause_banner__ {
            display:none;
            background:linear-gradient(135deg,#1a1f35,#242b45);
            border:1px solid rgba(245,158,11,0.4);
            border-radius:14px; padding:12px 15px;
            box-shadow:0 8px 32px rgba(0,0,0,0.45);
            pointer-events:all;
            animation:deployCardIn 0.3s cubic-bezier(0.34,1.56,0.64,1);
        }
        #__deploy_pause_banner__.visible { display:block; }
        #__deploy_pause_banner__ .pb-title {
            font-size:11px; font-weight:700; letter-spacing:0.07em;
            text-transform:uppercase; color:#fbbf24; margin-bottom:5px;
        }
        #__deploy_pause_banner__ .pb-body {
            font-size:12px; color:#cbd5e1; line-height:1.5;
        }
        #__deploy_pause_banner__ .pb-body strong { color:#f1f5f9; }
    `;
    if (!document.getElementById('__deploy_styles__')) document.head.appendChild(style);
    const overlay = document.createElement('div');
    overlay.id = '__deploy_overlay__';
    document.body.appendChild(overlay);
    _overlayEl = overlay;
}

function getOverlay() { ensureOverlay(); return _overlayEl; }

function ensureControlBar() {
    if (document.getElementById('__deploy_ctrl_bar__')) return;
    const overlay = getOverlay();

    const banner = document.createElement('div');
    banner.id = '__deploy_pause_banner__';
    banner.innerHTML = `<div class="pb-title">⏸ Process Paused</div><div class="pb-body" id="__pb_body__">Waiting for resume…</div>`;
    overlay.appendChild(banner);

    const bar = document.createElement('div');
    bar.id = '__deploy_ctrl_bar__';
    bar.innerHTML = `
        <button id="__ctrl_pause_btn__">⏸&nbsp; Pause</button>
        <button id="__ctrl_resume_btn__">▶&nbsp; Resume</button>
        <button id="__ctrl_stop_btn__">🛑&nbsp; Stop</button>`;
    overlay.appendChild(bar);

    document.getElementById('__ctrl_pause_btn__').addEventListener('click', () => _handlePause());
    document.getElementById('__ctrl_resume_btn__').addEventListener('click', () => _handleResume());
    document.getElementById('__ctrl_stop_btn__').addEventListener('click', () => _handleStop());
}

function _setControlBarPaused(isPaused) {
    const bar = document.getElementById('__deploy_ctrl_bar__');
    if (!bar) return;
    if (isPaused) bar.classList.add('paused');
    else          bar.classList.remove('paused');
}

function _showPauseBanner(bodyHTML) {
    const banner = document.getElementById('__deploy_pause_banner__');
    if (!banner) return;
    banner.classList.add('visible');
    const body = document.getElementById('__pb_body__');
    if (body) body.innerHTML = bodyHTML;
}

function _hidePauseBanner() {
    const banner = document.getElementById('__deploy_pause_banner__');
    if (banner) banner.classList.remove('visible');
}

function removeControlBar() {
    const bar    = document.getElementById('__deploy_ctrl_bar__');
    const banner = document.getElementById('__deploy_pause_banner__');
    if (bar)    { bar.classList.add('fade-out');    setTimeout(() => bar.remove(),    380); }
    if (banner) { banner.classList.add('fade-out'); setTimeout(() => banner.remove(), 380); }
}

async function _sendTelegramControlMsg(action, extra = '') {
    if (!_telegramChatId) return;
    const now  = new Date();
    const pad  = n => String(n).padStart(2, '0');
    const dt   = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const div  = '='.repeat(38);

    let icon, title;
    if      (action === 'paused')  { icon = '⏸'; title = 'PROCESS PAUSED';  }
    else if (action === 'resumed') { icon = '▶️'; title = 'PROCESS RESUMED'; }
    else                           { icon = '🛑'; title = 'PROCESS STOPPED'; }

    const lines = [
        `${icon}  WARMUP CONTROLLER — ${title}`,
        div,
        `Date / Time  :  ${dt}`,
        div,
        extra,
        div,
        `This message was sent automatically by the Warmup Extension.`,
    ].filter(l => l !== '');

    const text = '```\n' + lines.join('\n') + '\n```';
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify({ chat_id: _telegramChatId, text, parse_mode: 'Markdown' })
        });
    } catch(e) { console.warn('[Control] Telegram control msg failed:', e); }
}

async function _handlePause() {
    if (_processState !== "running") return;
    _processState   = "paused";
    _pauseStartedAt = Date.now();
    _setControlBarPaused(true);

    // Wake all sleeping wait() / _pollUntil() calls immediately so they
    // can enter the paused-block inside checkPauseOrStop / _pollUntil.
    _notifyStateChange();

    // _pausedCountdownSecs is frozen by pauseAwareWait at the moment of pause.
    const remainSecs = _pausedCountdownSecs;
    let bannerBody = `The process will pause at the next safe checkpoint.<br>`;
    if (remainSecs !== null) {
        bannerBody += `Countdown frozen — <strong>${fmtTime(remainSecs)}</strong> remaining. Time is paused.`;
    }
    _showPauseBanner(bannerBody);

    sendStatus('⏸ Pausing at next checkpoint…');
    await _sendTelegramControlMsg('paused',
        `The warmup process has been PAUSED by the operator.\n` +
        (remainSecs !== null
            ? `Countdown is FROZEN — ${fmtTime(remainSecs)} remaining when paused. Time will not advance until resumed.`
            : `The process will pause at the next safe checkpoint.`)
    );
}

async function _handleResume() {
    if (_processState !== "paused") return;

    // ── Extend the shared deadline BEFORE waking up waiters ──────────────
    // This eliminates the race where the countdown card timer ticks between
    // the resolver firing and pauseAwareWait extending _pauseAwareDeadline.
    if (_pauseStartedAt !== null && _pauseAwareDeadline !== null) {
        const pausedDuration = Date.now() - _pauseStartedAt;
        _pauseAwareDeadline += pausedDuration;
    }
    _pauseStartedAt = null;

    _processState = "running";
    _setControlBarPaused(false);
    _hidePauseBanner();

    // _pausedCountdownSecs was frozen at pause time — it is the exact remaining time
    // that will be restored (the deadline was extended by the full paused duration).
    let extraInfo = '';
    if (_pausedCountdownSecs !== null) {
        const remainNow = _pausedCountdownSecs;
        if (remainNow > 0) {
            const resumeAt  = new Date(Date.now() + remainNow * 1000);
            const pad       = n => String(n).padStart(2,'0');
            const resumeStr = `${pad(resumeAt.getHours())}:${pad(resumeAt.getMinutes())}:${pad(resumeAt.getSeconds())}`;
            extraInfo = `Countdown resumes with ${fmtTime(remainNow)} still left (time was frozen).\nNext drop step expected around: ${resumeStr}`;
        } else {
            extraInfo = `Countdown already expired — next task will start immediately.`;
        }
    }

    sendStatus('▶️ Process resumed.');
    await _sendTelegramControlMsg('resumed',
        `The warmup process has been RESUMED by the operator.\n` + extraInfo
    );

    const resolvers = _resumeResolvers.splice(0);
    resolvers.forEach(r => r());
    _pausedCountdownSecs  = null;
    _pausedCountdownLabel = null;
}

async function _handleStop() {
    if (_processState === "stopped") return;
    const wasPaused = _processState === "paused";
    _processState    = "stopped";
    _pauseStartedAt  = null;
    _setControlBarPaused(false);
    _hidePauseBanner();

    // Wake ALL sleeping calls (wait, _pollUntil, pauseAwareWait) immediately.
    _notifyStateChange();

    stopTelegramListener();

    sendStatus('🛑 Process stopped by user.');
    await _sendTelegramControlMsg('stopped',
        `The warmup process has been STOPPED by the operator.\n` +
        (wasPaused ? `(Was paused when stop was triggered.)` : `(Was running when stop was triggered.)`)
    );

    const resolvers = _resumeResolvers.splice(0);
    resolvers.forEach(r => r());
    _pausedCountdownSecs = null;
}

function showMainCard(drop, displayTotal, stepHTML, color = 'blue', icon = '🚀') {
    const overlay = getOverlay();
    if (_mainCard && _mainCard.isConnected) {
        _mainCard.querySelector('.dc-badge').textContent = `DROP ${drop}/${displayTotal}`;
        _mainCard.querySelector('.dc-body').innerHTML = stepHTML;
        const iconEl = _mainCard.querySelector('.dc-icon');
        iconEl.className = `dc-icon ${color}`;
        iconEl.textContent = icon;
        const bar = _mainCard.querySelector('.dc-progress-bar');
        if (bar) bar.className = `dc-progress-bar ${color}`;
        return;
    }
    const card = document.createElement('div');
    card.className = 'deploy-card';
    card.id = '__deploy_main__';
    card.innerHTML = `
        <div class="dc-header">
            <div class="dc-icon ${color}">${icon}</div>
            <div class="dc-title">Warmup Controller</div>
            <div class="dc-badge">DROP ${drop}/${displayTotal}</div>
        </div>
        <div class="dc-body">${stepHTML}</div>
        <div class="dc-progress-wrap">
            <div class="dc-progress-bar ${color}" style="width:100%"></div>
        </div>`;
    overlay.insertBefore(card, overlay.firstChild);
    _mainCard = card;
}

function updateMainCard(drop, displayTotal, stepHTML, color = 'blue', icon = '🚀') {
    showMainCard(drop, displayTotal, stepHTML, color, icon);
}

function removeMainCard() {
    if (_mainCard && _mainCard.isConnected) {
        _mainCard.classList.add('fade-out');
        setTimeout(() => { if (_mainCard) { _mainCard.remove(); _mainCard = null; } }, 380);
    }
}

function showCountdownCard(seconds, drop, displayTotal, label = 'Waiting…') {
    const overlay = getOverlay();
    const old = document.getElementById('__deploy_countdown__');
    if (old) old.remove();
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }

    const card = document.createElement('div');
    card.className = 'deploy-card';
    card.id = '__deploy_countdown__';
    card.innerHTML = `
        <div class="dc-header">
            <div class="dc-icon amber">⏱️</div>
            <div class="dc-title">${label}</div>
            <div class="dc-badge">DROP ${drop}/${displayTotal}</div>
        </div>
        <div class="dc-body">Time remaining: <strong><span id="__cd_secs__">${fmtTime(seconds)}</span></strong></div>
        <div class="dc-progress-wrap">
            <div class="dc-progress-bar amber" id="__cd_bar__" style="width:100%"></div>
        </div>`;
    overlay.appendChild(card);

    const total = seconds;
    // localDeadline tracks the wall-clock finish time for THIS card.
    // It is extended by the paused duration each time the process resumes,
    // keeping the visual countdown in sync with pauseAwareWait.
    let localDeadline = Date.now() + seconds * 1000;
    let frozenRemaining = null;  // non-null only while paused

    _countdownTimer = setInterval(() => {
        // If pauseAwareWait extended its shared deadline (on resume), sync ours.
        if (_pauseAwareDeadline !== null) {
            localDeadline = _pauseAwareDeadline;
        }

        let remaining;
        if (_processState === 'paused') {
            // Freeze the display: capture once, then keep showing it.
            if (frozenRemaining === null) {
                frozenRemaining = Math.max(0, Math.ceil((localDeadline - Date.now()) / 1000));
            }
            remaining = frozenRemaining;
        } else {
            frozenRemaining = null;  // reset when running
            remaining = Math.max(0, Math.ceil((localDeadline - Date.now()) / 1000));
        }

        const secsEl = document.getElementById('__cd_secs__');
        const barEl  = document.getElementById('__cd_bar__');
        if (secsEl) secsEl.textContent = fmtTime(remaining);
        if (barEl)  barEl.style.width  = ((remaining / total) * 100) + '%';

        if (remaining <= 0 && _processState !== 'paused') {
            clearInterval(_countdownTimer);
            _countdownTimer = null;
            card.classList.add('fade-out');
            setTimeout(() => card.remove(), 380);
        }
    }, 1000);
}

function removeCountdownCard() {
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
    const card = document.getElementById('__deploy_countdown__');
    if (card) { card.classList.add('fade-out'); setTimeout(() => card.remove(), 380); }
}

function showFinalCard(allIps, ipState, ipServerMap = {}) {
    ensureOverlay(); removeMainCard(); removeCountdownCard();
    const overlay = getOverlay();
    const old = document.getElementById('__deploy_final__');
    if (old) old.remove();

    const rows = allIps.map(ip => {
        const state  = ipState[ip];
        const server = ipServerMap[ip] ? `<span style="color:#6b7280;font-size:10px;">[${ipServerMap[ip]}]</span> ` : '';
        return `<div style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.04);border-radius:7px;padding:6px 9px;font-size:12px;">
            <span style="color:#93c5fd;font-family:monospace;font-weight:600;flex:1">${server}${ip}</span>
            <span style="color:#4ade80;font-weight:700">${state.totalSent.toLocaleString()}</span>
            <span style="color:#64748b;font-size:11px">target:${state.target.toLocaleString()}</span>
        </div>`;
    }).join('');

    const card = document.createElement('div');
    card.className = 'deploy-card';
    card.id = '__deploy_final__';
    card.innerHTML = `
        <div class="dc-header">
            <div class="dc-icon green">🏁</div>
            <div class="dc-title">All Drops Complete</div>
            <div class="dc-badge">DONE</div>
        </div>
        <div class="dc-body" style="margin-bottom:8px;">Total emails sent per IP:</div>
        <div style="display:flex;flex-direction:column;gap:5px;">${rows}</div>
        <div style="height:1px;background:rgba(255,255,255,0.07);margin:9px 0 8px;"></div>
        <div class="dc-body" style="font-size:11px;color:#64748b;">Click to dismiss</div>`;
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => { card.classList.add('fade-out'); setTimeout(() => card.remove(), 380); });
    overlay.appendChild(card);
}

// ===============================
// LIVE STATUS PANEL (bottom-left)
// ===============================

let _livePanel = null;
let _livePanelRemoved = false; // true when user dismissed the panel; resets on new queue data

function ensureLivePanel() {
    if (document.getElementById('__deploy_live_panel__')) {
        _livePanel = document.getElementById('__deploy_live_panel__');
        return;
    }
    const style = document.createElement('style');
    style.id = '__deploy_live_styles__';
    style.textContent = `
        #__deploy_live_panel__ {
            position:fixed;bottom:20px;left:20px;z-index:999998;width:360px;
            background:linear-gradient(160deg,#0a0f1e 0%,#111827 100%);
            border:1px solid rgba(99,102,241,0.3);border-radius:16px;
            font-family:'Consolas','Courier New',monospace;
            box-shadow:0 12px 40px rgba(0,0,0,0.65),0 0 0 1px rgba(255,255,255,0.04) inset;
            overflow:hidden;
            animation:lpSlideIn 0.3s cubic-bezier(0.34,1.56,0.64,1);
        }
        @keyframes lpSlideIn{from{opacity:0;transform:translateX(-30px) scale(0.95);}to{opacity:1;transform:translateX(0) scale(1);}}
        #__deploy_live_panel__.lp-removing{animation:lpSlideOut 0.3s ease forwards;}
        @keyframes lpSlideOut{to{opacity:0;transform:translateX(-30px) scale(0.93);}}
        #__deploy_live_panel__ .lp-header{
            display:flex;align-items:center;gap:8px;padding:11px 15px;
            background:rgba(99,102,241,0.08);border-bottom:1px solid rgba(99,102,241,0.18);
        }
        #__deploy_live_panel__ .lp-dot{
            width:8px;height:8px;border-radius:50%;
            background:#6366f1;box-shadow:0 0 6px #6366f1;
            animation:lp-pulse 2s infinite;flex-shrink:0;
        }
        #__deploy_live_panel__ .lp-dot.done{background:#4ade80;box-shadow:0 0 6px #4ade80;animation:none;}
        @keyframes lp-pulse{0%,100%{opacity:1}50%{opacity:0.35}}
        #__deploy_live_panel__ .lp-title{
            font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#818cf8;
        }
        #__deploy_live_panel__ .lp-drop{
            margin-left:auto;font-size:10px;font-weight:700;color:#fbbf24;
            background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.2);
            padding:2px 9px;border-radius:20px;letter-spacing:0.04em;
        }
        #__deploy_live_panel__ .lp-offset-row{
            display:flex;align-items:center;gap:6px;padding:7px 15px;
            background:rgba(255,255,255,0.02);border-bottom:1px solid rgba(255,255,255,0.05);
        }
        #__deploy_live_panel__ .lp-tag{font-size:9px;color:#374151;text-transform:uppercase;letter-spacing:0.06em;}
        #__deploy_live_panel__ .lp-val{color:#38bdf8;font-weight:700;font-size:13px;}
        #__deploy_live_panel__ .lp-ip-list{
            padding:8px 10px;display:flex;flex-direction:column;gap:5px;max-height:280px;overflow-y:auto;
        }
        #__deploy_live_panel__ .lp-ip-list::-webkit-scrollbar{width:4px;}
        #__deploy_live_panel__ .lp-ip-list::-webkit-scrollbar-thumb{background:rgba(99,102,241,0.3);border-radius:4px;}
        #__deploy_live_panel__ .lp-ip-row{
            display:flex;align-items:center;gap:8px;padding:8px 11px;
            background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);border-radius:9px;
        }
        #__deploy_live_panel__ .lp-ip{color:#7dd3fc;font-size:12px;flex:1;}
        #__deploy_live_panel__ .lp-rcpt-badge{
            font-size:10px;padding:2px 7px;border-radius:20px;white-space:nowrap;font-weight:600;
        }
        #__deploy_live_panel__ .lp-rcpt-badge.queue{background:rgba(251,191,36,0.1);color:#fbbf24;border:1px solid rgba(251,191,36,0.2);}
        #__deploy_live_panel__ .lp-rcpt-badge.done {background:rgba(74,222,128,0.1);color:#4ade80;border:1px solid rgba(74,222,128,0.2);}
        #__deploy_live_panel__ .lp-rcpt-badge.na   {background:rgba(248,113,113,0.1);color:#f87171;border:1px solid rgba(248,113,113,0.2);}
        #__deploy_live_panel__ .lp-sent{color:#a5f3fc;font-weight:700;font-size:13px;white-space:nowrap;min-width:64px;text-align:right;}
        #__deploy_live_panel__ .lp-footer{
            padding:10px 12px;border-top:1px solid rgba(255,255,255,0.05);display:flex;flex-direction:column;gap:7px;
        }
        #__deploy_live_panel__ .lp-done-label{
            text-align:center;font-size:11px;font-weight:700;color:#4ade80;letter-spacing:0.07em;text-transform:uppercase;
        }
        #__deploy_live_panel__ .lp-copy-btn{
            width:100%;padding:9px;
            background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);
            color:white;border:none;border-radius:9px;font-size:12px;font-weight:700;
            cursor:pointer;letter-spacing:0.04em;transition:opacity 0.15s,transform 0.1s;
            box-shadow:0 4px 12px rgba(99,102,241,0.35);font-family:'Segoe UI',sans-serif;
        }
        #__deploy_live_panel__ .lp-copy-btn:hover{opacity:0.88;transform:translateY(-1px);}
        #__deploy_live_panel__ .lp-copy-btn.copied{background:linear-gradient(135deg,#059669,#10b981);}
        #__lp_dismiss_btn__ {
            background:none;border:none;cursor:pointer;
            color:#64748b;font-size:15px;padding:0 0 0 6px;line-height:1;
            transition:color 0.15s;flex-shrink:0;
        }
        #__lp_dismiss_btn__:hover{color:#f87171;}
    `;
    if (!document.getElementById('__deploy_live_styles__')) document.head.appendChild(style);
    const panel = document.createElement('div');
    panel.id = '__deploy_live_panel__';
    document.body.appendChild(panel);
    _livePanel = panel;
}

function _removeLivePanel() {
    if (_livePanel && _livePanel.isConnected) {
        _livePanel.classList.add('lp-removing');
        setTimeout(() => {
            if (_livePanel) { _livePanel.remove(); _livePanel = null; }
        }, 320);
    } else {
        _livePanel = null;
    }
    _livePanelRemoved = true;
}

function updateLivePanel(ipState, allIps, drop, displayTotal, currentOffset, queueResults, isDone = false, ipServerMap = {}, downServers = []) {
    // ── Queue data arriving from MultiMonitor → re-show if the user had dismissed ──
    const hasNewQueueData = queueResults !== null;
    if (hasNewQueueData && _livePanelRemoved) {
        _livePanelRemoved = false;
        // Remove any stale DOM node so ensureLivePanel() creates a fresh one
        const stale = document.getElementById('__deploy_live_panel__');
        if (stale) stale.remove();
        _livePanel = null;
    }

    // If the user dismissed the panel and no new queue data arrived, do nothing
    if (_livePanelRemoved) return;

    ensureLivePanel();

    const ipRows = allIps.map(ip => {
        const state      = ipState[ip];
        const serverName = ipServerMap[ip] || '';
        const isDown     = queueResults !== null && queueResults[ip] === -2;
        let badge = '';
        if (queueResults !== null) {
            const rcpt = queueResults[ip];
            if (isDown)                              badge = '<span class="lp-rcpt-badge na">⛔️ DOWN</span>';
            else if (rcpt === undefined || rcpt === -1) badge = '<span class="lp-rcpt-badge na">N/A</span>';
            else if (rcpt === 0)                     badge = '<span class="lp-rcpt-badge done">✓ 0</span>';
            else                                     badge = `<span class="lp-rcpt-badge queue">q:${rcpt.toLocaleString()}</span>`;
        }
        const serverLabel = serverName
            ? `<span style="font-size:10px;color:#6b7280;margin-right:3px;">[${serverName}]</span>`
            : '';
        return `<div class="lp-ip-row${isDown ? ' lp-ip-row-down' : ''}">
            <span class="lp-ip">${serverLabel}${ip}</span>${badge}
            <span class="lp-sent">${state.totalSent.toLocaleString()}</span>
        </div>`;
    }).join('');

    const dotClass  = isDone ? 'lp-dot done' : 'lp-dot';
    const dropLabel = isDone ? 'DONE' : `DROP ${drop}/${displayTotal}`;
    const footerHtml = isDone ? `
        <div class="lp-footer">
            <div class="lp-done-label">✅ All Drops Complete</div>
            <button class="lp-copy-btn" id="__lp_copy_btn__">📋 Copy Results</button>
        </div>` : '';

    _livePanel.innerHTML = `
        <div class="lp-header">
            <div class="${dotClass}"></div>
            <span class="lp-title">📊 Live Warmup Status</span>
            <span class="lp-drop">${dropLabel}</span>
            <button id="__lp_dismiss_btn__" title="Remove">✕</button>
        </div>
        <div class="lp-offset-row">
            <span class="lp-tag">offset</span>
            <span class="lp-val">${currentOffset.toLocaleString()}</span>
        </div>
        <div class="lp-ip-list">${ipRows}</div>
        ${footerHtml}`;

    // Wire up dismiss button (re-added each innerHTML rebuild)
    const dismissBtn = document.getElementById('__lp_dismiss_btn__');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _removeLivePanel();
        });
    }

    if (isDone) {
        const copyBtn = document.getElementById('__lp_copy_btn__');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                let text = 'WARMUP RESULTS\n' + '─'.repeat(32) + '\n';
                text += 'Drop ' + drop + '/' + displayTotal + ' | Offset: ' + currentOffset.toLocaleString() + '\n';
                text += '─'.repeat(32) + '\n';
                allIps.forEach(ip => {
                    const s   = ipState[ip];
                    const srv = ipServerMap[ip] ? `[${ipServerMap[ip]}] ` : '';
                    text += srv + ip + '\n  Total Sent   : ' + s.totalSent.toLocaleString() + '\n  Final Target : ' + s.target.toLocaleString() + '\n';
                });
                text += '─'.repeat(32);

                const el = document.createElement('textarea');
                el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
                el.value = text;
                document.body.appendChild(el);
                el.focus(); el.select();
                try {
                    document.execCommand('copy');
                    copyBtn.textContent = '✅ Copied!';
                    copyBtn.classList.add('copied');
                    setTimeout(() => { copyBtn.textContent = '📋 Copy Results'; copyBtn.classList.remove('copied'); }, 2500);
                } catch(e) { copyBtn.textContent = '❌ Failed'; }
                document.body.removeChild(el);
            });
        }
    }
}

// ===============================
// PRE-FLIGHT VERIFICATION
// ===============================
// Checks that all required page fields are correctly set before the
// warmup process is allowed to start.  Returns an array of error
// strings (empty = all checks passed).
// processType: "passive" | "datalists"
// -------------------------------------------------------
function runPreflightChecks(processType, ispKeyword, ispMode) {
    const errors = [];

    // ── Helper: read the title attribute of a Select2 container span ──
    // Returns null  if the element doesn't exist.
    // Returns ''    if Select2 is showing a placeholder (nothing actually selected).
    // Returns the trimmed title string when a real value is selected.
    function getTitle(spanId) {
        const el = document.getElementById(spanId);
        if (!el) return null;
        // If a .select2-selection__placeholder child exists, the field is empty —
        // ignore the title attribute, which Select2 may still populate even in
        // placeholder state.
        if (el.querySelector('.select2-selection__placeholder')) return '';
        return (el.getAttribute('title') || '').trim();
    }

    // ── Helper: read the value of an <input> by name ─────────────────
    function getInputValue(name) {
        const el = document.querySelector(`input[name="${name}"]`);
        return el ? el.value.trim() : null;
    }

    // ── 1. Sponsors: must be "Sphere Digital" ────────────────────────
    const sponsor = getTitle('select2-sponsors-container');
    if (sponsor === null) {
        errors.push('Sponsors selector not found on this page.');
    } else if (sponsor !== 'Sphere Digital') {
        errors.push(`Sponsor must be "Sphere Digital" (found: "${sponsor}").`);
    }

    // ── 2. Offer: must contain "test offer [REPORTING]" ────────────────────────────
    const offer = getTitle('select2-offers-container');
    if (offer === null) {
        errors.push('Offers selector not found on this page.');
    } else if (!offer.includes('test offer [REPORTING]')) {
        errors.push(`Offer must contain "test offer [REPORTING]" (found: "${offer}").`);
    }

    // ── 3. system_speed[batch] = 0 ───────────────────────────────────
    const batch = getInputValue('system_speed[batch]');
    if (batch === null) {
        errors.push('Input system_speed[batch] not found on this page.');
    } else if (parseInt(batch) !== 0) {
        errors.push(`system_speed[batch] must be 0 (found: "${batch}").`);
    }

    // ── 4. system_speed[delay] = 0 ───────────────────────────────────
    const delay = getInputValue('system_speed[delay]');
    if (delay === null) {
        errors.push('Input system_speed[delay] not found on this page.');
    } else if (parseInt(delay) !== 0) {
        errors.push(`system_speed[delay] must be 0 (found: "${delay}").`);
    }

    // ── 5. Mode-specific checks ───────────────────────────────────────
    if (processType === 'passive') {
        // Lists Passive mode
        const provider = getTitle('select2-data_providers-container');
        if (provider === null) {
            errors.push('Data Provider selector not found on this page.');
        } else if (!/data_tss|seeds/i.test(provider)) {
            errors.push(`Data Provider must contain "data_TSS" (found: "${provider}").`);
        }

        const profile = getTitle('select2-data_profiles-container');
        if (profile === null) {
            errors.push('Data Profile selector not found on this page.');
        } else if (!/seeds/i.test(profile)) {
            errors.push(`Data Profile must be "Seeds" (found: "${profile}").`);
        }

        const ispProfile = getTitle('select2-data_profile_isps-container');
        if (ispProfile === null) {
            errors.push('ISP Profile selector not found on this page.');
        } else if (ispProfile.toLowerCase() !== ispKeyword.toLowerCase()) {
            errors.push(`ISP Profile must be exactly "${ispKeyword}" (found: "${ispProfile}").`);
        }

    } else if (processType === 'datalists') {
        // Data Lists mode — checks depend on the active entry's mode (warmup vs passive)

        // ── First select: Data Provider ─────────────────────────
        // Both modes require "data_TSS"
        const provider = getTitle('select2-data_providers-container');
        if (provider === null) {
            errors.push('Data Provider selector not found on this page.');
        } else if (!/data_tss|seeds/i.test(provider)) {
            errors.push(`Data Provider must contain "data_TSS" (found: "${provider}").`);
        }

        // ── Second select: Data Profile ─────────────────────────
        // Warmup Lists → contains "Seeds"
        // Passive Lists → exact "Seeds"
        const profile = getTitle('select2-data_profiles-container');
        if (profile === null) {
            errors.push('Data Profile selector not found on this page.');
        } else if (ispMode === 'passive') {
            if (!/seeds/i.test(profile)) {
                errors.push(`Data Profile must be "Seeds" (found: "${profile}").`);
            }
        } else {
            // warmup
            if (!/seeds/i.test(profile)) {
                errors.push(`Data Profile must contain "Seeds" (found: "${profile}").`);
            }
        }

        // ── Third select: ISP Profile ───────────────────────────
        // Both modes: exact match on the value the user supplied.
        // When ispKeyword is empty (shuffle mode) this check is skipped —
        // the extension will apply the shuffled sequence automatically.
        if (ispKeyword) {
            const ispProfile = getTitle('select2-data_profile_isps-container');
            if (ispProfile === null) {
                errors.push('ISP Profile selector not found on this page.');
            } else if (ispProfile.toLowerCase() !== ispKeyword.toLowerCase()) {
                errors.push(`ISP Profile must be exactly "${ispKeyword}" (found: "${ispProfile}").`);
            }
        }
    }

    return errors;
}

// ── Show a blocking error card in the overlay and notify popup ──
function showPreflightErrorCard(errors) {
    ensureOverlay();
    const overlay = getOverlay();

    // Remove any previous preflight card
    const old = document.getElementById('__deploy_preflight_error__');
    if (old) old.remove();

    const rows = errors.map(e =>
        `<div style="display:flex;align-items:flex-start;gap:7px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="color:#f87171;flex-shrink:0;margin-top:1px;">✗</span>
            <span style="font-size:12px;color:#fca5a5;line-height:1.5;">${e}</span>
        </div>`
    ).join('');

    const card = document.createElement('div');
    card.className = 'deploy-card';
    card.id = '__deploy_preflight_error__';
    card.style.cursor = 'pointer';
    card.innerHTML = `
        <div class="dc-header">
            <div class="dc-icon red">🚫</div>
            <div class="dc-title">Pre-flight Check Failed</div>
            <div class="dc-badge">BLOCKED</div>
        </div>
        <div class="dc-body" style="margin-bottom:8px;color:#fca5a5;">
            Fix the following before starting:
        </div>
        <div style="display:flex;flex-direction:column;">${rows}</div>
        <div style="height:1px;background:rgba(255,255,255,0.07);margin:9px 0 6px;"></div>
        <div class="dc-body" style="font-size:11px;color:#64748b;">Click to dismiss</div>`;
    card.addEventListener('click', () => {
        card.classList.add('fade-out');
        setTimeout(() => card.remove(), 380);
    });
    overlay.appendChild(card);
}

// ===============================
// Message Listener
// ===============================

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "PING") sendResponse({ ok: true });
    if (message.type === "START_DEPLOY_PROCESS") {
        if (message.deployTabId) _deployTabId = message.deployTabId;

        // Async handler — return true so the message channel stays open
        // until sendResponse is called inside the async IIFE below.
        (async () => {
            const processType = (message.config && message.config.processType) || 'passive';

            // Determine the ISP keyword and mode to use for preflight
            // For datalists: use the first entry's value + mode for the check.
            // When Shuffle ISP Sequence is enabled the actual first entry used at
            // runtime will differ from the configured order, so the ISP Profile
            // select check must be skipped — pass an empty keyword to signal that.
            const shuffleEnabled = !!(message.config && message.config.shuffleIspSequence);
            let ispPreflightKeyword = '';
            let ispPreflightMode    = 'warmup'; // default for datalists
            if (processType === 'passive') {
                ispPreflightKeyword = (message.config && message.config.ispPassiveValue) || '';
                ispPreflightMode    = 'passive';
            } else if (processType === 'datalists') {
                const entries = (message.config && message.config.ispDatalistsEntries) || [];
                // If shuffle is on, skip the ISP Profile check by leaving keyword empty
                ispPreflightKeyword = (!shuffleEnabled && entries.length > 0) ? (entries[0].value || '') : '';
                ispPreflightMode    = entries.length > 0 ? (entries[0].mode || 'warmup') : 'warmup';
            }

            const preflightErrors = runPreflightChecks(processType, ispPreflightKeyword, ispPreflightMode);

            // ── Passive list existence check ──────────────────────────────────
            // Collect every passive-mode list name in this configuration.
            // If the server reports a list as "existe" (it belongs to the warmup
            // system), the user must switch that entry to "Warmup Lists" mode.
            const passiveNamesToCheck = [];
            if (processType === 'passive' && ispPreflightKeyword) {
                passiveNamesToCheck.push(ispPreflightKeyword);
            } else if (processType === 'datalists') {
                const entries = (message.config && message.config.ispDatalistsEntries) || [];
                entries.forEach(e => {
                    if (e.mode === 'passive' && e.value) passiveNamesToCheck.push(e.value);
                });
            }

            for (const listName of passiveNamesToCheck) {
                try {
                    const resp = await fetch(`${_WARMUP_API_BASE}/Check_passives_lists`, {
                        method : 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body   : JSON.stringify({ liste_name: listName })
                    });
                    const data = await resp.json();
                    if (data.status === 'existe') {
                        preflightErrors.push(
                            `"${listName}" is a Warmup list — to run it, switch its mode to "Warmup Lists" instead of "Passive Lists".`
                        );
                    }
                } catch (e) {
                    console.warn('[checkPassiveList] API error for list "' + listName + '":', e);
                }
            }

            if (preflightErrors.length > 0) {
                // Block the process — notify popup and show error card on page
                sendResponse({ started: false, preflightErrors });
                ensureOverlay();
                showPreflightErrorCard(preflightErrors);
                return;
            }

            sendResponse({ started: true });
            startFullProcess(message.groups, message.config, message.orderedIps, message.ipServerMap || {}, message.ipOverrideMap || {});
        })();

        return true; // keep the sendResponse channel open for async reply
    }
});

// -------------------------------------------------------
// pauseAwareWait
// -------------------------------------------------------
// Counts down the requested duration, but FREEZES while paused.
// When the process is paused, we record how much time was remaining
// and extend the deadline by the full paused duration on resume.
// Example: 10 min left at 12:00, paused until 12:20 → resumes with
// 10 min still left, so the next task fires at 12:30.
async function pauseAwareWait(totalMs, drop, displayTotal, label) {
    // _pauseAwareDeadline is a shared reference so showCountdownCard
    // can sync to the same deadline after it gets extended.
    let deadline = Date.now() + totalMs;
    _pauseAwareDeadline = deadline;

    while (true) {
        if (_processState === "stopped") throw new ProcessStoppedError();

        const remaining = _pauseAwareDeadline - Date.now();
        if (remaining <= 0) {
            _pauseAwareDeadline = null;
            return;
        }

        if (_processState === "paused") {
            // Snapshot how much time was left the moment we paused.
            const frozenRemaining = Math.ceil(Math.max(0, _pauseAwareDeadline - Date.now()) / 1000);
            _pausedCountdownSecs  = frozenRemaining;  // frozen — not ticking
            _pausedCountdownLabel = label;
            _pausedCountdownDrop  = drop;
            _pausedCountdownTotal = displayTotal;

            // Record pause start if _handlePause hasn't already (covers rapid-pause edge cases)
            if (_pauseStartedAt === null) _pauseStartedAt = Date.now();

            // Block here until resumed (or stopped).
            // _handleResume already extended _pauseAwareDeadline before waking us —
            // so we do NOT extend it again here to avoid double-counting.
            await checkPauseOrStop();

            // Reset the frozen secs so the countdown card picks up the new deadline.
            _pausedCountdownSecs = null;
            continue;
        }

        const slice = Math.min(500, _pauseAwareDeadline - Date.now());
        if (slice > 0) await wait(slice);
    }
}

// Shared deadline reference so showCountdownCard can stay in sync.
let _pauseAwareDeadline = null;

// ===============================
// MAIN ORCHESTRATOR
// ===============================

async function startFullProcess(groups, config, orderedIps, ipServerMap = {}, ipOverrideMap = {}) {
    const {
        totalDrops, successThreshold, sentIncrement,
        timeBeforeResume,
        timeAfterResume,
        timeBetweenDrops,
        telegramChatId,
        toleranceRate,
        sheetsSpreadsheetId,
        dropStart: _dropStart,
        startAfterDelay: _startAfterDelay,
        emailCountEnabled,
        gmailEmail,
        gmailPassword,
        emailCountDelay,
        prepBufferTime,
        spamStopMode,
        spamStopValue,
        ispDatalistsEntries: _ispDatalistsEntries,
        shuffleIspSequence = false,
        dropNote = '',
        resumeNotifyEnabled = false,
        pauseResumeFromMultiMonitor = false,
        rateCheckIps = 0,
        ipGroupsParsed = [],
        multiMonitorJobId = '',
        stopDeferredIpsEnabled = false,
        deferredIpsMustCompleteEnabled = false,
        startAlwaysFromEnabled = false,
        startAlwaysFromValue = null,
    } = config;

    _useMultiMonitorCmds = !!pauseResumeFromMultiMonitor;
    _rateCheckIps        = Math.min(100, Math.max(0, parseInt(rateCheckIps) || 0));
    _deferredIpsEnabled   = !!stopDeferredIpsEnabled;
    _deferredMustComplete = !!deferredIpsMustCompleteEnabled;
    _deferredUntilDrop    = {}; // fresh state every session
    _ipDropCount          = {}; // fresh state every session

    // ── Shuffle ISP Sequence (once, before Drop 1) ─────────────────────────
    // If the toggle is on, randomise the entry order with a Fisher-Yates shuffle
    // so each run cycles through ISP profiles in an unpredictable sequence.
    // The _entryIndex / quota / passive logic is completely unaffected — it still
    // advances through whichever order the array happens to be in.
    const ispDatalistsEntries = (() => {
        const arr = (_ispDatalistsEntries || []).slice(); // shallow copy — never mutate the original
        if (shuffleIspSequence && arr.length > 1) {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            console.log('[ISP Shuffle] Shuffled sequence:', arr.map(e => e.value).join(' → '));
        }
        return arr;
    })();


    // ── Drop offset setup ──────────────────────────────────────────────────
    // dropStart  : the real first drop number (1 = normal, >=2 = resume offset)
    // displayTotal: the last drop number shown in UI (= dropEnd)
    //   Example: dropStart=4, totalDrops=10 -> drops 4..13 shown as 4/13...13/13
    const dropStart    = (_dropStart && _dropStart >= 2) ? _dropStart : 1;
    const dropEnd      = dropStart + totalDrops - 1;   // last real drop number (e.g. 13)
    const displayTotal = dropEnd;                       // badge denominator   (e.g. 13)

    // tgDropCounter counts 1,2,3… for Telegram regardless of offset
    let tgDropCounter = 0;

    _telegramChatId = telegramChatId;
    _ipServerMap    = ipServerMap || {};
    startKeepAlive();
    
    if (config.enableRemoteStop && _telegramChatId) {
        startTelegramListener(_telegramChatId);
    }
    
    _startBodyGuardian();

    _processState        = "running";
    _resumeResolvers     = [];
    _pausedCountdownSecs = null;
    // Reset Data Lists entry index so every new session starts from entry 1
    runDropSendDataLists._entryIndex = 0;
    _stopAfterCurrentDrop = false;
    // Start polling list status from server every 3s for Warmup Lists entries
    startListStatusPoller(ispDatalistsEntries || []);

    browser.runtime.sendMessage({
        type: "PROCESS_STARTED",
        tabId: _deployTabId,
        totalDrops
    });

    ensureOverlay();
    ensureLivePanel();
    ensureControlBar();

    const ipState = {};
    groups.forEach(g => g.ips.forEach(ip => {
        const ovr = ipOverrideMap[ip] || {};
        ipState[ip] = {
            target                 : g.value,
            consecutiveSuccesses   : 0,
            totalSent              : 0,
            // Per-IP overrides — null means "inherit the global form value"
            customIncrement        : (ovr.customIncrement        != null) ? ovr.customIncrement        : null,
            customSuccessThreshold : (ovr.customSuccessThreshold != null) ? ovr.customSuccessThreshold : null
        };
    }));
    const allIps = (orderedIps && orderedIps.length > 0)
        ? orderedIps
        : groups.flatMap(g => g.ips);

    // ── "Start Always From" — resolve the starting Warmup Lists offset ────────
    // Manual override (validated against Lists Count on first use inside
    // runDropSendDataLists) takes priority. Otherwise, auto-resume from the
    // last saved offset (persisted before DELETE on every drop, reset to 0
    // only when a full session completes without issue).
    let persistentOffset = 0;
    if (startAlwaysFromEnabled && startAlwaysFromValue != null && !isNaN(startAlwaysFromValue)) {
        persistentOffset = Math.max(0, parseInt(startAlwaysFromValue) || 0);
        runDropSendDataLists._pendingManualOffsetCheck = persistentOffset;
        sendStatus(`ℹ️ "Start Always From" enabled — starting Warmup Lists offset at ${persistentOffset.toLocaleString()} (will be validated against Lists Count on first use).`);
    } else {
        runDropSendDataLists._pendingManualOffsetCheck = null;
        try {
            const _savedData = await browser.storage.local.get('savedStartOffset');
            if (_savedData && typeof _savedData.savedStartOffset === 'number' && _savedData.savedStartOffset > 0) {
                persistentOffset = _savedData.savedStartOffset;
                sendStatus(`ℹ️ Resuming Warmup Lists offset from last saved position: ${persistentOffset.toLocaleString()}`);
            }
        } catch (e) {
            console.warn('[StartAlwaysFrom] Failed to read saved offset:', e);
        }
    }

    let lastResumeTime              = null;
    let targetResumeTimeForNextDrop = null;

    // ── Start-after delay ────────────────────────────────────────────────────
    const startAfterDelay = (_startAfterDelay && _startAfterDelay > 0) ? _startAfterDelay : 0;
    if (startAfterDelay > 0) {
        const deadline = Date.now() + startAfterDelay * 1000;
        // Live countdown — tick every second and push status to popup
        while (true) {
            if (_processState === "stopped") throw new ProcessStoppedError();
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;

            if (_processState === "paused") {
                // While paused just wait without ticking down
                await checkPauseOrStop();
                continue;
            }

            const remSec = Math.ceil(remainingMs / 1000);
            const label  = fmtTime(remSec);
            sendStatus(`⏳ First drop starts in ${label}…`);
            updateMainCard(0, displayTotal,
                `⏳ Starting in <strong>${label}</strong> — first drop preparing soon`,
                'blue', '⏳');

            // Sleep until next second boundary (or end)
            const slice = Math.min(1000, remainingMs);
            await wait(slice);
        }
        sendStatus(`⏳ Start delay done — preparing first drop…`);
    }

    try {
        // ── Extra-drops phase state (for "Deferred IPs must Complete all drops") ──
        let _extraDropPhaseActive = false;
        let _extraDropNum         = 0;
        let drop = dropStart;
        while (true) {
            // ── Extra-drops phase gate ──────────────────────────────────────────
            if (drop > dropEnd) {
                if (!(_deferredMustComplete && _deferredIpsEnabled)) break;
                const _extraStillNeeded = allIps.filter(
                    ip => !ipState[ip]?._rotationTemp && (_ipDropCount[ip] || 0) < totalDrops
                );
                if (_extraStillNeeded.length === 0) break;
                if (!_extraDropPhaseActive) {
                    _extraDropPhaseActive = true;
                    sendStatus(`🔄 Starting extra drops for ${_extraStillNeeded.length} deferred IP(s) that didn't complete all ${totalDrops} drops…`);
                    // Notify Telegram that extra drops are beginning for deferred IPs
                    if (telegramChatId) {
                        const _nLines = [
                            '🔄 DEFERRED IPs — EXTRA DROPS STARTING',
                            '='.repeat(42),
                            `${_extraStillNeeded.length} IP(s) did not complete all ${totalDrops} drops`,
                            `because they were deferred at some point during the process.`,
                            `Extra drops will now run to bring them to ${totalDrops} total.`,
                            '',
                            'IP STATUS:',
                            ..._extraStillNeeded.map(ip => {
                                const done = _ipDropCount[ip] || 0;
                                const srv  = ipServerMap[ip] || '';
                                return `  ${srv ? srv + ' | ' : ''}${ip}: ${done}/${totalDrops} done (${totalDrops - done} more needed)`;
                            }),
                            '='.repeat(42),
                        ];
                        const _nMsg = '```\n' + _nLines.join('\n') + '\n```';
                        fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            method : 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body   : JSON.stringify({ chat_id: telegramChatId, text: _nMsg, parse_mode: 'Markdown' })
                        }).catch(e => console.warn('[Deferred] Extra drops Telegram notify error:', e));
                    }
                }
                _extraDropNum++;
            }

            tgDropCounter++;
            const tgDrop  = tgDropCounter;   // Telegram: always 1-based
            const tgTotal = totalDrops;      // Telegram: always the configured count

            // ── Apply Additional/Update IPs before building the effective list ──
            // Re-reads the floating panel textarea live each drop.
            // New IPs are appended to allIps/ipState; existing IPs are updated.
            // Exclude IPs always takes priority over Additional IPs.
            applyAdditionalIpsBeforeDrop(allIps, ipState, ipServerMap, drop, ipGroupsParsed);

            // ── IP Group Rotation ─────────────────────────────────────────────
            // Each drop uses Main IPs + exactly one rotating added group.
            // Groups cycle in order: group[0], group[1], group[0], group[1], …
            // The rotation index is (drop - dropStart) % numGroups, so drop 1 → group 0,
            // drop 2 → group 1, drop 3 → group 0, etc. (0-based, always restarts).
            // IPs from the resting groups are NEVER added to allIps/ipState for that drop,
            // so they are completely invisible in Telegram/Sheets reports.
            // NOTE: rotation is skipped during the extra-drops phase — those drops run
            //       only the specific IPs that need to catch up.
            let _rotationGroupIps = []; // IPs added by rotation (to be removed after drop)
            if (!_extraDropPhaseActive && ipGroupsParsed && ipGroupsParsed.length > 0) {
                const rotIdx = (drop - dropStart) % ipGroupsParsed.length;
                const activeGroup = ipGroupsParsed[rotIdx];
                if (activeGroup && activeGroup.orderedIps && activeGroup.orderedIps.length > 0) {
                    for (const gIp of activeGroup.orderedIps) {
                        // Merge the group's ipServerMap entry
                        if (activeGroup.ipServerMap && activeGroup.ipServerMap[gIp]) {
                            ipServerMap[gIp] = activeGroup.ipServerMap[gIp];
                        }
                        // Find what target value this IP had in the parsed group
                        let gTarget = 0;
                        for (const grp of (activeGroup.groups || [])) {
                            if (grp.ips.includes(gIp)) { gTarget = grp.value; break; }
                        }
                        // Add to ipState if not already present (new IP)
                        if (!ipState[gIp]) {
                            const ovr = (activeGroup.ipOverrideMap && activeGroup.ipOverrideMap[gIp]) || {};
                            ipState[gIp] = {
                                target                 : gTarget,
                                consecutiveSuccesses   : 0,
                                totalSent              : 0,
                                customIncrement        : (ovr.customIncrement        != null) ? ovr.customIncrement        : null,
                                customSuccessThreshold : (ovr.customSuccessThreshold != null) ? ovr.customSuccessThreshold : null,
                                _rotationTemp          : true   // flag: added by rotation
                            };
                            allIps.push(gIp);
                            _rotationGroupIps.push(gIp);
                        } else if (ipState[gIp]._rotationTemp) {
                            // IP was left over from a previous drop (shouldn't happen but guard)
                            _rotationGroupIps.push(gIp);
                        }
                    }
                    sendStatus(`Drop ${drop}: Using IP Group ${rotIdx + 1}/${ipGroupsParsed.length} (${_rotationGroupIps.length} extra IP(s) active)`);
                }
            }

            // ── Compute effective IP list for this drop (re-read exclude box live) ──
            // Excluded IPs are skipped for ALL operations: send, resume, queue read,
            // Sheets save, Telegram report, and DELETE.  They are still tracked in
            // ipState so their cumulative totals appear in the final summary card.
            let effectiveAllIps = getEffectiveIps(allIps);
            if (effectiveAllIps.length < allIps.length) {
                const skipped = allIps.filter(ip => !effectiveAllIps.includes(ip));
                sendStatus(`⚠️ Drop ${drop}: ${skipped.length} IP(s) excluded from all operations → ${skipped.join(', ')}`);
            }

            // ── Stop Deferred IPs: skip IPs that failed tolerance (⚠️) last drop ──
            // Applies only to the main IP list (not rotation groups), only for the
            // ⚠️ tolerance-fail case, and only for exactly this one drop.
            if (_deferredIpsEnabled) {
                const deferredSkip = _consumeDeferredSkipsForDrop(drop);
                if (deferredSkip.size > 0) {
                    effectiveAllIps = effectiveAllIps.filter(ip => !deferredSkip.has(ip));
                    sendStatus(`⏸️ Drop ${drop}: ${deferredSkip.size} IP(s) deferred (failed tolerance last drop) → ${[...deferredSkip].join(', ')}`);
                }
            }

            // ── Extra-drops phase: restrict effectiveAllIps to IPs still needing drops ──
            if (_extraDropPhaseActive) {
                const _extraStillNeeded = new Set(
                    allIps.filter(ip => !ipState[ip]?._rotationTemp && (_ipDropCount[ip] || 0) < totalDrops)
                );
                effectiveAllIps = effectiveAllIps.filter(ip => _extraStillNeeded.has(ip));
                if (effectiveAllIps.length === 0) { drop++; continue; }
                sendStatus(`🔄 Extra Drop ${_extraDropNum}: running ${effectiveAllIps.length} deferred IP(s) to reach total of ${totalDrops} drops…`);
            }

            // ── Track drop count per IP (used by "Deferred IPs must Complete all drops") ──
            if (_deferredMustComplete) {
                effectiveAllIps.forEach(ip => { _ipDropCount[ip] = (_ipDropCount[ip] || 0) + 1; });
            }

            await checkPauseOrStop();
            sendStatus(`DROP ${drop}/${displayTotal} starting...`);

            updateMainCard(drop, displayTotal,
                `DROP ${drop}/${displayTotal} — <strong>PAUSE · DELETE · RESET · SCHEDULE</strong>`,
                'blue', '🔧');
            sendStatus(`Drop ${drop}: PAUSE / DELETE / RESET / SCHEDULE all IPs…`);
            if (_useMultiMonitorCmds) {
                await selectIps(effectiveAllIps);
                await wait(1000);
                await executePauseAndVerifyViaMonitor(drop, displayTotal, effectiveAllIps, tgDrop, tgTotal, telegramChatId);
            } else {
                await selectIps(effectiveAllIps);
                await wait(1000);
                await openRunCommandModal();
                await executePauseAndVerify(drop, displayTotal, effectiveAllIps, tgDrop, tgTotal, telegramChatId);
            }

            updateMainCard(drop, displayTotal, `Building send groups from current targets…`, 'blue', '📋');
            // Build send groups only from effective (non-excluded) IPs
            const currentGroups = buildCurrentGroups(ipState, new Set(effectiveAllIps));

            updateLivePanel(ipState, effectiveAllIps, drop, displayTotal, persistentOffset, null);

            updateMainCard(drop, displayTotal, `Applying <strong>ISP Profile</strong> selection…`, 'purple', '🔄');
            sendStatus(`Drop ${drop}: Applying ISP Profile for current entry…`);

            // ── Shuffle mode: cycle through ALL entries (warmup + passive) per drop ─
            // Every entry participates in the rotation — one entry per drop, wrapping.
            // Example: [Warmup A, Passive B] -> drop1=A, drop2=B, drop3=A, drop4=B...
            // Exhaustion check: warmup entries with remaining=0 are skipped; passive
            // entries have no quota so they are always considered available.
            if (shuffleIspSequence && ispDatalistsEntries && ispDatalistsEntries.length > 0) {
                const allEntries = ispDatalistsEntries; // all entries participate
                const dropIndex  = drop - dropStart;    // 0-based within this session

                // Ensure the cache has fresh data for every warmup entry before we
                // evaluate which one to use. A cache miss (null) means the poller
                // hasn't run yet — we wait up to 8 s so we never assume Infinity.
                for (const e of allEntries) {
                    if (e.mode === 'warmup' && e.value) {
                        const r = _getCachedRemaining(e.value);
                        if (r === null) {
                            sendStatus(`Drop ${drop}: [Shuffle] Waiting for quota data for "${e.value}"…`);
                            await _waitForCacheReady(e.value, 8000);
                        }
                    }
                }

                // Start at the natural rotation position, then skip exhausted warmup
                // entries. Passive entries are never exhausted so they always qualify.
                // We try at most allEntries.length candidates to avoid an infinite loop.
                let chosenEntry = null;
                for (let attempt = 0; attempt < allEntries.length; attempt++) {
                    const candidate = allEntries[(dropIndex + attempt) % allEntries.length];

                    // Passive entries are always available — no quota to check
                    if (candidate.mode === 'passive') {
                        chosenEntry = candidate;
                        if (attempt > 0) {
                            sendStatus(`Drop ${drop}: [Shuffle] Skipped ${attempt} exhausted entry(ies) — using passive "${candidate.value}"`);
                        }
                        break;
                    }

                    // Warmup entry — use _getCachedRemaining (never assumes Infinity on miss)
                    // null means still unknown after waiting — treat as exhausted to be safe.
                    const remaining = _getCachedRemaining(candidate.value);
                    if (remaining === null) {
                        sendStatus(`Drop ${drop}: [Shuffle] Entry "${candidate.value}" quota unknown after wait — treating as exhausted, skipping.`);
                        continue;
                    }
                    if (remaining > 0 || !isFinite(remaining)) {
                        chosenEntry = candidate;
                        if (attempt > 0) {
                            sendStatus(`Drop ${drop}: [Shuffle] Entry "${allEntries[dropIndex % allEntries.length].value}" exhausted — skipped ${attempt}, using "${candidate.value}"`);
                        }
                        break;
                    }
                    sendStatus(`Drop ${drop}: [Shuffle] Entry "${candidate.value}" remaining=${remaining} — skipping...`);
                }

                // All entries exhausted and no passive fallback available → stop the process
                if (!chosenEntry) {
                    sendStatus(`Drop ${drop}: [Shuffle] All Warmup Lists exhausted and no Passive Lists configured — stopping process.`);
                    updateMainCard(drop, displayTotal,
                        `🛑 All Warmup Lists exhausted — no Passive Lists to fall back to.<br>Sending Telegram alert &amp; stopping…`,
                        'red', '🛑');

                    // Send Telegram alert before stopping
                    try {
                        const _now = new Date();
                        const _pad = n => String(n).padStart(2, '0');
                        const _dt  = `${_pad(_now.getDate())}-${_pad(_now.getMonth()+1)}-${_now.getFullYear()}  ${_pad(_now.getHours())}:${_pad(_now.getMinutes())}:${_pad(_now.getSeconds())}`;
                        const _div = '='.repeat(42);
                        const _alertLines = [
                            `🛑  WARMUP CONTROLLER — ALL LISTS EXHAUSTED`,
                            _div,
                            `Date / Time  :  ${_dt}`,
                            _div,
                            `Drop         :  ${tgDrop} / ${tgTotal}`,
                            ``,
                            `All Warmup Lists have remaining = 0.`,
                            `No Passive Lists entry was configured to fall back to.`,
                            ``,
                            `The warmup process has been STOPPED automatically.`,
                            _div,
                            `This message was sent automatically by the Warmup Extension.`,
                        ];
                        const _alertText = '```\n' + _alertLines.join('\n') + '\n```';
                        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            method  : 'POST',
                            headers : { 'Content-Type': 'application/json' },
                            body    : JSON.stringify({ chat_id: telegramChatId, text: _alertText, parse_mode: 'Markdown' })
                        });
                    } catch (_tgErr) {
                        console.warn('[Shuffle] Telegram exhaustion alert failed:', _tgErr);
                    }

                    _processState = 'stopped';
                    throw new ProcessStoppedError();
                }

                const realIdx = allEntries.indexOf(chosenEntry);
                const prevIdx = runDropSendDataLists._entryIndex;
                runDropSendDataLists._entryIndex = realIdx >= 0 ? realIdx : 0;
                // Reset offset to 0 whenever we switch to a different entry
                if (runDropSendDataLists._entryIndex !== prevIdx) {
                    persistentOffset = 0;
                }
                sendStatus(`Drop ${drop}: [Shuffle] Using entry ${runDropSendDataLists._entryIndex + 1}/${allEntries.length} [${chosenEntry.mode}] — "${chosenEntry.value}"`);
            }

            persistentOffset = await runDropSendDataLists(
                currentGroups, drop, displayTotal, persistentOffset,
                ispDatalistsEntries || [],
                tgDrop, tgTotal, telegramChatId,
                shuffleIspSequence   // ← new parameter: skip quota-advance when true
            );
            // Capture the mode that was actually used this drop — must be read
            // immediately after runDropSendDataLists returns, before any next drop
            // overwrites _lastMode.
            _effectiveProcessType = runDropSendDataLists._lastMode === 'passive' ? 'passive' : 'warmup';
            // Capture list info for the Telegram report
            const _listInfo = (runDropSendDataLists._lastListName)
                ? { name: runDropSendDataLists._lastListName, count: runDropSendDataLists._lastListCount != null ? runDropSendDataLists._lastListCount : null }
                : null;
            updateLivePanel(ipState, effectiveAllIps, drop, displayTotal, persistentOffset, null);

            await checkPauseOrStop();

            // ── Wait before RESUME ────────────────────────────────────────────
            if (drop === dropStart || targetResumeTimeForNextDrop === null) {
                if (timeBeforeResume > 0) {
                    showCountdownCard(timeBeforeResume, drop, displayTotal, 'Before Resume & Schedule');
                    sendStatus(`Drop ${drop}: Waiting ${fmtTime(timeBeforeResume)} before RESUME+SCHEDULE...`);
                    await pauseAwareWait(timeBeforeResume * 1000, drop, displayTotal, 'Before Resume & Schedule');
                    removeCountdownCard();
                }
            } else {
                const nowMs = Date.now();
                if (nowMs < targetResumeTimeForNextDrop) {
                    const waitMs   = targetResumeTimeForNextDrop - nowMs;
                    const waitSecs = Math.ceil(waitMs / 1000);
                    showCountdownCard(waitSecs, drop, displayTotal, 'Waiting for resume window');
                    sendStatus(`Drop ${drop}: Waiting ${fmtTime(waitSecs)} for scheduled resume window…`);
                    await pauseAwareWait(waitMs, drop, displayTotal, 'Waiting for resume window');
                    removeCountdownCard();
                } else {
                    if (timeBeforeResume > 0) {
                        showCountdownCard(timeBeforeResume, drop, displayTotal, 'Before Resume & Schedule');
                        sendStatus(`Drop ${drop}: Waiting ${fmtTime(timeBeforeResume)} before RESUME+SCHEDULE...`);
                        await pauseAwareWait(timeBeforeResume * 1000, drop, displayTotal, 'Before Resume & Schedule');
                        removeCountdownCard();
                    }
                }
            }

            await checkPauseOrStop();

            lastResumeTime = Date.now();

            updateMainCard(drop, displayTotal, `Running <strong>RESUME + SCHEDULE</strong> for all IPs…`, 'purple', '▶️');
            sendStatus(`Drop ${drop}: RESUME + SCHEDULE...`);
            if (_useMultiMonitorCmds) {
                await selectIps(effectiveAllIps);
                await wait(1000);
                await executeResumeAndVerifyViaMonitor(drop, displayTotal, effectiveAllIps, tgDrop, tgTotal, telegramChatId);
            } else {
                await selectIps(effectiveAllIps);
                await wait(1000);
                await openRunCommandModalss();
                await executeResumeAndVerify(drop, displayTotal, effectiveAllIps, tgDrop, tgTotal, telegramChatId);
            }

            // ── Resume notification ───────────────────────────────────────────
            if (resumeNotifyEnabled) {
                try {
                    const now = new Date();
                    const pad = n => String(n).padStart(2, '0');
                    const dt  = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}  ${pad(now.getHours())}:${pad(now.getMinutes())}`;
                    const processLabel = _effectiveProcessType === 'passive' ? 'Passive Lists' : 'Warmup Lists';
                    const div  = '='.repeat(63);
                    const thin = '='.repeat(38);
                    const noteLines = dropNote ? [`Note     :  ${dropNote}`] : [];
                    const lines = [
                        `Drop ${tgDrop} was resumed correctly. Please check your test after.`,
                    ];
                    const text = '```\n' + lines.join('\n') + '\n```';
                    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        method  : 'POST',
                        headers : { 'Content-Type': 'application/json' },
                        body    : JSON.stringify({ chat_id: telegramChatId, text, parse_mode: 'Markdown' })
                    });
                    sendStatus(`Drop ${drop}: ℹ️ Resume notification sent to Telegram.`);
                } catch (notifyErr) {
                    console.warn('[ResumeNotify] Telegram send failed:', notifyErr);
                }
            }

            if (timeAfterResume > 0) {
                await repeatScheduleForDuration(effectiveAllIps, drop, displayTotal, timeAfterResume);
            }

            updateMainCard(drop, displayTotal, `Opening monitor &amp; reading <strong>#Rcpt</strong>…`, 'amber', '🖥️');
            sendStatus(`Drop ${drop}: Opening monitor and reading queues...`);
            const monitorBtn = await waitForElementVisible("#ips_by_classes_ms-multi-monitors");
            monitorBtn.click();

            sendStatus(`Drop ${drop}: Waiting 9s for MultiMonitor page to load…`);
            await wait(9000);

            sendStatus(`Drop ${drop}: Navigating iframes to Queues…`);
            await bgMessage({ type: "NAVIGATE_QUEUES" });

            sendStatus(`Drop ${drop}: Waiting 15s for Queues data to load…`);
            await wait(15000);

            const { queueResults, downServers } = await readQueueData(effectiveAllIps, ipServerMap);
            updateLivePanel(ipState, effectiveAllIps, drop, displayTotal, persistentOffset, queueResults, false, ipServerMap, downServers);

            // ── Persist the Warmup Lists offset (Last Saved Offset) ──
            // Saved here — after reading the queues, before DELETE — so the banner
            // always reflects the most recently used offset. Saved unconditionally,
            // even when "Start Always From" is enabled, so the value stays accurate
            // for whenever the manual override is turned back off.
            try {
                await browser.storage.local.set({ savedStartOffset: persistentOffset, savedStartOffsetAt: Date.now() });
                try { browser.runtime.sendMessage({ type: "OFFSET_SAVED", value: persistentOffset }); } catch (_e) {}
            } catch (e) {
                console.warn('[StartAlwaysFrom] Failed to save offset:', e);
            }

            const targetSnapshot = {};
            for (const ip of effectiveAllIps) targetSnapshot[ip] = ipState[ip].target;

            for (const ip of effectiveAllIps) {
                const state = ipState[ip];
                let rcpt = queueResults[ip];
                if (rcpt === undefined) { state.consecutiveSuccesses = 0; continue; }
                // rcpt === -2 means server was down → treat as 0 sent (no increment)
                if (rcpt === -2) { state.consecutiveSuccesses = 0; continue; }
                if (rcpt === -1) rcpt = 0;

                const delivered = Math.max(0, state.target - rcpt);
                state.totalSent += delivered;

                // A drop counts as successful if the remaining queue (rcpt) is within
                // the tolerance window: rcpt <= target * (toleranceRate / 100)
                const toleranceAllowed = Math.floor(state.target * ((toleranceRate || 0) / 100));
                const isSuccess = rcpt <= toleranceAllowed;

                // ── Resolve effective increment / success-threshold for this IP ──
                // Per-IP override takes priority; falls back to the global form values.
                const effectiveIncrement        = (state.customIncrement        != null) ? state.customIncrement        : sentIncrement;
                const effectiveSuccessThreshold = (state.customSuccessThreshold != null) ? state.customSuccessThreshold : successThreshold;

                if (isSuccess) {
                    state.consecutiveSuccesses += 1;
                    if (state.consecutiveSuccesses >= effectiveSuccessThreshold) {
                        state.target += effectiveIncrement;
                        state.consecutiveSuccesses = 0;
                        sendStatus(`Drop ${drop}: 🚀 ${ip} target → ${state.target} (rcpt ${rcpt} ≤ tolerance ${toleranceAllowed}` +
                            (state.customIncrement != null || state.customSuccessThreshold != null
                                ? ` | custom: inc=${effectiveIncrement} succ=${effectiveSuccessThreshold}` : '') + ')');
                    }
                } else {
                    state.consecutiveSuccesses = 0;

                    // ── Stop Deferred IPs: mark this IP to be skipped next drop ──
                    // Only applies to the main IP list (never to rotation-group IPs,
                    // whose ipState is wiped after each drop anyway).
                    if (_deferredIpsEnabled && !state._rotationTemp) {
                        _deferredUntilDrop[ip] = drop + 1;
                        sendStatus(`Drop ${drop}: ⏸️ ${ip} failed tolerance (rcpt ${rcpt} > tolerance ${toleranceAllowed}) — deferring from Drop ${drop + 1}`);
                    }
                }
            }
            updateLivePanel(ipState, effectiveAllIps, drop, displayTotal, persistentOffset, queueResults, false, ipServerMap, downServers);

            // ── Save to Google Sheets ──
            // Uses real `drop` number so columns land correctly even when starting from drop 3+
            try {
                browser.runtime.sendMessage({ type: "SHEETS_SAVING", drop });
                sendStatus(`Drop ${drop}: Saving results to Google Sheets…`);

                const ipResults = effectiveAllIps.map(ip => {
                    const state      = ipState[ip];
                    const target     = targetSnapshot[ip];
                    const rcpt       = queueResults[ip];
                    const serverDown = rcpt === -2;
                    const reallySent = serverDown
                        ? 0
                        : (rcpt === undefined || rcpt === -1)
                            ? target
                            : Math.max(0, target - rcpt);
                    return {
                        ip,
                        target,
                        reallySent,
                        rcpt       : rcpt === undefined ? -1 : rcpt,
                        server     : ipServerMap[ip] || '',
                        serverDown
                    };
                });

                // ── Build final ipResults for Sheets in a consistent canonical order ──
                // Order: main IPs (not from any group) first, then group IPs in
                // group-index order regardless of which group is active this drop.
                // Resting group IPs appear with null target/reallySent (blank cells).
                let _orderedIpResults;
                if (ipGroupsParsed && ipGroupsParsed.length > 0) {
                    const _activeRotIdx  = (drop - dropStart) % ipGroupsParsed.length;
                    const _effectiveSet  = new Set(effectiveAllIps);
                    const _ipResultMap   = new Map(ipResults.map(r => [r.ip, r]));

                    // Set of every IP that belongs to ANY rotation group
                    const _allGroupIpSet = new Set();
                    ipGroupsParsed.forEach(grp => {
                        if (grp && grp.orderedIps) grp.orderedIps.forEach(ip => _allGroupIpSet.add(ip));
                    });

                    // 1. Main IPs (active, not from any rotation group) — preserve their order
                    const _mainIpResults = ipResults.filter(r => !_allGroupIpSet.has(r.ip));

                    // 2. Group IPs in group-index order so columns are the same every drop
                    const _groupIpResults = [];
                    ipGroupsParsed.forEach((grp, grpIdx) => {
                        if (!grp || !grp.orderedIps) return;
                        for (const gIp of grp.orderedIps) {
                            if (grpIdx === _activeRotIdx) {
                                // Active group — use the real measured result
                                if (_ipResultMap.has(gIp)) _groupIpResults.push(_ipResultMap.get(gIp));
                            } else {
                                // Resting group — blank IN/OUT (null → empty cell in Sheets)
                                if (!_effectiveSet.has(gIp)) {
                                    _groupIpResults.push({
                                        ip          : gIp,
                                        target      : null,
                                        reallySent  : null,
                                        rcpt        : null,
                                        server      : (grp.ipServerMap && grp.ipServerMap[gIp]) || '',
                                        serverDown  : false,
                                        restingGroup: true
                                    });
                                }
                            }
                        }
                    });

                    _orderedIpResults = [..._mainIpResults, ..._groupIpResults];
                } else {
                    _orderedIpResults = [...ipResults];
                }

                const saveResult = await bgMessage({
                    type         : "SHEETS_SAVE",
                    drop,
                    ipResults    : _orderedIpResults,
                    toleranceRate,
                    ipServerMap,
                    downServers,
                    spreadsheetId: sheetsSpreadsheetId
                });

                browser.runtime.sendMessage({
                    type: "SHEETS_SAVED", drop,
                    success:   saveResult.success,
                    sheetName: saveResult.sheetName || '',
                    error:     saveResult.error     || ''
                });

                sendStatus(`Drop ${drop}: ${saveResult.success
                    ? '✅ Saved to Google Sheets → ' + saveResult.sheetName
                    : '⚠️ Sheets save failed: '       + saveResult.error}`);
            } catch (sheetsErr) {
                console.error('[Sheets] Unexpected error:', sheetsErr);
                browser.runtime.sendMessage({
                    type: "SHEETS_SAVED", drop, success: false,
                    sheetName: '', error: sheetsErr.message
                });
            }

            // ── In/Out difference reporting ───────────────────────────────────
            // Only applies to Warmup Lists (passive lists have no quota to adjust).
            // If TOTAL IN − TOTAL OUT > 0, that many emails are still sitting in
            // the queue and were not delivered — the API restores that amount to
            // the list's remaining quota so future drops are not under-counted.
            try {
                const _diffListName = runDropSendDataLists._lastListName || '';
                const _diffMode     = runDropSendDataLists._lastMode     || '';
                if (_diffListName && _diffMode === 'warmup') {
                    const _totalIn  = effectiveAllIps.reduce((s, ip) => s + (targetSnapshot[ip] || 0), 0);
                    const _totalOut = effectiveAllIps.reduce((s, ip) => {
                        const _rcpt = queueResults[ip];
                        if (_rcpt === -2) return s; // server down — exclude from diff
                        const _sent = (_rcpt === undefined || _rcpt === -1)
                            ? (targetSnapshot[ip] || 0)
                            : Math.max(0, (targetSnapshot[ip] || 0) - _rcpt);
                        return s + _sent;
                    }, 0);
                    const _diff = _totalIn - _totalOut;
                    if (_diff > 0) {
                        sendStatus(`Drop ${drop}: ↩️ Reporting ${_diff.toLocaleString()} undelivered rows back to quota for "${_diffListName}"…`);
                        await _reportInOutDifference(_diffListName, _diff);
                        sendStatus(`Drop ${drop}: ✅ In/Out difference (${_diff.toLocaleString()}) reported.`);
                    } else {
                        console.log(`[InOutDiff] Drop ${drop}: diff=${_diff} — nothing to restore.`);
                    }
                }
            } catch (_diffErr) {
                console.warn('[InOutDiff] Unexpected error:', _diffErr);
            }

            await checkPauseOrStop();

            // ── Build tgResults snapshot (used for merged Telegram report) ────
            const tgResults = effectiveAllIps.map(ip => {
                const rcpt       = queueResults[ip];
                const serverDown = rcpt === -2;
                return {
                    ip,
                    server     : ipServerMap[ip] || '',
                    serverDown,
                    target     : targetSnapshot[ip],
                    reallySent : serverDown
                        ? 0
                        : (rcpt === undefined || rcpt === -1)
                            ? targetSnapshot[ip]
                            : Math.max(0, targetSnapshot[ip] - rcpt)
                };
            });

            // ── DELETE ──
            updateMainCard(drop, displayTotal, `Running <strong>DELETE</strong> on all IPs…`, 'red', '🗑️');
            sendStatus(`Drop ${drop}: Running DELETE...`);
            if (_useMultiMonitorCmds) {
                await selectIps(effectiveAllIps);
                await wait(1000);
                await executeViaMultiMonitorRunCmds(['DELETE'], drop, displayTotal, 'DELETE', multiMonitorJobId);
            } else {
                await selectIps(effectiveAllIps);
                await wait(1000);
                await openRunCommandModalDelete();
                await executeDeleteTwoClicks(drop, displayTotal);
            }

            // ── Merged Telegram report (warmup + optional email count) ────────
            // Sent after DELETE, respecting the email count wait delay.
            // Uses tgDrop/tgTotal so Telegram always shows 1/10, 2/10 … regardless of offset.
            await runMergedTelegramReport(
                drop, displayTotal,
                tgDrop, tgTotal,
                tgResults,
                lastResumeTime,
                telegramChatId,
                toleranceRate,
                downServers,
                _effectiveProcessType,
                emailCountEnabled && gmailEmail && gmailPassword
                    ? { gmailEmail, gmailPassword, emailCountDelay: emailCountDelay || 0 }
                    : null,
                spamStopMode  || 'none',
                spamStopValue || 0,
                _extraDropPhaseActive
                    ? (dropNote ? dropNote + ` [Deferred Extra Drop ${_extraDropNum}]` : `Deferred Extra Drop ${_extraDropNum} — catching up deferred IPs`)
                    : dropNote,
                _listInfo
            );

            // ── Stop if last-entry quota was exhausted mid-drop ──────────────
            if (_stopAfterCurrentDrop) {
                sendStatus(`Drop ${drop}: All list quotas exhausted — stopping after this drop.`);
                break;
            }

            // ── Schedule next drop preparation ────────────────────────────────
            // Also wait between extra drops if more deferred IPs still need drops.
            const _moreDropsAfterThis = drop < dropEnd ||
                (_deferredMustComplete && _deferredIpsEnabled &&
                 allIps.some(ip => !ipState[ip]?._rotationTemp && (_ipDropCount[ip] || 0) < totalDrops));
            if (_moreDropsAfterThis) {
                await checkPauseOrStop();

                targetResumeTimeForNextDrop = lastResumeTime + timeBetweenDrops * 1000;
                const PREP_BUFFER_MS        = (prepBufferTime || 15 * 60) * 1000;
                const prepStartTime         = targetResumeTimeForNextDrop - PREP_BUFFER_MS;
                const nowMs                 = Date.now();

                if (nowMs < prepStartTime) {
                    const waitMs   = prepStartTime - nowMs;
                    const waitSecs = Math.ceil(waitMs / 1000);

                    // ── Pause list-status polling during the idle between-drops window ──
                    // There is nothing useful to monitor while we are just waiting;
                    // polling will restart (with a fresh immediate call) once the
                    // prep buffer window opens and the next drop starts preparing.
                    stopListStatusPoller();
                    sendStatus(`Drop ${drop}: List quota polling paused for between-drops wait.`);

                    showCountdownCard(waitSecs, drop, displayTotal, 'Between drops');
                    sendStatus(`Drop ${drop}: Next preparation starts in ${fmtTime(waitSecs)}…`);
                    await pauseAwareWait(waitMs, drop, displayTotal, 'Between drops');
                    removeCountdownCard();

                    // ── Restart poller now that prep is about to begin ──────────────
                    startListStatusPoller(ispDatalistsEntries || []);
                    sendStatus(`Drop ${drop}: List quota polling resumed for next drop preparation.`);
                } else {
                    sendStatus(`Drop ${drop}: Prep window (${fmtTime(prepBufferTime || 900)}) already reached — starting next preparation immediately.`);
                }
            }

            // ── Clean up rotation IPs after drop ─────────────────────────────
            // Remove the temporary IPs that were injected by the rotation logic
            // so they do not appear in allIps/ipState for any subsequent drop.
            // They were only active for this specific drop — resting groups
            // must be completely invisible in all reports.
            if (_rotationGroupIps.length > 0) {
                const rotSet = new Set(_rotationGroupIps);
                // Remove from allIps in-place (splice backwards to keep indices stable)
                for (let i = allIps.length - 1; i >= 0; i--) {
                    if (rotSet.has(allIps[i])) allIps.splice(i, 1);
                }
                // Remove from ipState and ipServerMap
                for (const gIp of _rotationGroupIps) {
                    delete ipState[gIp];
                    // Only remove from ipServerMap if it was added by this rotation
                    // (not originally in the main ipServerMap)
                    if (ipServerMap[gIp] !== undefined) delete ipServerMap[gIp];
                }
                _rotationGroupIps = [];
            }

            drop++;
        } // end while (main + extra drops) loop
        // ── end drop loop ──

        // ── Full session completed without issue — reset the "Start Always From"
        //    auto-resume point back to 0, since there is nothing left to resume.
        try {
            await browser.storage.local.set({ savedStartOffset: 0, savedStartOffsetAt: Date.now() });
            try { browser.runtime.sendMessage({ type: "OFFSET_SAVED", value: 0 }); } catch (_e) {}
        } catch (e) {
            console.warn('[StartAlwaysFrom] Failed to reset saved offset:', e);
        }

        // ── ALL DONE ──
        showFinalCard(allIps, ipState, ipServerMap);
        updateLivePanel(ipState, allIps, dropEnd, displayTotal, persistentOffset, null, true, ipServerMap, []);
        removeControlBar();

        let report = "📊 FINAL REPORT\n━━━━━━━━━━━━━━━━━━━━━━━━\n";
        for (const ip of allIps) {
            const s = ipState[ip];
            report += `${ip}\n  Total Sent: ${s.totalSent.toLocaleString()}\n  Final Target: ${s.target.toLocaleString()}\n`;
        }
        report += "━━━━━━━━━━━━━━━━━━━━━━━━";

        stopKeepAlive();
        stopTelegramListener();
        stopListStatusPoller();
        _stopBodyGuardian();
        browser.runtime.sendMessage({ type: "PROCESS_COMPLETED" });
        browser.runtime.sendMessage({ type: "FINAL_REPORT", report });
        console.log(report);

    } catch (error) {
        stopKeepAlive();
        stopTelegramListener();
        stopListStatusPoller();
        removeControlBar();
        _stopBodyGuardian();

        if (error instanceof ProcessStoppedError) {
            console.log('[Process] Stopped by user.');
            removeMainCard();
            removeCountdownCard();
            const overlay = getOverlay();
            const card = document.createElement('div');
            card.className = 'deploy-card';
            card.style.cursor = 'pointer';
            card.innerHTML = `
                <div class="dc-header">
                    <div class="dc-icon red">🛑</div>
                    <div class="dc-title">Process Stopped</div>
                    <div class="dc-badge">BY USER</div>
                </div>
                <div class="dc-body">The warmup process was <strong>stopped manually</strong>. Click to dismiss.</div>`;
            card.addEventListener('click', () => { card.classList.add('fade-out'); setTimeout(() => card.remove(), 380); });
            overlay.appendChild(card);
            browser.runtime.sendMessage({ type: "PROCESS_FAILED", error: "Stopped by user." });
            return;
        }

        console.error('[Process] Fatal error:', error);
        sendStatus('❌ Process failed: ' + error.message);
        browser.runtime.sendMessage({ type: "PROCESS_FAILED", error: error.message });
        throw error;
    }
}

// -------------------------------------------------------
// PAUSE-AND-VERIFY
// -------------------------------------------------------
// Replaces the old `executeRunCommandModal(..., 5)` for the
// PAUSE+DELETE+RESET+SCHEDULE step.
//
// Flow (up to MAX_ATTEMPTS times):
//   1. Click Execute 2 times (5 s apart)
//   2. Dismiss the modal
//   3. Open MultiMonitor → wait 7 s for iframes to load
//   4. Ask background to check if at least one iframe shows
//      the 3 target queues as paused
//   5a. Paused confirmed → close monitor tab → return
//   5b. Not confirmed   → close monitor tab → retry from step 1
//      (re-select IPs and re-open the modal each time)
//   6. After MAX_ATTEMPTS failures → send Telegram alert → throw
//      ProcessStoppedError so the entire session is halted
// -------------------------------------------------------
async function executePauseAndVerify(drop, displayTotal, allIps, tgDrop, tgTotal, telegramChatId) {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {

        // ── 1. Click Execute × 2 ────────────────────────────
        const form = await waitForElement('#run-cmd-form', 30000);

        const chk = await waitForElementVisible('#check-cmd-by-server', 15000);
        if (!chk.checked) { chk.click(); await wait(600); }

        const submitBtn = await waitForChildElement(form, "button[type='submit']", 15000);
        await wait(800);

        submitBtn.click();
        sendStatus(`Drop ${drop}: PAUSE/DELETE/RESET/SCHEDULE — attempt ${attempt}/${MAX_ATTEMPTS} (click 1/2)…`);
        updateMainCard(drop, displayTotal,
            `Attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong> — PAUSE click <strong>1/2</strong>…`,
            'blue', '🔧');

        await wait(5000);
        submitBtn.click();
        sendStatus(`Drop ${drop}: PAUSE/DELETE/RESET/SCHEDULE — attempt ${attempt}/${MAX_ATTEMPTS} (click 2/2)…`);
        updateMainCard(drop, displayTotal,
            `Attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong> — PAUSE click <strong>2/2</strong>…`,
            'blue', '🔧');

        // ── 2. Wait for dismiss button and close modal ───────
        const dismissBtn = await new Promise(resolve => {
            const TIMEOUT  = 90000;
            const INTERVAL = 500;
            let elapsed = 0;
            const timer = setInterval(() => {
                const btn =
                    form.querySelector("button[data-dismiss='modal']") ||
                    document.querySelector(".modal.in button[data-dismiss='modal']") ||
                    document.querySelector(".modal.show button[data-dismiss='modal']");
                if (btn) { clearInterval(timer); resolve(btn); return; }
                elapsed += INTERVAL;
                if (elapsed >= TIMEOUT) { clearInterval(timer); resolve(null); }
            }, INTERVAL);
        });

        await wait(6000);

        await _closeModalAndWait(dismissBtn, 10000);
        await wait(800);

        // ── 3. Open MultiMonitor tab ─────────────────────────
        sendStatus(`Drop ${drop}: Opening MultiMonitor to verify pause (attempt ${attempt}/${MAX_ATTEMPTS})…`);
        updateMainCard(drop, displayTotal,
            `Attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong> — Opening monitor to verify pause…`,
            'amber', '🖥️');

        const monitorBtn = await waitForElementVisible("#ips_by_classes_ms-multi-monitors");
        monitorBtn.click();

        // Wait 9s for the MultiMonitor tab to open and its DOM to render
        // (the background CHECK_PAUSE_STATUS handler will then navigate
        //  the iframes to Queues and wait another 7s before reading)
        sendStatus(`Drop ${drop}: Waiting for MultiMonitor tab to open…`);
        await wait(9000);

        // ── 4. Check pause status via background ────────────
        // Background navigates iframes → waits 7s → reads Paused column
        sendStatus(`Drop ${drop}: Navigating iframes to Queues & checking pause status…`);
        const checkResult = await bgMessage({ type: "CHECK_PAUSE_STATUS", allIps, rateCheckIps: _rateCheckIps });

        const monitorTabId = checkResult ? checkResult.tabId : null;

        // ── 5a. Paused confirmed ─────────────────────────────
        if (checkResult && checkResult.paused) {
            sendStatus(`Drop ${drop}: ✅ Pause confirmed — closing monitor tab…`);
            updateMainCard(drop, displayTotal,
                `✅ Pause confirmed on attempt <strong>${attempt}</strong> — continuing…`,
                'green', '✅');

            if (monitorTabId) {
                await bgMessage({ type: "CLOSE_TAB", tabId: monitorTabId });
            }
            if (_deployTabId) {
                await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId });
                await wait(600);
            }
            return; // ✅ success — back to main loop
        }

        // ── 5b. Not confirmed — close tab and maybe retry ───
        sendStatus(`Drop ${drop}: ⚠️ Queues not paused yet (attempt ${attempt}/${MAX_ATTEMPTS}) — closing monitor tab…`);
        updateMainCard(drop, displayTotal,
            `⚠️ Not paused (attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong>)${attempt < MAX_ATTEMPTS ? ' — retrying…' : ' — STOPPING'}`,
            'amber', '⚠️');

        if (monitorTabId) {
            await bgMessage({ type: "CLOSE_TAB", tabId: monitorTabId });
        }
        if (_deployTabId) {
            await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId });
            await wait(600);
        }

        if (attempt < MAX_ATTEMPTS) {
            // Re-select IPs and re-open the modal for the next attempt
            await wait(2000);
            await selectIps(allIps);
            await wait(1000);
            await openRunCommandModal();
        }
    }

    // ── 6. All attempts exhausted — run emergency RESUME+SCHEDULE, send Telegram alert and stop ──
    sendStatus(`Drop ${drop}: ❌ Servers did NOT pause after ${MAX_ATTEMPTS} attempts — running emergency RESUME+SCHEDULE…`);
    updateMainCard(drop, displayTotal,
        `❌ Servers did not pause after <strong>${MAX_ATTEMPTS} attempts</strong>.<br>Running emergency <strong>RESUME+SCHEDULE</strong>…`,
        'red', '🚨');

    try {
        _forceCloseAllModals();
        await wait(800);
        await selectIps(allIps);
        await wait(1000);
        await openRunCommandModalss();
        await executeRunCommandModal(`Emergency RESUME+SCHEDULE (pause failure)`, 2);
        sendStatus(`Drop ${drop}: Emergency RESUME+SCHEDULE completed — sending Telegram alert…`);
    } catch (resumeErr) {
        console.warn('[executePauseAndVerify] Emergency RESUME+SCHEDULE failed:', resumeErr);
    }

    updateMainCard(drop, displayTotal,
        `❌ Pause failure — sending <strong>Telegram alert</strong>…`,
        'red', '🚨');

    const now   = new Date();
    const pad   = n => String(n).padStart(2, '0');
    const dt    = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const div   = '='.repeat(42);
    // Pick a random server name from the IPs list to include in the alert
    const _pauseServers = [...new Set(allIps.map(ip => (typeof _ipServerMap !== 'undefined' && _ipServerMap[ip]) || '').filter(Boolean))];
    const _pauseRandSrv = _pauseServers.length > 0 ? _pauseServers[Math.floor(Math.random() * _pauseServers.length)] : '';
    const alertLines = [
        `🚨  WARMUP CONTROLLER — PAUSE FAILURE`,
        div,
        `Date / Time  :  ${dt}`,
        ...(_pauseRandSrv ? [`Server       :  ${_pauseRandSrv}`] : []),
        div,
        `Drop         :  ${tgDrop} / ${tgTotal}`,
        `Attempts     :  ${MAX_ATTEMPTS} × 2 clicks`,
        ``,
        `The queues gmail.com/*, gmail.queue/*, googlemail.com/*`,
        `did NOT show Paused = yes in any iframe after ${MAX_ATTEMPTS} attempts.`,
        ``,
        `An emergency RESUME+SCHEDULE was executed before stopping.`,
        `The warmup process has been STOPPED automatically.`,
        div,
        `This message was sent automatically by the Warmup Extension.`,
    ];
    const alertText = '```\n' + alertLines.join('\n') + '\n```';

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify({ chat_id: telegramChatId, text: alertText, parse_mode: 'Markdown' })
        });
    } catch (tgErr) {
        console.warn('[executePauseAndVerify] Telegram alert failed:', tgErr);
    }

    // Stop the entire session
    _processState = "stopped";
    throw new ProcessStoppedError();
}

// -------------------------------------------------------
// RESUME-AND-VERIFY
// -------------------------------------------------------
// Same structure as executePauseAndVerify but for RESUME+SCHEDULE.
// After 2 Execute clicks it opens MultiMonitor and checks that at
// least one iframe shows a gmail.com/gmail-<ip> (or gmail.queue/…
// or googlemail.com/…) row with Paused = "no".
// Retries up to MAX_ATTEMPTS times, then stops session + Telegram.
// -------------------------------------------------------
async function executeResumeAndVerify(drop, displayTotal, allIps, tgDrop, tgTotal, telegramChatId) {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {

        // ── 1. Click Execute × 2 ────────────────────────────
        const form = await waitForElement('#run-cmd-form', 30000);

        const chk = await waitForElementVisible('#check-cmd-by-server', 15000);
        if (!chk.checked) { chk.click(); await wait(600); }

        const submitBtn = await waitForChildElement(form, "button[type='submit']", 15000);
        await wait(800);

        submitBtn.click();
        sendStatus(`Drop ${drop}: RESUME+SCHEDULE — attempt ${attempt}/${MAX_ATTEMPTS} (click 1/2)…`);
        updateMainCard(drop, displayTotal,
            `Attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong> — RESUME click <strong>1/2</strong>…`,
            'purple', '▶️');

        await wait(5000);
        submitBtn.click();
        sendStatus(`Drop ${drop}: RESUME+SCHEDULE — attempt ${attempt}/${MAX_ATTEMPTS} (click 2/2)…`);
        updateMainCard(drop, displayTotal,
            `Attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong> — RESUME click <strong>2/2</strong>…`,
            'purple', '▶️');

        // ── 2. Wait for dismiss button and close modal ───────
        const dismissBtn = await new Promise(resolve => {
            const TIMEOUT  = 90000;
            const INTERVAL = 500;
            let elapsed = 0;
            const timer = setInterval(() => {
                const btn =
                    form.querySelector("button[data-dismiss='modal']") ||
                    document.querySelector(".modal.in button[data-dismiss='modal']") ||
                    document.querySelector(".modal.show button[data-dismiss='modal']");
                if (btn) { clearInterval(timer); resolve(btn); return; }
                elapsed += INTERVAL;
                if (elapsed >= TIMEOUT) { clearInterval(timer); resolve(null); }
            }, INTERVAL);
        });

        await wait(6000);

        await _closeModalAndWait(dismissBtn, 10000);
        await wait(800);

        // ── 3. Open MultiMonitor tab ─────────────────────────
        sendStatus(`Drop ${drop}: Opening MultiMonitor to verify resume (attempt ${attempt}/${MAX_ATTEMPTS})…`);
        updateMainCard(drop, displayTotal,
            `Attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong> — Opening monitor to verify resume…`,
            'green', '🖥️');

        const monitorBtn = await waitForElementVisible("#ips_by_classes_ms-multi-monitors");
        monitorBtn.click();

        // Wait for the tab to open; background handles iframe nav + 7 s wait
        sendStatus(`Drop ${drop}: Waiting for MultiMonitor tab to open…`);
        await wait(9000);

        // ── 4. Check resume status via background ────────────
        // Background navigates iframes → waits 7 s → reads Paused column
        // and returns resumed=true if any gmail.com/gmail-<ip> row shows paused=no
        sendStatus(`Drop ${drop}: Navigating iframes to Queues & checking resume status…`);
        const checkResult = await bgMessage({ type: "CHECK_RESUME_STATUS", allIps, rateCheckIps: _rateCheckIps });

        const monitorTabId = checkResult ? checkResult.tabId : null;

        // ── 5a. Resumed confirmed ────────────────────────────
        if (checkResult && checkResult.resumed) {
            sendStatus(`Drop ${drop}: ✅ Resume confirmed — closing monitor tab…`);
            updateMainCard(drop, displayTotal,
                `✅ Resume confirmed on attempt <strong>${attempt}</strong> — continuing…`,
                'green', '✅');

            if (monitorTabId) await bgMessage({ type: "CLOSE_TAB", tabId: monitorTabId });
            if (_deployTabId) {
                await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId });
                await wait(600);
            }
            return; // ✅ success — back to main loop
        }

        // ── 5b. Not confirmed — close tab and maybe retry ───
        sendStatus(`Drop ${drop}: ⚠️ Queues not resumed yet (attempt ${attempt}/${MAX_ATTEMPTS}) — closing monitor tab…`);
        updateMainCard(drop, displayTotal,
            `⚠️ Not resumed (attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong>)${attempt < MAX_ATTEMPTS ? ' — retrying…' : ' — STOPPING'}`,
            'amber', '⚠️');

        if (monitorTabId) await bgMessage({ type: "CLOSE_TAB", tabId: monitorTabId });
        if (_deployTabId) {
            await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId });
            await wait(600);
        }

        if (attempt < MAX_ATTEMPTS) {
            // Re-select IPs and re-open the modal for the next attempt
            await wait(2000);
            await selectIps(allIps);
            await wait(1000);
            await openRunCommandModalss();
        }
    }

    // ── 6. All attempts exhausted — run emergency RESUME+SCHEDULE, send Telegram alert and stop ──
    sendStatus(`Drop ${drop}: ❌ Servers did NOT resume after ${MAX_ATTEMPTS} attempts — running emergency RESUME+SCHEDULE…`);
    updateMainCard(drop, displayTotal,
        `❌ Servers did not resume after <strong>${MAX_ATTEMPTS} attempts</strong>.<br>Running emergency <strong>RESUME+SCHEDULE</strong>…`,
        'red', '🚨');

    try {
        _forceCloseAllModals();
        await wait(800);
        await selectIps(allIps);
        await wait(1000);
        await openRunCommandModalss();
        await executeRunCommandModal(`Emergency RESUME+SCHEDULE (resume failure)`, 2);
        sendStatus(`Drop ${drop}: Emergency RESUME+SCHEDULE completed — sending Telegram alert…`);
    } catch (resumeErr) {
        console.warn('[executeResumeAndVerify] Emergency RESUME+SCHEDULE failed:', resumeErr);
    }

    updateMainCard(drop, displayTotal,
        `❌ Resume failure — sending <strong>Telegram alert</strong>…`,
        'red', '🚨');

    const now  = new Date();
    const pad  = n => String(n).padStart(2, '0');
    const dt   = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const div  = '='.repeat(42);
    // Pick a random server name from the IPs list to include in the alert
    const _resumeServers = [...new Set(allIps.map(ip => (typeof _ipServerMap !== 'undefined' && _ipServerMap[ip]) || '').filter(Boolean))];
    const _resumeRandSrv = _resumeServers.length > 0 ? _resumeServers[Math.floor(Math.random() * _resumeServers.length)] : '';
    const alertLines = [
        `🚨  WARMUP CONTROLLER — RESUME FAILURE`,
        div,
        `Date / Time  :  ${dt}`,
        ...(_resumeRandSrv ? [`Server       :  ${_resumeRandSrv}`] : []),
        div,
        `Drop         :  ${tgDrop} / ${tgTotal}`,
        `Attempts     :  ${MAX_ATTEMPTS} × 2 clicks`,
        ``,
        `The queues gmail.com/gmail-*, gmail.queue/gmail-*, googlemail.com/gmail-*`,
        `did NOT show Paused = no in any iframe after ${MAX_ATTEMPTS} attempts.`,
        ``,
        `An emergency RESUME+SCHEDULE was executed before stopping.`,
        `The warmup process has been STOPPED automatically.`,
        div,
        `This message was sent automatically by the Warmup Extension.`,
    ];
    const alertText = '```\n' + alertLines.join('\n') + '\n```';

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify({ chat_id: telegramChatId, text: alertText, parse_mode: 'Markdown' })
        });
    } catch (tgErr) {
        console.warn('[executeResumeAndVerify] Telegram alert failed:', tgErr);
    }

    // Stop the entire session
    _processState = "stopped";
    throw new ProcessStoppedError();
}

// -------------------------------------------------------
// EXECUTE VIA MULTIMONITOR RUN CMDS
// -------------------------------------------------------
// Opens the MultiMonitor tab (which must already be accessible via
// the "#ips_by_classes_ms-multi-monitors" button), sends a
// RUN_CMDS_VIA_MONITOR message to background to click the "Run Cmds"
// tab, check the specified cmds[] checkboxes, and click Execute once,
// then closes the monitor tab and refocuses the deploy tab.
// -------------------------------------------------------
async function executeViaMultiMonitorRunCmds(cmds, drop, displayTotal, label, jobId) {
    sendStatus(`Drop ${drop}: Opening MultiMonitor for ${label} via Run Cmds…`);
    updateMainCard(drop, displayTotal,
        `Opening monitor for <strong>${label}</strong> via Run Cmds…`,
        'blue', '🔧');

    const monitorBtn = await waitForElementVisible("#ips_by_classes_ms-multi-monitors");
    monitorBtn.click();

    sendStatus(`Drop ${drop}: Waiting for MultiMonitor tab to load…`);
    await wait(9000);

    sendStatus(`Drop ${drop}: Executing ${label} via Run Cmds iframe…`);
    updateMainCard(drop, displayTotal,
        `Running <strong>${label}</strong> via Run Cmds iframe…`,
        'blue', '🔧');

    const result = await bgMessage({ type: "RUN_CMDS_VIA_MONITOR", cmds, jobId: jobId || '' });

    if (!result || !result.success) {
        const reason = (result && result.reason) || 'unknown error';
        sendStatus(`Drop ${drop}: ⚠️ ${label} via monitor failed (${reason}) — continuing…`);
        console.warn(`[executeViaMultiMonitorRunCmds] RUN_CMDS_VIA_MONITOR failed:`, reason);
    } else {
        sendStatus(`Drop ${drop}: ✅ ${label} executed via Run Cmds.`);
    }

    await wait(6000);

    const monitorTabId = result && result.tabId ? result.tabId : null;
    if (monitorTabId) {
        await bgMessage({ type: "CLOSE_TAB", tabId: monitorTabId });
    }
    if (_deployTabId) {
        await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId });
        await wait(600);
    }
}

// -------------------------------------------------------
// PAUSE-AND-VERIFY via MultiMonitor Run Cmds
// -------------------------------------------------------
// Used when "PAUSE/RESUME FROM MultiMonitors" toggle is ON.
// Replaces openRunCommandModal() + executePauseAndVerify().
//
// Flow (up to MAX_ATTEMPTS times):
//   1. Run PAUSE+DELETE+RESET+SCHEDULE via MultiMonitor Run Cmds
//   2. Open MultiMonitor → wait 9 s for iframes to render
//   3. Ask background to navigate iframes to Queues and check pause
//   4a. Paused confirmed → close monitor tab → return
//   4b. Not confirmed → close monitor tab → retry from step 1
//   5. After MAX_ATTEMPTS failures → emergency RESUME+SCHEDULE via
//      MultiMonitor, send Telegram alert, throw ProcessStoppedError
// -------------------------------------------------------
async function executePauseAndVerifyViaMonitor(drop, displayTotal, allIps, tgDrop, tgTotal, telegramChatId) {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {

        // ── 1. Run PAUSE+DELETE+RESET+SCHEDULE via MultiMonitor Run Cmds ─
        sendStatus(`Drop ${drop}: PAUSE/DELETE/RESET/SCHEDULE via MultiMonitor — attempt ${attempt}/${MAX_ATTEMPTS}…`);
        updateMainCard(drop, displayTotal,
            `Attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong> — PAUSE/DELETE/RESET/SCHEDULE via MultiMonitor…`,
            'blue', '🔧');

        await executeViaMultiMonitorRunCmds(
            ['PAUSE', 'DELETE', 'RESET', 'SCHEDULE'],
            drop, displayTotal,
            'PAUSE/DELETE/RESET/SCHEDULE'
        );

        // ── 2. Open MultiMonitor tab for verification ─────────────────
        sendStatus(`Drop ${drop}: Opening MultiMonitor to verify pause (attempt ${attempt}/${MAX_ATTEMPTS})…`);
        updateMainCard(drop, displayTotal,
            `Attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong> — Opening monitor to verify pause…`,
            'amber', '🖥️');

        const monitorBtn = await waitForElementVisible("#ips_by_classes_ms-multi-monitors");
        monitorBtn.click();

        sendStatus(`Drop ${drop}: Waiting for MultiMonitor tab to open…`);
        await wait(9000);

        // ── 3. Check pause status via background ──────────────────────
        sendStatus(`Drop ${drop}: Navigating iframes to Queues & checking pause status…`);
        const checkResult = await bgMessage({ type: "CHECK_PAUSE_STATUS", allIps, rateCheckIps: _rateCheckIps });

        const monitorTabId = checkResult ? checkResult.tabId : null;

        // ── 4a. Paused confirmed ──────────────────────────────────────
        if (checkResult && checkResult.paused) {
            sendStatus(`Drop ${drop}: ✅ Pause confirmed — closing monitor tab…`);
            updateMainCard(drop, displayTotal,
                `✅ Pause confirmed on attempt <strong>${attempt}</strong> — continuing…`,
                'green', '✅');

            if (monitorTabId) {
                await bgMessage({ type: "CLOSE_TAB", tabId: monitorTabId });
            }
            if (_deployTabId) {
                await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId });
                await wait(600);
            }
            return;
        }

        // ── 4b. Not confirmed — close tab and maybe retry ────────────
        sendStatus(`Drop ${drop}: ⚠️ Queues not paused yet (attempt ${attempt}/${MAX_ATTEMPTS}) — closing monitor tab…`);
        updateMainCard(drop, displayTotal,
            `⚠️ Not paused (attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong>)${attempt < MAX_ATTEMPTS ? ' — retrying…' : ' — STOPPING'}`,
            'amber', '⚠️');

        if (monitorTabId) {
            await bgMessage({ type: "CLOSE_TAB", tabId: monitorTabId });
        }
        if (_deployTabId) {
            await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId });
            await wait(600);
        }

        if (attempt < MAX_ATTEMPTS) {
            await wait(2000);
        }
    }

    // ── 5. All attempts exhausted — run emergency RESUME+SCHEDULE, send Telegram alert and stop ──
    sendStatus(`Drop ${drop}: ❌ Servers did NOT pause after ${MAX_ATTEMPTS} attempts — running emergency RESUME+SCHEDULE…`);
    updateMainCard(drop, displayTotal,
        `❌ Servers did not pause after <strong>${MAX_ATTEMPTS} attempts</strong>.<br>Running emergency <strong>RESUME+SCHEDULE</strong>…`,
        'red', '🚨');

    try {
        await executeViaMultiMonitorRunCmds(['RESUME', 'SCHEDULE'], drop, displayTotal, 'Emergency RESUME+SCHEDULE');
        sendStatus(`Drop ${drop}: Emergency RESUME+SCHEDULE completed — sending Telegram alert…`);
    } catch (resumeErr) {
        console.warn('[executePauseAndVerifyViaMonitor] Emergency RESUME+SCHEDULE failed:', resumeErr);
    }

    updateMainCard(drop, displayTotal,
        `❌ Pause failure — sending <strong>Telegram alert</strong>…`,
        'red', '🚨');

    const now   = new Date();
    const pad   = n => String(n).padStart(2, '0');
    const dt    = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const div   = '='.repeat(42);
    const _pauseServers = [...new Set(allIps.map(ip => (typeof _ipServerMap !== 'undefined' && _ipServerMap[ip]) || '').filter(Boolean))];
    const _pauseRandSrv = _pauseServers.length > 0 ? _pauseServers[Math.floor(Math.random() * _pauseServers.length)] : '';
    const alertLines = [
        `🚨  WARMUP CONTROLLER — PAUSE FAILURE`,
        div,
        `Date / Time  :  ${dt}`,
        ...(_pauseRandSrv ? [`Server       :  ${_pauseRandSrv}`] : []),
        div,
        `Drop         :  ${tgDrop} / ${tgTotal}`,
        `Attempts     :  ${MAX_ATTEMPTS} (via MultiMonitor Run Cmds)`,
        ``,
        `The queues gmail.com/*, gmail.queue/*, googlemail.com/*`,
        `did NOT show Paused = yes in any iframe after ${MAX_ATTEMPTS} attempts.`,
        ``,
        `An emergency RESUME+SCHEDULE was executed before stopping.`,
        `The warmup process has been STOPPED automatically.`,
        div,
        `This message was sent automatically by the Warmup Extension.`,
    ];
    const alertText = '```\n' + alertLines.join('\n') + '\n```';

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify({ chat_id: telegramChatId, text: alertText, parse_mode: 'Markdown' })
        });
    } catch (tgErr) {
        console.warn('[executePauseAndVerifyViaMonitor] Telegram alert failed:', tgErr);
    }

    _processState = "stopped";
    throw new ProcessStoppedError();
}

// -------------------------------------------------------
// RESUME-AND-VERIFY via MultiMonitor Run Cmds
// -------------------------------------------------------
// Used when "PAUSE/RESUME FROM MultiMonitors" toggle is ON.
// Replaces openRunCommandModalss() + executeResumeAndVerify().
//
// Flow (up to MAX_ATTEMPTS times):
//   1. Run RESUME+SCHEDULE via MultiMonitor Run Cmds
//   2. Open MultiMonitor → wait 9 s for iframes to render
//   3. Ask background to navigate iframes to Queues and check resume
//   4a. Resumed confirmed → close monitor tab → return
//   4b. Not confirmed → close monitor tab → retry from step 1
//   5. After MAX_ATTEMPTS failures → emergency RESUME+SCHEDULE via
//      MultiMonitor, send Telegram alert, throw ProcessStoppedError
// -------------------------------------------------------
async function executeResumeAndVerifyViaMonitor(drop, displayTotal, allIps, tgDrop, tgTotal, telegramChatId) {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {

        // ── 1. Run RESUME+SCHEDULE via MultiMonitor Run Cmds ─────────
        sendStatus(`Drop ${drop}: RESUME+SCHEDULE via MultiMonitor — attempt ${attempt}/${MAX_ATTEMPTS}…`);
        updateMainCard(drop, displayTotal,
            `Attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong> — RESUME+SCHEDULE via MultiMonitor…`,
            'purple', '▶️');

        await executeViaMultiMonitorRunCmds(
            ['RESUME', 'SCHEDULE'],
            drop, displayTotal,
            'RESUME+SCHEDULE'
        );

        // ── 2. Open MultiMonitor tab for verification ─────────────────
        sendStatus(`Drop ${drop}: Opening MultiMonitor to verify resume (attempt ${attempt}/${MAX_ATTEMPTS})…`);
        updateMainCard(drop, displayTotal,
            `Attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong> — Opening monitor to verify resume…`,
            'green', '🖥️');

        const monitorBtn = await waitForElementVisible("#ips_by_classes_ms-multi-monitors");
        monitorBtn.click();

        sendStatus(`Drop ${drop}: Waiting for MultiMonitor tab to open…`);
        await wait(9000);

        // ── 3. Check resume status via background ─────────────────────
        sendStatus(`Drop ${drop}: Navigating iframes to Queues & checking resume status…`);
        const checkResult = await bgMessage({ type: "CHECK_RESUME_STATUS", allIps, rateCheckIps: _rateCheckIps });

        const monitorTabId = checkResult ? checkResult.tabId : null;

        // ── 4a. Resumed confirmed ─────────────────────────────────────
        if (checkResult && checkResult.resumed) {
            sendStatus(`Drop ${drop}: ✅ Resume confirmed — closing monitor tab…`);
            updateMainCard(drop, displayTotal,
                `✅ Resume confirmed on attempt <strong>${attempt}</strong> — continuing…`,
                'green', '✅');

            if (monitorTabId) await bgMessage({ type: "CLOSE_TAB", tabId: monitorTabId });
            if (_deployTabId) {
                await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId });
                await wait(600);
            }
            return;
        }

        // ── 4b. Not confirmed — close tab and maybe retry ────────────
        sendStatus(`Drop ${drop}: ⚠️ Queues not resumed yet (attempt ${attempt}/${MAX_ATTEMPTS}) — closing monitor tab…`);
        updateMainCard(drop, displayTotal,
            `⚠️ Not resumed (attempt <strong>${attempt}/${MAX_ATTEMPTS}</strong>)${attempt < MAX_ATTEMPTS ? ' — retrying…' : ' — STOPPING'}`,
            'amber', '⚠️');

        if (monitorTabId) await bgMessage({ type: "CLOSE_TAB", tabId: monitorTabId });
        if (_deployTabId) {
            await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId });
            await wait(600);
        }

        if (attempt < MAX_ATTEMPTS) {
            await wait(2000);
        }
    }

    // ── 5. All attempts exhausted — run emergency RESUME+SCHEDULE, send Telegram alert and stop ──
    sendStatus(`Drop ${drop}: ❌ Servers did NOT resume after ${MAX_ATTEMPTS} attempts — running emergency RESUME+SCHEDULE…`);
    updateMainCard(drop, displayTotal,
        `❌ Servers did not resume after <strong>${MAX_ATTEMPTS} attempts</strong>.<br>Running emergency <strong>RESUME+SCHEDULE</strong>…`,
        'red', '🚨');

    try {
        await executeViaMultiMonitorRunCmds(['RESUME', 'SCHEDULE'], drop, displayTotal, 'Emergency RESUME+SCHEDULE');
        sendStatus(`Drop ${drop}: Emergency RESUME+SCHEDULE completed — sending Telegram alert…`);
    } catch (resumeErr) {
        console.warn('[executeResumeAndVerifyViaMonitor] Emergency RESUME+SCHEDULE failed:', resumeErr);
    }

    updateMainCard(drop, displayTotal,
        `❌ Resume failure — sending <strong>Telegram alert</strong>…`,
        'red', '🚨');

    const now  = new Date();
    const pad  = n => String(n).padStart(2, '0');
    const dt   = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const div  = '='.repeat(42);
    const _resumeServers = [...new Set(allIps.map(ip => (typeof _ipServerMap !== 'undefined' && _ipServerMap[ip]) || '').filter(Boolean))];
    const _resumeRandSrv = _resumeServers.length > 0 ? _resumeServers[Math.floor(Math.random() * _resumeServers.length)] : '';
    const alertLines = [
        `🚨  WARMUP CONTROLLER — RESUME FAILURE`,
        div,
        `Date / Time  :  ${dt}`,
        ...(_resumeRandSrv ? [`Server       :  ${_resumeRandSrv}`] : []),
        div,
        `Drop         :  ${tgDrop} / ${tgTotal}`,
        `Attempts     :  ${MAX_ATTEMPTS} (via MultiMonitor Run Cmds)`,
        ``,
        `The queues gmail.com/gmail-*, gmail.queue/gmail-*, googlemail.com/gmail-*`,
        `did NOT show Paused = no in any iframe after ${MAX_ATTEMPTS} attempts.`,
        ``,
        `An emergency RESUME+SCHEDULE was executed before stopping.`,
        `The warmup process has been STOPPED automatically.`,
        div,
        `This message was sent automatically by the Warmup Extension.`,
    ];
    const alertText = '```\n' + alertLines.join('\n') + '\n```';

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify({ chat_id: telegramChatId, text: alertText, parse_mode: 'Markdown' })
        });
    } catch (tgErr) {
        console.warn('[executeResumeAndVerifyViaMonitor] Telegram alert failed:', tgErr);
    }

    _processState = "stopped";
    throw new ProcessStoppedError();
}

// -------------------------------------------------------
// SCHEDULE via MultiMonitor "Run Cmds" iframe
// -------------------------------------------------------
// New flow (replaces the old deploy-page modal loop):
//   1. Open the MultiMonitor tab (same button as for queue reading).
//   2. Wait 9 s for the tab to render.
//   3. Calculate numClicks = floor(durationSecs / 20), min 1.
//      Example: durationSecs=120 (2 min) → 6 clicks.
//   4. Ask background to:
//        a. Click the "Run Cmds" tab on the first panel that has a
//           #runcmd-iframe → this shows the FrameSide iframe.
//        b. Wait 8 s for the iframe to load.
//        c. Inside the iframe: uncheck all, check SCHEDULE, ensure all
//           domain checkboxes are checked, then click Execute numClicks
//           times, with 20 s between each click.
//   5. Wait another 6 s for results to settle.
//   6. Close the monitor tab, focus the deploy tab.
//   7. Show a countdown for the remainder of durationSecs while waiting.
// -------------------------------------------------------
async function repeatScheduleForDuration(allIps, drop, displayTotal, durationSecs) {
    updateMainCard(drop, displayTotal,
        `Opening monitor for <strong>SCHEDULE</strong> via Run Cmds…`,
        'purple', '🔁');

    showCountdownCard(durationSecs, drop, displayTotal, 'SCHEDULE via Run Cmds — before monitor');

    // ── Open MultiMonitor tab ────────────────────────────────
    sendStatus(`Drop ${drop}: Opening MultiMonitor for SCHEDULE (Run Cmds)…`);
    const monitorBtn = await waitForElementVisible("#ips_by_classes_ms-multi-monitors");
    monitorBtn.click();

    sendStatus(`Drop ${drop}: Waiting for MultiMonitor tab to load…`);
    await wait(9000);

    // ── Calculate how many SCHEDULE clicks fit in durationSecs ─
    // Each click is separated by 20 s; minimum 1 click.
    // Example: durationSecs=120 (2 min) → floor(120/20)=6 clicks.
    const CLICK_INTERVAL_SECS = 20;
    const numClicks = Math.max(1, Math.floor(durationSecs / CLICK_INTERVAL_SECS));

    // ── Ask background to perform the full schedule sequence ─
    sendStatus(`Drop ${drop}: Clicking Run Cmds tab & executing SCHEDULE (${numClicks} click(s) × ${CLICK_INTERVAL_SECS}s)…`);
    updateMainCard(drop, displayTotal,
        `Running <strong>SCHEDULE</strong> via Run Cmds iframe — <strong>${numClicks}</strong> click(s) × ${CLICK_INTERVAL_SECS}s…`,
        'purple', '🔁');

    const schedResult = await bgMessage({ type: "SCHEDULE_VIA_MONITOR", numClicks });

    if (!schedResult || !schedResult.success) {
        const reason = (schedResult && schedResult.reason) || 'unknown error';
        sendStatus(`Drop ${drop}: ⚠️ SCHEDULE via monitor failed (${reason}) — continuing anyway…`);
        console.warn('[repeatScheduleForDuration] SCHEDULE_VIA_MONITOR failed:', reason);
    } else {
        sendStatus(`Drop ${drop}: ✅ SCHEDULE executed (${numClicks} click(s)) via Run Cmds iframe.`);
        updateMainCard(drop, displayTotal,
            `<strong>SCHEDULE</strong> done (${numClicks} click(s) via Run Cmds) — waiting before monitor read…`,
            'green', '✅');
    }

    // ── Brief settle wait after last click ───────────────────
    await wait(6000);

    // ── Close monitor tab & refocus deploy tab ────────────────
    const monitorTabId = schedResult && schedResult.tabId ? schedResult.tabId : null;
    if (monitorTabId) {
        await bgMessage({ type: "CLOSE_TAB", tabId: monitorTabId });
    }
    if (_deployTabId) {
        await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId });
        await wait(600);
    }

    // ── Burn the remaining durationSecs as a countdown ───────
    // Total elapsed so far: 9s (tab load) + 8s (iframe load) +
    // numClicks clicks with (numClicks-1) × 20s gaps + 6s settle.
    // elapsed = 9 + 8 + (numClicks - 1) * 20 + 6 = 23 + (numClicks - 1) * 20
    const elapsedApproxSecs = 23 + (numClicks - 1) * CLICK_INTERVAL_SECS;
    const remainingSecs = Math.max(0, durationSecs - elapsedApproxSecs);

    if (remainingSecs > 0) {
        removeCountdownCard();
        showCountdownCard(remainingSecs, drop, displayTotal, 'After SCHEDULE — waiting before monitor read');
        sendStatus(`Drop ${drop}: Waiting ${fmtTime(remainingSecs)} after SCHEDULE…`);
        await pauseAwareWait(remainingSecs * 1000, drop, displayTotal, 'After SCHEDULE — waiting before monitor read');
    }

    removeCountdownCard();
}

// -------------------------------------------------------
// Build groups from current ipState targets
// -------------------------------------------------------
function buildCurrentGroups(ipState, allowedIps = null) {
    const grouped = {};
    for (const [ip, state] of Object.entries(ipState)) {
        if (allowedIps && !allowedIps.has(ip)) continue; // skip excluded IPs
        const t = state.target;
        if (!grouped[t]) grouped[t] = [];
        grouped[t].push(ip);
    }
    return Object.entries(grouped)
        .map(([value, ips]) => ({ value: parseInt(value), ips }))
        .sort((a, b) => a.value - b.value);
}

// -------------------------------------------------------
// Run send groups for one drop
// -------------------------------------------------------
async function runDropSend(currentGroups, drop, displayTotal, startOffset = 0) {
    let cumulativeOffset = startOffset;

    for (let gi = 0; gi < currentGroups.length; gi++) {
        const { value, ips } = currentGroups[gi];

        updateMainCard(drop, displayTotal,
            `Sending group <strong>${gi + 1} / ${currentGroups.length}</strong><br>
             <strong>${ips.length}</strong> IP${ips.length > 1 ? 's' : ''} · <strong>${value.toLocaleString()}</strong> each`,
            'blue', '📤');

        _forceCloseAllModals();
        await wait(800);

        sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Selecting ${ips.length} IPs…`);
        await selectIps(ips);

        const limitValue = ips.length * value;

        if (limitValue <= 0) {
            sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: ⚠️ limit=0 (${ips.length} IPs × target ${value}) — skipping group`);
            console.warn(`[runDropSend] limitValue=0 for group ${gi+1} — skipped`);
            await wait(randomDelay());
            await checkPauseOrStop();
            continue;
        }

        sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Filling offset=${cumulativeOffset} limit=${limitValue}…`);
        const offsetInput = await waitForElement("#offset");
        const limitInput  = await waitForElement("#limit");

        offsetInput.value = 0;
        offsetInput.dispatchEvent(new Event("input",  { bubbles: true }));
        offsetInput.dispatchEvent(new Event("change", { bubbles: true }));

        limitInput.value  = limitValue;
        limitInput.dispatchEvent(new Event("input",  { bubbles: true }));
        limitInput.dispatchEvent(new Event("change", { bubbles: true }));

        await wait(800);
        cumulativeOffset += limitValue;

        sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Clicking send…`);
        const sendBtn = await waitForElement("#send-button");
        await wait(600);

        const MODAL_WAIT_MS  = 2 * 60 * 1000;
        const MODAL_POLL_MS  = 400;
        const TOTAL_LIMIT_MS = 60 * 60 * 1000;

        const overallDeadline = Date.now() + TOTAL_LIMIT_MS;

        sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Waiting for modal or toast…`);

        let sendResult = null;
        let attempt    = 0;

        while (!sendResult) {
            attempt++;

            sendBtn.click();
            sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

            sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: ${attempt === 1 ? 'Waiting' : `Re-click #${attempt} — waiting`} up to 2 min for modal or toast…`);

            sendResult = await new Promise(resolve => {
                const deadline = Date.now() + MODAL_WAIT_MS;
                const timer    = setInterval(() => {
                    const toastMsg  = document.querySelector('.toast-message');
                    const toastSeen = !!(toastMsg && toastMsg.textContent.includes('Deploy has been successfully sent'));

                    const modal = document.querySelector('.modal.in, .modal.show');
                    if (modal) {
                        const hasContent =
                            modal.querySelector('.modal-content') ||
                            modal.querySelector('.modal-body');
                        if (hasContent) {
                            clearInterval(timer);
                            resolve({ modal, toast: toastSeen });
                            return;
                        }
                    }

                    if (toastSeen) {
                        clearInterval(timer);
                        resolve({ modal: null, toast: true });
                        return;
                    }

                    if (Date.now() >= deadline) {
                        clearInterval(timer);
                        resolve(null);
                    }
                }, MODAL_POLL_MS);
            });

            if (!sendResult) {
                if (Date.now() >= overallDeadline) {
                    sendStatus(`❌ No modal or toast after 1 hour — sending Telegram alert…`);
                    updateMainCard(drop, displayTotal,
                        `❌ No modal or toast after <strong>1 hour</strong> of retrying.<br>Sending Telegram alert…`,
                        'red', '🚨');

                    // Pick a random server name to include in the alert
                    const _modalFailServers = [...new Set(ips.map(ip => (typeof _ipServerMap !== 'undefined' && _ipServerMap && _ipServerMap[ip]) || '').filter(Boolean))];
                    const _modalFailRandSrv = _modalFailServers.length > 0 ? _modalFailServers[Math.floor(Math.random() * _modalFailServers.length)] : '';

                    try {
                        await sendTelegramAlert(
                            drop, displayTotal, gi + 1, currentGroups.length,
                            ips, _telegramChatId, attempt, _modalFailRandSrv
                        );
                    } catch (tgErr) {
                        console.error('[SendRetry] Telegram alert failed:', tgErr);
                    }

                    // Attempt emergency RESUME before stopping so servers are not left paused
                    try {
                        sendStatus(`❌ Send modal failure — attempting emergency RESUME before stopping…`);
                        updateMainCard(drop, displayTotal,
                            `❌ Send modal failure — running emergency <strong>RESUME</strong>…`,
                            'red', '🚨');
                        _forceCloseAllModals();
                        await wait(800);
                        // allIps is accessible via closure in runDropSend
                        const _resumeAllIps = (typeof allIps !== 'undefined' && allIps.length > 0) ? allIps : ips;
                        await selectIps(_resumeAllIps);
                        await wait(1000);
                        await openRunCommandModalss();
                        await executeRunCommandModal(`Emergency RESUME (send modal failure)`, 2);
                        sendStatus(`Emergency RESUME completed — stopping process.`);
                    } catch (resumeErr) {
                        console.warn('[SendRetry] Emergency RESUME failed:', resumeErr);
                    }

                    throw new Error(
                        `No modal or toast after 1 hour of retrying (2 min per attempt, ${attempt} attempts). ` +
                        `Group ${gi+1}/${currentGroups.length}, IPs: ${ips.join(', ')}`
                    );
                }

                const elapsedMin = Math.floor((Date.now() - (overallDeadline - TOTAL_LIMIT_MS)) / 60000);
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Nothing seen — retrying (attempt ${attempt}, ${elapsedMin}m / 60m elapsed)…`);
                await wait(1500);
            }
        }

        if (sendResult.modal) {
            sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Closing report modal…`);
            const closeBtn = await waitForChildElement(sendResult.modal, ".modal-header button.close[data-dismiss='modal']", 15000);
            await wait(600);
            await _closeModalAndWait(closeBtn, 8000);
            await wait(400);
        } else {
            sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: ✅ Toast detected — waiting up to 5s for modal…`);
            const lateModal = await new Promise(resolve => {
                const deadline = Date.now() + 5000;
                const t = setInterval(() => {
                    const m = document.querySelector('.modal.in, .modal.show');
                    if (m && (m.querySelector('.modal-content') || m.querySelector('.modal-body'))) {
                        clearInterval(t);
                        resolve(m);
                        return;
                    }
                    if (Date.now() >= deadline) { clearInterval(t); resolve(null); }
                }, 300);
            });

            if (lateModal) {
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Modal appeared — closing it…`);
                const closeBtn = await waitForChildElement(lateModal, ".modal-header button.close[data-dismiss='modal']", 10000);
                await wait(600);
                await _closeModalAndWait(closeBtn, 8000);
            } else {
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: ✅ No modal after 5s — moving on…`);
                _forceCloseAllModals();
            }

            await wait(400);
        }

        await wait(randomDelay());
        await checkPauseOrStop();
    }

    return cumulativeOffset;
}

// -------------------------------------------------------
// Apply all three selects for a given ISP entry { mode, value }
//
// mode = 'warmup':
//   data_providers  → option containing "Seeds"
//   data_profiles   → option containing "Seeds_Tss" (case-insensitive)
//   data_profile_isps → exact match on entry.value
//
// mode = 'passive':
//   data_providers  → option containing "data_TSS"
//   data_profiles   → option containing "Seeds"
//   data_profile_isps → exact match on entry.value
// -------------------------------------------------------
// ispOnly = true  → only reselect #data_profile_isps (used by resetIspProfile when
//                   staying on the same list — no page reload needed, ListsCount
//                   never changes mid-drop so there is nothing else to update).
// ispOnly = false → full apply: provider → profile → isp (used when switching lists
//                   or applying the entry for the first time each drop).
async function _applyIspEntry(drop, entry, ispOnly = false) {
    const { mode, value } = entry;

    if (!ispOnly) {
    if (mode === 'warmup') {
        // Data Provider: ONLY "Seeds" — never falls back to "data_TSS"
        const providerSel = document.getElementById('data_providers');
        if (providerSel) {
            const opt = Array.from(providerSel.options).find(o => o.text.trim().includes('Seeds'));
            if (opt) {
                providerSel.value = opt.value;
                providerSel.dispatchEvent(new Event('change', { bubbles: true }));
                sendStatus(`Drop ${drop}: [Warmup] Data Provider → "${opt.text}"…`);
            } else {
                sendStatus(`Drop ${drop}: ⚠️ [Warmup] No option containing "Seeds" in #data_providers`);
            }
        }
        await _waitForPageLoad(30000);
        await _waitForListsCount(30000);
        await checkPauseOrStop();

        // Data Profile: ONLY "seeds_TSS" (case-insensitive) — never falls back to plain "Seeds"
        const profileSel = document.getElementById('data_profiles');
        if (profileSel) {
            const opt = Array.from(profileSel.options).find(o => /seeds_tss/i.test(o.text.trim()));
            if (opt) {
                profileSel.value = opt.value;
                profileSel.dispatchEvent(new Event('change', { bubbles: true }));
                sendStatus(`Drop ${drop}: [Warmup] Data Profile → "${opt.text}"…`);
            } else {
                sendStatus(`Drop ${drop}: ⚠️ [Warmup] No option matching "seeds_TSS" in #data_profiles`);
            }
        }
        await _waitForPageLoad(30000);
        await _waitForListsCount(30000);
        await checkPauseOrStop();

    } else {
        // mode === 'passive'

        // Data Provider: ONLY "data_TSS" — never falls back to "Seeds"
        const providerSel = document.getElementById('data_providers');
        if (providerSel) {
            const opt = Array.from(providerSel.options).find(o => o.text.trim().includes('data_TSS'));
            if (opt) {
                providerSel.value = opt.value;
                providerSel.dispatchEvent(new Event('change', { bubbles: true }));
                sendStatus(`Drop ${drop}: [Passive] Data Provider → "${opt.text}"…`);
            } else {
                sendStatus(`Drop ${drop}: ⚠️ [Passive] No option containing "data_TSS" in #data_providers`);
            }
        }
        await _waitForPageLoad(30000);
        await _waitForListsCount(30000);
        await checkPauseOrStop();

        // Data Profile: plain "Seeds" ONLY — explicitly excludes "seeds_TSS"
        const profileSel = document.getElementById('data_profiles');
        if (profileSel) {
            const opt = Array.from(profileSel.options).find(o => {
                const t = o.text.trim();
                return t.includes('Seeds') && !/seeds_tss/i.test(t);
            });
            if (opt) {
                profileSel.value = opt.value;
                profileSel.dispatchEvent(new Event('change', { bubbles: true }));
                sendStatus(`Drop ${drop}: [Passive] Data Profile → "${opt.text}"…`);
            } else {
                sendStatus(`Drop ${drop}: ⚠️ [Passive] No option containing "Seeds" (excluding seeds_TSS) in #data_profiles`);
            }
        }
        await _waitForPageLoad(30000);
        await _waitForListsCount(30000);
        await checkPauseOrStop();
    }
} else {
    sendStatus(`Drop ${drop}: ISP-only reset — skipping Data Provider/Profile reselect (same list, no page reload needed).`);
}

    // ── ISP Profile: exact match on entry.value (always) ──────────────────
    const ispSel = document.getElementById('data_profile_isps');
    if (ispSel) {
        const kw  = (value || '').trim();
        const opt = kw
            ? Array.from(ispSel.options).find(o => o.text.trim() === kw)
            : null;
        if (opt) {
            ispSel.value = opt.value;
            ispSel.dispatchEvent(new Event('change', { bubbles: true }));
            sendStatus(`Drop ${drop}: ISP Profile → "${opt.text}"…`);
        } else {
            sendStatus(`Drop ${drop}: ⚠️ No ISP Profile option with exact value "${kw}"`);
        }
    }
    await _waitForPageLoad(30000);
    await _waitForListsCount(30000);
    // ── Verify the ISP Profile selection actually stuck ────────
    // After a page reload (triggered by Data Provider / Profile change),
    // the ISP Profile select can silently revert to a previous or empty
    // value.  _verifyIspSelection re-checks and re-applies up to 3 times.
    await _verifyIspSelection(drop, entry);
    await checkPauseOrStop();
}

// -------------------------------------------------------
// ISP Profile reset (mid-drop, between groups, SAME list)
// Only reselects #data_profile_isps — skips provider/profile
// because those selects trigger a full page reload and the
// ListsCount never changes while we stay on the same entry.
// When switching to a DIFFERENT entry, call _applyIspEntry
// directly with ispOnly=false (the default).
// -------------------------------------------------------
async function resetIspProfile(drop, displayTotal, entry) {
    if (!entry) return;
    const modeLabel = entry.mode === 'passive' ? 'Passive' : 'Warmup';
    sendStatus(`Drop ${drop}: Resetting ISP Profile [${modeLabel}] "${entry.value}" (ISP select only)…`);
    updateMainCard(drop, displayTotal,
        `Resetting <strong>ISP Profile</strong> [${modeLabel}] — "${entry.value}"…`,
        'purple', '🔄');

    // ispOnly=true: only touch data_profile_isps, no provider/profile reload
    await _applyIspEntry(drop, entry, true);
    sendStatus(`Drop ${drop}: ISP Profile reset complete.`);
}

// -------------------------------------------------------
// Helper: read the current lists count from #data_lists_counts
// Returns 0 if the element is absent or the value cannot be parsed.
// IMPORTANT: We round DOWN to the nearest 1000 so we never exceed the
// real count, but we keep the raw value if it is above 0 yet below 1000
// (treat it as 1 000 minimum) to avoid returning 0 on a non-empty list.
// -------------------------------------------------------
function _readListsCount() {
    const sel = document.getElementById('data_lists_counts');
    if (!sel) return 0;
    // Parse the number from the selected option text, e.g. "ALL(98)" → 98.
    const opt  = sel.options[sel.selectedIndex] || sel.options[0];
    const text = (opt && opt.text) || '';
    const m    = text.match(/\((\d+)\)/);
    const raw  = m ? parseInt(m[1]) : (parseInt(sel.value) || 0);
    // Return the exact count — no rounding. Even small lists (e.g. 98) are valid
    // and will be handled by the wrapping logic in the send loop.
    return raw > 0 ? raw : 0;
}

// -------------------------------------------------------
// Helper: wait for the page-loading spinner to disappear
// -------------------------------------------------------
async function _waitForPageLoad(maxWaitMs = 60000) {
    await new Promise(resolve => {
        const POLL_MS  = 300;
        const deadline = Date.now() + maxWaitMs;
        setTimeout(function poll() {
            const spinner = document.querySelector('.page-loading');
            if (!spinner || getComputedStyle(spinner).display === 'none') { resolve(); return; }
            if (Date.now() >= deadline) { resolve(); return; }
            setTimeout(poll, POLL_MS);
        }, 800);
    });
}

// -------------------------------------------------------
// Wait until #data_lists_counts has an option whose text
// contains "ALL" (meaning the list options have fully loaded).
// Falls back after maxWaitMs so the process never hangs.
// -------------------------------------------------------
async function _waitForListsCount(maxWaitMs = 30000) {
    const POLL_MS  = 300;
    const deadline = Date.now() + maxWaitMs;
    await new Promise(resolve => {
        function poll() {
            const sel = document.getElementById('data_lists_counts');
            if (sel) {
                const hasAll = Array.from(sel.options).some(o => o.text.toUpperCase().includes('ALL'));
                if (hasAll) { resolve(); return; }
            }
            if (Date.now() >= deadline) { resolve(); return; }
            setTimeout(poll, POLL_MS);
        }
        setTimeout(poll, 300);
    });
}

// -------------------------------------------------------
// Run send groups for one drop — Data Lists mode
// -------------------------------------------------------
// ispEntries: ordered array of { mode, value } from the popup.
//
// State machine:
//   _currentEntryIndex tracks which entry is active across drops
//   (stored on the function object so it persists across calls).
//   The process stays on the current entry while listsCount > 0.
//   When listsCount = 0, it advances to the next entry.
//   The last entry (typically passive) is never advanced past —
//   it is used for all remaining drops once reached.
//
// On each drop:
//   1. Apply the current entry's three selects.
//   2. Read listsCount.
//   3. If listsCount = 0 AND not already on last entry → advance entry, re-apply, re-read.
//   4. Run send groups using that listsCount.
//   5. Between groups: resetIspProfile(currentEntry) to refresh mid-drop.
// -------------------------------------------------------
// -------------------------------------------------------
async function runDropSendDataLists(currentGroups, drop, displayTotal, startOffset = 0, ispEntries = [], tgDrop = drop, tgTotal = displayTotal, telegramChatId = _telegramChatId, shuffleMode = false) {

    // recordSent is now fired immediately after each group — no pending list needed.

    // Persistent entry index across drops (stored on function object)
    if (runDropSendDataLists._entryIndex === undefined) {
        runDropSendDataLists._entryIndex = 0;
    }

    const entries    = ispEntries && ispEntries.length > 0 ? ispEntries : [{ mode: 'warmup', value: '' }];
    const lastIndex  = entries.length - 1;

    // ── 1. Apply current entry & read listsCount ──────────────
    let entryIndex  = runDropSendDataLists._entryIndex;
    // Clamp in case entries were reduced
    if (entryIndex > lastIndex) entryIndex = lastIndex;

    // Snapshot of which entry we were on when this drop started. Used later to
    // decide whether the running offset should carry over (same list) or reset
    // to 0 (we ended up on a different list — a fresh list has no prior position).
    const _entryIndexAtDropStart = entryIndex;

    // ── Check server remaining quota before applying entry ────
    // If the current entry's quota is exhausted (remaining <= 0), advance.
    // SKIPPED in shuffle mode — the caller already assigned the correct entry
    // for this drop and we must not let quota logic override that assignment.
    if (!shuffleMode) {
        while (entryIndex < lastIndex) {
            const entry = entries[entryIndex];
            if (entry.mode === 'warmup' && entry.value) {
                // Wait for the cache if it hasn't populated yet (cache miss = null).
                // Never assume Infinity here — always get a real value first.
                let remaining = _getCachedRemaining(entry.value);
                if (remaining === null) {
                    sendStatus(`Drop ${drop}: Waiting for quota data for entry ${entryIndex + 1} "${entry.value}"…`);
                    remaining = await _waitForCacheReady(entry.value, 8000);
                }
                if (isFinite(remaining) && remaining <= 0) {
                    sendStatus(`Drop ${drop}: Entry ${entryIndex + 1} quota exhausted on server (remaining=${remaining}) — advancing to next entry…`);
                    entryIndex++;
                    runDropSendDataLists._entryIndex = entryIndex;
                } else {
                    break;
                }
            } else {
                break;
            }
        }
    } else {
        // Shuffle mode: the caller selected the entry, but we still verify the
        // cache has data. If remaining is 0, log a warning — the shuffle block
        // in startFullProcess should have already skipped it, but if it somehow
        // slipped through (e.g. quota just hit 0 between selection and here),
        // we report it clearly rather than silently sending.
        const _se = entries[entryIndex];
        if (_se.mode === 'warmup' && _se.value) {
            let _sr = _getCachedRemaining(_se.value);
            if (_sr === null) {
                sendStatus(`Drop ${drop}: [Shuffle] Waiting for quota data for assigned entry "${_se.value}"…`);
                _sr = await _waitForCacheReady(_se.value, 8000);
            }
            if (isFinite(_sr) && _sr <= 0) {
                sendStatus(`Drop ${drop}: [Shuffle] ⚠️ Assigned entry "${_se.value}" has remaining=${_sr} — this entry is exhausted. Check shuffle logic.`);
                console.warn(`[runDropSendDataLists][shuffle] Entry "${_se.value}" remaining=${_sr} at start of drop ${drop}`);
            }
        }
    }

    let currentEntry = entries[entryIndex];
        runDropSendDataLists._lastMode = currentEntry.mode;
    updateMainCard(drop, displayTotal,
        `Applying ISP entry <strong>${entryIndex + 1}/${entries.length}</strong> [${currentEntry.mode}] "${currentEntry.value}"…`,
        'purple', '🔄');
    sendStatus(`Drop ${drop}: Applying ISP entry ${entryIndex + 1}/${entries.length} [${currentEntry.mode}] "${currentEntry.value}"…`);

    await _applyIspEntry(drop, currentEntry);
    await checkPauseOrStop();

    // ── 2. Handle Passive Lists immediately ──
    if (currentEntry.mode === 'passive') {
                runDropSendDataLists._lastMode = 'passive';
        sendStatus(`Drop ${drop}: Passive Lists mode reached. Reverting to simple offset 0...`);
        runDropSendDataLists._lastListName  = currentEntry.value || '';
        runDropSendDataLists._lastListCount = null;
        return runDropSend(currentGroups, drop, displayTotal, 0);
    }

    // ── 3. Handle Warmup Lists logic (listsCount) ──
    let listsCount = _readListsCount();
    sendStatus(`Drop ${drop}: Lists count = ${listsCount.toLocaleString()} (entry ${entryIndex + 1}/${entries.length})`);

    // Only advance when the DOM truly shows 0 — a small but non-zero count (e.g. 98)
    // is a valid list size and must go through the wrapping logic, not be skipped.
    // SKIPPED entirely in shuffle mode — we stay on the assigned entry no matter what.
    while (!shuffleMode && listsCount <= 0 && entryIndex < lastIndex) {
        // Guard: if the API cache reports this entry still has capacity, the DOM
        // reading is likely stale or wrong — trust the API and stop advancing.
        const _curEntry = entries[entryIndex];
        if (_curEntry.mode === 'warmup' && _curEntry.value) {
            const _apiStatus = _listStatusCache[_curEntry.value];
            if (_apiStatus && _apiStatus.remaining > 0) {
                sendStatus(`Drop ${drop}: listsCount=${listsCount} = 0 but API remaining=${_apiStatus.remaining.toLocaleString()} — keeping entry ${entryIndex + 1} (DOM may be stale).`);
                break; // API says capacity exists — do not advance
            }
        }

        entryIndex++;
        currentEntry = entries[entryIndex];

        sendStatus(`Drop ${drop}: Lists count = 0 → advancing to entry ${entryIndex + 1}/${entries.length} [${currentEntry.mode}] "${currentEntry.value}"…`);
        updateMainCard(drop, displayTotal,
            `Lists count = 0 → entry <strong>${entryIndex + 1}/${entries.length}</strong> [${currentEntry.mode}] "${currentEntry.value}"…`,
            'amber', '🔄');

        await _applyIspEntry(drop, currentEntry);
        await checkPauseOrStop();

        if (currentEntry.mode === 'passive') {
            runDropSendDataLists._entryIndex = entryIndex;
                        runDropSendDataLists._lastMode = 'passive';
            sendStatus(`Drop ${drop}: Passive Lists mode reached. Reverting to simple offset 0...`);
            runDropSendDataLists._lastListName  = currentEntry.value || '';
            runDropSendDataLists._lastListCount = null;
            return runDropSend(currentGroups, drop, displayTotal, 0);
        }

        listsCount = _readListsCount();
        sendStatus(`Drop ${drop}: Lists count = ${listsCount.toLocaleString()} (entry ${entryIndex + 1}/${entries.length})`);
    }

    // ── 4. Save the active index so the next drop starts here ──
    runDropSendDataLists._entryIndex = entryIndex;
runDropSendDataLists._lastMode = 'warmup';
    // Safety fallback: only bail out if the DOM truly shows 0 (page not loaded /
    // list genuinely empty). A small non-zero count like 98 is a valid list and
    // will be handled correctly by the wrapping logic below — do NOT skip it.
    if (listsCount <= 0) {
        sendStatus(`Drop ${drop}: ⚠️ Lists count = 0 on last entry — falling back to simple offset 0.`);
        runDropSendDataLists._lastListName  = currentEntry.value || '';
        runDropSendDataLists._lastListCount = 0;
        return runDropSend(currentGroups, drop, displayTotal, 0);
    }

    sendStatus(`Drop ${drop}: Warmup Lists — entry ${entryIndex + 1}/${entries.length}, lists count = ${listsCount.toLocaleString()}, offset = ${startOffset.toLocaleString()}`);

    // cumulativeOffset tracks the running position within the CURRENT list and
    // carries over between groups within this drop, and between drops as long
    // as we stay on the same list (via startOffset, which is persistentOffset
    // from the previous drop). If the process advanced to a different entry/list
    // since the drop started (quota exhaustion, lists count = 0, etc.), the old
    // offset belongs to a different list and must not be reused — start at 0.
    const _offsetCarriesOver = (entryIndex === _entryIndexAtDropStart);

    // ── Validate "Start Always From" manual offset against Lists Count ────────
    // One-time check performed the first time a Warmup Lists entry is actually
    // about to use the manual/saved starting offset (i.e. offset carries over).
    if (runDropSendDataLists._pendingManualOffsetCheck !== undefined && runDropSendDataLists._pendingManualOffsetCheck !== null) {
        const _manualVal = runDropSendDataLists._pendingManualOffsetCheck;
        runDropSendDataLists._pendingManualOffsetCheck = null; // consume — only ever checked once
        if (_offsetCarriesOver && _manualVal >= listsCount) {
            const _errMsg = `"Start Always From" value (${_manualVal.toLocaleString()}) must be strictly less than Lists Count (${listsCount.toLocaleString()}) for "${currentEntry.value}".`;
            sendStatus(`Drop ${drop}: ❌ ${_errMsg}`);
            updateMainCard(drop, displayTotal, `❌ <strong>Start Always From</strong> error:<br>${_errMsg}`, 'red', '🚫');
            showPreflightErrorCard([_errMsg]);
            try {
                await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    method : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body   : JSON.stringify({
                        chat_id   : telegramChatId,
                        text      : '```\n🚫 START ALWAYS FROM — INVALID OFFSET\n' + _errMsg + '\n```',
                        parse_mode: 'Markdown'
                    })
                });
            } catch (_tgErr) { console.warn('[StartAlwaysFrom] Telegram alert failed:', _tgErr); }
            _processState = "stopped";
            throw new ProcessStoppedError();
        }
    }

    let cumulativeOffset = _offsetCarriesOver ? startOffset : 0;
    if (!_offsetCarriesOver) {
        sendStatus(`Drop ${drop}: Entry changed since drop start — offset reset to 0 for "${currentEntry.value}".`);
    }
    // Total volume sent this drop via this entry (used to update cumulativeOut at end)
    let dropSentThisEntry = 0;

    // ── Local consumption tracker (safety net) ────────────────────────────────────
    // Tracks rows sent from currentEntry during THIS drop.
    // recordSent + cache refresh now happen immediately after each group, so
    // _getCachedRemaining() is already accurate for subsequent groups.
    // This counter is kept as a fallback in case the API call is slow/fails.
    // Reset to 0 whenever currentEntry changes (entry switch, Part B overflow, etc).
    let _localConsumedCurrentEntry = 0;

    for (let gi = 0; gi < currentGroups.length; gi++) {
        const { value, ips } = currentGroups[gi];

        // Every group continues from the running position in the list
        // (cumulativeOffset), which carries over from the previous group in
        // this same drop, and from the previous drop via startOffset when
        // still on the same list. It only resets to 0 on a wrap (handled
        // inside _sendWithWrap) or on a genuine switch to a different list.
        const groupStartOffset = cumulativeOffset;

        // ── Server remaining quota check before each group ────────────────
        // Re-evaluate in case the server reports the current list is exhausted.
        // Loop so that if the newly-switched-to entry is ALSO exhausted we keep
        // advancing — handles the case where entries 1, 2, … are all depleted.
        // SKIPPED in shuffle mode — we must stay on the assigned entry all drop.
        while (!shuffleMode && currentEntry.mode === 'warmup' && currentEntry.value && entryIndex < lastIndex) {
            const _qr = _getCachedRemaining(currentEntry.value);
            // null = still unknown — do a quick wait before deciding
            const _qrResolved = (_qr === null)
                ? await _waitForCacheReady(currentEntry.value, 4000)
                : _qr;
            // Subtract local consumption so we account for what was already sent
            // this drop (the API cache has not yet been updated by recordSent).
            const _qrAdjusted = (isFinite(_qrResolved) && _qrResolved !== null)
                ? Math.max(0, _qrResolved - _localConsumedCurrentEntry)
                : _qrResolved;
            if (!(isFinite(_qrAdjusted) && _qrAdjusted <= 0)) break; // still has quota — stop

            sendStatus(`Drop ${drop}: Entry ${entryIndex + 1} quota exhausted (remaining=${_qrResolved}, consumed=${_localConsumedCurrentEntry}, adjusted=${_qrAdjusted}) — advancing to next entry for remaining groups…`);
            dropSentThisEntry = 0;
            _localConsumedCurrentEntry = 0; // reset — new entry starts fresh

            entryIndex++;
            currentEntry = entries[entryIndex];
            runDropSendDataLists._entryIndex = entryIndex;
            runDropSendDataLists._lastMode   = currentEntry.mode;

            if (currentEntry.mode === 'passive') {
                sendStatus(`Drop ${drop}: Passive Lists entry reached mid-drop — switching page selects before reverting to simple offset 0…`);
                updateMainCard(drop, displayTotal,
                    `Quota exhausted → switching to <strong>Passive Lists</strong> "${currentEntry.value}"…`,
                    'amber', '🔄');
                await _applyIspEntry(drop, currentEntry, false); // full apply: provider + profile + ISP
                await checkPauseOrStop();
                const remainingGroups = currentGroups.slice(gi);
                return runDropSend(remainingGroups, drop, displayTotal, 0);
            }

            updateMainCard(drop, displayTotal,
                `Quota exhausted → switching to entry <strong>${entryIndex + 1}/${entries.length}</strong> [${currentEntry.mode}] "${currentEntry.value}"…`,
                'amber', '🔄');
            await resetIspProfile(drop, displayTotal, currentEntry);
            listsCount = _readListsCount();
            sendStatus(`Drop ${drop}: Switched entry — new lists count = ${listsCount.toLocaleString()}`);
        }

        updateMainCard(drop, displayTotal,
            `Sending group <strong>${gi + 1} / ${currentGroups.length}</strong><br>
             <strong>${ips.length}</strong> IP${ips.length > 1 ? 's' : ''} · <strong>${value.toLocaleString()}</strong> each · 
             offset <strong>${groupStartOffset.toLocaleString()}</strong> / ${listsCount.toLocaleString()}`,
            'blue', '📤');

        _forceCloseAllModals();
        await wait(800);

        await selectIps(ips);

        // Re-read the select immediately before each send so the split is always
        // based on the current value (e.g. user may switch ALL↔UNIQ mid-drop).
        listsCount = _readListsCount();

        const totalLimit = ips.length * value;

        // ── Determine server quota for current entry ──────────────────────────
        // Use _getCachedRemaining — cache is refreshed immediately after each
        // group's recordSent call, so values are accurate across groups.
        // _localConsumedCurrentEntry is kept as a safety fallback in case the
        // API refresh was slow or failed for this group.
        let serverRemaining;
        if (currentEntry.mode === 'warmup' && currentEntry.value) {
            let _sr = _getCachedRemaining(currentEntry.value);
            if (_sr === null) {
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Waiting for quota data for "${currentEntry.value}"…`);
                _sr = await _waitForCacheReady(currentEntry.value, 4000);
            }
            // Apply local-consumption correction so mid-drop groups see accurate quota.
            if (_sr !== null && isFinite(_sr)) {
                const _srAdjusted = Math.max(0, _sr - _localConsumedCurrentEntry);
                if (_localConsumedCurrentEntry > 0) {
                    sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Cache remaining=${_sr}, consumed this drop=${_localConsumedCurrentEntry} → adjusted remaining=${_srAdjusted}`);
                }
                _sr = _srAdjusted;
            }
            serverRemaining = (_sr !== null) ? _sr : Infinity; // absolute last resort only
        } else {
            serverRemaining = Infinity; // passive or no list name — no quota limit
        }

        // Last entry quota fully exhausted → flag stop and break
        if (currentEntry.mode === 'warmup' && currentEntry.value && isFinite(serverRemaining) && serverRemaining <= 0 && entryIndex === lastIndex) {
            sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Last entry quota exhausted (adjusted remaining=0) — stopping after this drop.`);
            _stopAfterCurrentDrop = true;
            break;
        }

        // How much to send on the current entry (capped by remaining quota)
        // and how much overflows to the next entry.
        //
        // Only advance to the next entry when the quota boundary is hit.
        // When quota allows, always wrap within the same list
        // (0→98, 0→98, 0→4 …) instead of jumping to a new entry.
        const toSendA = serverRemaining <= 0    ? 0
            : serverRemaining === Infinity ? totalLimit
            : Math.min(totalLimit, serverRemaining);
        const toSendB = totalLimit - toSendA; // > 0 only when quota forces a switch

        // ── Helper: send `amount` on `entry`, wrapping within the same list ──
        // Returns the final offset position after all chunks are sent.
        // startOffset: where to begin within the list (0 for all groups except
        //              the first group of the drop which inherits from previous drop).
        const _sendWithWrap = async (entry, startOffset, amount, baseLabel, isFirstCallAlready) => {
            let still    = amount;
            let offset   = startOffset;
            let passIdx  = 0;
            let firstCall = isFirstCallAlready; // first call reuses already-done selectIps
            while (still > 0) {
                listsCount = _readListsCount();
                // If we're already at/past end of list, wrap to beginning first
                while ((listsCount - offset) <= 0 && listsCount > 0) {
                    updateMainCard(drop, displayTotal,
                        `Group <strong>${gi + 1}/${currentGroups.length}</strong> — wrapping within entry <strong>${entryIndex + 1}</strong>…`,
                        'purple', '🔄');
                    await resetIspProfile(drop, displayTotal, entry);
                    listsCount = _readListsCount();
                    offset = 0;
                }
                if (listsCount <= 0) break;
                passIdx++;
                const spaceLeft = listsCount - offset;
                const chunk     = Math.min(still, spaceLeft);
                const passLabel = baseLabel
                    ? (passIdx === 1 ? baseLabel : `${baseLabel}${passIdx}`)
                    : '';
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: ${passLabel ? 'Part ' + passLabel + ' ' : ''}offset=${offset} limit=${chunk} (entry ${entryIndex + 1})`);
                updateMainCard(drop, displayTotal,
                    `Group <strong>${gi + 1}/${currentGroups.length}</strong>${passLabel ? ' Part ' + passLabel : ''} — offset <strong>${offset.toLocaleString()}</strong>→<strong>${(offset + chunk).toLocaleString()}</strong> / ${listsCount.toLocaleString()} (entry ${entryIndex + 1})`,
                    'blue', '📤');
                if (!firstCall) { _forceCloseAllModals(); await wait(600); await selectIps(ips); }
                firstCall = false;
                await _doSingleGroupSend(drop, displayTotal, gi, currentGroups.length, ips, offset, chunk, passLabel, entry);
                offset += chunk;
                still  -= chunk;
                dropSentThisEntry += chunk;
                // ── FIX: also track local consumption for the current entry ──────
                // This feeds the per-group serverRemaining correction so that the
                // NEXT group sees an accurate (cache − consumed) remaining value.
                _localConsumedCurrentEntry += chunk;
                // Wrap within same list when we hit the end and still have more to send
                if (offset >= listsCount && still > 0) {
                    updateMainCard(drop, displayTotal,
                        `Group <strong>${gi + 1}/${currentGroups.length}</strong> — wrapping within entry <strong>${entryIndex + 1}</strong>…`,
                        'purple', '🔄');
                    await resetIspProfile(drop, displayTotal, entry);
                    listsCount = _readListsCount();
                    offset = 0;
                }
            }
            return offset; // final position in the list after this group
        };

        // ── Warn when the group would exceed remaining quota (overflow to Part B) ──
        if (toSendB > 0 && currentEntry.mode === 'warmup' && currentEntry.value) {
            sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: ⚠️ total_group (${totalLimit.toLocaleString()}) > remaining (${isFinite(serverRemaining) ? serverRemaining.toLocaleString() : '∞'}) — Part A=${toSendA.toLocaleString()}, Part B=${toSendB.toLocaleString()} on next entry.`);
        }

        // ── Part A: send toSendA on current entry (wraps within same list) ────
        if (toSendA > 0) {
            const aLabel = toSendB > 0 ? 'A' : '';
            const finalOffset = await _sendWithWrap(currentEntry, groupStartOffset, toSendA, aLabel, true);
            // Only update cumulativeOffset for the first group — subsequent groups
            // always start at 0 so their final offset is the new cumulativeOffset
            // only if it's the last group (to carry into the next drop correctly).
            cumulativeOffset = finalOffset;
            // ── Fire recordSent immediately after this group (Part A) ──────────
            // howManySents = total sents for this group on the current entry.
            // Then refresh the cache so the next group sees accurate remaining.
            if (currentEntry.mode === 'warmup' && currentEntry.value) {
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Recording ${toSendA.toLocaleString()} sent for list "${currentEntry.value}"…`);
                await recordSent(currentEntry.value, toSendA).catch(e => console.warn('[recordSent Part A]', e));
                await _refreshListStatusCache(currentEntry.value);
                // Cache is now authoritative — reset local counter so subsequent
                // groups don't double-subtract what was already reflected in the
                // fresh cache value returned by the server.
                _localConsumedCurrentEntry = 0;
                const _freshRemA = _getCachedRemaining(currentEntry.value);
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: ✅ Quota updated — remaining: ${isFinite(_freshRemA) ? _freshRemA.toLocaleString() : '∞'}`);
                // Check if remaining is now exhausted
                if (isFinite(_freshRemA) && _freshRemA <= 0 && entryIndex === lastIndex) {
                    sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: 🛑 Remaining=0 on last entry after recording — flagging stop after this drop.`);
                    _stopAfterCurrentDrop = true;
                }
            }
        }

        // ── Part B: quota overflow → switch to next entry ─────────────────────
        if (toSendB > 0) {
            if (entryIndex >= lastIndex) {
                // No next entry — flag stop and break
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Last entry quota consumed — stopping after this drop.`);
                _stopAfterCurrentDrop = true;
                break;
            }

            // Advance to next entry — then keep skipping further exhausted warmup
            // entries so that if entries[N+1] is also depleted we don't send on it.
            entryIndex++;
            currentEntry = entries[entryIndex];
            runDropSendDataLists._entryIndex = entryIndex;
            runDropSendDataLists._lastMode   = currentEntry.mode;
            // ── FIX: reset local consumption counter for the new entry ──────────
            _localConsumedCurrentEntry = 0;

            while (currentEntry.mode === 'warmup' && currentEntry.value && entryIndex < lastIndex) {
                const _pbr = _getCachedRemaining(currentEntry.value);
                const _pbrResolved = (_pbr === null)
                    ? await _waitForCacheReady(currentEntry.value, 4000)
                    : _pbr;
                // No local-consumption offset here — this is a freshly-switched entry
                // (_localConsumedCurrentEntry was just reset to 0 above).
                if (!(isFinite(_pbrResolved) && _pbrResolved <= 0)) break; // has quota — stop skipping
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Entry ${entryIndex + 1} also exhausted (remaining=${_pbrResolved}) — advancing further…`);
                entryIndex++;
                currentEntry = entries[entryIndex];
                runDropSendDataLists._entryIndex = entryIndex;
                runDropSendDataLists._lastMode   = currentEntry.mode;
                // Each successive skip is also a fresh entry — keep counter at 0
                _localConsumedCurrentEntry = 0;
            }

            if (currentEntry.mode === 'passive') {
                // ── Full select switch to passive ─────────────────────────────
                // runDropSend() does NOT call _applyIspEntry — must do it here
                // before any send so the page has the correct provider/profile/ISP.
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Part B → switching page to Passive Lists "${currentEntry.value}"…`);
                updateMainCard(drop, displayTotal,
                    `Part B → switching to <strong>Passive Lists</strong> "${currentEntry.value}"…`,
                    'amber', '🔄');
                await _applyIspEntry(drop, currentEntry, false); // full apply
                await checkPauseOrStop();

                // ── Send the exact toSendB rows that overflowed from Part A ───
                // Do NOT reconstruct a fake group via Math.ceil(toSendB/ips.length)
                // — that loses precision (e.g. ceil(20/3)=7 → 3×7=21 ≠ 20).
                // Instead call _doSingleGroupSend directly with limit=toSendB so
                // the form gets exactly the right number of rows.
                if (toSendB > 0) {
                    sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Part B (Passive) — offset=0 limit=${toSendB} on "${currentEntry.value}"…`);
                    updateMainCard(drop, displayTotal,
                        `Group <strong>${gi+1}/${currentGroups.length}</strong> Part B (Passive) — sending <strong>${toSendB.toLocaleString()}</strong> rows…`,
                        'blue', '📤');
                    _forceCloseAllModals();
                    await wait(600);
                    await selectIps(ips);
                    await _doSingleGroupSend(drop, displayTotal, gi, currentGroups.length, ips, 0, toSendB, 'B', currentEntry);
                    await wait(randomDelay());
                    await checkPauseOrStop();
                }

                // ── Remaining full groups go through runDropSend normally ─────
                const remGroups = currentGroups.slice(gi + 1);
                if (remGroups.length > 0) {
                    runDropSendDataLists._lastListName  = currentEntry.value || '';
                    runDropSendDataLists._lastListCount = null;
                    return runDropSend(remGroups, drop, displayTotal, 0);
                }
                runDropSendDataLists._lastListName  = currentEntry.value || '';
                runDropSendDataLists._lastListCount = null;
                return cumulativeOffset;
            }

            updateMainCard(drop, displayTotal,
                `Group <strong>${gi + 1}/${currentGroups.length}</strong> Part B — switching to entry <strong>${entryIndex + 1}/${entries.length}</strong> [${currentEntry.mode}] "${currentEntry.value}" for ${toSendB.toLocaleString()} remaining…`,
                'amber', '🔄');
            await resetIspProfile(drop, displayTotal, currentEntry);
            listsCount = _readListsCount();
            cumulativeOffset = 0;
            sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Entry ${entryIndex + 1} lists count = ${listsCount.toLocaleString()}`);

            // Send Part B on new entry (also wraps within same list if needed)
            cumulativeOffset = await _sendWithWrap(currentEntry, 0, toSendB, 'B', false);

            // ── Fire recordSent immediately after Part B ───────────────────────
            // howManySents = total sents for this group on the new entry (Part B).
            // Refresh cache so the next group sees accurate remaining.
            if (currentEntry.mode === 'warmup' && currentEntry.value) {
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Recording ${toSendB.toLocaleString()} sent for list "${currentEntry.value}" (Part B)…`);
                await recordSent(currentEntry.value, toSendB).catch(e => console.warn('[recordSent Part B]', e));
                await _refreshListStatusCache(currentEntry.value);
                // Cache is now authoritative — reset local counter so subsequent
                // groups don't double-subtract what is already in the fresh value.
                _localConsumedCurrentEntry = 0;
                const _freshRemB = _getCachedRemaining(currentEntry.value);
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: ✅ Quota updated (Part B) — remaining: ${isFinite(_freshRemB) ? _freshRemB.toLocaleString() : '∞'}`);
                if (isFinite(_freshRemB) && _freshRemB <= 0 && entryIndex === lastIndex) {
                    sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: 🛑 Remaining=0 on last entry after Part B — flagging stop after this drop.`);
                    _stopAfterCurrentDrop = true;
                }
            }

            // Inter-group ISP reset after entry switch
            if (gi < currentGroups.length - 1) {
                updateMainCard(drop, displayTotal,
                    `Group <strong>${gi + 1}/${currentGroups.length}</strong> done — Resetting ISP Profile…`,
                    'purple', '🔄');
                await resetIspProfile(drop, displayTotal, currentEntry);
                const freshCount = _readListsCount();
                if (freshCount > 0) listsCount = freshCount;
            }

            await wait(randomDelay());
            await checkPauseOrStop();
            continue; // skip the normal inter-group reset below
        }

        // ISP Profile reset after every group except the last
        if (gi < currentGroups.length - 1) {
            updateMainCard(drop, displayTotal,
                `Group <strong>${gi + 1}/${currentGroups.length}</strong> done — Resetting <strong>ISP Profile</strong>…`,
                'purple', '🔄');
            await resetIspProfile(drop, displayTotal, currentEntry);
            const freshCount = _readListsCount();
            if (freshCount > 0) {
                listsCount = freshCount;
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: Fresh lists count = ${listsCount.toLocaleString()}`);
            } else {
                sendStatus(`Drop ${drop} · Group ${gi+1}/${currentGroups.length}: ⚠️ Lists count read as 0 after group reset — keeping previous value (${listsCount.toLocaleString()})`);
                console.warn(`[runDropSendDataLists] _readListsCount()=0 after inter-group reset — retaining listsCount=${listsCount}`);
            }
        }

        await wait(randomDelay());
        await checkPauseOrStop();
    }

    // Log drop summary with server remaining info
    const _finalStatus = (currentEntry.mode === 'warmup' && currentEntry.value)
        ? _listStatusCache[currentEntry.value]
        : null;
    sendStatus(`Drop ${drop}: Entry ${entryIndex + 1} — sent this drop: ${dropSentThisEntry.toLocaleString()}${_finalStatus ? ' | server remaining: ' + _finalStatus.remaining.toLocaleString() : ''}`);

    runDropSendDataLists._lastListName  = currentEntry.value || '';
    runDropSendDataLists._lastListCount = currentEntry.mode === 'warmup' ? listsCount : null;
    return cumulativeOffset;
}

// -------------------------------------------------------
// Internal helper: fill offset+limit fields and click send
// Extracted so both runDropSend and runDropSendDataLists share it.
// -------------------------------------------------------
async function _doSingleGroupSend(drop, displayTotal, gi, totalGroups, ips, offsetVal, limitVal, partLabel = '', currentEntry = null) {
    const partTag = partLabel ? ` (Part ${partLabel})` : '';

    // ── Safety guard — never write 0 into the limit input ────────────────
    // This is the last line of defence; callers should avoid reaching here
    // with limitVal=0, but if they do we skip silently rather than submit
    // a broken form that would either error out or send an unexpected volume.
    if (!limitVal || limitVal <= 0) {
        console.warn(`[_doSingleGroupSend] limitVal=${limitVal} ≤ 0 for Group ${gi+1}/${totalGroups}${partTag} — skipping`);
        sendStatus(`Drop ${drop} · Group ${gi+1}/${totalGroups}${partTag}: ⚠️ limit=0 — segment skipped (nothing to send)`);
        return;
    }

    // ── Validation-error keywords that require ISP profile re-selection ──
    // These appear as toast/alert messages when the form submission is
    // rejected because a required select has lost its value (e.g. after a
    // page reload resets the dropdowns).
    const VALIDATION_ERROR_TEXTS = [
        'The data profile isps field is required.',
        'The data lists counts field is required.'
    ];

    // ── Helper: check whether a validation error banner is visible ────────
    // Returns the matched error string, or null if none found.
    function _detectValidationError() {
        const candidates = [
            ...document.querySelectorAll('.toast-message'),
            ...document.querySelectorAll('.alert'),
            ...document.querySelectorAll('.invalid-feedback'),
            ...document.querySelectorAll('.error-message'),
        ];
        for (const el of candidates) {
            const txt = (el.textContent || '').trim();
            for (const kw of VALIDATION_ERROR_TEXTS) {
                if (txt.includes(kw)) return kw;
            }
        }
        // Also scan the full page text as a fallback
        const bodyText = document.body ? document.body.innerText : '';
        for (const kw of VALIDATION_ERROR_TEXTS) {
            if (bodyText.includes(kw)) return kw;
        }
        return null;
    }

    const offsetInput = await waitForElement("#offset");
    const limitInput  = await waitForElement("#limit");

    offsetInput.value = offsetVal;
    offsetInput.dispatchEvent(new Event("input",  { bubbles: true }));
    offsetInput.dispatchEvent(new Event("change", { bubbles: true }));
    // The form submits via name="limit_offset[offset]" which may be a different
    // element from #offset — set both so the submitted value is always correct.
    const _namedOffsetInput = document.querySelector('[name="limit_offset[offset]"]');
    if (_namedOffsetInput && _namedOffsetInput !== offsetInput) {
        _namedOffsetInput.value = offsetVal;
        _namedOffsetInput.dispatchEvent(new Event("input",  { bubbles: true }));
        _namedOffsetInput.dispatchEvent(new Event("change", { bubbles: true }));
    }

    limitInput.value  = limitVal;
    limitInput.dispatchEvent(new Event("input",  { bubbles: true }));
    limitInput.dispatchEvent(new Event("change", { bubbles: true }));
    // Same belt-and-suspenders for the limit field.
    const _namedLimitInput = document.querySelector('[name="limit_offset[limit]"]');
    if (_namedLimitInput && _namedLimitInput !== limitInput) {
        _namedLimitInput.value = limitVal;
        _namedLimitInput.dispatchEvent(new Event("input",  { bubbles: true }));
        _namedLimitInput.dispatchEvent(new Event("change", { bubbles: true }));
    }

    await wait(800);

    sendStatus(`Drop ${drop} · Group ${gi+1}/${totalGroups}${partTag}: Clicking send…`);
    const sendBtn = await waitForElement("#send-button");
    await wait(600);

    const MODAL_WAIT_MS  = 2 * 60 * 1000;
    const MODAL_POLL_MS  = 400;
    const TOTAL_LIMIT_MS = 60 * 60 * 1000;
    const overallDeadline = Date.now() + TOTAL_LIMIT_MS;

    let sendResult = null;
    let attempt    = 0;

    while (!sendResult) {
        attempt++;
        sendBtn.click();
        sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        sendStatus(`Drop ${drop} · Group ${gi+1}/${totalGroups}${partTag}: ${attempt === 1 ? 'Waiting' : `Re-click #${attempt} — waiting`} up to 2 min…`);

        sendResult = await new Promise(resolve => {
            const deadline = Date.now() + MODAL_WAIT_MS;
            const timer    = setInterval(() => {
                const toastMsg  = document.querySelector('.toast-message');
                const toastSeen = !!(toastMsg && toastMsg.textContent.includes('Deploy has been successfully sent'));
                const modal = document.querySelector('.modal.in, .modal.show');
                if (modal) {
                    const hasContent = modal.querySelector('.modal-content') || modal.querySelector('.modal-body');
                    if (hasContent) { clearInterval(timer); resolve({ modal, toast: toastSeen }); return; }
                }
                if (toastSeen) { clearInterval(timer); resolve({ modal: null, toast: true }); return; }
                if (Date.now() >= deadline) { clearInterval(timer); resolve(null); }
            }, MODAL_POLL_MS);
        });

        if (!sendResult) {
            if (Date.now() >= overallDeadline) {
                sendStatus(`❌ No modal or toast after 1 hour${partTag} — sending Telegram alert…`);
                updateMainCard(drop, displayTotal,
                    `❌ No modal or toast after <strong>1 hour</strong>${partTag ? ' (Part ' + partLabel + ')' : ''}.<br>Sending Telegram alert…`,
                    'red', '🚨');
                // Pick a random server name to include in the alert
                const _dsgFailServers = [...new Set(ips.map(ip => (typeof _ipServerMap !== 'undefined' && _ipServerMap && _ipServerMap[ip]) || '').filter(Boolean))];
                const _dsgFailRandSrv = _dsgFailServers.length > 0 ? _dsgFailServers[Math.floor(Math.random() * _dsgFailServers.length)] : '';
                try { await sendTelegramAlert(drop, displayTotal, gi + 1, totalGroups, ips, _telegramChatId, attempt, _dsgFailRandSrv); }
                catch (tgErr) { console.error('[SendRetry] Telegram alert failed:', tgErr); }

                // Attempt emergency RESUME before stopping so servers are not left paused
                try {
                    sendStatus(`❌ Send modal failure${partTag} — attempting emergency RESUME before stopping…`);
                    updateMainCard(drop, displayTotal,
                        `❌ Send modal failure — running emergency <strong>RESUME</strong>…`,
                        'red', '🚨');
                    _forceCloseAllModals();
                    await wait(800);
                    await selectIps(ips);
                    await wait(1000);
                    await openRunCommandModalss();
                    await executeRunCommandModal(`Emergency RESUME (send modal failure${partTag})`, 2);
                    sendStatus(`Emergency RESUME completed — stopping process.`);
                } catch (resumeErr) {
                    console.warn('[SendRetry] Emergency RESUME failed:', resumeErr);
                }

                throw new Error(`No modal or toast after 1 hour${partTag}. Group ${gi+1}/${totalGroups}, IPs: ${ips.join(', ')}`);
            }

            // ── Validation-error recovery ─────────────────────────────────
            // Before sleeping and re-clicking, check whether the page is
            // showing a "field is required" error that means the ISP Profile
            // select (and/or the lists-count select) has lost its value.
            // If so — and we know which entry to re-apply — re-run
            // _applyIspEntry so the selects are repopulated, wait for the
            // page to finish loading, re-fill offset/limit, then loop back
            // to click send again without counting this as a new attempt.
            const validationErr = _detectValidationError();
            if (validationErr && currentEntry) {
                sendStatus(`Drop ${drop} · Group ${gi+1}/${totalGroups}${partTag}: ⚠️ Validation error detected ("${validationErr}") — re-applying ISP Profile [${currentEntry.mode}] "${currentEntry.value}"…`);
                updateMainCard(drop, displayTotal,
                    `⚠️ Validation error — re-applying <strong>ISP Profile</strong> [${currentEntry.mode}] "${currentEntry.value}"…`,
                    'amber', '🔄');

                try {
                    await _applyIspEntry(drop, currentEntry);
                    await wait(2000);

                    // Re-fill offset & limit after page reload (same dual-target logic)
                    const freshOffset = await waitForElement("#offset");
                    const freshLimit  = await waitForElement("#limit");
                    freshOffset.value = offsetVal;
                    freshOffset.dispatchEvent(new Event("input",  { bubbles: true }));
                    freshOffset.dispatchEvent(new Event("change", { bubbles: true }));
                    const _freshNamedOffset = document.querySelector('[name="limit_offset[offset]"]');
                    if (_freshNamedOffset && _freshNamedOffset !== freshOffset) {
                        _freshNamedOffset.value = offsetVal;
                        _freshNamedOffset.dispatchEvent(new Event("input",  { bubbles: true }));
                        _freshNamedOffset.dispatchEvent(new Event("change", { bubbles: true }));
                    }
                    freshLimit.value  = limitVal;
                    freshLimit.dispatchEvent(new Event("input",  { bubbles: true }));
                    freshLimit.dispatchEvent(new Event("change", { bubbles: true }));
                    const _freshNamedLimit = document.querySelector('[name="limit_offset[limit]"]');
                    if (_freshNamedLimit && _freshNamedLimit !== freshLimit) {
                        _freshNamedLimit.value = limitVal;
                        _freshNamedLimit.dispatchEvent(new Event("input",  { bubbles: true }));
                        _freshNamedLimit.dispatchEvent(new Event("change", { bubbles: true }));
                    }
                    await wait(800);

                    sendStatus(`Drop ${drop} · Group ${gi+1}/${totalGroups}${partTag}: ISP Profile re-applied — retrying send…`);
                    // Do NOT increment attempt — this re-select is transparent
                    attempt--;
                } catch (reapplyErr) {
                    console.warn('[_doSingleGroupSend] ISP re-apply failed:', reapplyErr);
                }
            } else {
                const elapsedMin = Math.floor((Date.now() - (overallDeadline - TOTAL_LIMIT_MS)) / 60000);
                sendStatus(`Drop ${drop} · Group ${gi+1}/${totalGroups}${partTag}: Nothing seen — retrying (attempt ${attempt}, ${elapsedMin}m/60m)…`);
                await wait(1500);
            }
        }
    }

    if (sendResult.modal) {
        sendStatus(`Drop ${drop} · Group ${gi+1}/${totalGroups}${partTag}: Closing report modal…`);
        const closeBtn = await waitForChildElement(sendResult.modal, ".modal-header button.close[data-dismiss='modal']", 15000);
        await wait(600);
        await _closeModalAndWait(closeBtn, 8000);
        await wait(400);
    } else {
        sendStatus(`Drop ${drop} · Group ${gi+1}/${totalGroups}${partTag}: ✅ Toast detected — waiting up to 5s for modal…`);
        const lateModal = await new Promise(resolve => {
            const deadline = Date.now() + 5000;
            const t = setInterval(() => {
                const m = document.querySelector('.modal.in, .modal.show');
                if (m && (m.querySelector('.modal-content') || m.querySelector('.modal-body'))) { clearInterval(t); resolve(m); return; }
                if (Date.now() >= deadline) { clearInterval(t); resolve(null); }
            }, 300);
        });
        if (lateModal) {
            const closeBtn = await waitForChildElement(lateModal, ".modal-header button.close[data-dismiss='modal']", 10000);
            await wait(600);
            await _closeModalAndWait(closeBtn, 8000);
        } else {
            _forceCloseAllModals();
        }
        await wait(400);
    }
}

// -------------------------------------------------------
// Read queue data from multi_monitor iframes
// -------------------------------------------------------
async function readQueueData(allIps, ipServerMap = {}) {
    const results = {};
    allIps.forEach(ip => { results[ip] = -1; });

    const { urls, tabId, iframeServerMap } = await bgMessage({ type: "GET_MONITOR_IFRAME_URLS" });

    if (!urls || urls.length === 0) {
        console.warn("No monitor iframe URLs found.");
        return { queueResults: results, downServers: [] };
    }

    const iframeUrls = [];
    for (const ip of allIps) {
        const matchedUrl = urls.find(u => u.includes(ip));
        if (matchedUrl) {
            iframeUrls.push({ ip, url: matchedUrl });
        } else {
            urls.forEach(u => iframeUrls.push({ ip, url: u }));
        }
    }

    const fetchResults = await bgMessage({
        type           : "FETCH_QUEUE_DATA",
        iframeUrls,
        iframeServerMap: iframeServerMap || {}
    });

    // downServerNames come from FETCH_QUEUE_DATA frame content detection
    const downServers = (fetchResults && fetchResults.downServerNames) ? fetchResults.downServerNames : [];

    if (fetchResults && fetchResults.results) {
        fetchResults.results.forEach(({ ip, rcpt, _serverDown }) => {
            if (_serverDown || rcpt === -2) {
                results[ip] = -2; // server down marker
            } else if (rcpt >= 0) {
                results[ip] = (results[ip] === -1 ? 0 : results[ip]) + rcpt;
            }
        });
    }

    // Also propagate down status to all IPs sharing the same server name
    if (downServers.length > 0 && ipServerMap) {
        allIps.forEach(ip => {
            const srv = ipServerMap[ip];
            if (srv && downServers.includes(srv) && results[ip] !== -2) {
                results[ip] = -2;
            }
        });
    }

    if (tabId) await bgMessage({ type: "CLOSE_TAB", tabId });
    if (_deployTabId) { await bgMessage({ type: "FOCUS_TAB", tabId: _deployTabId }); await wait(600); }

    return { queueResults: results, downServers };
}

// ===============================
// EXCLUDE IPs — helper
// ===============================
// Reads the "Exclude IPs" textarea injected by the extension on the
// deploy page and returns a Set of IP strings to skip.
// Called live before every selectIps() call so it always reflects
// the current content of the box at the moment of the action.
function getExcludedIps() {
    const ta = document.getElementById('__exclude_ips_textarea__');
    if (!ta) return new Set();
    return new Set(
        ta.value.split(/[\n,\s]+/)
            .map(s => s.trim())
            .filter(s => s.length > 0)
    );
}

// Returns allIps with excluded IPs removed — re-read live each drop.
function getEffectiveIps(allIps) {
    const excluded = getExcludedIps();
    if (excluded.size === 0) return allIps;
    const eff     = allIps.filter(ip => !excluded.has(ip));
    const skipped = allIps.filter(ip =>  excluded.has(ip));
    if (skipped.length > 0)
        console.log('[ExcludeIPs] Drop-level filter — skipped:', skipped);
    return eff;
}

// ===============================
// STOP DEFERRED IPs — helper
// ===============================
// When enabled (via the popup toggle), an IP that fails the tolerance check
// (⚠️) on a drop is skipped entirely — like Exclude IPs — for exactly the
// NEXT drop, then becomes eligible again the drop after that.
//
// _deferredUntilDrop maps ip -> the single drop number it must be skipped
// for. Entries are consumed (deleted) the moment that drop number is
// reached, so the IP is automatically eligible again afterwards with no
// extra bookkeeping needed.
function _consumeDeferredSkipsForDrop(drop) {
    const skip = new Set();
    for (const ip of Object.keys(_deferredUntilDrop)) {
        if (_deferredUntilDrop[ip] === drop) {
            skip.add(ip);
            delete _deferredUntilDrop[ip];
        }
    }
    return skip;
}

// ===============================
// ADDITIONAL / UPDATE IPs — helpers
// ===============================
// Reads the "Additional/Update IPs" textarea and returns an array of
// parsed entries: { server, ip, target, customIncrement, customSuccessThreshold }.
// Same format as IPs & Targets: server:ip:target[:inc[:succ]]
// Called live before every drop so changes take effect immediately.
function getAdditionalIps() {
    const ta = document.getElementById('__additional_ips_textarea__');
    if (!ta) return [];
    const lines = ta.value.split('\n').map(s => s.trim()).filter(s => s.length > 0);
    const result = [];
    lines.forEach(line => {
        const parts = line.split(':');
        let server = null, ip, target;
        let rawInc = '', rawSucc = '';
        let groupIndex = null; // null = main IPs; 0-based index for rotation groups

        // Detect optional G{N}: prefix — e.g. "G1:server:ip:target"
        const groupMatch = parts[0].trim().match(/^[Gg](\d+)$/);
        const dataParts  = groupMatch ? parts.slice(1) : parts;
        if (groupMatch) groupIndex = parseInt(groupMatch[1]) - 1; // 1-based → 0-based

        if (dataParts.length >= 4) {
            server   = dataParts[0].trim();
            ip       = dataParts[1].trim();
            target   = parseInt(dataParts[2].trim());
            rawInc   = dataParts[3].trim();
            rawSucc  = dataParts.length >= 5 ? dataParts[4].trim() : '';
        } else if (dataParts.length === 3) {
            server = dataParts[0].trim();
            ip     = dataParts[1].trim();
            target = parseInt(dataParts[2].trim());
        } else if (dataParts.length === 2) {
            ip     = dataParts[0].trim();
            target = parseInt(dataParts[1].trim());
        } else {
            return;
        }
        if (!ip || isNaN(target)) return;

        const custInc  = rawInc  !== '' ? parseInt(rawInc)  : null;
        const custSucc = rawSucc !== '' ? parseInt(rawSucc) : null;
        result.push({
            server : server || '',
            ip,
            target,
            customIncrement        : (custInc  !== null && !isNaN(custInc))  ? custInc  : null,
            customSuccessThreshold : (custSucc !== null && !isNaN(custSucc)) ? custSucc : null,
            groupIndex             // null = main IPs
        });
    });
    return result;
}

// Called once before each drop.
// • Exclude IPs always wins — if an IP is excluded it is skipped here entirely.
// • If the IP is NEW → pushed into allIps/ipServerMap and a fresh ipState entry is created.
// • If the IP EXISTS → target, customIncrement, customSuccessThreshold are all updated.
function applyAdditionalIpsBeforeDrop(allIps, ipState, ipServerMap, drop, ipGroupsParsed) {
    const entries = getAdditionalIps();
    if (entries.length === 0) return;

    const excluded = getExcludedIps();

    entries.forEach(({ server, ip, target, customIncrement, customSuccessThreshold, groupIndex }) => {
        if (excluded.has(ip)) {
            console.log(`[AdditionalIPs] Drop ${drop}: ${ip} is in Exclude list — skipping.`);
            return;
        }

        // ── Route to a rotation group when G{N}: prefix was used ──────────
        if (groupIndex !== null && groupIndex !== undefined) {
            if (!ipGroupsParsed || groupIndex >= ipGroupsParsed.length) {
                sendStatus(`Drop ${drop}: ⚠️ G${groupIndex + 1} not found (${ipGroupsParsed ? ipGroupsParsed.length : 0} group(s) configured) — skipping ${ip}`);
                return;
            }
            const grp = ipGroupsParsed[groupIndex];
            if (!grp.ipServerMap)   grp.ipServerMap   = {};
            if (!grp.ipOverrideMap) grp.ipOverrideMap = {};

            if (grp.orderedIps.includes(ip)) {
                // Update existing group IP — move to new target bucket if changed
                for (const g of grp.groups) {
                    const idx = g.ips.indexOf(ip);
                    if (idx !== -1) {
                        if (g.value !== target) {
                            g.ips.splice(idx, 1);
                            if (g.ips.length === 0) grp.groups.splice(grp.groups.indexOf(g), 1);
                            let bucket = grp.groups.find(b => b.value === target);
                            if (!bucket) { bucket = { value: target, ips: [] }; grp.groups.push(bucket); grp.groups.sort((a, b) => a.value - b.value); }
                            bucket.ips.push(ip);
                        }
                        break;
                    }
                }
                grp.ipServerMap[ip] = server || grp.ipServerMap[ip] || '';
                if (customIncrement !== null || customSuccessThreshold !== null) {
                    grp.ipOverrideMap[ip] = { customIncrement, customSuccessThreshold };
                }
                sendStatus(`Drop ${drop}: ✏️ Updated IP ${ip} in Group ${groupIndex + 1} (target=${target})`);
            } else {
                // Add new IP to group
                grp.orderedIps.push(ip);
                grp.ipServerMap[ip] = server || '';
                let bucket = grp.groups.find(b => b.value === target);
                if (!bucket) { bucket = { value: target, ips: [] }; grp.groups.push(bucket); grp.groups.sort((a, b) => a.value - b.value); }
                bucket.ips.push(ip);
                if (customIncrement !== null || customSuccessThreshold !== null) {
                    grp.ipOverrideMap[ip] = { customIncrement, customSuccessThreshold };
                }
                sendStatus(`Drop ${drop}: ➕ Added IP ${ip} to Group ${groupIndex + 1} (target=${target})`);
            }
            return;
        }

        // ── Main IPs (no group prefix) ─────────────────────────────────────
        if (ipState[ip]) {
            const old = ipState[ip];
            const changed = [];
            if (old.target !== target)                                 changed.push(`target ${old.target}→${target}`);
            if (old.customIncrement !== customIncrement)               changed.push(`inc ${old.customIncrement}→${customIncrement}`);
            if (old.customSuccessThreshold !== customSuccessThreshold) changed.push(`succ ${old.customSuccessThreshold}→${customSuccessThreshold}`);

            old.target                 = target;
            old.customIncrement        = customIncrement;
            old.customSuccessThreshold = customSuccessThreshold;

            if (changed.length > 0) {
                console.log(`[AdditionalIPs] Drop ${drop}: Updated ${ip}: ${changed.join(', ')}`);
                sendStatus(`Drop ${drop}: ✏️ Updated IP ${ip} — ${changed.join(', ')}`);
            }
        } else {
            allIps.push(ip);
            ipServerMap[ip] = server;
            ipState[ip] = {
                target,
                consecutiveSuccesses   : 0,
                totalSent              : 0,
                customIncrement,
                customSuccessThreshold
            };
            console.log(`[AdditionalIPs] Drop ${drop}: Added ${ip} (server=${server}, target=${target})`);
            sendStatus(`Drop ${drop}: ➕ Added IP ${ip} (target=${target})`);
        }
    });
}

// ===============================
// Select IPs
// ===============================

async function selectIps(ips) {
    // ── No mid-drop re-read: the caller is responsible for passing
    // the already-snapshotted effectiveAllIps list.  We only guard
    // against an empty list to avoid a no-op form submission.
    if (!ips || ips.length === 0) {
        sendStatus('⚠️ selectIps: empty IP list — skipping.');
        console.warn('[selectIps] Called with empty list — no-op.');
        return;
    }
    _forceCloseAllModals();
    await wait(300);

    const textarea  = await waitForElement("#servers_by_providers_ms-select-search-option");
    const selectBtn = await waitForElement("#servers_by_providers_ms-select");

    textarea.value = '';
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(300);
    textarea.value = ips.join("\n");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(1500);

    selectBtn.click();
    await wait(30000);
}

// ===============================
// Modal helpers
// ===============================

async function openRunCommandModal() {
    const runCmdBtn = await waitForElementVisible("#ips_by_classes_ms-run-cmd");
    runCmdBtn.click(); await wait(randomDelay());
    const selAll = await waitForElementVisible("#servermulti-select-all");
    selAll.click(); await wait(randomDelay());
    for (const cmd of ["PAUSE","DELETE","RESET","SCHEDULE"]) {
        const item = await waitForCommandItem(cmd);
        item.click(); await wait(300);
    }
    await wait(500);
    const qAll = await waitForElementVisible("#queue-multi-select-all");
    qAll.click(); await wait(randomDelay());
}

async function openRunCommandModalss() {
    const runCmdBtn = await waitForElementVisible("#ips_by_classes_ms-run-cmd");
    runCmdBtn.click(); await wait(randomDelay());
    const selAll = await waitForElementVisible("#servermulti-select-all");
    selAll.click(); await wait(randomDelay());
    for (const cmd of ["RESUME","SCHEDULE"]) {
        const item = await waitForCommandItem(cmd);
        item.click(); await wait(300);
    }
    await wait(500);
    const qAll = await waitForElementVisible("#queue-multi-select-all");
    qAll.click(); await wait(randomDelay());
}

async function openRunCommandModalScheduleOnly() {
    const runCmdBtn = await waitForElementVisible("#ips_by_classes_ms-run-cmd");
    runCmdBtn.click(); await wait(randomDelay());
    const selAll = await waitForElementVisible("#servermulti-select-all");
    selAll.click(); await wait(randomDelay());
    const item = await waitForCommandItem("SCHEDULE");
    item.click(); await wait(500);
    const qAll = await waitForElementVisible("#queue-multi-select-all");
    qAll.click(); await wait(randomDelay());
}

async function openRunCommandModalDelete() {
    const runCmdBtn = await waitForElementVisible("#ips_by_classes_ms-run-cmd");
    runCmdBtn.click(); await wait(randomDelay());
    const selAll = await waitForElementVisible("#servermulti-select-all");
    selAll.click(); await wait(randomDelay());
    const item = await waitForCommandItem("DELETE");
    item.click(); await wait(500);
    const qAll = await waitForElementVisible("#queue-multi-select-all");
    qAll.click(); await wait(randomDelay());
}

// ===============================
// EMAIL COUNT FEATURE
// ===============================

// ── Extract Subject and From from the headers[] textarea ─────
function extractSubjectAndFrom() {
    const textarea = document.querySelector('textarea[name="headers[]"]');
    if (!textarea) return { subject: '', from: '' };

    const text = textarea.value;
    let subject = '';
    let fromEmail = '';

    // Extract Subject line
    const subjectMatch = text.match(/^Subject:\s*(.+)$/m);
    if (subjectMatch) subject = subjectMatch[1].trim();

    // Extract From line
    const fromMatch = text.match(/^From:\s*(.+)$/m);
    if (fromMatch) {
        const raw = fromMatch[1].trim();
        
        // Case 1: "Name <email@domain>" → extract name before <
        if (/<[^>]+>/.test(raw)) {
            fromEmail = raw.replace(/\s*<[^>]+>\s*/, '').trim();
        } 
        // Case 2: "email@domain" without brackets → extract part before @
        else if (raw.includes('@')) {
            fromEmail = raw.split('@')[0].trim();
        } 
        // Case 3: Plain display name with no email → keep as-is
        else {
            fromEmail = raw;
        }
    }
    return { subject, from: fromEmail };
}

// ── countEmailsCore (inline copy for content script) ─────────
async function countEmailsCore(params) {
    const { email, password, subject = '', from = '', receivedAfter = '' } = params;

    if (!email || !email.trim()) return { success: false, error: 'Email is required', type: 'validation_error' };
    if (!password || !password.trim()) return { success: false, error: 'Password is required', type: 'validation_error' };

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) return { success: false, error: 'Invalid email format', type: 'validation_error' };

    const formattedPassword = password.replace(/\s/g, '');
    const API_URL = 'http://203.161.41.70:5617/count_emails';

    // ── Hard timeout: if the server hasn't answered within 30s, abort the
    // request and report a 'timeout' so the caller can skip email counting
    // for this drop instead of blocking the whole warmup process.
    const COUNT_EMAILS_TIMEOUT_MS = 300000;
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), COUNT_EMAILS_TIMEOUT_MS);

    try {
        const requestBody = {
            email      : email.trim(),
            app_password: formattedPassword,
            subject    : subject.trim() || null,
            from       : from.trim()    || null
        };
        if (receivedAfter) requestBody.received_after = receivedAfter;

        const response = await fetch(API_URL, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body   : JSON.stringify(requestBody),
            signal : controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();

        if (data.success) {
            return {
                success    : true,
                inbox_count: data.inbox_count || 0,
                spam_count : data.spam_count  || 0,
                total_count: data.total_count || 0
            };
        } else {
            return { success: false, error: data.error || 'Unknown error', type: 'server_error' };
        }
    } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
            return {
                success: false,
                error  : `No response from Gmail server after ${COUNT_EMAILS_TIMEOUT_MS / 1000}s`,
                type   : 'timeout'
            };
        }

        let errorMessage = error.message;
        let errorType    = 'network_error';
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            errorMessage = 'Network error: Cannot connect to server';
        } else if (error.message.includes('Failed to fetch')) {
            errorMessage = 'Connection failed: Server might be down';
            errorType    = 'connection_error';
        }
        return { success: false, error: errorMessage, type: errorType };
    }
}

// ── Save drop results to database ────────────────────────────
async function saveToDatabase(drop, tgResults, toleranceRate, downServers, processType, emailCountData) {
    const API_URL      = 'http://203.161.41.70:5000/save_db';
    const API_PASSWORD = 'PAsswOrdCheckker';

    // Extract entity from server name: "s_tss1_4876" → "tss1"
    function extractEntity(serverName) {
        if (!serverName) return '';
        const parts = serverName.split('_');
        // ["s", "tss1", "4876"] → parts[1] = "tss1"
        return parts.length >= 3 ? parts[1] : (parts.length >= 2 ? parts[1] : serverName);
    }

    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dropDate = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const dropTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const totalSend    = tgResults.reduce((s, r) => s + r.target,     0);
    const totalOut     = tgResults.reduce((s, r) => s + r.reallySent, 0);
    const deliveryRate = totalSend > 0
        ? parseFloat(((totalOut / totalSend) * 100).toFixed(2))
        : 0;

    // Extract entity from the first server name found
    const serverNames = [...new Set(tgResults.map(r => r.server).filter(Boolean))];
    const entity      = serverNames.length > 0 ? extractEntity(serverNames[0]) : '';
    const listType = processType === 'passive' ? 'Passive Lists' : 'Warmup Lists';

    // Build serveurs — one entry per unique server
    const seenSrv = new Set();
    const serverOrder = [];
    tgResults.forEach(r => {
        if (r.server && !seenSrv.has(r.server)) {
            seenSrv.add(r.server);
            serverOrder.push(r.server);
        }
    });

    const serveurs = serverOrder.map(srv => {
        const srvIps  = tgResults.filter(r => r.server === srv);
        const isDown  = downServers.includes(srv) || srvIps.every(r => r.serverDown);
        const srvIn   = srvIps.reduce((s, r) => s + r.target,     0);
        const srvOut  = srvIps.reduce((s, r) => s + r.reallySent, 0);
        const srvRate = (!isDown && srvIn > 0)
            ? parseFloat(((srvOut / srvIn) * 100).toFixed(2))
            : 0;

        return {
            serveur_name  : srv,
            total_in      : isDown ? 0 : srvIn,
            total_out     : isDown ? 0 : srvOut,
            delivery_rate : isDown ? 0 : srvRate,
            ips: srvIps.map(r => {
                const ipRate = (!r.serverDown && r.target > 0)
                    ? parseFloat(((r.reallySent / r.target) * 100).toFixed(2))
                    : 0;
                return {
                    ip            : r.ip,
                    total_in      : r.serverDown ? 0 : r.target,
                    total_out     : r.serverDown ? 0 : r.reallySent,
                    delivery_rate : r.serverDown ? 0 : ipRate
                };
            })
        };
    });

    // Build emails section — empty array when email count is disabled
    const emails = [];
    if (emailCountData) {
        emails.push({
            gmail_account : emailCountData.gmailAccount || '',
            From_email    : emailCountData.fromEmail    || '',
            subject_email : emailCountData.subject      || '',
            total_inbox   : emailCountData.inboxCount   || 0,
            total_spam    : emailCountData.spamCount    || 0
        });
    }

    const payload = {
        password: API_PASSWORD,
        drop_details: {
            entity,
            drop_date    : dropDate,
            drop_time    : dropTime,
            total_in     : totalSend,
            total_out    : totalOut,
            list_type    : listType,
            tolerance    : toleranceRate,
            delivery_rate: deliveryRate
        },
        serveurs,
        emails
    };

    try {
        console.log(`[DB] Saving Drop ${drop} to database…`);
        const response = await fetch(API_URL, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify(payload)
        });
        const result = await response.json();
        if (result.success) {
            console.log(`[DB] ✅ Drop ${drop} saved — ID: ${result.drop_id}`);
        } else {
            console.error(`[DB] ❌ Drop ${drop} save failed:`, result.error);
        }
        return result;
    } catch (err) {
        console.error('[DB] Save error:', err);
        return { success: false, error: err.message };
    }
}

// ── Merged Telegram report: warmup results + optional email count ─
// Called after DELETE, once per drop.
//
// tgResults    : array of { ip, server, serverDown, target, reallySent }
// resumeTime   : timestamp (ms) of when RESUME was executed this drop
// emailCfg     : null → no email count; or { gmailEmail, gmailPassword, emailCountDelay }
//
// Flow:
//   1. If emailCfg is set: wait emailCountDelay, then count emails.
//   2. Build the merged message (warmup section always present,
//      email count section appended only when emailCfg is set).
//   3. Send once to Telegram.
async function runMergedTelegramReport(drop, displayTotal, tgDrop, tgTotal, tgResults, resumeTime, telegramChatId, toleranceRate, downServers, processType, emailCfg, spamStopMode, spamStopValue, dropNote = '', listInfo = null) {

    let emailCountData = null;

    if (emailCfg) {
        const { gmailEmail, gmailPassword, emailCountDelay } = emailCfg;

        // ── Wait the configured delay ────────────────────────
        if (emailCountDelay > 0) {
            showCountdownCard(emailCountDelay, drop, displayTotal, 'Waiting before email count');
            sendStatus(`Drop ${drop}: Waiting ${fmtTime(emailCountDelay)} before counting emails…`);
            await pauseAwareWait(emailCountDelay * 1000, drop, displayTotal, 'Waiting before email count');
            removeCountdownCard();
        }

        await checkPauseOrStop();

        // ── Extract subject / from from the headers textarea ─
        const { subject, from } = extractSubjectAndFrom();

        // ── Build receivedAfter: resumeTime minus 1 hour ─────
        const searchFromMs   = resumeTime - 60 * 60 * 1000;
        const searchFromDate = new Date(searchFromMs);
        const pad = n => String(n).padStart(2, '0');
        const receivedAfter =
            `${searchFromDate.getFullYear()}-${pad(searchFromDate.getMonth()+1)}-${pad(searchFromDate.getDate())}` +
            `T${pad(searchFromDate.getHours())}:${pad(searchFromDate.getMinutes())}`;

        updateMainCard(drop, displayTotal,
            `Counting emails in <strong>${gmailEmail}</strong>…`,
            'blue', '📧');
        sendStatus(`Drop ${drop}: Counting emails (received after ${receivedAfter})…`);

        const countResult = await countEmailsCore({
            email        : gmailEmail,
            password     : gmailPassword,
            subject      : subject || '',
            from         : from    || '',
            receivedAfter: receivedAfter
        });

        const countTime = Date.now();

        if (countResult.success) {
            sendStatus(`Drop ${drop}: Email count done — Total=${countResult.total_count} Inbox=${countResult.inbox_count} Spam=${countResult.spam_count}`);
            updateMainCard(drop, displayTotal,
                `Email count done — Total: <strong>${countResult.total_count.toLocaleString()}</strong> · Inbox: <strong>${countResult.inbox_count.toLocaleString()}</strong> · Spam: <strong>${countResult.spam_count.toLocaleString()}</strong>`,
                'green', '📧');
        } else if (countResult.type === 'timeout') {
            // ── Gmail server took too long — skip counting for this drop ────
            // Don't block the warmup process; alert on Telegram and move on.
            sendStatus(`Drop ${drop}: ⏱️ Email count timed out — skipping for this drop.`);
            updateMainCard(drop, displayTotal,
                `⏱️ Email count timed out — <strong>skipping</strong> for this drop…`,
                'amber', '⏱️');

            const _now = new Date();
            const _pad = n => String(n).padStart(2, '0');
            const _dt  = `${_pad(_now.getDate())}-${_pad(_now.getMonth()+1)}-${_now.getFullYear()}  ${_pad(_now.getHours())}:${_pad(_now.getMinutes())}:${_pad(_now.getSeconds())}`;
            const _div = '='.repeat(46);
            const _timeoutLines = [
                `⏱️  WARMUP CONTROLLER — EMAIL COUNT`,
                _div,
                `Date / Time  :  ${_dt}`,
                _div,
                `Drop         :  ${tgDrop} / ${tgTotal}`,
                `Gmail        :  ${gmailEmail}`,
                ``,
                `The Gmail server is taking longer than expected to respond.`,
                `To keep your warm-up schedule on track, we'll skip the email`,
                `count for this session and continue the warm-up process.`,
                _div,
                `This message was sent automatically by the Warmup Extension.`,
            ];
            const _timeoutText = '```\n' + _timeoutLines.join('\n') + '\n```';
            try {
                await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    method  : 'POST',
                    headers : { 'Content-Type': 'application/json' },
                    body    : JSON.stringify({ chat_id: telegramChatId, text: _timeoutText, parse_mode: 'Markdown' })
                });
            } catch (_tgTimeoutErr) {
                console.warn('[EmailCount] Timeout alert failed to send:', _tgTimeoutErr);
            }

            // The EMAIL COUNT section will still be sent below, with zeros,
            // so the Telegram report stays consistent even on timeout.
        } else {
            sendStatus(`Drop ${drop}: Email count failed — ${countResult.error}`);
            updateMainCard(drop, displayTotal,
                `Email count failed: <strong>${countResult.error}</strong>`,
                'amber', '⚠️');
        }

        // Always build the EMAIL COUNT section — even when the count failed or
        // timed out — so the Telegram report is consistent every drop. On
        // failure we report zeros instead of omitting the section entirely.
        emailCountData = {
            inboxCount  : countResult.success ? countResult.inbox_count : 0,
            spamCount   : countResult.success ? countResult.spam_count  : 0,
            totalCount  : countResult.success ? countResult.total_count : 0,
            subject     : subject || '',
            fromEmail   : from    || '',
            resumeTime,
            countTime,
            gmailAccount: gmailEmail
        };

        browser.runtime.sendMessage({ type: 'EMAIL_COUNT_SENDING', drop });

        // ── Spam stop threshold check (only meaningful when the count actually succeeded) ──
        if (countResult.success && spamStopMode && spamStopMode !== 'none' && spamStopValue > 0) {
            const { inbox_count, spam_count, total_count } = countResult;
            let thresholdBreached = false;
            let stopReason        = '';

            if (spamStopMode === 'number') {
                if (spam_count >= spamStopValue) {
                    thresholdBreached = true;
                    stopReason = `Spam count (${spam_count.toLocaleString()}) reached the limit of ${spamStopValue.toLocaleString()} messages.`;
                }
            } else if (spamStopMode === 'percentage') {
                const spamRate = total_count > 0 ? (spam_count / total_count) * 100 : 0;
                if (spamRate >= spamStopValue) {
                    thresholdBreached = true;
                    stopReason = `Spam rate (${spamRate.toFixed(1)}%) reached or exceeded the ${spamStopValue}% threshold.`;
                }
            }

            if (thresholdBreached) {
                sendStatus(`Drop ${drop}: 🛑 Spam threshold exceeded — ${stopReason} Sending warmup report first…`);
                updateMainCard(drop, displayTotal,
                    `🛑 Spam threshold exceeded!<br><strong>${stopReason}</strong><br>Sending warmup report first…`,
                    'red', '🛑');

                // ── Step 1: Send the WARMUP REPORT of the last (spammed) drop ──
                try {
                    await sendMergedReport(
                        tgDrop, tgTotal, tgResults,
                        telegramChatId,
                        toleranceRate,
                        downServers,
                        processType,
                        emailCountData,
                        dropNote,
                        listInfo
                    );
                    sendStatus(`Drop ${drop}: ✅ Warmup report sent.`);
                } catch (tgReportErr) {
                    console.warn('[SpamThreshold] Warmup report send failed:', tgReportErr);
                }

                // ── Step 2: Save to database ───────────────────────────────────
                try {
                    sendStatus(`Drop ${drop}: 💾 Saving drop data to database before stopping…`);
                    updateMainCard(drop, displayTotal,
                        `Spam threshold exceeded — saving <strong>drop data</strong> before stopping…`,
                        'red', '💾');
                    await saveToDatabase(
                        drop, tgResults, toleranceRate, downServers, processType, emailCountData
                    );
                    sendStatus(`Drop ${drop}: ✅ Drop data saved.`);
                } catch (dbErr) {
                    console.error('[SpamThreshold] DB save failed before stop:', dbErr);
                }

                // ── Step 3: Send SPAM THRESHOLD EXCEEDED alert ─────────────────
                const now = new Date();
                const _p  = n => String(n).padStart(2, '0');
                const dt  = `${_p(now.getDate())}-${_p(now.getMonth()+1)}-${now.getFullYear()}  ${_p(now.getHours())}:${_p(now.getMinutes())}:${_p(now.getSeconds())}`;
                const div = '='.repeat(42);
                const alertLines = [
                    `🛑  WARMUP CONTROLLER — SPAM THRESHOLD EXCEEDED`,
                    div,
                    `Date / Time  :  ${dt}`,
                    div,
                    `Drop         :  ${tgDrop} / ${tgTotal}`,
                    ``,
                    `REASON`,
                    stopReason,
                    ``,
                    `Email Count Results:`,
                    `  Inbox  : ${inbox_count.toLocaleString()}`,
                    `  Spam   : ${spam_count.toLocaleString()}`,
                    `  Total  : ${total_count.toLocaleString()}`,
                    `  Inbox% : ${total_count > 0 ? ((inbox_count / total_count) * 100).toFixed(1) : 0}%`,
                    ``,
                    `The warmup process has been STOPPED automatically.`,
                    div,
                    `This message was sent automatically by the Warmup Extension.`,
                ];
                const alertText = '```\n' + alertLines.join('\n') + '\n```';

                updateMainCard(drop, displayTotal,
                    `Sending SPAM THRESHOLD EXCEEDED alert…`,
                    'red', '🛑');

                try {
                    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        method  : 'POST',
                        headers : { 'Content-Type': 'application/json' },
                        body    : JSON.stringify({ chat_id: telegramChatId, text: alertText, parse_mode: 'Markdown' })
                    });
                } catch (tgErr) {
                    console.warn('[SpamThreshold] Telegram alert failed:', tgErr);
                }

                // Mark process as stopped — the throw below will propagate up
                // through the main loop catch block and trigger the full cleanup.
                _processState = "stopped";
                throw new ProcessStoppedError();
            }
        }
    }

    // ── Send merged Telegram message ─────────────────────────
    updateMainCard(drop, displayTotal,
        `Sending drop report to <strong>Telegram</strong>…`,
        'purple', '✈️');
    sendStatus(`Drop ${drop}: Sending Telegram report…`);
    browser.runtime.sendMessage({ type: "TG_SENDING", drop });

    try {
        const tgResult = await sendMergedReport(
            tgDrop, tgTotal, tgResults,
            telegramChatId,
            toleranceRate,
            downServers,
            processType,
            emailCountData,
            dropNote,
            listInfo
        );

        if (tgResult.success) {
            updateMainCard(drop, displayTotal,
                `Telegram report sent for Drop ${drop}`,
                'green', '✅');
            sendStatus(`Drop ${drop}: Telegram report sent successfully`);
            browser.runtime.sendMessage({ type: "TG_SENT", drop, success: true, error: '' });
            if (emailCfg) {
                browser.runtime.sendMessage({ type: 'EMAIL_COUNT_SENT', drop, success: true, error: '' });
            }
        } else {
            updateMainCard(drop, displayTotal,
                `Telegram failed: <strong>${tgResult.error}</strong>`,
                'amber', '⚠️');
            sendStatus(`Drop ${drop}: Telegram failed — ${tgResult.error}`);
            browser.runtime.sendMessage({ type: "TG_SENT", drop, success: false, error: tgResult.error });
            if (emailCfg) {
                browser.runtime.sendMessage({ type: 'EMAIL_COUNT_SENT', drop, success: false, error: tgResult.error });
            }
        }
    } catch (tgErr) {
        updateMainCard(drop, displayTotal,
            `Telegram error: <strong>${tgErr.message}</strong>`,
            'amber', '⚠️');
        sendStatus(`Drop ${drop}: Telegram error — ${tgErr.message}`);
        browser.runtime.sendMessage({ type: "TG_SENT", drop, success: false, error: tgErr.message });
        if (emailCfg) {
            browser.runtime.sendMessage({ type: 'EMAIL_COUNT_SENT', drop, success: false, error: tgErr.message });
        }
    }

    // ── Save to database (always runs after Telegram, regardless of TG success) ──
    try {
        updateMainCard(drop, displayTotal,
            `Saving Drop ${drop} to <strong>database</strong>…`,
            'blue', '💾');
        sendStatus(`Drop ${drop}: Saving to database…`);

        const dbResult = await saveToDatabase(
            drop, tgResults, toleranceRate, downServers, processType, emailCountData
        );

        if (dbResult.success) {
            sendStatus(`Drop ${drop}: ✅ Database saved (ID: ${dbResult.drop_id})`);
            updateMainCard(drop, displayTotal,
                `Drop ${drop} saved to database — ID: <strong>${dbResult.drop_id}</strong>`,
                'green', '💾');
        } else {
            sendStatus(`Drop ${drop}: ⚠️ Database save failed: ${dbResult.error}`);
            updateMainCard(drop, displayTotal,
                `⚠️ Database save failed: <strong>${dbResult.error}</strong>`,
                'amber', '⚠️');
        }
    } catch (dbErr) {
        console.error('[DB] Unexpected error:', dbErr);
        sendStatus(`Drop ${drop}: ⚠️ Database error: ${dbErr.message}`);
    }
}

// ============================================================
// EXCLUDE IPs — Floating panel (fixed position, always visible)
// ============================================================
// Appended directly to document.body as a fixed overlay so it
// works regardless of page DOM structure. Includes a
// collapse/expand toggle to stay out of the way.
// The textarea ID (__exclude_ips_textarea__) is kept identical
// so getExcludedIps() and selectIps() need no changes.
// ============================================================
(function injectExcludeIpsPanel() {
    // Only run on the deploy page
    if (!window.location.pathname.includes('/deployment/deploy') && !window.location.pathname.includes('/deploy/deploy')) return;

    function _doInject() {
        if (document.getElementById('__exclude_ips_float__')) return;
        if (!document.body) return;

        // ── Styles ────────────────────────────────────────────
        const st = document.createElement('style');
        st.id = '__exclude_ips_float_styles__';
        st.textContent = `
            #__exclude_ips_float__ {
                position: fixed;
                top: 80px;
                left: 20px;
                z-index: 999997;
                width: 420px;
                font-family: 'Segoe UI', system-ui, sans-serif;
                animation: __eip_slideIn__ 0.35s cubic-bezier(0.34,1.56,0.64,1);
            }
            @keyframes __eip_slideIn__ {
                from { opacity:0; transform: translateX(-30px) scale(0.95); }
                to   { opacity:1; transform: translateX(0)     scale(1); }
            }
            #__exclude_ips_float__ .eip-card {
                background: linear-gradient(135deg, #1a1f35 0%, #242b45 100%);
                border: 1px solid rgba(239,68,68,0.35);
                border-radius: 14px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.06) inset;
                overflow: hidden;
            }
            #__exclude_ips_float__ .eip-header {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 10px 13px;
                background: rgba(239,68,68,0.12);
                border-bottom: 1px solid rgba(239,68,68,0.2);
                cursor: pointer;
                user-select: none;
            }
            #__exclude_ips_float__ .eip-icon {
                width: 26px; height: 26px;
                border-radius: 7px;
                background: rgba(239,68,68,0.22);
                display: flex; align-items: center; justify-content: center;
                font-size: 13px; flex-shrink: 0;
            }
            #__exclude_ips_float__ .eip-title {
                font-size: 11px; font-weight: 700;
                letter-spacing: 0.07em; text-transform: uppercase; color: #f87171;
                flex: 1;
            }
            #__exclude_ips_badge__ {
                font-size: 10px; font-weight: 700;
                padding: 2px 8px; border-radius: 20px;
                background: rgba(255,255,255,0.07); color: #94a3b8;
                border: 1px solid rgba(255,255,255,0.1);
                letter-spacing: 0.04em; white-space: nowrap;
                transition: background 0.2s, color 0.2s;
            }
            #__exclude_ips_badge__.active {
                background: rgba(251,191,36,0.18);
                border-color: rgba(251,191,36,0.35);
                color: #fbbf24;
            }
            #__eip_toggle_btn__ {
                background: none; border: none; cursor: pointer;
                color: #64748b; font-size: 13px; padding: 0;
                line-height: 1; transition: color 0.15s;
            }
            #__eip_toggle_btn__:hover { color: #f87171; }
            #__exclude_ips_body__ {
                padding: 10px 12px 12px;
                transition: max-height 0.3s ease, opacity 0.25s ease;
                max-height: 300px;
                opacity: 1;
                overflow: hidden;
            }
            #__exclude_ips_body__.collapsed {
                max-height: 0;
                opacity: 0;
                padding-top: 0;
                padding-bottom: 0;
            }
            #__exclude_ips_textarea__ {
                width: 100%;
                height: 160px;
                resize: vertical;
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 8px;
                color: #e2e8f0;
                font-family: 'Consolas', 'Courier New', monospace;
                font-size: 13px;
                line-height: 1.65;
                padding: 9px 11px;
                outline: none;
                box-sizing: border-box;
                transition: border-color 0.2s, box-shadow 0.2s;
            }
            #__exclude_ips_textarea__:focus {
                border-color: rgba(248,113,113,0.55);
                box-shadow: 0 0 0 2px rgba(239,68,68,0.15);
            }
            #__exclude_ips_textarea__::placeholder { color: #475569; }
            #__exclude_ips_hint__ {
                font-size: 10px; color: #475569;
                margin-top: 6px; line-height: 1.45;
            }
            #__exclude_ips_hint__ strong { color: #64748b; }
        `;
        document.head.appendChild(st);

        // ── Build the floating panel ──────────────────────────
        const wrap = document.createElement('div');
        wrap.id = '__exclude_ips_float__';
        wrap.innerHTML = `
            <div class="eip-card">
                <div class="eip-header" id="__eip_header__">
                    <div class="eip-icon">🚫</div>
                    <div class="eip-title">Exclude IPs</div>
                    <span id="__exclude_ips_badge__">0 excluded</span>
                    <button id="__eip_toggle_btn__" title="Collapse / Expand">▼</button>
                </div>
                <div id="__exclude_ips_body__">
                    <textarea
                        id="__exclude_ips_textarea__"
                        placeholder="One IP per line&#10;(or comma / space separated)&#10;&#10;Checked once before each drop starts&#10;(before PAUSE · DELETE · RESET · SCHEDULE)"
                        spellcheck="false"
                        autocomplete="off"
                    ></textarea>
                    <div id="__exclude_ips_hint__">
                        💡 Read <strong>once per drop</strong> — changes take effect at the start of the next drop (before PAUSE).
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(wrap);

        // ── Collapse / expand toggle ──────────────────────────
        const body      = document.getElementById('__exclude_ips_body__');
        const toggleBtn = document.getElementById('__eip_toggle_btn__');
        const header    = document.getElementById('__eip_header__');
        let collapsed   = false;

        function _toggle() {
            collapsed = !collapsed;
            body.classList.toggle('collapsed', collapsed);
            toggleBtn.textContent = collapsed ? '▲' : '▼';
        }
        // Click anywhere on the header to toggle, but only the button fires it
        // (so the header can still be used as a drag handle in future)
        toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); _toggle(); });
        header.addEventListener('click', _toggle);

        // ── Live badge counter ────────────────────────────────
        const ta    = document.getElementById('__exclude_ips_textarea__');
        const badge = document.getElementById('__exclude_ips_badge__');
        function _updateBadge() {
            const ips = ta.value.split(/[\n,\s]+/).map(s => s.trim()).filter(s => s.length > 0);
            const n   = ips.length;
            badge.textContent = n === 0 ? '0 excluded' : n + ' excluded';
            if (n > 0) badge.classList.add('active');
            else       badge.classList.remove('active');
        }
        ta.addEventListener('input',  _updateBadge);
        ta.addEventListener('change', _updateBadge);

        // ── Make the panel draggable ──────────────────────────
        let _dragX = 0, _dragY = 0, _dragging = false;
        header.addEventListener('mousedown', (e) => {
            if (e.target === toggleBtn) return; // don't drag when clicking toggle
            _dragging = true;
            _dragX = e.clientX - wrap.getBoundingClientRect().left;
            _dragY = e.clientY - wrap.getBoundingClientRect().top;
            wrap.style.transition = 'none';
        });
        document.addEventListener('mousemove', (e) => {
            if (!_dragging) return;
            wrap.style.left = (e.clientX - _dragX) + 'px';
            wrap.style.top  = (e.clientY - _dragY) + 'px';
        });
        document.addEventListener('mouseup', () => {
            _dragging = false;
            wrap.style.transition = '';
        });

        console.log('[ExcludeIPs] Floating panel injected successfully.');
    }

    // Inject as soon as the body is available
    if (document.body) {
        _doInject();
    } else {
        document.addEventListener('DOMContentLoaded', _doInject);
    }
})();

// ============================================================
// ADDITIONAL / UPDATE IPs — Floating panel
// ============================================================
// Same design as the Exclude IPs panel but with a green accent.
// Textarea ID: __additional_ips_textarea__
// Format: server:ip:target[:customIncrement[:customSuccessThreshold]]
// Re-read live before every drop via applyAdditionalIpsBeforeDrop().
// ============================================================
(function injectAdditionalIpsPanel() {
    if (!window.location.pathname.includes('/deployment/deploy') && !window.location.pathname.includes('/deploy/deploy')) return;

    function _doInject() {
        if (document.getElementById('__additional_ips_float__')) return;
        if (!document.body) return;

        // ── Styles ────────────────────────────────────────────
        const st = document.createElement('style');
        st.id = '__additional_ips_float_styles__';
        st.textContent = `
            #__additional_ips_float__ {
                position: fixed;
                top: 80px;
                left: 460px;
                z-index: 999997;
                width: 440px;
                font-family: 'Segoe UI', system-ui, sans-serif;
                animation: __aip_slideIn__ 0.35s cubic-bezier(0.34,1.56,0.64,1);
            }
            @keyframes __aip_slideIn__ {
                from { opacity:0; transform: translateY(-20px) scale(0.95); }
                to   { opacity:1; transform: translateY(0)      scale(1); }
            }
            #__additional_ips_float__ .aip-card {
                background: linear-gradient(135deg, #0f2318 0%, #162b1f 100%);
                border: 1px solid rgba(34,197,94,0.35);
                border-radius: 14px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.06) inset;
                overflow: hidden;
            }
            #__additional_ips_float__ .aip-header {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 10px 13px;
                background: rgba(34,197,94,0.10);
                border-bottom: 1px solid rgba(34,197,94,0.2);
                cursor: pointer;
                user-select: none;
            }
            #__additional_ips_float__ .aip-icon {
                width: 26px; height: 26px;
                border-radius: 7px;
                background: rgba(34,197,94,0.20);
                display: flex; align-items: center; justify-content: center;
                font-size: 13px; flex-shrink: 0;
            }
            #__additional_ips_float__ .aip-title {
                font-size: 11px; font-weight: 700;
                letter-spacing: 0.07em; text-transform: uppercase; color: #4ade80;
                flex: 1;
            }
            #__additional_ips_badge__ {
                font-size: 10px; font-weight: 700;
                padding: 2px 8px; border-radius: 20px;
                background: rgba(255,255,255,0.07); color: #94a3b8;
                border: 1px solid rgba(255,255,255,0.1);
                letter-spacing: 0.04em; white-space: nowrap;
                transition: background 0.2s, color 0.2s;
            }
            #__additional_ips_badge__.active {
                background: rgba(74,222,128,0.18);
                border-color: rgba(74,222,128,0.4);
                color: #4ade80;
            }
            #__aip_toggle_btn__ {
                background: none; border: none; cursor: pointer;
                color: #64748b; font-size: 13px; padding: 0;
                line-height: 1; transition: color 0.15s;
            }
            #__aip_toggle_btn__:hover { color: #4ade80; }
            #__additional_ips_body__ {
                padding: 10px 12px 12px;
                transition: max-height 0.3s ease, opacity 0.25s ease;
                max-height: 340px;
                opacity: 1;
                overflow: hidden;
            }
            #__additional_ips_body__.collapsed {
                max-height: 0;
                opacity: 0;
                padding-top: 0;
                padding-bottom: 0;
            }
            #__additional_ips_textarea__ {
                width: 100%;
                height: 160px;
                resize: vertical;
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 8px;
                color: #bbf7d0;
                font-family: 'Consolas', 'Courier New', monospace;
                font-size: 12px;
                line-height: 1.65;
                padding: 9px 11px;
                outline: none;
                box-sizing: border-box;
                transition: border-color 0.2s, box-shadow 0.2s;
            }
            #__additional_ips_textarea__:focus {
                border-color: rgba(74,222,128,0.55);
                box-shadow: 0 0 0 2px rgba(34,197,94,0.15);
            }
            #__additional_ips_textarea__::placeholder { color: #1e4d2b; }
            #__additional_ips_hint__ {
                font-size: 10px; color: #475569;
                margin-top: 6px; line-height: 1.5;
            }
            #__additional_ips_hint__ strong { color: #64748b; }
            #__additional_ips_hint__ code {
                font-family: 'Consolas', monospace;
                font-size: 10px;
                background: rgba(255,255,255,0.06);
                padding: 1px 5px; border-radius: 4px;
                color: #86efac;
            }
        `;
        document.head.appendChild(st);

        // ── Build the floating panel ──────────────────────────
        const wrap = document.createElement('div');
        wrap.id = '__additional_ips_float__';
        wrap.innerHTML = `
            <div class="aip-card">
                <div class="aip-header" id="__aip_header__">
                    <div class="aip-icon">➕</div>
                    <div class="aip-title">Additional / Update IPs</div>
                    <span id="__additional_ips_badge__">0 entries</span>
                    <button id="__aip_toggle_btn__" title="Collapse / Expand">▼</button>
                </div>
                <div id="__additional_ips_body__">
                    <textarea
                        id="__additional_ips_textarea__"
                        placeholder="server:ip:target&#10;server:ip:target:increment:successes&#10;&#10;Examples:&#10;s_tss1_4876:84.247.140.109:5000&#10;s_tss1_4876:84.247.140.110:5000:200:3&#10;s_tss1_4876:84.247.140.111:5000::2&#10;&#10;Re-read before every drop."
                        spellcheck="false"
                        autocomplete="off"
                    ></textarea>
                    <div id="__additional_ips_hint__">
                        💡 <strong>New IPs</strong> are added to the process. <strong>Existing IPs</strong> have their target + increment + success-threshold updated.<br>
                        Format: <code>server:ip:target[:inc[:succ]]</code> — empty field inherits global setting.<br>
                        <strong>Exclude IPs</strong> always wins if the same IP appears in both panels.
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(wrap);

        // ── Collapse / expand toggle ──────────────────────────
        const body      = document.getElementById('__additional_ips_body__');
        const toggleBtn = document.getElementById('__aip_toggle_btn__');
        const header    = document.getElementById('__aip_header__');
        let collapsed   = false;

        function _toggle() {
            collapsed = !collapsed;
            body.classList.toggle('collapsed', collapsed);
            toggleBtn.textContent = collapsed ? '▲' : '▼';
        }
        toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); _toggle(); });
        header.addEventListener('click', _toggle);

        // ── Live badge counter ────────────────────────────────
        const ta    = document.getElementById('__additional_ips_textarea__');
        const badge = document.getElementById('__additional_ips_badge__');
        function _updateBadge() {
            const lines = ta.value.split('\n')
                .map(s => s.trim())
                .filter(s => s.length > 0 && s.split(':').length >= 2);
            const n = lines.length;
            badge.textContent = n === 0 ? '0 entries' : n + (n === 1 ? ' entry' : ' entries');
            if (n > 0) badge.classList.add('active');
            else       badge.classList.remove('active');
        }
        ta.addEventListener('input',  _updateBadge);
        ta.addEventListener('change', _updateBadge);

        // ── Make the panel draggable ──────────────────────────
        let _dragX = 0, _dragY = 0, _dragging = false;
        header.addEventListener('mousedown', (e) => {
            if (e.target === toggleBtn) return;
            _dragging = true;
            _dragX = e.clientX - wrap.getBoundingClientRect().left;
            _dragY = e.clientY - wrap.getBoundingClientRect().top;
            wrap.style.transition = 'none';
        });
        document.addEventListener('mousemove', (e) => {
            if (!_dragging) return;
            wrap.style.left = (e.clientX - _dragX) + 'px';
            wrap.style.top  = (e.clientY - _dragY) + 'px';
        });
        document.addEventListener('mouseup', () => {
            _dragging = false;
            wrap.style.transition = '';
        });

        console.log('[AdditionalIPs] Floating panel injected successfully.');
    }

    if (document.body) {
        _doInject();
    } else {
        document.addEventListener('DOMContentLoaded', _doInject);
    }
})();

// ============================================================
// LATEST MESSAGE — Floating panel
// ============================================================
// Polls http://203.161.41.70:6010/Latest_messages every 5s.
// Shows the latest message in a floating panel (blue accent).
// Hides the panel when the response indicates "no new message".
// Updates the message live; keeps the last message if unchanged.
// ============================================================
(function injectLatestMessagePanel() {
    if (!window.location.pathname.includes('/deployment/deploy')) return;

    const _LM_API_URL    = 'http://203.161.41.70:6010/Latest_messages';
    let   _lmInterval    = null;
    let   _lmLastMessage = null;
    let   _lmPanelEl     = null;

    // ── Helpers ───────────────────────────────────────────────

    function _lmIsNoMessage(text) {
        if (!text) return true;
        const t = text.trim().toLowerCase();
        return t === '' || t.includes('no new message');
    }

    function _lmExtractText(raw) {
        // Try JSON first; fall back to plain text
        try {
            const obj = JSON.parse(raw);
            if (typeof obj === 'object' && obj !== null) {
                const val = obj.message ?? obj.text ?? obj.data ?? Object.values(obj)[0];
                if (val !== undefined) return String(val).trim();
            }
            return String(obj).trim();
        } catch (_) {
            return String(raw).trim();
        }
    }

    // ── DOM: show / hide panel ────────────────────────────────

    function _lmShowPanel(message) {
        if (!document.body) return;

        // Inject styles once
        if (!document.getElementById('__lm_float_styles__')) {
            const st = document.createElement('style');
            st.id = '__lm_float_styles__';
            st.textContent = `
                #__lm_float__ {
                    position: fixed;
                    bottom: 390px;
                    left: 20px;
                    z-index: 999997;
                    width: 380px;
                    font-family: 'Segoe UI', system-ui, sans-serif;
                    animation: __lm_slideIn__ 0.35s cubic-bezier(0.34,1.56,0.64,1);
                }
                @keyframes __lm_slideIn__ {
                    from { opacity:0; transform: translateY(20px) scale(0.95); }
                    to   { opacity:1; transform: translateY(0)     scale(1); }
                }
                #__lm_float__ .lm-card {
                    background: linear-gradient(135deg, #0f1a35 0%, #162040 100%);
                    border: 1px solid rgba(99,102,241,0.38);
                    border-radius: 14px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.06) inset;
                    overflow: hidden;
                }
                #__lm_float__ .lm-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 10px 13px;
                    background: rgba(99,102,241,0.12);
                    border-bottom: 1px solid rgba(99,102,241,0.22);
                    cursor: pointer;
                    user-select: none;
                }
                #__lm_float__ .lm-icon {
                    width: 26px; height: 26px;
                    border-radius: 7px;
                    background: rgba(99,102,241,0.22);
                    display: flex; align-items: center; justify-content: center;
                    font-size: 13px; flex-shrink: 0;
                }
                #__lm_float__ .lm-title {
                    font-size: 11px; font-weight: 700;
                    letter-spacing: 0.07em; text-transform: uppercase; color: #818cf8;
                    flex: 1;
                }
                #__lm_pulse__ {
                    width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
                    background: #818cf8;
                    box-shadow: 0 0 5px #818cf8;
                    animation: __lm_pulse__ 2s infinite;
                }
                @keyframes __lm_pulse__ { 0%,100%{opacity:1} 50%{opacity:0.25} }
                #__lm_toggle_btn__ {
                    background: none; border: none; cursor: pointer;
                    color: #64748b; font-size: 13px; padding: 0;
                    line-height: 1; transition: color 0.15s;
                }
                #__lm_toggle_btn__:hover { color: #818cf8; }
                #__lm_body__ {
                    padding: 12px 14px 14px;
                    transition: max-height 0.3s ease, opacity 0.25s ease;
                    max-height: 300px;
                    opacity: 1;
                    overflow: hidden;
                }
                #__lm_body__.collapsed {
                    max-height: 0;
                    opacity: 0;
                    padding-top: 0;
                    padding-bottom: 0;
                }
                #__lm_text__ {
                    font-size: 13px;
                    line-height: 1.65;
                    color: #c7d2fe;
                    white-space: pre-wrap;
                    word-break: break-word;
                    background: rgba(255,255,255,0.04);
                    border: 1px solid rgba(99,102,241,0.18);
                    border-radius: 8px;
                    padding: 10px 12px;
                    font-family: 'Consolas', 'Courier New', monospace;
                    min-height: 40px;
                }
                #__lm_updated__ {
                    font-size: 9px; color: #374151;
                    margin-top: 6px; text-align: right;
                    letter-spacing: 0.04em;
                }
            `;
            document.head.appendChild(st);
        }

        // Create panel element once
        if (!_lmPanelEl || !_lmPanelEl.isConnected) {
            const wrap = document.createElement('div');
            wrap.id = '__lm_float__';
            wrap.innerHTML = `
                <div class="lm-card">
                    <div class="lm-header" id="__lm_header__">
                        <div class="lm-icon">📨</div>
                        <div class="lm-title">Latest Message</div>
                        <div id="__lm_pulse__"></div>
                        <button id="__lm_toggle_btn__" title="Collapse / Expand">▼</button>
                    </div>
                    <div id="__lm_body__">
                        <div id="__lm_text__"></div>
                        <div id="__lm_updated__"></div>
                    </div>
                </div>
            `;
            document.body.appendChild(wrap);
            _lmPanelEl = wrap;

            // Collapse / expand
            const body      = document.getElementById('__lm_body__');
            const toggleBtn = document.getElementById('__lm_toggle_btn__');
            const header    = document.getElementById('__lm_header__');
            let collapsed   = false;

            function _toggle() {
                collapsed = !collapsed;
                body.classList.toggle('collapsed', collapsed);
                toggleBtn.textContent = collapsed ? '▲' : '▼';
            }
            toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); _toggle(); });
            header.addEventListener('click', _toggle);

            // Draggable — switches from bottom-anchored to top-anchored on first drag
            let _dragX = 0, _dragY = 0, _dragging = false;
            header.addEventListener('mousedown', (e) => {
                if (e.target === toggleBtn) return;
                _dragging = true;
                if (wrap.style.bottom !== 'auto') {
                    const rect  = wrap.getBoundingClientRect();
                    wrap.style.top    = rect.top  + 'px';
                    wrap.style.left   = rect.left + 'px';
                    wrap.style.bottom = 'auto';
                }
                _dragX = e.clientX - wrap.getBoundingClientRect().left;
                _dragY = e.clientY - wrap.getBoundingClientRect().top;
                wrap.style.transition = 'none';
            });
            document.addEventListener('mousemove', (e) => {
                if (!_dragging) return;
                wrap.style.left = (e.clientX - _dragX) + 'px';
                wrap.style.top  = (e.clientY - _dragY) + 'px';
            });
            document.addEventListener('mouseup', () => {
                _dragging = false;
                wrap.style.transition = '';
            });

            console.log('[LatestMessage] Floating panel injected.');
        }

        // Update content
        const textEl    = document.getElementById('__lm_text__');
        const updatedEl = document.getElementById('__lm_updated__');
        if (textEl)    textEl.textContent = message;
        if (updatedEl) {
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            updatedEl.textContent =
                `Updated ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        }
    }

    function _lmHidePanel() {
        if (_lmPanelEl && _lmPanelEl.isConnected) {
            _lmPanelEl.remove();
        }
        _lmPanelEl = null;
    }

    // ── Polling ───────────────────────────────────────────────

    async function _lmPoll() {
        try {
            const resp = await fetch(_LM_API_URL, {
                method : 'GET',
                headers: { 'Accept': 'text/plain, application/json' }
            });

            const raw     = await resp.text();
            const message = _lmExtractText(raw);

            if (_lmIsNoMessage(message)) {
                _lmHidePanel();
                _lmLastMessage = null;
                return;
            }

            // Only update the stored message if it changed
            if (message !== _lmLastMessage) {
                _lmLastMessage = message;
            }

            // Always call show to keep the "Updated" timestamp fresh
            _lmShowPanel(_lmLastMessage);

        } catch (err) {
            // Network error — keep last known message visible, don't hide
            console.warn('[LatestMessage] Poll error:', err.message);
        }
    }

    function _lmStart() {
        _lmPoll(); // immediate first call
        _lmInterval = setInterval(_lmPoll, 5000);
    }

    // ── Boot ──────────────────────────────────────────────────

    if (document.body) {
        _lmStart();
    } else {
        document.addEventListener('DOMContentLoaded', _lmStart);
    }
})();

// ══════════════════════════════════════════════════════════════
// ── Contact TSSW Team — Floating trigger + overlay modal ─────
// ══════════════════════════════════════════════════════════════
(function () {
    const _CONTACT_CHANNEL   = '-1003975805335';
    const _CONTACT_BOT_TOKEN = TELEGRAM_BOT_TOKEN; // from telegram.js

    // ── Helpers ───────────────────────────────────────────────
    function _ctGetUsername() {
        return _getUsername();
    }

    function _ctGetEntity() {
        // Use live _ipServerMap if process is running
        if (typeof _ipServerMap === 'object') {
            const servers = Object.values(_ipServerMap).filter(Boolean);
            if (servers.length > 0) {
                const srv   = servers[0];
                const parts = srv.split('_');
                const ent   = parts.length >= 3 ? parts[1] : (parts.length >= 2 ? parts[1] : srv);
                if (ent) return ent;
            }
        }
        return 'unknown';
    }

    // ── Inject styles ─────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        #__ct_trigger__ {
            position: fixed;
            bottom: 28px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 2147483646;
            width: 54px;
            height: 54px;
            border-radius: 50%;
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            box-shadow: 0 4px 20px rgba(16,185,129,0.55), 0 2px 8px rgba(0,0,0,0.35);
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: box-shadow 0.18s;
            animation: __ct_pop__ 0.45s cubic-bezier(.34,1.56,.64,1);
        }
        @keyframes __ct_pop__ {
            from { opacity:0; transform:translateX(-50%) scale(0.4); }
            to   { opacity:1; transform:translateX(-50%) scale(1); }
        }
        #__ct_trigger__:hover {
            box-shadow: 0 6px 28px rgba(16,185,129,0.7), 0 3px 10px rgba(0,0,0,0.4);
            filter: brightness(1.1);
        }
        #__ct_trigger__:active { filter: brightness(0.9); }
        #__ct_trigger__ svg { pointer-events: none; }

        #__ct_backdrop__ {
            position: fixed;
            inset: 0;
            z-index: 2147483646;
            background: rgba(0,0,0,0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.22s ease;
        }
        #__ct_backdrop__.visible { opacity: 1; }

        #__ct_modal__ {
            width: 380px;
            max-width: calc(100vw - 32px);
            background: linear-gradient(160deg, #0f1923 0%, #141f2e 100%);
            border: 1px solid rgba(16,185,129,0.25);
            border-radius: 18px;
            box-shadow: 0 24px 64px rgba(0,0,0,0.7), 0 1px 0 rgba(255,255,255,0.05) inset;
            overflow: hidden;
            transform: translateY(24px) scale(0.96);
            transition: transform 0.28s cubic-bezier(.34,1.56,.64,1);
        }
        #__ct_backdrop__.visible #__ct_modal__ { transform: translateY(0) scale(1); }

        #__ct_modal__ .ct-head {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 14px 16px 13px;
            background: rgba(16,185,129,0.08);
            border-bottom: 1px solid rgba(16,185,129,0.14);
        }
        #__ct_modal__ .ct-head-icon {
            width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
            background: linear-gradient(135deg,#10b981,#059669);
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 2px 10px rgba(16,185,129,0.45);
        }
        #__ct_modal__ .ct-head-text h2 {
            font-family: 'Segoe UI',system-ui,sans-serif;
            font-size: 13px; font-weight: 700; color: #d1fae5;
            letter-spacing: 0.02em; margin: 0;
        }
        #__ct_modal__ .ct-head-text p {
            font-family: 'Segoe UI',system-ui,sans-serif;
            font-size: 10px; color: #4b9c7f; margin: 2px 0 0;
        }
        #__ct_modal__ .ct-close {
            margin-left: auto;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.08);
            color: #6b7280; border-radius: 8px;
            width: 26px; height: 26px;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; font-size: 16px; line-height: 1;
            transition: background 0.15s, color 0.15s;
            flex-shrink: 0;
        }
        #__ct_modal__ .ct-close:hover { background: rgba(239,68,68,0.15); color: #f87171; border-color: rgba(239,68,68,0.25); }

        #__ct_modal__ .ct-meta {
            display: flex;
            gap: 8px;
            padding: 10px 16px 0;
        }
        #__ct_modal__ .ct-chip {
            display: flex; align-items: center; gap: 5px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.07);
            border-radius: 20px; padding: 4px 10px;
            font-family: 'Segoe UI',system-ui,sans-serif;
            font-size: 10px; color: #9ca3af;
        }
        #__ct_modal__ .ct-chip strong { color: #d1fae5; font-weight: 700; font-family: 'Consolas',monospace; }
        #__ct_modal__ .ct-chip-dot {
            width: 6px; height: 6px; border-radius: 50%; background: #10b981;
            box-shadow: 0 0 5px #10b981; flex-shrink: 0;
        }

        #__ct_modal__ .ct-body { padding: 12px 16px 16px; }

        #__ct_modal__ textarea {
            width: 100%; height: 110px;
            background: rgba(0,0,0,0.35);
            border: 1px solid rgba(16,185,129,0.18);
            border-radius: 10px;
            color: #d1fae5;
            font-family: 'Segoe UI',system-ui,sans-serif;
            font-size: 12px; line-height: 1.65;
            padding: 10px 12px; resize: none; outline: none;
            box-sizing: border-box;
            transition: border-color 0.2s;
        }
        #__ct_modal__ textarea:focus { border-color: rgba(16,185,129,0.5); }
        #__ct_modal__ textarea::placeholder { color: #1c4535; }

        #__ct_send_btn__ {
            width: 100%; margin-top: 10px; padding: 11px;
            background: linear-gradient(135deg,#10b981 0%,#059669 100%);
            border: none; border-radius: 10px;
            color: #fff; font-family: 'Segoe UI',system-ui,sans-serif;
            font-size: 12px; font-weight: 700; letter-spacing: 0.05em;
            cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            box-shadow: 0 4px 14px rgba(16,185,129,0.4);
            transition: opacity 0.15s, transform 0.12s, box-shadow 0.15s;
        }
        #__ct_send_btn__:hover:not(:disabled) {
            opacity: 0.9; transform: translateY(-1px);
            box-shadow: 0 6px 20px rgba(16,185,129,0.55);
        }
        #__ct_send_btn__:active:not(:disabled) { transform: translateY(0); }
        #__ct_send_btn__:disabled { background: #1f2937; color: #374151; cursor: not-allowed; box-shadow: none; }

        #__ct_status__ {
            min-height: 14px; margin-top: 8px;
            text-align: center;
            font-family: 'Segoe UI',system-ui,sans-serif;
            font-size: 11px; line-height: 1.5; color: #4b5563;
        }
        #__ct_status__.busy  { color: #fbbf24; }
        #__ct_status__.error { color: #f87171; }

        #__ct_success_screen__ {
            display: none;
            flex-direction: column; align-items: center; justify-content: center;
            gap: 10px; padding: 32px 24px;
            text-align: center;
        }
        #__ct_success_screen__.visible { display: flex; }
        #__ct_success_screen__ .ct-ok-circle {
            width: 56px; height: 56px; border-radius: 50%;
            background: linear-gradient(135deg,#10b981,#059669);
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 4px 20px rgba(16,185,129,0.5);
            animation: __ct_pop__ 0.4s cubic-bezier(.34,1.56,.64,1);
        }
        #__ct_success_screen__ h3 {
            font-family: 'Segoe UI',system-ui,sans-serif;
            font-size: 14px; font-weight: 700; color: #d1fae5; margin: 0;
        }
        #__ct_success_screen__ p {
            font-family: 'Segoe UI',system-ui,sans-serif;
            font-size: 11px; color: #4b9c7f; margin: 0;
        }
    `;
    document.head.appendChild(style);

    // ── Build trigger button ───────────────────────────────────
    const trigger = document.createElement('button');
    trigger.id = '__ct_trigger__';
    trigger.title = 'Contact TSSW Team';
    trigger.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
        </svg>`;
    document.body.appendChild(trigger);

    // ── Build backdrop + modal ─────────────────────────────────
    const backdrop = document.createElement('div');
    backdrop.id = '__ct_backdrop__';
    backdrop.innerHTML = `
        <div id="__ct_modal__">
            <div class="ct-head">
                <div class="ct-head-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="white">
                        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
                    </svg>
                </div>
                <div class="ct-head-text">
                    <h2>Contact TSSW Team</h2>
                    <p>Your message goes directly to the team</p>
                </div>
                <button class="ct-close" id="__ct_close__">×</button>
            </div>

            <div class="ct-meta">
                <div class="ct-chip">
                    <div class="ct-chip-dot"></div>
                    <span id="__ct_name_chip__">…</span>
                </div>
                <div class="ct-chip">
                    Entity: <strong id="__ct_entity_chip__">…</strong>
                </div>
            </div>

            <div class="ct-body">
                <div id="__ct_form_screen__">
                    <textarea id="__ct_textarea__" placeholder="Describe what happened or what you need help with…"></textarea>
                    <button id="__ct_send_btn__">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="white">
                            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                        </svg>
                        Send Message
                    </button>
                    <div id="__ct_status__"></div>
                </div>
                <div id="__ct_success_screen__">
                    <div class="ct-ok-circle">
                        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="white">
                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
                        </svg>
                    </div>
                    <h3>Message Sent!</h3>
                    <p>The TSSW team has been notified.</p>
                </div>
            </div>
        </div>`;
    document.body.appendChild(backdrop);

    // ── Element refs ──────────────────────────────────────────
    const modal       = document.getElementById('__ct_modal__');
    const closeBtn    = document.getElementById('__ct_close__');
    const textarea    = document.getElementById('__ct_textarea__');
    const sendBtn     = document.getElementById('__ct_send_btn__');
    const statusEl    = document.getElementById('__ct_status__');
    const formScreen  = document.getElementById('__ct_form_screen__');
    const successScr  = document.getElementById('__ct_success_screen__');
    const nameChip    = document.getElementById('__ct_name_chip__');
    const entityChip  = document.getElementById('__ct_entity_chip__');

    // ── Open / close ──────────────────────────────────────────
    function openModal() {
        formScreen.style.display  = 'block';
        successScr.classList.remove('visible');
        textarea.value            = '';
        statusEl.textContent      = '';
        statusEl.className        = '';
        sendBtn.disabled          = false;
        nameChip.textContent      = _ctGetUsername();
        entityChip.textContent    = _ctGetEntity();
        backdrop.style.display    = 'flex';
        requestAnimationFrame(() => backdrop.classList.add('visible'));
        setTimeout(() => textarea.focus(), 280);
    }

    function closeModal() {
        backdrop.classList.remove('visible');
        setTimeout(() => { backdrop.style.display = 'none'; }, 240);
    }

    trigger.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });

    backdrop.style.display = 'none';

    // ── Send ──────────────────────────────────────────────────
    sendBtn.addEventListener('click', async () => {
        const msg = (textarea.value || '').trim();
        if (!msg) {
            statusEl.textContent = 'Please write a message first.';
            statusEl.className   = 'error';
            textarea.focus();
            return;
        }

        sendBtn.disabled     = true;
        statusEl.textContent = 'Sending…';
        statusEl.className   = 'busy';

        const userName = _ctGetUsername();
        const entity   = _ctGetEntity();
        const divider  = '─'.repeat(36);

        const text = [
            '📬 *CONTACT TSSW TEAM*',
            divider,
            `*From   :*  ${userName}`,
            `*Entity :*  ${entity}`,
            divider,
            msg,
            divider,
        ].join('\n');

        try {
            const resp = await fetch(
                `https://api.telegram.org/bot${_CONTACT_BOT_TOKEN}/sendMessage`,
                {
                    method : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body   : JSON.stringify({
                        chat_id    : _CONTACT_CHANNEL,
                        text       : text,
                        parse_mode : 'Markdown'
                    })
                }
            );
            const data = await resp.json();
            if (resp.ok && data.ok) {
                formScreen.style.display = 'none';
                successScr.classList.add('visible');
                setTimeout(closeModal, 2200);
            } else {
                statusEl.textContent = `Failed: ${data.description || 'Unknown error'}`;
                statusEl.className   = 'error';
                sendBtn.disabled     = false;
            }
        } catch (err) {
            statusEl.textContent = `Network error: ${err.message}`;
            statusEl.className   = 'error';
            sendBtn.disabled     = false;
        }
    });
})();