// ── Firefox MV2 compatibility shim ──────────────────────────
// Firefox exposes the native `browser` namespace with real Promises.
// Chrome (and Chrome-mode polyfills) expose only `chrome` with callbacks.
// We unify under `browser` so the rest of the file works in both.
var browser = (typeof browser !== "undefined") ? browser : chrome;

// ===============================
// KEEP-ALIVE & TAB MANAGEMENT
// ===============================
let _activeProcessTabId = null;
let _lastHeartbeat = null;
let _heartbeatCheckInterval = null;

// Monitor heartbeats from content script
function startHeartbeatMonitor() {
    if (_heartbeatCheckInterval) return;
    
    console.log('[Background] Starting heartbeat monitor...');
    
    _heartbeatCheckInterval = setInterval(() => {
        if (_activeProcessTabId && _lastHeartbeat) {
            const timeSinceLastBeat = Date.now() - _lastHeartbeat;
            
            // If no heartbeat for 30 seconds, try to wake up the tab
            if (timeSinceLastBeat > 30000) {
                console.warn('[Background] No heartbeat for 30s - attempting to wake tab...');
                wakeUpTab(_activeProcessTabId);
            }
        }
    }, 15000); // Check every 15 seconds
}

function stopHeartbeatMonitor() {
    if (_heartbeatCheckInterval) {
        clearInterval(_heartbeatCheckInterval);
        _heartbeatCheckInterval = null;
    }
    _activeProcessTabId = null;
    _lastHeartbeat = null;
}

// Wake up a tab by injecting a minimal no-op script.
// We intentionally avoid writing to document.body.dataset — that mutation
// can trigger MutationObserver listeners on the host page and break inputs.
async function wakeUpTab(tabId) {
    try {
        const code = `console.log('[WakeUp] Tab woken by background script');`;
        await browser.tabs.executeScript(tabId, { code });
        console.log('[Background] Tab wake-up script injected');
    } catch (err) {
        console.error('[Background] Failed to wake tab:', err);
    }
}

// Keep the tab visible/active by updating it periodically
function keepTabActive(tabId) {
    // Update tab properties to keep it "warm"
    browser.tabs.get(tabId, (tab) => {
        if (browser.runtime.lastError) return;
        
        // Just getting the tab info keeps it in memory
        console.log('[Background] Tab kept active:', tab.id);
    });
}

// ── Helper: promisify chrome.* callback APIs when needed ─────
function tabsSendMessage(tabId, msg) {
    return new Promise(resolve => {
        browser.tabs.sendMessage(tabId, msg, res => {
            if (browser.runtime.lastError) resolve(null);
            else resolve(res);
        });
    });
}

