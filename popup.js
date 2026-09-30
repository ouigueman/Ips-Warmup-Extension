// ── Firefox MV2 compatibility shim ──────────────────────────
var browser = (typeof browser !== "undefined") ? browser : chrome;

const statusEl  = document.getElementById("status");
const reportEl  = document.getElementById("final-report");
const startBtn  = document.getElementById("start-deploy-process");
const sheetsDot = document.getElementById("sheets-dot");
const sheetsMsg = document.getElementById("sheets-status-text");
const tgDot     = document.getElementById("tg-dot");
const tgMsg     = document.getElementById("tg-status-text");
const chatIdEl   = document.getElementById("telegram-chat-id");
const tgRemoteStopChk = document.getElementById("telegram-remote-stop");
const sheetsIdEl = document.getElementById("sheets-spreadsheet-id");

// ── Process type selector ────────────────────────────────────
const ispEntriesList            = document.getElementById("isp-entries-list");
const addIspEntryBtn            = document.getElementById("add-isp-entry-btn");

// ── Dynamic ISP entry list ────────────────────────────────────
let _ispEntryCounter = 0;

function _createIspEntry(mode = 'warmup', value = '') {
    _ispEntryCounter++;
    const id  = _ispEntryCounter;
    const row = document.createElement('div');
    row.className   = 'isp-entry-row';
    row.dataset.id  = id;

    const radioName   = `isp-mode-${id}`;
    row.innerHTML = `
        <span class="isp-entry-num">#</span>
        <div class="isp-mode-group">
            <label class="isp-mode-label warmup-label">
                <input type="radio" name="${radioName}" value="warmup" ${mode === 'warmup' ? 'checked' : ''} />
                <span>Warmup Lists</span>
            </label>
            <label class="isp-mode-label passive-label">
                <input type="radio" name="${radioName}" value="passive" ${mode === 'passive' ? 'checked' : ''} />
                <span>Passive Lists</span>
            </label>
        </div>
        <input type="text" class="isp-entry-input" placeholder="ISP Profile exact value…" value="${value.replace(/"/g,'&quot;')}" />
        <button class="isp-entry-remove" title="Remove">×</button>
    `;

    row.querySelector('.isp-entry-remove').addEventListener('click', () => {
        const rows = ispEntriesList.querySelectorAll('.isp-entry-row');
        if (rows.length <= 1) return; // keep minimum 1
        row.classList.add('fade-out');
        setTimeout(() => { row.remove(); _renumberEntries(); saveAllSettings(); }, 220);
    });

    row.querySelector('.isp-entry-input').addEventListener('input', saveAllSettings);
    row.querySelectorAll('input[type="radio"]').forEach(r => r.addEventListener('change', () => {
        const value = r.value;
        if (value === 'passive') {
            let removeMode = false;
            ispEntriesList.querySelectorAll('.isp-entry-row').forEach(cand => {
                if (removeMode) {
                    cand.remove();
                } else if (cand === row) {
                    removeMode = true;
                }
            });
            _renumberEntries();
        } else {
            _refreshRemoveButtons();
        }
        saveAllSettings();
    }));

    ispEntriesList.appendChild(row);
    _renumberEntries();
    return row;
}

function _renumberEntries() {
    ispEntriesList.querySelectorAll('.isp-entry-row').forEach((row, i) => {
        const num = row.querySelector('.isp-entry-num');
        if (num) num.textContent = i + 1;
    });
    _refreshRemoveButtons();
}

function _refreshRemoveButtons() {
    const rows = Array.from(ispEntriesList.querySelectorAll('.isp-entry-row'));
    let hasPassive = false;
    rows.forEach(row => {
        const btn = row.querySelector('.isp-entry-remove');
        if (btn) btn.disabled = rows.length <= 1;
        const modeRadio = row.querySelector('input[type="radio"]:checked');
        if (modeRadio && modeRadio.value === 'passive') {
            hasPassive = true;
        }
    });

    if (addIspEntryBtn) {
        addIspEntryBtn.disabled = hasPassive;
        addIspEntryBtn.style.opacity = hasPassive ? '0.3' : '1';
        addIspEntryBtn.style.cursor = hasPassive ? 'not-allowed' : 'pointer';
    }
}

function _getIspEntries() {
    const entries = [];
    ispEntriesList.querySelectorAll('.isp-entry-row').forEach(row => {
        const modeRadio = row.querySelector('input[type="radio"]:checked');
        const valInput  = row.querySelector('.isp-entry-input');
        const mode      = modeRadio ? modeRadio.value : 'warmup';
        entries.push({
            mode,
            value: valInput ? valInput.value.trim() : ''
        });
    });
    return entries;
}

function _loadIspEntries(entries) {
    // Clear all rows
    ispEntriesList.innerHTML = '';
    _ispEntryCounter = 0;
    if (!entries || entries.length === 0) {
        _createIspEntry('warmup', '');
    } else {
        entries.forEach(e => _createIspEntry(e.mode || 'warmup', e.value || ''));
    }
}

addIspEntryBtn.addEventListener('click', () => {
    _createIspEntry('warmup', '');
    saveAllSettings();
});

// Initialize with one default entry
_createIspEntry('warmup', '');

// ═══════════════════════════════════════════════════════════════
// ── Additional IP Groups (rotation per drop) ─────────────────
// ═══════════════════════════════════════════════════════════════
const ipGroupsList    = document.getElementById("ip-groups-list");
const addIpGroupBtn   = document.getElementById("add-ip-group-btn");
const ipRotationInfo  = document.getElementById("ip-rotation-info");

let _ipGroupCounter = 0;

function _updateIpGroupNumbers() {
    ipGroupsList.querySelectorAll('.ip-group-row').forEach((row, i) => {
        const lbl = row.querySelector('.ip-group-label');
        if (lbl) lbl.textContent = `Added Group ${i + 1} — rotates with main IPs`;
    });
    // Show/hide the rotation info badge
    const count = ipGroupsList.querySelectorAll('.ip-group-row').length;
    ipRotationInfo.classList.toggle('visible', count > 0);
}

