const TELEGRAM_BOT_TOKEN = '8716536042:AAGZsFb-QF_5BQD5Bvfmc908_BXPxcasyCM';

// ── Format number with thousand separators ───────────────────
function tgFmt(n) {
    return Number(n).toLocaleString('en-US');
}

// ── Build alert message for send-modal failure ───────────────
function buildTelegramAlertMessage(drop, totalDrops, groupIndex, totalGroups, ips, attemptCount, randomServer = '') {
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}  ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const ipList  = ips.map(ip => `  - ${ip}`).join('\n');
    const divider = '='.repeat(40);

    const lines = [
        `[!!] SEND MODAL FAILURE ALERT`,
        divider,
        `Date     :  ${dateStr}`,
        ...(randomServer ? [`Server   :  ${randomServer}`] : []),
        divider,
        `Drop     :  ${drop} / ${totalDrops}`,
        `Group    :  ${groupIndex} / ${totalGroups}`,
        `Attempts :  ${attemptCount} clicks x 2 min = ~${Math.round(attemptCount * 2)} min`,
        ``,
        `IPs in failed group:`,
        ipList,
        divider,
        `The send button was clicked repeatedly (every 2 min).`,
        `The report modal never appeared after 1 hour.`,
        `The warmup process has been STOPPED.`,
    ];

    return '```\n' + lines.join('\n') + '\n```';
}

// ── Send a plain alert (error notification) to Telegram ──────
async function sendTelegramAlert(drop, totalDrops, groupIndex, totalGroups, ips, chatId, attemptCount, randomServer = '') {
    const message = buildTelegramAlertMessage(drop, totalDrops, groupIndex, totalGroups, ips, attemptCount, randomServer);

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method  : 'POST',
                headers : { 'Content-Type': 'application/json' },
                body    : JSON.stringify({
                    chat_id    : chatId,
                    text       : message,
                    parse_mode : 'Markdown'
                })
            }
        );
        const data = await response.json();
        if (response.ok && data.ok) return { success: true };
        return { success: false, error: data.description || `HTTP ${response.status}` };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ── Build the merged drop report (warmup + optional email count) ─