// ── executeScript for MV2 (Firefox uses browser.tabs.executeScript) ──
// Returns the result array just like MV3's scripting.executeScript
async function mv2ExecuteScript({ tabId, frameId, func, args }) {
    // Convert the function to a self-calling string so we can pass it to
    // tabs.executeScript, which only accepts code strings or files in MV2.
    const argsSerialized = JSON.stringify(args || []);
    const code = `(${func.toString()}).apply(null, ${argsSerialized});`;

    return new Promise((resolve, reject) => {
        const opts = { code, runAt: "document_start" };
        if (frameId !== undefined && frameId !== null) opts.frameId = frameId;

        browser.tabs.executeScript(tabId, opts, results => {
            if (browser.runtime.lastError) {
                reject(browser.runtime.lastError);
            } else {
                // Match MV3 return shape: [{ result: value }]
                resolve(results ? results.map(r => ({ result: r })) : [{ result: null }]);
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────
// Message listener
// ─────────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // ── HEARTBEAT ────────────────────────────────────────────
    if (message.type === "HEARTBEAT") {
        _lastHeartbeat = message.timestamp;
        // Keep the tab active
        if (_activeProcessTabId) {
            keepTabActive(_activeProcessTabId);
        }
        sendResponse({ received: true });
        return true;
    }

    // ── PROCESS_STARTED ──────────────────────────────────────
    if (message.type === "PROCESS_STARTED") {
        _activeProcessTabId = message.tabId;
        _lastHeartbeat = Date.now();
        startHeartbeatMonitor();
        
        console.log('[Background] Process started on tab:', message.tabId);
        console.log('[Background] Total drops:', message.totalDrops);
        
        sendResponse({ acknowledged: true });
        return true;
    }

    // ── PROCESS_COMPLETED ────────────────────────────────────
    if (message.type === "PROCESS_COMPLETED") {
        console.log('[Background] Process completed successfully');
        stopHeartbeatMonitor();
        sendResponse({ acknowledged: true });
        return true;
    }

    // ── PROCESS_FAILED ───────────────────────────────────────
    if (message.type === "PROCESS_FAILED") {
        console.error('[Background] Process failed:', message.error);
        stopHeartbeatMonitor();
        sendResponse({ acknowledged: true });
        return true;
    }

    // ── PROCESS_DEPLOY_DATA ──────────────────────────────────
    if (message.type === "PROCESS_DEPLOY_DATA") {

        const lines = message.payload.ips
            .split("\n")
            .map(l => l.trim())
            .filter(Boolean);

        // Preserve the exact order the user typed the IPs in
        const orderedIps  = [];
        const groups      = {};
        // ipServerMap: { ip -> serverName }
        const ipServerMap = {};
        // ipOverrideMap: { ip -> { customIncrement, customSuccessThreshold } }
        // null values mean "use the global setting from the popup form"
        const ipOverrideMap = {};

        lines.forEach(line => {
            const parts = line.split(":");
            // Supported formats:
            //   ip:target                              (old, 2-part)
            //   server:ip:target                       (new, 3-part, no overrides)
            //   server:ip:target:customIncrement       (4-part: custom increment only)
            //   server:ip:target::customSuccThreshold  (4-part with blank increment field)
            //   server:ip:target:customIncrement:customSuccThreshold  (5-part: both)
            let server, ip, value;
            let rawIncrement = '';   // empty string = use global
            let rawSuccThresh = '';  // empty string = use global

            if (parts.length >= 4) {
                // 4-part or 5-part: server:ip:target[:inc[:succ]]
                server       = parts[0].trim();
                ip           = parts[1].trim();
                value        = parseInt(parts[2].trim());
                rawIncrement = parts[3].trim();          // may be ''
                rawSuccThresh = parts.length >= 5 ? parts[4].trim() : '';
            } else if (parts.length === 3) {
                server = parts[0].trim();
                ip     = parts[1].trim();
                value  = parseInt(parts[2].trim());
            } else if (parts.length === 2) {
                server = null;
                ip     = parts[0].trim();
                value  = parseInt(parts[1].trim());
            } else {
                return;
            }
            if (!ip || isNaN(value)) return;
            orderedIps.push(ip);
            ipServerMap[ip] = server || '';
            if (!groups[value]) groups[value] = [];
            groups[value].push(ip);

            // Store per-IP overrides (null = inherit global)
            const custInc  = rawIncrement  !== '' ? parseInt(rawIncrement)  : null;
            const custSucc = rawSuccThresh !== '' ? parseInt(rawSuccThresh) : null;
            if (custInc !== null || custSucc !== null) {
                ipOverrideMap[ip] = {
                    customIncrement        : (!isNaN(custInc)  && custInc  !== null) ? custInc  : null,
                    customSuccessThreshold : (!isNaN(custSucc) && custSucc !== null) ? custSucc : null
                };
            }
        });

        const sorted = Object.keys(groups)
            .map(Number)
            .sort((a, b) => a - b)
            .map(key => ({ value: key, ips: groups[key] }));

        // ── Parse additional IP groups (one raw text block per group) ─────────
        // Each group is an independent set of lines in the same server:ip:target format.
        // These are parsed here and sent back as ipGroupsParsed: array of parsed group objects.
        // Each parsed group: { orderedIps: [...], groups: [...], ipServerMap: {...}, ipOverrideMap: {...} }
        function parseIpBlock(rawText) {
            const blockLines = (rawText || '').split('\n').map(l => l.trim()).filter(Boolean);
            const bOrderedIps  = [];
            const bGroups      = {};
            const bIpServerMap = {};
            const bIpOverrideMap = {};

            blockLines.forEach(line => {
                const parts = line.split(':');
                let server, ip, value;
                let rawIncrement  = '';
                let rawSuccThresh = '';

                if (parts.length >= 4) {
                    server        = parts[0].trim();
                    ip            = parts[1].trim();
                    value         = parseInt(parts[2].trim());
                    rawIncrement  = parts[3].trim();
                    rawSuccThresh = parts.length >= 5 ? parts[4].trim() : '';
                } else if (parts.length === 3) {
                    server = parts[0].trim();
                    ip     = parts[1].trim();
                    value  = parseInt(parts[2].trim());
                } else if (parts.length === 2) {
                    server = null;
                    ip     = parts[0].trim();
                    value  = parseInt(parts[1].trim());
                } else {
                    return;
                }
                if (!ip || isNaN(value)) return;

                bOrderedIps.push(ip);
                bIpServerMap[ip] = server || '';
                if (!bGroups[value]) bGroups[value] = [];
                bGroups[value].push(ip);

                const custInc  = rawIncrement  !== '' ? parseInt(rawIncrement)  : null;
                const custSucc = rawSuccThresh !== '' ? parseInt(rawSuccThresh) : null;
                if (custInc !== null || custSucc !== null) {
                    bIpOverrideMap[ip] = {
                        customIncrement        : (!isNaN(custInc)  && custInc  !== null) ? custInc  : null,
                        customSuccessThreshold : (!isNaN(custSucc) && custSucc !== null) ? custSucc : null
                    };
                }
            });

            const bSorted = Object.keys(bGroups)
                .map(Number)
                .sort((a, b) => a - b)
                .map(key => ({ value: key, ips: bGroups[key] }));

            return {
                orderedIps  : bOrderedIps,
                groups      : bSorted,
                ipServerMap : bIpServerMap,
                ipOverrideMap: bIpOverrideMap
            };
        }

        const ipGroupsParsed = (message.payload.ipGroupsRaw || []).map(raw => parseIpBlock(raw));

        sendResponse({ success: true, groups: sorted, orderedIps, ipServerMap, ipOverrideMap, ipGroupsParsed });
        return true;
    }

    // ── WATCH_FOR_MONITOR_TAB ────────────────────────────────
    if (message.type === "WATCH_FOR_MONITOR_TAB") {

        function onUpdated(tabId, changeInfo, tab) {
            if (
                changeInfo.status === "complete" &&
                tab.url &&
                tab.url.includes("multi_monitor")
            ) {
                browser.tabs.onUpdated.removeListener(onUpdated);

                // MV2: use tabs.executeScript instead of scripting.executeScript
                const func = () => {
                    const queuesBase64 = 'aHR0cDovLzEyNy4wLjAuMTo4MDgwL3F1ZXVlcw==';
                    document.querySelectorAll('iframe[src*="pmta"]').forEach((iframe, i) => {
                        const baseUrl = iframe.src.split('?')[0];
                        const newSrc  = `${baseUrl}?u=${queuesBase64}&refresh=20`;
                        console.log(`📍 Iframe #${i}: Navigating to Queues`);
                        iframe.src = newSrc;
                    });
                    console.log('✅ All iframes navigated to Queues');
                };

                const code = `(${func.toString()})();`;
                browser.tabs.executeScript(tabId, { code, runAt: "document_start" });
            }
        }

        browser.tabs.onUpdated.addListener(onUpdated);
        setTimeout(() => browser.tabs.onUpdated.removeListener(onUpdated), 30000);
        sendResponse({ watching: true });
        return true;
    }

    // ── NAVIGATE_QUEUES ──────────────────────────────────────
    // Called after 7s wait — in each pmta iframe, clicks the gmail.com
    // link on the home page so the frame navigates to the domain detail
    // page. If no gmail.com row exists the frame stays on home (= all
    // emails were delivered for that server).
    // Down server detection happens later in FETCH_QUEUE_DATA after the
    // 15s wait, by reading each frame's actual content.
    if (message.type === "NAVIGATE_QUEUES") {
        (async () => {
            try {
                const tabs = await browser.tabs.query({});
                const monitorTab = tabs.find(t => t.url && t.url.includes("multi_monitor"));
                if (!monitorTab) { sendResponse({ done: false, reason: "no monitor tab" }); return; }

                const frames = await browser.webNavigation.getAllFrames({ tabId: monitorTab.id });
                const pmtaFrames = frames.filter(f => f.url && (f.url.includes("pmta") || f.url.includes("8181")));

                console.log(`[NAVIGATE_QUEUES] Found ${pmtaFrames.length} pmta frame(s)`);

                for (const frame of pmtaFrames) {
                    try {
                        await mv2ExecuteScript({
                            tabId  : monitorTab.id,
                            frameId: frame.frameId,
                            func   : () => {
                                // Find the gmail.com link in the Top Domains table
                                const gmailLink = Array.from(
                                    document.querySelectorAll('table.data tbody tr td.l a')
                                ).find(a => a.textContent.trim() === 'gmail.com');

                                if (gmailLink) {
                                    console.log('[NavGmail] Navigating to gmail.com detail:', gmailLink.href);
                                    window.location.href = gmailLink.href;
                                } else {
                                    console.log('[NavGmail] No gmail.com row — all emails delivered on this server');
                                }
                            },
                            args: []
                        });
                    } catch (e) {
                        console.warn('[NAVIGATE_QUEUES] Frame inject error:', e.message);
                    }
                }

                sendResponse({ done: true });
            } catch (err) {
                console.error('[NAVIGATE_QUEUES] Error:', err);
                sendResponse({ done: false, reason: err.message });
            }
        })();
        return true;
    }

    // ── FETCH_QUEUE_DATA ─────────────────────────────────────
    // Frame injection first, fetch fallback.
    // Also detects down servers by reading each frame's content after the 15s wait:
    // if the frame shows the Firefox timeout error page → server is down.
    // iframeServerMap: { iframeBaseUrl -> serverName } so we can name the down server.
    if (message.type === "FETCH_QUEUE_DATA") {
        const allIPs            = [...new Set(message.iframeUrls.map(i => i.ip))];
        const iframeServerMapBg = message.iframeServerMap || {};

        // Keywords present in the Firefox/Chrome network-error page shown inside the iframe
        const DOWN_KEYWORDS = [
            "délai d'attente est dépassé",
            "Le serveur à l'adresse",
            'neterror-page-title',
            'aboutNetError',
            'netTimeout-title',
            'NS_ERROR_NET_TIMEOUT',
            'ERR_CONNECTION_TIMED_OUT',
            'ERR_CONNECTION_REFUSED'
        ];

        async function readViaFrameInjection() {
            const tabs = await browser.tabs.query({});
            const monitorTab = tabs.find(t => t.url && t.url.includes("multi_monitor"));
            if (!monitorTab) return null;

            const frames = await browser.webNavigation.getAllFrames({ tabId: monitorTab.id });
            const pmtaFrames = frames.filter(f => f.url && (f.url.includes("pmta") || f.url.includes("8181")));
            if (pmtaFrames.length === 0) return null;

            const rcptMap         = {};
            const downServerNames = new Set();
            const downFrameIPs    = new Set();
            let readyFrames    = 0;
            let notReadyFrames = 0;

            for (const frame of pmtaFrames) {
                try {
                    const [result] = await mv2ExecuteScript({
                        tabId   : monitorTab.id,
                        frameId : frame.frameId,
                        func    : (targetIPs, downKws) => {
                            const bodyText = (document.body && document.body.innerText) || '';
                            const bodyHTML = document.documentElement
                                ? document.documentElement.outerHTML
                                : (document.body ? document.body.innerHTML : '');

                            // ── Down-server detection (error page inside iframe) ──
                            const isDown = downKws.some(k => bodyText.includes(k) || bodyHTML.includes(k));
                            if (isDown) return { _serverDown: true };

                            // ── Home page with NO gmail.com row = all emails delivered ──
                            const isHomePage = bodyText.includes('Traffic Totals') ||
                                               bodyText.includes('Top Domains');
                            if (isHomePage) {
                                const gmailLink = Array.from(
                                    document.querySelectorAll('table.data tbody tr td.l a')
                                ).find(a => a.textContent.trim() === 'gmail.com');
                                if (!gmailLink) {
                                    // No gmail.com row → everything was delivered, rcpt = 0
                                    const out = {};
                                    targetIPs.forEach(ip => { out[ip] = 0; });
                                    return out;
                                }
                                // Home page still shows gmail.com → navigation not done yet
                                return { _pageNotReady: true };
                            }

                            // ── Domain detail page readiness check ────────────────
                            if (!bodyText.includes('Domain Detail')) {
                                return { _pageNotReady: true };
                            }

                            // ── Find specifically the "Queues" table ─────────────
                            // The domain detail page has multiple table.data elements:
                            //   1. Domain Detail summary  2. Queues  3. Last Errors
                            // We must ONLY read from the Queues table — other tables
                            // (especially Last Errors) contain dates whose parseInt()
                            // value (e.g. 2026) would corrupt the recipients count.
                            let queuesTable = null;
                            document.querySelectorAll("table.data").forEach(tbl => {
                                if (queuesTable) return;
                                for (const th of tbl.querySelectorAll("th")) {
                                    if (th.textContent.trim() === 'Queues') {
                                        queuesTable = tbl;
                                        break;
                                    }
                                }
                            });

                            const out = {};
                            targetIPs.forEach(ip => { out[ip] = null; });

                            if (queuesTable) {
                                queuesTable.querySelectorAll("tbody tr").forEach(row => {
                                    const cells = row.querySelectorAll("td");
                                    if (cells.length < 2) return;
                                    const vmtaName = cells[0].textContent.trim();
                                    const val      = parseInt(cells[1].textContent.replace(/,/g, "").trim());
                                    if (isNaN(val)) return;

                                    // Match trailing IPv4, e.g. "gmail-84.247.140.109"
                                    const ipMatch = vmtaName.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
                                    if (!ipMatch) return;
                                    const frameIp = ipMatch[1];

                                    targetIPs.forEach(ip => {
                                        if (ip === frameIp)
                                            out[ip] = (out[ip] === null ? 0 : out[ip]) + val;
                                    });
                                });
                            }

                            return out;
                        },
                        args: [allIPs, DOWN_KEYWORDS]
                    });

                    if (result?.result?._serverDown) {
                        // Match this frame's base URL to a server name
                        const frameBase = frame.url ? frame.url.split('?')[0].replace('/pmta', '') : '';
                        const matchedKey = Object.keys(iframeServerMapBg).find(k => frameBase && k.includes(frameBase));
                        const srvName = matchedKey ? iframeServerMapBg[matchedKey] : null;
                        if (srvName) downServerNames.add(srvName);

                        // Mark all IPs that belong to this frame's URL as down
                        message.iframeUrls.forEach(({ ip, url }) => {
                            if (frameBase && url.includes(frameBase)) downFrameIPs.add(ip);
                        });

                    } else if (result?.result?._pageNotReady) {
                        notReadyFrames++;
                    } else if (result?.result) {
                        readyFrames++;
                        Object.entries(result.result).forEach(([ip, rcpt]) => {
                            if (rcpt !== null) rcptMap[ip] = (rcptMap[ip] || 0) + rcpt;
                        });
                    }
                } catch (e) { /* frame not accessible */ }
            }

            if (readyFrames === 0 && notReadyFrames > 0 && downFrameIPs.size === 0) {
                return { _pageNotReady: true };
            }

            if (Object.keys(rcptMap).length === 0 && downFrameIPs.size === 0) return null;

            const ipResults = allIPs.map(ip => {
                if (downFrameIPs.has(ip)) return { ip, rcpt: -2, _serverDown: true };
                return { ip, rcpt: ip in rcptMap ? rcptMap[ip] : 0 };
            });

            return { ipResults, downServerNames: [...downServerNames] };
        }

        async function readViaFetch() {
            const downServerNames = new Set();
            const promises = message.iframeUrls.map(({ ip, url }) =>
                (async () => {
                    try {
                        // ── Step 1: fetch the home page ──────────────────────────
                        const homeResp = await fetch(url, { credentials: "include" });
                        const homeHtml = await homeResp.text();

                        // Down-server check on home page
                        const isDownHome = DOWN_KEYWORDS.some(k => homeHtml.includes(k));
                        if (isDownHome) {
                            const srvName = iframeServerMapBg[url] || null;
                            if (srvName) downServerNames.add(srvName);
                            return { ip, rcpt: -2, _serverDown: true };
                        }

                        // Parse gmail.com link from home page Top Domains table
                        const homeDoc    = new DOMParser().parseFromString(homeHtml, "text/html");
                        const gmailAnchor = Array.from(
                            homeDoc.querySelectorAll('table.data tbody tr td.l a')
                        ).find(a => a.textContent.trim() === 'gmail.com');

                        // No gmail.com row → all emails delivered for this server
                        if (!gmailAnchor) {
                            return { ip, rcpt: 0 };
                        }

                        // ── Step 2: fetch the gmail domain detail page ────────────
                        const detailUrl = gmailAnchor.getAttribute('href');
                        if (!detailUrl) return { ip, rcpt: -1, _pageNotReady: true };

                        const detailResp = await fetch(detailUrl, { credentials: "include" });
                        const detailHtml = await detailResp.text();

                        // Down-server check on detail page
                        const isDownDetail = DOWN_KEYWORDS.some(k => detailHtml.includes(k));
                        if (isDownDetail) {
                            const srvName = iframeServerMapBg[url] || null;
                            if (srvName) downServerNames.add(srvName);
                            return { ip, rcpt: -2, _serverDown: true };
                        }

                        if (!detailHtml.includes('Domain Detail')) {
                            return { ip, rcpt: -1, _pageNotReady: true };
                        }

                        // ── Parse Queues table on domain detail page ─────────────
                        // Must target ONLY the Queues table — other tables (especially
                        // Last Errors) have dates in the second column that parseInt()
                        // turns into large numbers (e.g. 2026), corrupting the count.
                        const detailDoc = new DOMParser().parseFromString(detailHtml, "text/html");

                        let queuesTable = null;
                        detailDoc.querySelectorAll("table.data").forEach(tbl => {
                            if (queuesTable) return;
                            for (const th of tbl.querySelectorAll("th")) {
                                if (th.textContent.trim() === 'Queues') {
                                    queuesTable = tbl;
                                    break;
                                }
                            }
                        });

                        let rcpt = null;
                        if (queuesTable) {
                            queuesTable.querySelectorAll("tbody tr").forEach(row => {
                                const cells = row.querySelectorAll("td");
                                if (cells.length < 2) return;
                                const vmtaName = cells[0].textContent.trim();
                                const ipMatch  = vmtaName.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
                                if (!ipMatch || ipMatch[1] !== ip) return;
                                const val = parseInt(cells[1].textContent.replace(/,/g, "").trim());
                                if (!isNaN(val)) rcpt = (rcpt === null ? 0 : rcpt) + val;
                            });
                        }

                        return { ip, rcpt: rcpt === null ? 0 : rcpt };

                    } catch (err) {
                        const srvName = iframeServerMapBg[url] || null;
                        if (srvName) downServerNames.add(srvName);
                        return { ip, rcpt: -2, _serverDown: true, error: String(err) };
                    }
                })()
            );
            const results = await Promise.all(promises);
            return { results, downServerNames: [...downServerNames] };
        }

        (async () => {
            const frameResult = await readViaFrameInjection();
            let results;
            let pageNotReady    = false;
            let downServerNames = [];

            if (frameResult && frameResult._pageNotReady) {
                pageNotReady = true;
                results = allIPs.map(ip => ({ ip, rcpt: -1 }));
            } else if (frameResult && frameResult.ipResults) {
                results         = frameResult.ipResults;
                downServerNames = frameResult.downServerNames || [];
            } else {
                const fetchResult = await readViaFetch();
                results           = fetchResult.results || [];
                downServerNames   = fetchResult.downServerNames || [];
                if (results.length > 0 && results.every(r => r._pageNotReady)) {
                    pageNotReady = true;
                }
            }

            sendResponse({ results, pageNotReady, downServerNames });
        })();
        return true;
    }

    // ── GET_MONITOR_IFRAME_URLS ──────────────────────────────
    // Returns { urls, tabId, iframeServerMap }
    // urls: home-page URLs for each pmta iframe (used by the fetch fallback
    //       in FETCH_QUEUE_DATA to do step-1 fetch → find gmail.com link).
    //       iframe.src still points to the original home URL even after
    //       NAVIGATE_QUEUES because we navigated via window.location inside
    //       the frame rather than changing iframe.src from the parent.
    // iframeServerMap: { homeUrl -> serverName } extracted from panel headings
    if (message.type === "GET_MONITOR_IFRAME_URLS") {
        browser.tabs.query({}, (tabs) => {
            const monitorTab = tabs.find(t => t.url && t.url.includes("multi_monitor"));
            if (!monitorTab) {
                sendResponse({ urls: [], tabId: null, iframeServerMap: {} });
                return;
            }

            const func = () => {
                const entries = [];
                const iframeServerMap = {};

                document.querySelectorAll('iframe[src*="pmta"]').forEach(iframe => {
                    // Use the iframe's current src attribute as the home page URL.
                    // (NAVIGATE_QUEUES navigated via window.location inside the frame,
                    //  so iframe.src in the parent DOM is still the original home URL.)
                    const homeUrl = iframe.src;

                    // Try to find the server name from the panel heading:
                    // Pattern: <b>(N) [ id ] - serverName</b>
                    let serverName = '';
                    const panel = iframe.closest('.panel');
                    if (panel) {
                        const bold = panel.querySelector('.panel-heading b');
                        if (bold) {
                            // e.g. "(1) [ 207148 ] - s_tss1_4876"
                            const match = bold.textContent.match(/-\s+(\S+)\s*$/);
                            if (match) serverName = match[1];
                        }
                    }

                    entries.push(homeUrl);
                    if (serverName) iframeServerMap[homeUrl] = serverName;
                });

                return { urls: entries, iframeServerMap };
            };

            const code = `(${func.toString()})();`;

            browser.tabs.executeScript(monitorTab.id, { code }, (results) => {
                if (browser.runtime.lastError || !results || !results[0]) {
                    sendResponse({ urls: [], tabId: null, iframeServerMap: {} });
                } else {
                    const { urls, iframeServerMap } = results[0];
                    sendResponse({ urls, tabId: monitorTab.id, iframeServerMap });
                }
            });
        });
        return true;
    }

    // ── CHECK_PAUSE_STATUS ───────────────────────────────────
    // Checks whether the 3 target queues are paused in at least ONE
    // pmta iframe on the MultiMonitor tab.
    //
    // CORS-safe approach — two separate injections:
    //
    // Step 1 — inject into the PARENT MultiMonitor tab (no CORS issue)
    //   → set iframe.src to the Queues URL for every pmta iframe.
    //   We build the Queues URL from each iframe's existing src base,
    //   appending ?u=<queues-base64>&refresh=20 — exactly like
    //   WATCH_FOR_MONITOR_TAB does.  This avoids touching the frame
    //   document directly, so no CORS block.
    //
    // Step 2 — wait 7 s for all iframes to finish loading, then inject
    //   into each pmta frame individually (background has host permission
    //   for those origins via <all_urls>) and read the Paused column
    //   (5th <td>, index 4, class="l") in table.data.
    //
    // Returns { paused: true/false, tabId, frameCount }
    if (message.type === "CHECK_PAUSE_STATUS") {
        (async () => {
            try {
                // ── Find the MultiMonitor tab ────────────────────────
                const tabs = await browser.tabs.query({});
                const monitorTab = tabs.find(t => t.url && t.url.includes("multi_monitor"));
                if (!monitorTab) {
                    sendResponse({ paused: false, tabId: null, frameCount: 0, reason: "no monitor tab" });
                    return;
                }

                // ── Step 1: navigate every pmta iframe to Queues page ─
                // Injected into the PARENT tab — sets iframe.src from
                // the parent DOM, which is NOT a cross-origin operation
                // and is therefore never blocked by CORS.
                // queuesBase64 decodes to: http://127.0.0.1:8080/queues
                const navigateCode = `
                    (function() {
                        const queuesBase64 = 'aHR0cDovLzEyNy4wLjAuMTo4MDgwL3F1ZXVlcw==';
                        let count = 0;
                        document.querySelectorAll('iframe[src*="pmta"], iframe[src*="8181"]').forEach(function(iframe) {
                            const base = iframe.src.split('?')[0];
                            iframe.src = base + '?u=' + queuesBase64 + '&refresh=20';
                            count++;
                        });
                        console.log('[CHECK_PAUSE_STATUS] Navigated ' + count + ' iframe(s) to Queues page');
                        return count;
                    })();
                `;

                await new Promise((resolve, reject) => {
                    browser.tabs.executeScript(monitorTab.id, { code: navigateCode }, results => {
                        if (browser.runtime.lastError) reject(browser.runtime.lastError);
                        else {
                            const count = results && results[0] ? results[0] : 0;
                            console.log(`[CHECK_PAUSE_STATUS] Step 1 done — navigated ${count} iframe(s)`);
                            resolve(count);
                        }
                    });
                });

                // ── Step 2: wait 7 s for iframes to fully load ───────
                await new Promise(r => setTimeout(r, 7000));

                // ── Step 2b: in every pmta frame, set maxItems=100,
                //   click Display, then confirm "Top 100 queues" appears.
                //   This ensures all IPs are visible before checking pause.
                const framesForMax = await browser.webNavigation.getAllFrames({ tabId: monitorTab.id });
                const pmtaFramesForMax = framesForMax.filter(f => f.url && (f.url.includes("pmta") || f.url.includes("8181")));

                // All frames are processed in parallel — no more frame-by-frame clicking.
                await Promise.all(pmtaFramesForMax.map(async function(frame) {
                    try {
                        // Set maxItems to 100 and click Display
                        await mv2ExecuteScript({
                            tabId  : monitorTab.id,
                            frameId: frame.frameId,
                            func   : () => {
                                const maxInput = document.querySelector('input[name="maxItems"]');
                                if (maxInput) {
                                    maxInput.value = '100';
                                    maxInput.dispatchEvent(new Event('input',  { bubbles: true }));
                                    maxInput.dispatchEvent(new Event('change', { bubbles: true }));
                                }
                                const displayBtn = document.querySelector('input[type="submit"][value="Display"]');
                                if (displayBtn) displayBtn.click();
                                return !!(maxInput && displayBtn);
                            },
                            args: []
                        });

                        // Wait 3 s for the page to reload with 100 items
                        await new Promise(r => setTimeout(r, 3000));

                        // Verify "Top 100 queues" text is present; retry once if not
                        const [verifyResult] = await mv2ExecuteScript({
                            tabId  : monitorTab.id,
                            frameId: frame.frameId,
                            func   : () => {
                                const bodyText = (document.body && document.body.innerText) || '';
                                return bodyText.includes('Top 100 queues');
                            },
                            args: []
                        });

                        if (!verifyResult || !verifyResult.result) {
                            console.warn('[CHECK_PAUSE_STATUS] "Top 100 queues" not found — retrying Display click…');
                            // Wait 5 s then click Display again
                            await new Promise(r => setTimeout(r, 5000));
                            await mv2ExecuteScript({
                                tabId  : monitorTab.id,
                                frameId: frame.frameId,
                                func   : () => {
                                    const displayBtn = document.querySelector('input[type="submit"][value="Display"]');
                                    if (displayBtn) displayBtn.click();
                                    return !!displayBtn;
                                },
                                args: []
                            });
                            // Final wait before proceeding
                            await new Promise(r => setTimeout(r, 3000));
                        } else {
                            console.log('[CHECK_PAUSE_STATUS] "Top 100 queues" confirmed in frame', frame.frameId);
                        }
                    } catch (e) {
                        console.warn('[CHECK_PAUSE_STATUS] maxItems step error (frame ' + frame.frameId + '):', e.message);
                    }
                }));

                // ── Step 3: get updated frame list and read each frame ─
                const frames = await browser.webNavigation.getAllFrames({ tabId: monitorTab.id });
                const pmtaFrames = frames.filter(f => f.url && (f.url.includes("pmta") || f.url.includes("8181")));

                console.log(`[CHECK_PAUSE_STATUS] Step 3 — ${pmtaFrames.length} pmta frame(s) found`);

                // The Queues page table columns (from the actual HTML):
                //   <th> Name </th>           → td index 0
                //   <th> #Rcpt </th>          → td index 1
                //   <th> KBytes </th>         → td index 2
                //   <th> #Conn </th>          → td index 3
                //   <th class="l"> Paused </th>  → td index 4  ← this one
                //   <th class="l"> Mode </th> → td index 5
                //   <th class="l"> Last Error </th> → td index 6
                //
                // A queue row counts as a match if its Name column is paused AND:
                //   • equals one of the exact wildcard entries  e.g. "gmail.com/*"
                //   • OR starts with one of the IP prefixes AND its trailing IP is
                //     in the user's IP list  e.g. "gmail.com/gmail-84.247.140.109"
                //     (prevents a row like "googlemail.com/gmail-194.61.28.175" from
                //     being accepted when 194.61.28.175 was not in the user's IPs)
                const EXACT_QUEUES  = ['gmail.com/*', 'gmail.queue/*', 'googlemail.com/*'];
                const PREFIX_QUEUES = ['gmail.com/gmail-', 'gmail.queue/gmail-', 'googlemail.com/gmail-'];
                const userIPs       = message.allIps || [];

                // Rate-based threshold:
                //   rateCheckIps = 0  → need at least 1 IP (or any paused signal)
                //   rateCheckIps > 0  → need at least ceil(totalIps × rate/100) unique IPs paused
                const rateCheckIps  = typeof message.rateCheckIps === 'number' ? message.rateCheckIps : 0;
                const totalIps      = userIPs.length;
                const requiredCount = (rateCheckIps <= 0 || totalIps === 0)
                    ? 1
                    : Math.max(1, Math.ceil(totalIps * rateCheckIps / 100));

                // Collect unique paused IPs (by trailing IP string) across ALL frames.
                // A wildcard row (gmail.com/*) means every IP is paused — shortcut.
                const pausedIpSet = new Set();
                let wildcardFound  = false;

                for (const frame of pmtaFrames) {
                    if (wildcardFound) break; // wildcard already covers all IPs
                    try {
                        const [result] = await mv2ExecuteScript({
                            tabId  : monitorTab.id,
                            frameId: frame.frameId,
                            func   : (exactQueues, prefixQueues, knownIPs) => {
                                const table = document.querySelector('table.data');
                                if (!table) return { ready: false, foundIps: [], hasWildcard: false };

                                const foundIps  = [];
                                let hasWildcard = false;
                                table.querySelectorAll('tbody tr').forEach(function(row) {
                                    const cells = row.querySelectorAll('td');
                                    if (cells.length < 5) return;
                                    const name   = cells[0].textContent.trim();
                                    const paused = cells[4].textContent.trim().toLowerCase();
                                    if (paused !== 'yes') return;

                                    // Wildcard row → all queues paused
                                    if (exactQueues.includes(name)) {
                                        hasWildcard = true;
                                        return;
                                    }

                                    // Per-IP row → extract and validate the trailing IP
                                    const matchedPrefix = prefixQueues.find(function(p) { return name.startsWith(p); });
                                    if (matchedPrefix) {
                                        const trailingIp = name.slice(matchedPrefix.length);
                                        if (knownIPs.length === 0 || knownIPs.indexOf(trailingIp) !== -1) {
                                            foundIps.push(trailingIp);
                                        }
                                    }
                                });
                                return { ready: true, foundIps, hasWildcard };
                            },
                            args: [EXACT_QUEUES, PREFIX_QUEUES, userIPs]
                        });

                        const res = result && result.result;
                        if (res && res.ready) {
                            console.log(`[CHECK_PAUSE_STATUS] Frame ${frame.frameId} — paused IPs: [${(res.foundIps || []).join(', ')}]${res.hasWildcard ? ' + wildcard' : ''}`);
                            if (res.hasWildcard) {
                                wildcardFound = true;
                            }
                            if (res.foundIps) {
                                res.foundIps.forEach(ip => pausedIpSet.add(ip));
                            }
                        } else {
                            console.warn(`[CHECK_PAUSE_STATUS] Frame ${frame.frameId} — page not ready yet`);
                        }
                    } catch (e) {
                        console.warn('[CHECK_PAUSE_STATUS] Frame inject error (frame ' + frame.frameId + '):', e.message);
                    }
                }

                // A wildcard row covers all IPs — always satisfies any threshold.
                const pausedCount = wildcardFound ? Math.max(totalIps, requiredCount) : pausedIpSet.size;
                const paused      = pausedCount >= requiredCount;

                console.log(`[CHECK_PAUSE_STATUS] pausedCount=${pausedCount} required=${requiredCount} wildcard=${wildcardFound} → paused=${paused}`);

                sendResponse({
                    paused    : paused,
                    tabId     : monitorTab.id,
                    frameCount: pmtaFrames.length
                });

            } catch (err) {
                console.error('[CHECK_PAUSE_STATUS] Error:', err);
                sendResponse({ paused: false, tabId: null, frameCount: 0, reason: err.message });
            }
        })();
        return true;
    }

    // ── CHECK_RESUME_STATUS ──────────────────────────────────
    // Mirror of CHECK_PAUSE_STATUS but checks that at least ONE iframe
    // shows the target queues as NOT paused (paused = "no") after RESUME.
    //
    // Only looks for per-IP prefix rows (gmail.com/gmail-<ip>, …) because
    // after a resume PowerMTA shows individual vmta rows, not wildcards.
    //
    // Same CORS-safe 2-step approach:
    //   Step 1 — set iframe.src from parent tab → Queues page (no CORS)
    //   Step 2 — wait 7 s → inject into each frame → read Paused column
    //
    // Returns { resumed: true/false, tabId, frameCount }
    if (message.type === "CHECK_RESUME_STATUS") {
        (async () => {
            try {
                // ── Find the MultiMonitor tab ────────────────────────
                const tabs = await browser.tabs.query({});
                const monitorTab = tabs.find(t => t.url && t.url.includes("multi_monitor"));
                if (!monitorTab) {
                    sendResponse({ resumed: false, tabId: null, frameCount: 0, reason: "no monitor tab" });
                    return;
                }

                // ── Step 1: navigate every pmta iframe to Queues page ─
                const navigateCode = `
                    (function() {
                        const queuesBase64 = 'aHR0cDovLzEyNy4wLjAuMTo4MDgwL3F1ZXVlcw==';
                        let count = 0;
                        document.querySelectorAll('iframe[src*="pmta"], iframe[src*="8181"]').forEach(function(iframe) {
                            const base = iframe.src.split('?')[0];
                            iframe.src = base + '?u=' + queuesBase64 + '&refresh=20';
                            count++;
                        });
                        console.log('[CHECK_RESUME_STATUS] Navigated ' + count + ' iframe(s) to Queues page');
                        return count;
                    })();
                `;

                await new Promise((resolve, reject) => {
                    browser.tabs.executeScript(monitorTab.id, { code: navigateCode }, results => {
                        if (browser.runtime.lastError) reject(browser.runtime.lastError);
                        else {
                            const count = results && results[0] ? results[0] : 0;
                            console.log(`[CHECK_RESUME_STATUS] Step 1 done — navigated ${count} iframe(s)`);
                            resolve(count);
                        }
                    });
                });

                // ── Step 2: wait 7 s for iframes to fully load ───────
                await new Promise(r => setTimeout(r, 7000));

                // ── Step 2b: in every pmta frame, set maxItems=100,
                //   click Display, then confirm "Top 100 queues" appears.
                //   This ensures all IPs are visible before checking resume.
                const framesForMax = await browser.webNavigation.getAllFrames({ tabId: monitorTab.id });
                const pmtaFramesForMax = framesForMax.filter(f => f.url && (f.url.includes("pmta") || f.url.includes("8181")));

                // All frames are processed in parallel — no more frame-by-frame clicking.
                await Promise.all(pmtaFramesForMax.map(async function(frame) {
                    try {
                        // Set maxItems to 100 and click Display
                        await mv2ExecuteScript({
                            tabId  : monitorTab.id,
                            frameId: frame.frameId,
                            func   : () => {
                                const maxInput = document.querySelector('input[name="maxItems"]');
                                if (maxInput) {
                                    maxInput.value = '100';
                                    maxInput.dispatchEvent(new Event('input',  { bubbles: true }));
                                    maxInput.dispatchEvent(new Event('change', { bubbles: true }));
                                }
                                const displayBtn = document.querySelector('input[type="submit"][value="Display"]');
                                if (displayBtn) displayBtn.click();
                                return !!(maxInput && displayBtn);
                            },
                            args: []
                        });

                        // Wait 3 s for the page to reload with 100 items
                        await new Promise(r => setTimeout(r, 3000));

                        // Verify "Top 100 queues" text is present; retry once if not
                        const [verifyResult] = await mv2ExecuteScript({
                            tabId  : monitorTab.id,
                            frameId: frame.frameId,
                            func   : () => {
                                const bodyText = (document.body && document.body.innerText) || '';
                                return bodyText.includes('Top 100 queues');
                            },
                            args: []
                        });

                        if (!verifyResult || !verifyResult.result) {
                            console.warn('[CHECK_RESUME_STATUS] "Top 100 queues" not found — retrying Display click…');
                            // Wait 5 s then click Display again
                            await new Promise(r => setTimeout(r, 5000));
                            await mv2ExecuteScript({
                                tabId  : monitorTab.id,
                                frameId: frame.frameId,
                                func   : () => {
                                    const displayBtn = document.querySelector('input[type="submit"][value="Display"]');
                                    if (displayBtn) displayBtn.click();
                                    return !!displayBtn;
                                },
                                args: []
                            });
                            // Final wait before proceeding
                            await new Promise(r => setTimeout(r, 3000));
                        } else {
                            console.log('[CHECK_RESUME_STATUS] "Top 100 queues" confirmed in frame', frame.frameId);
                        }
                    } catch (e) {
                        console.warn('[CHECK_RESUME_STATUS] maxItems step error (frame ' + frame.frameId + '):', e.message);
                    }
                }));

                // ── Step 3: get updated frame list and read each frame ─
                const frames = await browser.webNavigation.getAllFrames({ tabId: monitorTab.id });
                const pmtaFrames = frames.filter(f => f.url && (f.url.includes("pmta") || f.url.includes("8181")));

                console.log(`[CHECK_RESUME_STATUS] Step 3 — ${pmtaFrames.length} pmta frame(s) found`);

                // After RESUME, queues are considered resumed when target per-IP rows
                // no longer show Paused = "yes".
                //   rateCheckIps = 0  → any single frame with no paused rows = resumed (legacy)
                //   rateCheckIps > 0  → at least ceil(totalIps × rate/100) IPs must be confirmed
                //                       resumed (absent or paused="no") across ALL frames.
                const PREFIX_QUEUES = ['gmail.com/gmail-', 'gmail.queue/gmail-', 'googlemail.com/gmail-'];
                const userIPs       = message.allIps || [];

                const rateCheckIps  = typeof message.rateCheckIps === 'number' ? message.rateCheckIps : 0;
                const totalIps      = userIPs.length;
                const requiredCount = (rateCheckIps <= 0 || totalIps === 0)
                    ? 1
                    : Math.max(1, Math.ceil(totalIps * rateCheckIps / 100));

                // Collect all IPs still paused (by trailing IP string) across ALL frames.
                const stillPausedIpSet    = new Set();
                let   anyFrameWithNoPaused = false; // for rateCheckIps=0 (legacy path)

                for (const frame of pmtaFrames) {
                    try {
                        const [result] = await mv2ExecuteScript({
                            tabId  : monitorTab.id,
                            frameId: frame.frameId,
                            func   : (prefixQueues, knownIPs) => {
                                const table = document.querySelector('table.data');
                                if (!table) return { ready: false, stillPausedIps: [] };

                                const stillPausedIps = [];
                                table.querySelectorAll('tbody tr').forEach(function(row) {
                                    const cells = row.querySelectorAll('td');
                                    if (cells.length < 5) return;
                                    const name   = cells[0].textContent.trim();
                                    const paused = cells[4].textContent.trim().toLowerCase();

                                    const matchedPrefix = prefixQueues.find(function(p) { return name.startsWith(p); });
                                    if (!matchedPrefix) return;

                                    const trailingIp = name.slice(matchedPrefix.length);
                                    const isKnownIp  = knownIPs.length === 0 || knownIPs.indexOf(trailingIp) !== -1;
                                    if (isKnownIp && paused === 'yes') stillPausedIps.push(trailingIp);
                                });

                                return { ready: true, stillPausedIps };
                            },
                            args: [PREFIX_QUEUES, userIPs]
                        });

                        const res = result && result.result;
                        if (res && res.ready) {
                            if (res.stillPausedIps && res.stillPausedIps.length > 0) {
                                console.log(`[CHECK_RESUME_STATUS] Frame ${frame.frameId} — still paused IPs: [${res.stillPausedIps.join(', ')}]`);
                                res.stillPausedIps.forEach(ip => stillPausedIpSet.add(ip));
                            } else {
                                console.log(`[CHECK_RESUME_STATUS] Frame ${frame.frameId} — ✅ no target rows still paused`);
                                anyFrameWithNoPaused = true;
                            }
                        } else {
                            console.warn(`[CHECK_RESUME_STATUS] Frame ${frame.frameId} — page not ready yet`);
                        }
                    } catch (e) {
                        console.warn('[CHECK_RESUME_STATUS] Frame inject error (frame ' + frame.frameId + '):', e.message);
                    }
                }

                let resumed;
                if (rateCheckIps <= 0 || totalIps === 0) {
                    // Legacy: any frame with no paused rows is enough
                    resumed = anyFrameWithNoPaused;
                } else {
                    const resumedCount = totalIps - stillPausedIpSet.size;
                    resumed = resumedCount >= requiredCount;
                    console.log(`[CHECK_RESUME_STATUS] resumedCount=${resumedCount} required=${requiredCount} → resumed=${resumed}`);
                }

                sendResponse({
                    resumed   : resumed,
                    tabId     : monitorTab.id,
                    frameCount: pmtaFrames.length
                });

            } catch (err) {
                console.error('[CHECK_RESUME_STATUS] Error:', err);
                sendResponse({ resumed: false, tabId: null, frameCount: 0, reason: err.message });
            }
        })();
        return true;
    }

    // ── SHEETS_SAVE ──────────────────────────────────────────
    // Content scripts on http:// pages have no crypto.subtle (insecure context).
    // We proxy the Google Sheets save call through the background script, which
    // always runs in a secure extension context where crypto.subtle IS available.
    if (message.type === "SHEETS_SAVE") {
        (async () => {
            try {
                const handler = new GoogleSheetsHandler({
                    ...GOOGLE_SHEETS_CONFIG,
                    spreadsheetId: message.spreadsheetId || GOOGLE_SHEETS_CONFIG.spreadsheetId
                });
                const result  = await handler.saveDropResults(
                    message.drop,
                    message.ipResults,
                    message.toleranceRate || 0,
                    message.ipServerMap  || {},
                    message.downServers  || []
                );
                sendResponse(result);
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true; // keep channel open for async sendResponse
    }

    // ── SCHEDULE_VIA_MONITOR ─────────────────────────────────
    // Goes to the already-open MultiMonitor tab, finds the first panel that
    // contains a #runcmd-iframe, clicks its "Run Cmds" tab to reveal the
    // iframe, then injects into that iframe to:
    //   1. Tick the SCHEDULE checkbox
    //   2. Click Execute `numClicks` times, with 20 s between each click.
    //      numClicks is supplied by the content script (= floor(durationSecs/20),
    //      minimum 1). Example: durationSecs=120 → 6 clicks.
    //
    // Returns { success, tabId, reason? }
    if (message.type === "SCHEDULE_VIA_MONITOR") {
        (async () => {
            try {
                // ── Find the MultiMonitor tab ────────────────────────
                const tabs = await browser.tabs.query({});
                const monitorTab = tabs.find(t => t.url && t.url.includes("multi_monitor"));
                if (!monitorTab) {
                    sendResponse({ success: false, reason: "no monitor tab" });
                    return;
                }

                // ── Step 1: click the "Run Cmds" tab on the FIRST panel
                //    that has a #runcmd-iframe.  We do this from the parent
                //    document (no CORS issue).
                const clickRunCmdsTab = `
                    (function() {
                        // Find the first iframe with id="runcmd-iframe"
                        var iframeEl = document.querySelector('iframe#runcmd-iframe');
                        if (!iframeEl) return { found: false, reason: 'no runcmd-iframe' };

                        // Walk up to find the panel-body, then the panel,
                        // then look for the "Run Cmds" tab link (href="#home").
                        var panel = iframeEl.closest('.panel');
                        if (!panel) return { found: false, reason: 'no parent panel' };

                        var runCmdsLink = panel.querySelector('a[href="#home"]');
                        if (!runCmdsLink) return { found: false, reason: 'no Run Cmds tab link' };

                        runCmdsLink.click();

                        // Return the iframeEl src so background can match the frame
                        return { found: true, iframeSrc: iframeEl.src };
                    })();
                `;

                const stepOneResult = await new Promise((resolve, reject) => {
                    browser.tabs.executeScript(monitorTab.id, { code: clickRunCmdsTab }, results => {
                        if (browser.runtime.lastError) reject(browser.runtime.lastError);
                        else resolve(results && results[0] ? results[0] : { found: false });
                    });
                });

                if (!stepOneResult || !stepOneResult.found) {
                    sendResponse({ success: false, reason: stepOneResult && stepOneResult.reason || 'panel not found' });
                    return;
                }

                console.log('[SCHEDULE_VIA_MONITOR] Run Cmds tab clicked — iframe src:', stepOneResult.iframeSrc);

                // ── Step 2: wait for the runcmd-iframe frame to load ─
                // The tab toggle triggers Bootstrap to show the pane; the
                // iframe may already be loaded (lazy or eager). We wait up to
                // 8 s then proceed regardless.
                await new Promise(r => setTimeout(r, 8000));

                // ── Step 3: find the runcmd-iframe frame id ──────────
                const allFrames = await browser.webNavigation.getAllFrames({ tabId: monitorTab.id });
                // Match on the known path segment; src may have been set on
                // the element already when the page loaded.
                const runcmdFrame = allFrames.find(f =>
                    f.url && (
                        f.url.includes('/deploy/run/commands/api') ||
                        f.url.includes('run/commands/api')
                    )
                );

                if (!runcmdFrame) {
                    sendResponse({ success: false, reason: 'runcmd-iframe frame not found in webNavigation frames' });
                    return;
                }

                console.log('[SCHEDULE_VIA_MONITOR] Found runcmd frame:', runcmdFrame.frameId, runcmdFrame.url);

                // ── Step 4: inside the iframe — tick SCHEDULE, then click
                //    Execute `numClicks` times with 20 s between each click.
                //    numClicks is supplied by the content script (derived from
                //    durationSecs / 20); defaults to 1 when not provided.
                const numClicks = (typeof message.numClicks === 'number' && message.numClicks >= 1)
                    ? Math.floor(message.numClicks)
                    : 1;

                // Click 1 — also sets up the SCHEDULE checkbox and domain checkboxes
                const click1Result = await new Promise((resolve, reject) => {
                    const code = `
                        (function() {
                            // Uncheck everything first, then check only SCHEDULE
                            document.querySelectorAll('.pmta_cmds input[type="checkbox"]').forEach(function(cb) {
                                cb.checked = false;
                            });
                            var schedCb = document.querySelector('.pmta_cmds input[value="SCHEDULE"]');
                            if (!schedCb) return { ok: false, reason: 'SCHEDULE checkbox not found' };
                            schedCb.checked = true;

                            // Make sure all domain checkboxes are checked (gmail.com, gmail.queue, googlemail.com)
                            document.querySelectorAll('#domains input[type="checkbox"]').forEach(function(cb) {
                                cb.checked = true;
                            });

                            var execBtn = document.getElementById('execute');
                            if (!execBtn) return { ok: false, reason: 'execute button not found' };
                            execBtn.click();
                            return { ok: true };
                        })();
                    `;
                    browser.tabs.executeScript(monitorTab.id, { code, frameId: runcmdFrame.frameId }, results => {
                        if (browser.runtime.lastError) reject(browser.runtime.lastError);
                        else resolve(results && results[0] ? results[0] : { ok: false });
                    });
                });

                if (!click1Result || !click1Result.ok) {
                    sendResponse({ success: false, reason: click1Result && click1Result.reason || 'click 1 failed' });
                    return;
                }

                console.log(`[SCHEDULE_VIA_MONITOR] Execute click 1/${numClicks} done — waiting 20 s…`);

                // Clicks 2…N — each preceded by a 20 s wait
                for (let clickIdx = 2; clickIdx <= numClicks; clickIdx++) {
                    await new Promise(r => setTimeout(r, 20000));

                    const clickNResult = await new Promise((resolve, reject) => {
                        const code = `
                            (function() {
                                var execBtn = document.getElementById('execute');
                                if (!execBtn) return { ok: false, reason: 'execute button not found on click ${clickIdx}' };
                                execBtn.click();
                                return { ok: true };
                            })();
                        `;
                        browser.tabs.executeScript(monitorTab.id, { code, frameId: runcmdFrame.frameId }, results => {
                            if (browser.runtime.lastError) reject(browser.runtime.lastError);
                            else resolve(results && results[0] ? results[0] : { ok: false });
                        });
                    });

                    console.log(`[SCHEDULE_VIA_MONITOR] Execute click ${clickIdx}/${numClicks} done:`, clickNResult);

                    if (clickIdx < numClicks) {
                        console.log(`[SCHEDULE_VIA_MONITOR] Waiting 20 s before click ${clickIdx + 1}/${numClicks}…`);
                    }
                }

                sendResponse({ success: true, tabId: monitorTab.id });

            } catch (err) {
                console.error('[SCHEDULE_VIA_MONITOR] Error:', err);
                sendResponse({ success: false, reason: err.message });
            }
        })();
        return true;
    }

    // ── RUN_CMDS_VIA_MONITOR ─────────────────────────────────
    // Like SCHEDULE_VIA_MONITOR but accepts a configurable list of
    // command values (cmds[] checkboxes) and clicks Execute exactly ONCE.
    // Used for PAUSE+DELETE+RESET+SCHEDULE, RESUME+SCHEDULE, and DELETE
    // when the "PAUSE/RESUME FROM MultiMonitors" toggle is enabled.
    //
    // message.cmds — array of command values to check
    //                e.g. ['PAUSE','DELETE','RESET','SCHEDULE']
    // Returns { success, tabId, reason? }
    if (message.type === "RUN_CMDS_VIA_MONITOR") {
        (async () => {
            try {
                // ── Find the MultiMonitor tab ────────────────────────
                const tabs = await browser.tabs.query({});
                const monitorTab = tabs.find(t => t.url && t.url.includes("multi_monitor"));
                if (!monitorTab) {
                    sendResponse({ success: false, reason: "no monitor tab" });
                    return;
                }

                const cmds = Array.isArray(message.cmds) ? message.cmds : [];
                if (cmds.length === 0) {
                    sendResponse({ success: false, reason: "no cmds specified" });
                    return;
                }

                // ── Step 1: click the "Run Cmds" tab ────────────────
                const clickRunCmdsTab = `
                    (function() {
                        var iframeEl = document.querySelector('iframe#runcmd-iframe');
                        if (!iframeEl) return { found: false, reason: 'no runcmd-iframe' };
                        var panel = iframeEl.closest('.panel');
                        if (!panel) return { found: false, reason: 'no parent panel' };
                        var runCmdsLink = panel.querySelector('a[href="#home"]');
                        if (!runCmdsLink) return { found: false, reason: 'no Run Cmds tab link' };
                        runCmdsLink.click();
                        return { found: true, iframeSrc: iframeEl.src };
                    })();
                `;

                const stepOneResult = await new Promise((resolve, reject) => {
                    browser.tabs.executeScript(monitorTab.id, { code: clickRunCmdsTab }, results => {
                        if (browser.runtime.lastError) reject(browser.runtime.lastError);
                        else resolve(results && results[0] ? results[0] : { found: false });
                    });
                });

                if (!stepOneResult || !stepOneResult.found) {
                    sendResponse({ success: false, reason: stepOneResult && stepOneResult.reason || 'panel not found' });
                    return;
                }

                console.log('[RUN_CMDS_VIA_MONITOR] Run Cmds tab clicked — iframe src:', stepOneResult.iframeSrc);

                // ── Step 2: wait 8 s for the iframe to load ──────────
                await new Promise(r => setTimeout(r, 8000));

                // ── Step 3: find the runcmd-iframe frame id ──────────
                const allFrames = await browser.webNavigation.getAllFrames({ tabId: monitorTab.id });
                const runcmdFrame = allFrames.find(f =>
                    f.url && (
                        f.url.includes('/deploy/run/commands/api') ||
                        f.url.includes('run/commands/api')
                    )
                );

                if (!runcmdFrame) {
                    sendResponse({ success: false, reason: 'runcmd-iframe frame not found in webNavigation frames' });
                    return;
                }

                console.log('[RUN_CMDS_VIA_MONITOR] Found runcmd frame:', runcmdFrame.frameId, runcmdFrame.url);

                // ── Step 4: inside the iframe — uncheck all, check requested
                //    cmds[], ensure domain checkboxes are all checked, click Execute once ──
                const cmdsJson = JSON.stringify(cmds);
                const jobId = (message.jobId && String(message.jobId).trim()) || '';
                const clickResult = await new Promise((resolve, reject) => {
                    const code = `
                        (function() {
                            var cmds = ${cmdsJson};
                            var jobId = ${JSON.stringify(jobId)};
                            // Uncheck all command checkboxes first
                            document.querySelectorAll('.pmta_cmds input[type="checkbox"]').forEach(function(cb) {
                                cb.checked = false;
                            });
                            // Check only the requested commands.
                            // If a jobId is provided, skip 'DELETE' and use 'DELETE_JOBID' instead.
                            var effectiveCmds = jobId
                                ? cmds.filter(function(c) { return c !== 'DELETE'; })
                                : cmds;
                            var missing = [];
                            effectiveCmds.forEach(function(cmd) {
                                var cb = document.querySelector('.pmta_cmds input[value="' + cmd + '"]');
                                if (cb) { cb.checked = true; }
                                else { missing.push(cmd); }
                            });
                            // If a jobId is provided, check DELETE_JOBID and fill the jobid input
                            if (jobId) {
                                var deleteJobIdCb = document.querySelector('input[value="DELETE_JOBID"]');
                                if (deleteJobIdCb) { deleteJobIdCb.checked = true; }
                                else { missing.push('DELETE_JOBID'); }
                                var jobidInput = document.getElementById('jobid');
                                if (jobidInput) { jobidInput.value = 'send-gmail-' + jobId; }
                            }
                            // Make sure all domain checkboxes are checked
                            document.querySelectorAll('#domains input[type="checkbox"]').forEach(function(cb) {
                                cb.checked = true;
                            });
                            var execBtn = document.getElementById('execute');
                            if (!execBtn) return { ok: false, reason: 'execute button not found' };
                            execBtn.click();
                            return { ok: true, missing: missing };
                        })();
                    `;
                    browser.tabs.executeScript(monitorTab.id, { code, frameId: runcmdFrame.frameId }, results => {
                        if (browser.runtime.lastError) reject(browser.runtime.lastError);
                        else resolve(results && results[0] ? results[0] : { ok: false });
                    });
                });

                if (!clickResult || !clickResult.ok) {
                    sendResponse({ success: false, reason: clickResult && clickResult.reason || 'execute click failed' });
                    return;
                }

                if (clickResult.missing && clickResult.missing.length > 0) {
                    console.warn('[RUN_CMDS_VIA_MONITOR] Some checkboxes not found:', clickResult.missing);
                }

                console.log('[RUN_CMDS_VIA_MONITOR] Execute clicked for cmds:', cmds);
                sendResponse({ success: true, tabId: monitorTab.id });

            } catch (err) {
                console.error('[RUN_CMDS_VIA_MONITOR] Error:', err);
                sendResponse({ success: false, reason: err.message });
            }
        })();
        return true;
    }

    // ── CLOSE_TAB ────────────────────────────────────────────
    if (message.type === "CLOSE_TAB") {
        browser.tabs.remove(message.tabId, () => sendResponse({ done: true }));
        return true;
    }

    // ── FOCUS_TAB ────────────────────────────────────────────
    if (message.type === "FOCUS_TAB") {
        browser.tabs.update(message.tabId, { active: true }, () => sendResponse({ done: true }));
        return true;
    }
});