function _createIpGroup(value = '') {
    _ipGroupCounter++;
    const row = document.createElement('div');
    row.className = 'ip-group-row';

    row.innerHTML = `
        <div class="ip-group-header">
            <span class="ip-group-label">Added Group — rotates with main IPs</span>
            <button class="ip-group-remove" title="Remove this group">× Remove</button>
        </div>
        <div class="ip-group-body">
            <textarea class="ip-group-textarea"
                placeholder="[SERVEUR]:[IP]:[NUMBER_SENT]:[SENT_INCREMENT]:[SUCCESSES_TO_SCALE_UP]"
            >${value.replace(/</g, '&lt;')}</textarea>
            <div class="ip-group-hint">
                These IPs are added to the Main IPs for this group's turn only. The group rotates in order each drop.
            </div>
        </div>
    `;

    row.querySelector('.ip-group-remove').addEventListener('click', () => {
        row.classList.add('fade-out');
        setTimeout(() => {
            row.remove();
            _updateIpGroupNumbers();
            saveAllSettings();
        }, 220);
    });

    row.querySelector('.ip-group-textarea').addEventListener('input', saveAllSettings);

    ipGroupsList.appendChild(row);
    _updateIpGroupNumbers();
    return row;
}

function _getIpGroups() {
    const groups = [];
    ipGroupsList.querySelectorAll('.ip-group-row').forEach(row => {
        const ta = row.querySelector('.ip-group-textarea');
        groups.push(ta ? ta.value : '');
    });
    return groups;
}

function _loadIpGroups(groups) {
    ipGroupsList.innerHTML = '';
    _ipGroupCounter = 0;
    if (!groups || groups.length === 0) {
        _updateIpGroupNumbers();
        return;
    }
    groups.forEach(val => _createIpGroup(val));
}

addIpGroupBtn.addEventListener('click', () => {
    _createIpGroup('');
    saveAllSettings();
});

// ── Email Count UI ───────────────────────────────────────────
const emailCountChk    = document.getElementById("email-count-enabled");
const emailCountFields = document.getElementById("email-count-fields");
const ecDot            = document.getElementById("ec-dot");
const ecStatusText     = document.getElementById("ec-status-text");

emailCountChk.addEventListener("change", () => {
    emailCountFields.style.display = emailCountChk.checked ? "flex" : "none";
    saveAllSettings();
    if (emailCountChk.checked) {
        _scheduleAppPasswordCheck();
    } else {
        _appPasswordCheckState = 'idle';
        _setAppPasswordIcons('idle');
    }
    _updateStartButtonAvailability();
});

["email-count-gmail","email-count-password","ec-h","ec-m","ec-s"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", saveAllSettings);
});

// ── App Password validation (Gmail address + App Password) ────
// Calls the check_app_password API whenever both fields are filled,
// and gates the "Start Warmup Process" button on a successful ("ok")
// response. If the Email Count feature is disabled, the button is
// never blocked by this check.
const CHECK_APP_PASSWORD_URL = 'http://203.161.41.70:5314/check_app_password';

const gmailInputEl      = document.getElementById('email-count-gmail');
const passwordInputEl   = document.getElementById('email-count-password');
const gmailIconEl       = document.getElementById('email-count-gmail-icon');
const passwordIconEl    = document.getElementById('email-count-password-icon');
const appPassStatusRow  = document.getElementById('app-pass-status-row');

let _appPasswordCheckState = 'idle'; // 'idle' | 'checking' | 'ok' | 'error'
let _appPasswordCheckTimer = null;
let _appPasswordCheckToken = 0; // guards against stale/out-of-order responses

function _setAppPasswordIcons(state, message = '') {
    [gmailIconEl, passwordIconEl].forEach(el => {
        if (!el) return;
        el.className = 'app-pass-icon';
        el.textContent = '';
        if (state === 'checking') {
            el.classList.add('checking');
            el.title = 'Checking App Password…';
        } else if (state === 'ok') {
            el.classList.add('ok');
            el.textContent = '✓';
            el.title = 'App Password valid';
        } else if (state === 'error') {
            el.classList.add('error');
            el.textContent = '✕';
            el.title = message || 'App Password invalid';
        } else {
            el.title = '';
        }
    });
    if (appPassStatusRow) {
        if (state === 'checking') {
            appPassStatusRow.textContent = '⏳ Verifying Gmail App Password…';
            appPassStatusRow.style.color = '#fbbf24';
        } else if (state === 'ok') {
            appPassStatusRow.textContent = '✅ App Password verified.';
            appPassStatusRow.style.color = '#4ade80';
        } else if (state === 'error') {
            appPassStatusRow.textContent = '❌ ' + (message || 'Invalid Gmail address / App Password.');
            appPassStatusRow.style.color = '#f87171';
        } else {
            appPassStatusRow.textContent = '';
        }
    }
}

function _updateStartButtonAvailability() {
    if (!emailCountChk.checked) {
        startBtn.disabled = false;
        return;
    }
    startBtn.disabled = _appPasswordCheckState !== 'ok';
}

async function _checkAppPasswordNow() {
    const email    = (gmailInputEl    && gmailInputEl.value    || '').trim();
    const password = (passwordInputEl && passwordInputEl.value || '').trim();

    if (!email || !password) {
        _appPasswordCheckState = 'idle';
        _setAppPasswordIcons('idle');
        _updateStartButtonAvailability();
        return;
    }

    _appPasswordCheckState = 'checking';
    _setAppPasswordIcons('checking');
    _updateStartButtonAvailability();

    const myToken = ++_appPasswordCheckToken;

    try {
        const resp = await fetch(CHECK_APP_PASSWORD_URL, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ email, app_password: password })
        });
        const data = await resp.json();

        if (myToken !== _appPasswordCheckToken) return; // a newer check superseded this one

        if (data && data.status === 'ok') {
            _appPasswordCheckState = 'ok';
            _setAppPasswordIcons('ok');
        } else {
            _appPasswordCheckState = 'error';
            _setAppPasswordIcons('error', 'Invalid Gmail address / App Password.');
        }
    } catch (err) {
        if (myToken !== _appPasswordCheckToken) return;
        console.warn('[AppPasswordCheck] Error:', err);
        _appPasswordCheckState = 'error';
        _setAppPasswordIcons('error', 'Could not reach verification server.');
    }

    _updateStartButtonAvailability();
}