// emailCountData: null  → email count section omitted
//                { inboxCount, spamCount, totalCount, subject, fromEmail,
//                  resumeTime, countTime, gmailAccount }  → section included
function buildMergedMessage(drop, totalDrops, ipResults, toleranceRate = 0, downServers = [], processType = 'passive', emailCountData = null, dropNote = '', listInfo = null) {
    const totalIn  = ipResults.reduce((s, r) => s + r.target,     0);
    const totalOut = ipResults.reduce((s, r) => s + r.reallySent, 0);
    const rate     = totalIn > 0 ? ((totalOut / totalIn) * 100).toFixed(1) : '0.0';

    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}  ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // Collect unique servers (in order of first appearance)
    const serverOrder = [];
    const seenSrv = new Set();
    ipResults.forEach(r => {
        if (r.server && !seenSrv.has(r.server)) {
            seenSrv.add(r.server);
            serverOrder.push(r.server);
        }
    });
    const hasServers = serverOrder.length > 0;

    // Column widths — wide enough to fit all data cleanly
    const ipColW  = Math.max(...ipResults.map(r => r.ip.length), 15);
    const srvColW = hasServers ? Math.max(...serverOrder.map(s => s.length), 10) : 0;
    const totalW  = hasServers ? (ipColW + srvColW + 38) : (ipColW + 34);
    const divider = '='.repeat(totalW);
    const thin    = '-'.repeat(totalW);

    // ── Per-IP detail rows ─────────────────────────────────────
    const colHead = hasServers
        ? `${'ST'.padEnd(6)}  ${'SERVER'.padEnd(srvColW)}  ${'IP'.padEnd(ipColW)}  ${'IN'.padStart(9)}  ${'OUT'.padStart(9)}  ${'RATE'.padStart(6)}`
        : `${'ST'.padEnd(6)}  ${'IP'.padEnd(ipColW)}  ${'IN'.padStart(9)}  ${'OUT'.padStart(9)}  ${'RATE'.padStart(6)}`;

    const ipRows = ipResults.map(r => {
        if (r.serverDown) {
            const srvPart = hasServers ? `${(r.server || '').padEnd(srvColW)}  ` : '';
            return `[DOWN]  ${srvPart}${r.ip.padEnd(ipColW)}  ${'---'.padStart(9)}  ${'---'.padStart(9)}  ${'DOWN'.padStart(6)}`;
        }
        const pctIp     = r.target > 0 ? ((r.reallySent / r.target) * 100).toFixed(1) : '0.0';
        const threshold = 100 - toleranceRate;
        const tag       = parseFloat(pctIp) >= threshold ? '✅' : '⚠️';
        const srvPart   = hasServers ? `${(r.server || '').padEnd(srvColW)}  ` : '';
        return `${tag}  ${srvPart}${r.ip.padEnd(ipColW)}  ${tgFmt(r.target).padStart(9)}  ${tgFmt(r.reallySent).padStart(9)}  ${(pctIp + '%').padStart(6)}`;
    }).join('\n');

    // ── Per-server subtotals ───────────────────────────────────
    let serverSection = [];
    if (hasServers) {
        const srvHead = `${'ST'.padEnd(6)}  ${'SERVER'.padEnd(srvColW)}  ${'TOTAL IN'.padStart(9)}  ${'TOTAL OUT'.padStart(10)}  ${'RATE'.padStart(6)}`;
        serverSection = [``, `SERVER TOTALS`, thin, srvHead, thin];

        serverOrder.forEach(srv => {
            const srvIps    = ipResults.filter(r => r.server === srv);
            const isDown    = downServers.includes(srv) || srvIps.every(r => r.serverDown);
            const srvIn     = srvIps.reduce((s, r) => s + r.target,     0);
            const srvOut    = srvIps.reduce((s, r) => s + r.reallySent, 0);
            const srvRate   = srvIn > 0 ? ((srvOut / srvIn) * 100).toFixed(1) : '0.0';
            const threshold = 100 - toleranceRate;

            if (isDown) {
                serverSection.push(
                    `[DOWN]  ${srv.padEnd(srvColW)}  ${'---'.padStart(9)}  ${'---'.padStart(10)}  ${'DOWN'.padStart(6)}`
                );
            } else {
                const tag = parseFloat(srvRate) >= threshold ? '✅' : '⚠️';
                serverSection.push(
                    `${tag}  ${srv.padEnd(srvColW)}  ${tgFmt(srvIn).padStart(9)}  ${tgFmt(srvOut).padStart(10)}  ${(srvRate + '%').padStart(6)}`
                );
            }
        });
        serverSection.push(thin);
    }

    const processLabel = processType === 'passive' ? 'Passive Lists' : 'Warmup Lists';
    const fmtCount = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

    // ── Email count section (optional) ────────────────────────
    let emailSection = [];
    if (emailCountData) {
        const fmtDate = d => `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const {
            inboxCount, spamCount, totalCount,
            subject, fromEmail, resumeTime, countTime, gmailAccount
        } = emailCountData;

        const countStr    = fmtDate(new Date(countTime));
        const searchAfter = resumeTime ? fmtDate(new Date(resumeTime - 60 * 60 * 1000)) : 'N/A';
        const inboxRate   = totalCount > 0 ? Math.round((inboxCount / totalCount) * 100) : 0;

        emailSection = [
            ``,
            `EMAIL COUNT`,
            thin,
            `Counted At    :  ${countStr}`,
            `Gmail Account :  ${gmailAccount || 'N/A'}`,
            thin,
            `From          :  ${fromEmail || 'N/A'}`,
            `Subject       :  ${subject   || 'N/A'}`,
            `Received After:  ${searchAfter}`,
            thin,
            `Inbox         :  ${tgFmt(inboxCount)}`,
            `Spam          :  ${tgFmt(spamCount)}`,
            `Total         :  ${tgFmt(totalCount)}`,
            `Inbox Rate    :  ${inboxRate}%`,
            thin,
            `NOTE: The portal sends with GMT timing.`,
            `      Search starts from ${searchAfter}.`,
            thin,
        ];
    }

    const lines = [
        `WARMUP REPORT`,
        divider,
        `Drop     :  ${drop} / ${totalDrops}`,
        `Date     :  ${dateStr}`,
        `Mode     :  ${processLabel}`,
        ...(listInfo && listInfo.name ? [`List     :  ${listInfo.name}${listInfo.count != null ? ' (' + fmtCount(listInfo.count) + ' unique)' : ''}`] : []),
        ...(dropNote ? [`Note     :  ${dropNote}`] : []),
        divider,
        ``,
        `SUMMARY`,
        thin,
        `Total IPs    :  ${ipResults.length}`,
        `Total IN     :  ${tgFmt(totalIn)}`,
        `Total OUT    :  ${tgFmt(totalOut)}`,
        `Delivery     :  ${rate}%`,
        `Tolerance    :  ${toleranceRate}%`,
        ...(downServers.length > 0 ? [`Down Servers :  ${downServers.join(', ')}`] : []),
        thin,
        ...serverSection,
        ``,
        `DETAIL PER IP`,
        thin,
        colHead,
        thin,
        ipRows,
        thin,
        ...emailSection,
    ];

    return '```\n' + lines.join('\n') + '\n```';
}

// ── Build plain-text version of the merged report (for .txt file fallback) ──
function buildMergedPlainText(drop, totalDrops, ipResults, toleranceRate = 0, downServers = [], processType = 'passive', emailCountData = null, dropNote = '', listInfo = null) {
    // Same as buildMergedMessage but without the backtick fences
    const full = buildMergedMessage(drop, totalDrops, ipResults, toleranceRate, downServers, processType, emailCountData, dropNote, listInfo);
    return full.replace(/^```\n/, '').replace(/\n```$/, '');
}

// ── Send merged report as a .txt document to Telegram ────────
async function sendMergedReportAsFile(drop, totalDrops, ipResults, chatId, toleranceRate = 0, downServers = [], processType = 'passive', emailCountData = null, dropNote = '', listInfo = null) {
    const plainText = buildMergedPlainText(drop, totalDrops, ipResults, toleranceRate, downServers, processType, emailCountData, dropNote, listInfo);

    const now      = new Date();
    const pad      = n => String(n).padStart(2, '0');
    const stamp    = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    const fileName = `warmup_report_drop${drop}_${stamp}.txt`;

    const blob     = new Blob([plainText], { type: 'text/plain' });
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('caption', `Warmup Report - Drop ${drop}/${totalDrops} (attached as file)`);
    formData.append('document', blob, fileName);

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
            { method: 'POST', body: formData }
        );
        const data = await response.json();
        if (response.ok && data.ok) return { success: true };
        return { success: false, error: data.description || `HTTP ${response.status}` };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ── Send the merged report (inline if fits, file fallback otherwise) ─
// emailCountData: null = no email count section; object = include it.
async function sendMergedReport(drop, totalDrops, ipResults, chatId, toleranceRate = 0, downServers = [], processType = 'passive', emailCountData = null, dropNote = '', listInfo = null) {
    const message = buildMergedMessage(drop, totalDrops, ipResults, toleranceRate, downServers, processType, emailCountData, dropNote, listInfo);

    if (message.length > 4090) {
        return sendMergedReportAsFile(drop, totalDrops, ipResults, chatId, toleranceRate, downServers, processType, emailCountData, dropNote, listInfo);
    }

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method  : 'POST',
                headers : { 'Content-Type': 'application/json' },
                body    : JSON.stringify({
                    chat_id    : chatId,
                    text       : message,
                    parse_mode : 'Markdown'
                })
            }
        );
        const data = await response.json();
        if (response.ok && data.ok) return { success: true };
        return { success: false, error: data.description || `HTTP ${response.status}` };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ── Legacy aliases kept so nothing in content.js breaks ──────
// sendTelegramReport is still called nowhere after the refactor,
// but kept in case old code paths reference it.
async function sendTelegramReport(drop, totalDrops, ipResults, chatId, toleranceRate = 0, downServers = [], processType = 'passive') {
    return sendMergedReport(drop, totalDrops, ipResults, chatId, toleranceRate, downServers, processType, null);
}