function _scheduleAppPasswordCheck() {
    // Immediately show "idle" (clears old icons) while the user is still typing,
    // then debounce the actual API call.
    _appPasswordCheckState = 'idle';
    _setAppPasswordIcons('idle');
    _updateStartButtonAvailability();

    if (!emailCountChk.checked) return;

    if (_appPasswordCheckTimer) clearTimeout(_appPasswordCheckTimer);
    _appPasswordCheckTimer = setTimeout(_checkAppPasswordNow, 700);
}

if (gmailInputEl)    gmailInputEl.addEventListener('input', _scheduleAppPasswordCheck);
if (passwordInputEl) passwordInputEl.addEventListener('input', _scheduleAppPasswordCheck);

// ── Spam stop threshold UI ───────────────────────────────────
const spamModeNone   = document.getElementById("spam-mode-none");
const spamModeNumber = document.getElementById("spam-mode-number");
const spamModePct    = document.getElementById("spam-mode-pct");
const spamInputRow   = document.getElementById("spam-threshold-input-row");
const spamValueInput = document.getElementById("spam-threshold-value");
const spamLabel      = document.getElementById("spam-threshold-label");
const spamSublabel   = document.getElementById("spam-threshold-sublabel");
const spamUnit       = document.getElementById("spam-threshold-unit");

const spamModeCards = {
    none:       document.getElementById("spam-mode-none-card"),
    number:     document.getElementById("spam-mode-number-card"),
    percentage: document.getElementById("spam-mode-pct-card")
};

function applySpamModeCard(mode) {
    Object.entries(spamModeCards).forEach(([key, card]) => {
        if (!card) return;
        if (key === mode) {
            card.style.borderColor = "rgba(239,68,68,0.55)";
            card.style.background  = "rgba(239,68,68,0.08)";
            card.style.boxShadow   = "0 0 0 1px rgba(239,68,68,0.25)";
        } else {
            card.style.borderColor = "rgba(255,255,255,0.1)";
            card.style.background  = "rgba(255,255,255,0.04)";
            card.style.boxShadow   = "none";
        }
    });

    if (mode === "none") {
        spamInputRow.style.display = "none";
    } else {
        spamInputRow.style.display = "flex";
        if (mode === "number") {
            if (spamLabel)    spamLabel.firstChild.textContent = "Spam count limit";
            if (spamSublabel) spamSublabel.textContent = "Stop if spam messages >= this number";
            if (spamUnit)     spamUnit.textContent      = "";
        } else {
            if (spamLabel)    spamLabel.firstChild.textContent = "Max spam rate (%)";
            if (spamSublabel) spamSublabel.textContent = "Stop if spam rate >= this % (e.g. 10 = stop when spam% >= 10%)";
            if (spamUnit)     spamUnit.textContent      = "%";
        }
    }
}

[spamModeNone, spamModeNumber, spamModePct].forEach(function(radio) {
    if (!radio) return;
    radio.addEventListener("change", function() {
        applySpamModeCard(radio.value);
        saveAllSettings();
    });
});
if (spamValueInput) spamValueInput.addEventListener("input", saveAllSettings);

// ── Drop offset UI ───────────────────────────────────────────
const useOffsetChk    = document.getElementById("use-drop-offset");
const dropOffsetRow   = document.getElementById("drop-offset-row");
const dropStartInput  = document.getElementById("drop-start-number");
const dropOffsetPrev  = document.getElementById("drop-offset-preview");
const totalDropsInput = document.getElementById("total-drops");

// ── Start Always From ────────────────────────────────────────
const startAlwaysFromChk   = document.getElementById("start-always-from");
const startAlwaysFromRow   = document.getElementById("start-always-from-row");
const startAlwaysFromValue = document.getElementById("start-always-from-value");
const savedOffsetValueEl   = document.getElementById("saved-offset-value");
const savedOffsetTimeEl    = document.getElementById("saved-offset-time");

function _refreshSavedOffsetDisplay() {
    browser.storage.local.get(['savedStartOffset', 'savedStartOffsetAt'], data => {
        const val = (data && typeof data.savedStartOffset === 'number') ? data.savedStartOffset : 0;
        if (savedOffsetValueEl) savedOffsetValueEl.textContent = val.toLocaleString();
        if (savedOffsetTimeEl) {
            if (data && data.savedStartOffsetAt) {
                const d   = new Date(data.savedStartOffsetAt);
                const pad = n => String(n).padStart(2, '0');
                savedOffsetTimeEl.textContent = `as of ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            } else {
                savedOffsetTimeEl.textContent = '';
            }
        }
    });
}
_refreshSavedOffsetDisplay();

// Live-update the banner while the popup stays open during a running process
browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "OFFSET_SAVED") {
        if (savedOffsetValueEl) savedOffsetValueEl.textContent = (msg.value || 0).toLocaleString();
        if (savedOffsetTimeEl) {
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            savedOffsetTimeEl.textContent = `as of ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        }
    }
});

startAlwaysFromChk.addEventListener("change", () => {
    startAlwaysFromRow.classList.toggle("visible", startAlwaysFromChk.checked);
    startAlwaysFromValue.classList.remove('input-error');
    saveAllSettings();
});
startAlwaysFromValue.addEventListener("input", () => {
    startAlwaysFromValue.classList.remove('input-error');
    saveAllSettings();
});

function updateOffsetPreview() {
    const start = parseInt(dropStartInput.value) || 2;
    const total = parseInt(totalDropsInput.value) || 10;
    const displayTotal = start + total - 1;
    dropOffsetPrev.textContent = `${start}/${displayTotal} → ${displayTotal}/${displayTotal}`;
}

useOffsetChk.addEventListener("change", () => {
    if (useOffsetChk.checked) {
        dropOffsetRow.classList.add("visible");
        updateOffsetPreview();
    } else {
        dropOffsetRow.classList.remove("visible");
    }
    saveAllSettings();
});

dropStartInput.addEventListener("input", () => {
    if (useOffsetChk.checked) updateOffsetPreview();
    saveAllSettings();
});

totalDropsInput.addEventListener("input", () => {
    if (useOffsetChk.checked) updateOffsetPreview();
    saveAllSettings();
});

// ── Start-After toggle ───────────────────────────────────────
const startAfterInputs  = document.getElementById("start-after-inputs");
const startImmediateRad = document.getElementById("start-immediate");
const startCustomRad    = document.getElementById("start-custom");

function applyStartMode(mode) {
    if (mode === "custom") {
        startAfterInputs.style.opacity = "1";
        startAfterInputs.style.pointerEvents = "auto";
    } else {
        startAfterInputs.style.opacity = "0.3";
        startAfterInputs.style.pointerEvents = "none";
    }
}

startImmediateRad.addEventListener("change", () => { applyStartMode("immediate"); saveAllSettings(); });
startCustomRad.addEventListener("change",    () => { applyStartMode("custom");    saveAllSettings(); });

// ── Persist ALL settings across popup opens ──────────────────
const PERSIST_KEYS = [
    'customIps',
    'totalDrops', 'successThreshold', 'sentIncrement', 'toleranceRate',
    'dropOffsetEnabled', 'dropStartNumber',
    't0h','t0m','t0s',
    't1h','t1m','t1s',
    't2h','t2m','t2s',
    't3h','t3m','t3s',
    't4h','t4m','t4s',
    't5h','t5m','t5s',
    'startMode',
    'tgChatId', 'tgRemoteStop',
    'sheetsSpreadsheetId',
    'emailCountEnabled', 'emailCountGmail', 'emailCountPassword',
    'ech', 'ecm', 'ecs',
    'spamStopMode', 'spamStopValue',
    'ispDatalistsEntries',
    'shuffleIspSequence',
    'dropNote',
    'resumeNotifyEnabled',
    'pauseResumeFromMultiMonitor',
    'rateCheckIps',
    'ipGroups',
    'multiMonitorJobId',
    'stopDeferredIpsEnabled',
    'deferredIpsMustCompleteEnabled',
    'startAlwaysFromEnabled',
    'startAlwaysFromValue',
];

function saveAllSettings() {
    const startMode   = startCustomRad.checked ? "custom" : "immediate";
    browser.storage.local.set({
        customIps:          document.getElementById("custom-ip-input").value,
        totalDrops:         document.getElementById("total-drops").value,
        successThreshold:   document.getElementById("success-threshold").value,
        sentIncrement:      document.getElementById("sent-increment").value,
        toleranceRate:      document.getElementById("tolerance-rate").value,
        dropOffsetEnabled:  useOffsetChk.checked,
        dropStartNumber:    dropStartInput.value,
        t0h: document.getElementById("t0-h").value,
        t0m: document.getElementById("t0-m").value,
        t0s: document.getElementById("t0-s").value,
        t1h: document.getElementById("t1-h").value,
        t1m: document.getElementById("t1-m").value,
        t1s: document.getElementById("t1-s").value,
        t2h: document.getElementById("t2-h").value,
        t2m: document.getElementById("t2-m").value,
        t2s: document.getElementById("t2-s").value,
        t3h: document.getElementById("t3-h").value,
        t3m: document.getElementById("t3-m").value,
        t3s: document.getElementById("t3-s").value,
        t4h: document.getElementById("t4-h").value,
        t4m: document.getElementById("t4-m").value,
        t4s: document.getElementById("t4-s").value,
        t5h: document.getElementById("t5-h").value,
        t5m: document.getElementById("t5-m").value,
        t5s: document.getElementById("t5-s").value,
        startMode,
        tgChatId: chatIdEl.value.trim(),
        tgRemoteStop: tgRemoteStopChk.checked,
        sheetsSpreadsheetId: sheetsIdEl.value.trim(),
        emailCountEnabled:  emailCountChk.checked,
        emailCountGmail:    (document.getElementById("email-count-gmail")    || {}).value || '',
        emailCountPassword: (document.getElementById("email-count-password") || {}).value || '',
        ech: (document.getElementById("ec-h") || {}).value || '0',
        ecm: (document.getElementById("ec-m") || {}).value || '5',
        ecs: (document.getElementById("ec-s") || {}).value || '0',
        spamStopMode:  (document.querySelector('input[name="spam-stop-mode"]:checked') || {}).value || 'none',
        spamStopValue: (document.getElementById("spam-threshold-value") || {}).value || '10',
        ispDatalistsEntries: JSON.stringify(_getIspEntries()),
        shuffleIspSequence: !!(document.getElementById("shuffle-isp-sequence") || {}).checked,
        dropNote: (document.getElementById("drop-note") || {}).value || '',
        resumeNotifyEnabled: !!(document.getElementById("resume-notify-enabled") || {}).checked,
        pauseResumeFromMultiMonitor: !!(document.getElementById("pause-resume-from-multimonitors") || {}).checked,
        rateCheckIps: Math.min(100, Math.max(0, parseInt((document.getElementById("rate-check-ips") || {}).value) || 0)),
        ipGroups: JSON.stringify(_getIpGroups()),
        multiMonitorJobId: (document.getElementById("multi-monitor-jobid") || {}).value || '',
        stopDeferredIpsEnabled: !!(document.getElementById("stop-deferred-ips") || {}).checked,
        deferredIpsMustCompleteEnabled: !!(document.getElementById("deferred-ips-complete-all") || {}).checked,
        startAlwaysFromEnabled: startAlwaysFromChk.checked,
        startAlwaysFromValue: startAlwaysFromValue.value,
    });
}

// Attach saveAllSettings to all relevant inputs
["custom-ip-input","total-drops","success-threshold","sent-increment","tolerance-rate",
 "t0-h","t0-m","t0-s","t1-h","t1-m","t1-s","t2-h","t2-m","t2-s","t3-h","t3-m","t3-s",
 "t4-h","t4-m","t4-s","t5-h","t5-m","t5-s","drop-note"
].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", saveAllSettings);
});

chatIdEl.addEventListener('input', () => {
    chatIdEl.classList.remove('input-error');
    saveAllSettings();
});

tgRemoteStopChk.addEventListener("change", saveAllSettings);

document.getElementById("resume-notify-enabled").addEventListener("change", saveAllSettings);

const shuffleIspChk = document.getElementById("shuffle-isp-sequence");
if (shuffleIspChk) shuffleIspChk.addEventListener("change", saveAllSettings);
const pauseResumeFromMultiMonitorsChk = document.getElementById("pause-resume-from-multimonitors");
if (pauseResumeFromMultiMonitorsChk) pauseResumeFromMultiMonitorsChk.addEventListener("change", () => {
    const jobIdRow = document.getElementById("multi-monitor-jobid-row");
    if (jobIdRow) jobIdRow.style.display = pauseResumeFromMultiMonitorsChk.checked ? "flex" : "none";
    saveAllSettings();
});
const rateCheckIpsInput = document.getElementById("rate-check-ips");
if (rateCheckIpsInput) rateCheckIpsInput.addEventListener("input", saveAllSettings);

const stopDeferredIpsChk = document.getElementById("stop-deferred-ips");
if (stopDeferredIpsChk) stopDeferredIpsChk.addEventListener("change", () => {
    const deferredCompleteRow = document.getElementById("deferred-complete-row");
    if (deferredCompleteRow) deferredCompleteRow.style.display = stopDeferredIpsChk.checked ? "flex" : "none";
    if (!stopDeferredIpsChk.checked) {
        const deferredCompleteChk = document.getElementById("deferred-ips-complete-all");
        if (deferredCompleteChk) deferredCompleteChk.checked = false;
    }
    saveAllSettings();
});

sheetsIdEl.addEventListener('input', () => {
    sheetsIdEl.classList.remove('input-error');
    saveAllSettings();
});

// ── Restore saved settings on popup open ────────────────────
browser.storage.local.get(PERSIST_KEYS, data => {
    if (data.customIps        != null) document.getElementById("custom-ip-input").value    = data.customIps;
    if (data.totalDrops       != null) document.getElementById("total-drops").value        = data.totalDrops;
    if (data.successThreshold != null) document.getElementById("success-threshold").value  = data.successThreshold;
    if (data.sentIncrement    != null) document.getElementById("sent-increment").value      = data.sentIncrement;
    if (data.toleranceRate    != null) document.getElementById("tolerance-rate").value      = data.toleranceRate;
    if (data.tgChatId)             chatIdEl.value   = data.tgChatId;
    if (data.tgRemoteStop != null) tgRemoteStopChk.checked = data.tgRemoteStop;
    if (data.sheetsSpreadsheetId)  sheetsIdEl.value = data.sheetsSpreadsheetId;

    if (data.dropStartNumber)  dropStartInput.value = data.dropStartNumber;
    if (data.dropOffsetEnabled) {
        useOffsetChk.checked = true;
        dropOffsetRow.classList.add("visible");
        updateOffsetPreview();
    }

    // Time fields
    const timeFields = [
        ['t0h','t0-h'],['t0m','t0-m'],['t0s','t0-s'],
        ['t1h','t1-h'],['t1m','t1-m'],['t1s','t1-s'],
        ['t2h','t2-h'],['t2m','t2-m'],['t2s','t2-s'],
        ['t3h','t3-h'],['t3m','t3-m'],['t3s','t3-s'],
        ['t4h','t4-h'],['t4m','t4-m'],['t4s','t4-s'],
        ['t5h','t5-h'],['t5m','t5-m'],['t5s','t5-s'],
    ];
    timeFields.forEach(([key, id]) => {
        if (data[key] != null) document.getElementById(id).value = data[key];
    });

    // Start mode
    const mode = data.startMode || "immediate";
    if (mode === "custom") {
        startCustomRad.checked = true;
        startImmediateRad.checked = false;
    } else {
        startImmediateRad.checked = true;
        startCustomRad.checked = false;
    }
    applyStartMode(mode);

    // ISP Data Lists entries
    if (data.ispDatalistsEntries) {
        try {
            const entries = JSON.parse(data.ispDatalistsEntries);
            if (Array.isArray(entries) && entries.length > 0) {
                _loadIspEntries(entries);
            }
        } catch(e) { /* keep default */ }
    }

    // Shuffle ISP Sequence toggle
    const shuffleChk = document.getElementById("shuffle-isp-sequence");
    if (shuffleChk && data.shuffleIspSequence) shuffleChk.checked = true;

    // Email count
    if (data.emailCountEnabled) {
        emailCountChk.checked = true;
        emailCountFields.style.display = "flex";
    }
    if (data.emailCountGmail)    document.getElementById("email-count-gmail").value    = data.emailCountGmail;
    if (data.emailCountPassword) document.getElementById("email-count-password").value = data.emailCountPassword;
    if (data.ech != null) document.getElementById("ec-h").value = data.ech;
    if (data.ecm != null) document.getElementById("ec-m").value = data.ecm;
    if (data.ecs != null) document.getElementById("ec-s").value = data.ecs;

    // Re-validate the restored Gmail / App Password (if Email Count is enabled)
    // and set the Start button's initial availability accordingly.
    if (emailCountChk.checked) {
        _scheduleAppPasswordCheck();
    } else {
        _updateStartButtonAvailability();
    }

    // Spam stop threshold
    const savedSpamMode = data.spamStopMode || "none";
    const spamRadio = document.querySelector(`input[name="spam-stop-mode"][value="${savedSpamMode}"]`);
    if (spamRadio) spamRadio.checked = true;
    if (data.spamStopValue != null && document.getElementById("spam-threshold-value")) {
        document.getElementById("spam-threshold-value").value = data.spamStopValue;
    }
    applySpamModeCard(savedSpamMode);

    if (data.dropNote != null) document.getElementById("drop-note").value = data.dropNote;

    const resumeNotifyEl = document.getElementById("resume-notify-enabled");
    if (resumeNotifyEl && data.resumeNotifyEnabled) resumeNotifyEl.checked = true;

    const pauseResumeFromMultiMonitorsEl = document.getElementById("pause-resume-from-multimonitors");
    if (pauseResumeFromMultiMonitorsEl && data.pauseResumeFromMultiMonitor) {
        pauseResumeFromMultiMonitorsEl.checked = true;
        const jobIdRow = document.getElementById("multi-monitor-jobid-row");
        if (jobIdRow) jobIdRow.style.display = "flex";
    }

    const rateCheckIpsEl = document.getElementById("rate-check-ips");
    if (rateCheckIpsEl && data.rateCheckIps != null) rateCheckIpsEl.value = data.rateCheckIps;

    const multiMonitorJobIdEl = document.getElementById("multi-monitor-jobid");
    if (multiMonitorJobIdEl && data.multiMonitorJobId) multiMonitorJobIdEl.value = data.multiMonitorJobId;

    const stopDeferredIpsEl = document.getElementById("stop-deferred-ips");
    if (stopDeferredIpsEl && data.stopDeferredIpsEnabled) stopDeferredIpsEl.checked = true;

    const deferredIpsMustCompleteEl = document.getElementById("deferred-ips-complete-all");
    if (deferredIpsMustCompleteEl && data.deferredIpsMustCompleteEnabled) deferredIpsMustCompleteEl.checked = true;
    const deferredCompleteRow = document.getElementById("deferred-complete-row");
    if (deferredCompleteRow && data.stopDeferredIpsEnabled) deferredCompleteRow.style.display = "flex";

    // Start Always From
    if (data.startAlwaysFromEnabled) {
        startAlwaysFromChk.checked = true;
        startAlwaysFromRow.classList.add("visible");
    }
    if (data.startAlwaysFromValue != null) startAlwaysFromValue.value = data.startAlwaysFromValue;

    // Restore additional IP groups
    if (data.ipGroups) {
        try {
            const groups = JSON.parse(data.ipGroups);
            if (Array.isArray(groups) && groups.length > 0) {
                _loadIpGroups(groups);
            }
        } catch(e) { /* keep default (no groups) */ }
    }
});

function setStatus(msg) { statusEl.textContent = msg; }

function setSheetsStatus(state, msg) {
    sheetsDot.className = 'sheets-dot ' + (state === 'idle' ? '' : state);
    sheetsMsg.textContent = msg;
}

function setTgStatus(state, msg) {
    tgDot.className = 'sheets-dot ' + (state === 'idle' ? '' : state);
    tgMsg.textContent = msg;
}

function toSeconds(h, m, s) {
    return (parseInt(h) || 0) * 3600 + (parseInt(m) || 0) * 60 + (parseInt(s) || 0);
}

// ── MV2 script injection helper ──────────────────────────────
function injectFile(tabId, file) {
    return new Promise((resolve) => {
        browser.tabs.executeScript(tabId, { file }, () => {
            if (browser.runtime.lastError) {
                console.warn(`[popup] inject ${file}:`, browser.runtime.lastError.message);
            }
            resolve();
        });
    });
}

startBtn.addEventListener("click", async () => {
    const ips              = document.getElementById("custom-ip-input").value.trim();
    const totalDrops       = parseInt(document.getElementById("total-drops").value);
    const successThreshold = parseInt(document.getElementById("success-threshold").value);
    const sentIncrement    = parseInt(document.getElementById("sent-increment").value);
    const toleranceRate    = parseFloat(document.getElementById("tolerance-rate").value) || 0;
    const telegramChatId   = chatIdEl.value.trim();
    const enableRemoteStop = tgRemoteStopChk.checked;
    const sheetsSpreadsheetId = sheetsIdEl.value.trim();

    // Drop offset
    const useOffset = useOffsetChk.checked;
    const dropStart = useOffset ? (parseInt(dropStartInput.value) || 2) : 1;

    // Start-after delay
    const startMode = startCustomRad.checked ? "custom" : "immediate";
    const startAfterDelay = startMode === "custom"
        ? toSeconds(
            document.getElementById("t0-h").value,
            document.getElementById("t0-m").value,
            document.getElementById("t0-s").value
          )
        : 0;

    const timeBeforeResume = toSeconds(
        document.getElementById("t1-h").value,
        document.getElementById("t1-m").value,
        document.getElementById("t1-s").value
    );
    const timeAfterResume = toSeconds(
        document.getElementById("t2-h").value,
        document.getElementById("t2-m").value,
        document.getElementById("t2-s").value
    );
    const timeBetweenDrops = toSeconds(
        document.getElementById("t3-h").value,
        document.getElementById("t3-m").value,
        document.getElementById("t3-s").value
    );
    const timeAfterPauseVerified = toSeconds(
        document.getElementById("t4-h").value,
        document.getElementById("t4-m").value,
        document.getElementById("t4-s").value
    );
    const prepBufferTime = toSeconds(
        document.getElementById("t5-h").value,
        document.getElementById("t5-m").value,
        document.getElementById("t5-s").value
    );

    const emailCountEnabled = emailCountChk.checked;
    const gmailEmail        = (document.getElementById("email-count-gmail")    || {}).value || '';
    const gmailPassword     = (document.getElementById("email-count-password") || {}).value || '';
    const emailCountDelay   = toSeconds(
        document.getElementById("ec-h").value,
        document.getElementById("ec-m").value,
        document.getElementById("ec-s").value
    );
    const spamStopMode  = (document.querySelector('input[name="spam-stop-mode"]:checked') || {}).value || 'none';
    const spamStopValue = parseInt((document.getElementById("spam-threshold-value") || {}).value) || 10;

    // ISP profile keyword values
    const ispDatalistsEntries = _getIspEntries();

    // Additional IP groups (raw text, one per group)
    const ipGroupsRaw = _getIpGroups();

    // Validations
    if (!ips && ipGroupsRaw.filter(g => g.trim()).length === 0) { setStatus("Please enter IPs or add at least one IP group."); return; }
    if (isNaN(totalDrops)       || totalDrops < 1)       { setStatus("Invalid total drops.");        return; }
    if (isNaN(successThreshold) || successThreshold < 1) { setStatus("Invalid success threshold.");  return; }
    if (isNaN(sentIncrement)    || sentIncrement < 1)    { setStatus("Invalid increment.");           return; }
    if (isNaN(toleranceRate) || toleranceRate < 0 || toleranceRate > 100) { setStatus("Invalid tolerance rate (0-100)."); return; }
    if (!telegramChatId) {
        chatIdEl.classList.add('input-error');
        chatIdEl.focus();
        setStatus("Telegram Chat ID is required.");
        return;
    }
    if (!sheetsSpreadsheetId) {
        sheetsIdEl.classList.add('input-error');
        sheetsIdEl.focus();
        setStatus("Google Sheets Spreadsheet ID is required.");
        return;
    }
    if (useOffset && (isNaN(dropStart) || dropStart < 2)) {
        dropStartInput.style.borderColor = 'rgba(239,68,68,0.6)';
        dropStartInput.focus();
        setStatus("Start drop must be 2 or greater.");
        return;
    }

    // Start Always From validation
    const startAlwaysFromEnabled  = startAlwaysFromChk.checked;
    const startAlwaysFromValueNum = parseInt(startAlwaysFromValue.value);
    if (startAlwaysFromEnabled && (isNaN(startAlwaysFromValueNum) || startAlwaysFromValueNum < 0)) {
        startAlwaysFromValue.classList.add('input-error');
        startAlwaysFromValue.focus();
        setStatus("Start Always From value must be a whole number ≥ 0.");
        return;
    }
    if (startMode === "custom" && startAfterDelay === 0) {
        setStatus("Custom start delay is 0 — set a time or switch to Immediate.");
        return;
    }
    if (prepBufferTime <= 0) {
        document.getElementById("t5-m").style.borderColor = 'rgba(239,68,68,0.6)';
        document.getElementById("t5-m").focus();
        setStatus("Prep buffer must be greater than 0.");
        return;
    }
    if (prepBufferTime >= timeBetweenDrops) {
        document.getElementById("t5-m").style.borderColor = 'rgba(239,68,68,0.6)';
        document.getElementById("t5-m").focus();
        setStatus("Prep buffer must be less than 'Between drops' time.");
        return;
    }
    if (emailCountEnabled && !gmailEmail) {
        document.getElementById("email-count-gmail").style.borderColor = 'rgba(239,68,68,0.6)';
        document.getElementById("email-count-gmail").focus();
        setStatus("Gmail address is required for email count feature.");
        return;
    }
    if (emailCountEnabled && !gmailPassword) {
        document.getElementById("email-count-password").style.borderColor = 'rgba(239,68,68,0.6)';
        document.getElementById("email-count-password").focus();
        setStatus("Gmail App Password is required for email count feature.");
        return;
    }
    if (emailCountEnabled && _appPasswordCheckState !== 'ok') {
        setStatus(_appPasswordCheckState === 'checking'
            ? "Still verifying the Gmail App Password — please wait…"
            : "Gmail App Password could not be verified. Fix it before starting.");
        return;
    }
    if (emailCountEnabled && emailCountDelay > (timeBetweenDrops - prepBufferTime)) {
        document.getElementById("ec-h").style.borderColor = 'rgba(239,68,68,0.6)';
        document.getElementById("ec-m").style.borderColor = 'rgba(239,68,68,0.6)';
        document.getElementById("ec-s").style.borderColor = 'rgba(239,68,68,0.6)';
        document.getElementById("ec-m").focus();
        setStatus(`Wait before counting must be ≤ 'Between drops' minus 'Prep buffer' (${fmtTime(Math.max(0, timeBetweenDrops - prepBufferTime))}).`);
        return;
    }

    // ISP profile validations
    if (ispDatalistsEntries.length === 0) {
        setStatus("Please add at least one ISP Profile entry.");
        return;
    }
    let hasError = false;
    ispEntriesList.querySelectorAll('.isp-entry-row').forEach((row, i) => {
        const valInput = row.querySelector('.isp-entry-input');
        if (valInput && !valInput.value.trim()) {
            valInput.classList.add('input-error');
            if (!hasError) { valInput.focus(); hasError = true; }
        }
    });
    if (hasError) {
        setStatus("All ISP Profile entries must have a list name value.");
        return;
    }

    // ── Validate added IP groups: all must be non-empty ──────
    let groupHasError = false;
    ipGroupsList.querySelectorAll('.ip-group-row').forEach((row, i) => {
        const ta = row.querySelector('.ip-group-textarea');
        if (ta && !ta.value.trim()) {
            ta.classList.add('input-error');
            if (!groupHasError) { ta.focus(); groupHasError = true; }
        } else if (ta) {
            ta.classList.remove('input-error');
        }
    });
    if (groupHasError) {
        setStatus("All added IP groups must be filled in, or remove the empty ones.");
        return;
    }

    setStatus("Parsing...");
    reportEl.style.display = "none";
    setSheetsStatus('idle', 'Waiting for first drop…');
    setTgStatus('idle', 'Report will be sent after each drop');

    browser.runtime.sendMessage(
        { type: "PROCESS_DEPLOY_DATA", payload: { ips, ipGroupsRaw } },
        async (response) => {
            if (!response || !response.success) { setStatus("Parsing failed."); return; }

            setStatus("Starting process on active tab...");

            browser.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
                const tab = tabs && tabs[0];
                if (!tab) { setStatus("No active tab found."); return; }

                startBtn.disabled = true;

                const config = {
                    totalDrops, successThreshold, sentIncrement,
                    timeBeforeResume, timeAfterResume, timeBetweenDrops,
                    timeAfterPauseVerified,
                    prepBufferTime,
                    telegramChatId, enableRemoteStop, toleranceRate,
                    sheetsSpreadsheetId,
                    dropStart,
                    startAfterDelay,
                    processType: "datalists",
                    emailCountEnabled,
                    gmailEmail,
                    gmailPassword,
                    emailCountDelay,
                    spamStopMode,
                    spamStopValue,
                    ispDatalistsEntries,
                    shuffleIspSequence: !!(document.getElementById("shuffle-isp-sequence") || {}).checked,
                    dropNote: document.getElementById("drop-note").value.trim(),
                    resumeNotifyEnabled: !!(document.getElementById("resume-notify-enabled") || {}).checked,
                    pauseResumeFromMultiMonitor: !!(document.getElementById("pause-resume-from-multimonitors") || {}).checked,
                    rateCheckIps: Math.min(100, Math.max(0, parseInt((document.getElementById("rate-check-ips") || {}).value) || 0)),
                    multiMonitorJobId: (document.getElementById("multi-monitor-jobid") || {}).value || '',
                    stopDeferredIpsEnabled: !!(document.getElementById("stop-deferred-ips") || {}).checked,
                    deferredIpsMustCompleteEnabled: !!(document.getElementById("deferred-ips-complete-all") || {}).checked,
                    startAlwaysFromEnabled,
                    startAlwaysFromValue: startAlwaysFromEnabled ? startAlwaysFromValueNum : null,
                    // Pass parsed IP group data to content script
                    ipGroupsParsed: response.ipGroupsParsed || [],
                };

                // ── Ping the content script; inject if not yet present ──
                const sendMessage = (tabId, msg) => new Promise(resolve => {
                    browser.tabs.sendMessage(tabId, msg, res => {
                        if (browser.runtime.lastError) resolve(null);
                        else resolve(res);
                    });
                });

                let res = await sendMessage(tab.id, { type: "PING" });
                if (!res) {
                    for (const file of ["config.js", "googleSheets.js", "telegram.js", "content.js"]) {
                        await injectFile(tab.id, file);
                    }
                    await new Promise(resolve => setTimeout(resolve, 800));
                }

                // ── Listen for messages from content script ──
                browser.runtime.onMessage.addListener(function listener(msg) {
                    if (msg.type === "STATUS_UPDATE") {
                        setStatus(msg.text);
                    }

                    if (msg.type === "SHEETS_SAVING") {
                        setSheetsStatus('busy', `Saving Drop ${msg.drop} to Google Sheets…`);
                    }
                    if (msg.type === "SHEETS_SAVED") {
                        setSheetsStatus(
                            msg.success ? 'ok' : 'error',
                            msg.success
                                ? `Drop ${msg.drop} saved to ${msg.sheetName}`
                                : `Drop ${msg.drop} save failed: ${msg.error}`
                        );
                    }

                    if (msg.type === "TG_SENDING") {
                        setTgStatus('busy', `Sending Drop ${msg.drop} report to Telegram…`);
                    }
                    if (msg.type === "TG_SENT") {
                        setTgStatus(
                            msg.success ? 'ok' : 'error',
                            msg.success
                                ? `Drop ${msg.drop} report sent successfully`
                                : `Drop ${msg.drop} failed: ${msg.error}`
                        );
                    }

                    if (msg.type === "EMAIL_COUNT_SENDING") {
                        if (ecDot) { ecDot.className = 'sheets-dot busy'; ecStatusText.textContent = `Counting emails for Drop ${msg.drop}…`; }
                    }
                    if (msg.type === "EMAIL_COUNT_SENT") {
                        if (ecDot) {
                            ecDot.className = 'sheets-dot ' + (msg.success ? 'ok' : 'error');
                            ecStatusText.textContent = msg.success
                                ? `Drop ${msg.drop} email count sent`
                                : `Drop ${msg.drop} email count failed: ${msg.error}`;
                        }
                    }

                    if (msg.type === "FINAL_REPORT") {
                        browser.runtime.onMessage.removeListener(listener);
                        _updateStartButtonAvailability();
                        reportEl.style.display = "block";
                        reportEl.textContent = msg.report;
                        setStatus("All drops completed!");
                    }
                });

                browser.tabs.sendMessage(tab.id, {
                    type: "START_DEPLOY_PROCESS",
                    groups: response.groups,
                    orderedIps: response.orderedIps,
                    ipServerMap: response.ipServerMap || {},
                    ipOverrideMap: response.ipOverrideMap || {},
                    config,
                    deployTabId: tab.id
                }, (startResp) => {
                    if (browser.runtime.lastError) return;
                    if (startResp && startResp.preflightErrors && startResp.preflightErrors.length > 0) {
                        // Pre-flight failed — re-enable button (subject to app-password gating) and show errors in popup
                        _updateStartButtonAvailability();
                        const errList = startResp.preflightErrors.map(e => `• ${e}`).join('\n');
                        setStatus('🚫 Pre-flight check failed:\n' + errList);
                    }
                });
            });
        }
    );
});
