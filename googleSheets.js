// ============================================================
// Google Sheets Handler — Ips Warmup Extension
// ============================================================
// Sheet layout (one sheet per day  →  Warmup_DD-MM-YYYY):
//
//  Columns A-D  →  SUMMARY section  (frozen)
//    A  : Drop label  ("Drop 1", "Drop 2", …)
//    B  : Total Target
//    C  : Total Really Sent
//    D  : Date / Time
//
//  From column E onwards, each DROP gets its own 4-column group
//  (3 data cols + 1 empty spacer):
//    [E]  DROP N  (merged header row 1)
//    [E]  IP  |  [F] Target  |  [G] Really Sent
//    rows 3+  →  one row per IP
//    Rows where Really Sent < Target are highlighted yellow.
// ============================================================

// ── JWT / Auth helpers ───────────────────────────────────────

function _base64urlEncode(data) {
  if (typeof data === 'string') data = new TextEncoder().encode(data);
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _str2ab(str) {
  // charCodeAt returns values 0-255 for binary strings from atob()
  // Using Uint8Array.from ensures no byte is lost or truncated
  return Uint8Array.from(str, c => c.charCodeAt(0)).buffer;
}

async function _signJwt(header, claims, privateKey) {
  const enc  = _base64urlEncode(JSON.stringify(header)) + '.' +
               _base64urlEncode(JSON.stringify(claims));
  const key  = await crypto.subtle.importKey(
    'pkcs8',
    _str2ab(atob(privateKey.replace(/-----BEGIN PRIVATE KEY-----|\n|-----END PRIVATE KEY-----/g, ''))),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig  = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(enc));
  return `${enc}.${_base64urlEncode(sig)}`;
}

async function _getCredentials() {
  // PRIMARY: If GOOGLE_SHEETS_CREDENTIALS is defined (set in config.js and
  // available in the background script context), use it directly — no fetch
  // needed and no dependency on web_accessible_resources.
  if (typeof GOOGLE_SHEETS_CREDENTIALS !== 'undefined' && GOOGLE_SHEETS_CREDENTIALS) {
    const json = GOOGLE_SHEETS_CREDENTIALS;
    if (!json.private_key || !json.client_email || !json.token_uri) {
      throw new Error('GOOGLE_SHEETS_CREDENTIALS is missing required fields (private_key / client_email / token_uri).');
    }
    return json;
  }

  // FALLBACK: fetch via extension URL (content script path, requires
  // the file to be listed in manifest web_accessible_resources).
  let url;
  try {
    url = (typeof browser !== 'undefined' ? browser : chrome).runtime.getURL(GOOGLE_SHEETS_CONFIG.credentialsFile);
  } catch (e) {
    throw new Error('chrome.runtime not available: ' + e.message);
  }

  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    throw new Error('Failed to fetch credentials (network/CSP error): ' + e.message);
  }

  if (!resp.ok) {
    throw new Error(
      `Failed to load credentials JSON — HTTP ${resp.status}. ` +
      `Make sure "${GOOGLE_SHEETS_CONFIG.credentialsFile}" is listed in ` +
      `manifest.json > web_accessible_resources.`
    );
  }

  let json;
  try {
    json = await resp.json();
  } catch (e) {
    throw new Error('Credentials file is not valid JSON: ' + e.message);
  }

  if (!json.private_key || !json.client_email || !json.token_uri) {
    throw new Error('Credentials JSON is missing required fields (private_key / client_email / token_uri).');
  }

  return json;
}

async function _getAccessToken(creds) {
  const now   = Math.floor(Date.now() / 1000);
  const jwt   = await _signJwt(
    { alg: 'RS256', typ: 'JWT' },
    { iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: creds.token_uri, exp: now + 3600, iat: now },
    creds.private_key
  );
  const resp  = await fetch(creds.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '(unreadable)');
    throw new Error(`Failed to get access token — HTTP ${resp.status}: ${body}`);
  }
  const data  = await resp.json();
  if (!data.access_token) {
    throw new Error('Token response missing access_token: ' + JSON.stringify(data));
  }
  return data.access_token;
}

// ── Formatting helpers ───────────────────────────────────────

function _formatDateTime(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getDate())}-${pad(date.getMonth()+1)}-${date.getFullYear()} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function _formatDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getDate())}-${pad(date.getMonth()+1)}-${date.getFullYear()}`;
}

// ── Column index → letter (0-based) ─────────────────────────
function _col(index) {
  let letter = '';
  let i = index;
  while (i >= 0) {
    letter = String.fromCharCode((i % 26) + 65) + letter;
    i = Math.floor(i / 26) - 1;
  }
  return letter;
}

// ── Layout constants ─────────────────────────────────────────
const SUMMARY_COLS   = 4;   // A-D  (Drop | Target | ReallySent | DateTime)
const DROP_COLS      = 4;   // Server | IP | Target | ReallySent
const SPACER_COLS    = 1;   // 1 empty col between drop groups
const DROP_GROUP     = DROP_COLS + SPACER_COLS; // 5 cols per drop

function _dropStartCol(dropNumber) {
  // drop 1 → col index 4 (= E), drop 2 → col 9 (= J), …
  return SUMMARY_COLS + (dropNumber - 1) * DROP_GROUP;
}

// ── Sheets API helpers ───────────────────────────────────────

async function _sheetsGet(path, token) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${path} failed: ${await r.text()}`);
  return r.json();
}

async function _sheetsPut(path, token, body) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`,
    { method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PUT ${path} failed: ${await r.text()}`);
  return r.json();
}

async function _sheetsPost(path, token, body) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`,
    { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${path} failed: ${await r.text()}`);
  return r.json();
}

async function _getSheetId(spreadsheetId, sheetName, token) {
  const meta = await _sheetsGet(`${spreadsheetId}?fields=sheets.properties`, token);
  const sheet = (meta.sheets || []).find(s => s.properties.title === sheetName);
  return sheet ? sheet.properties.sheetId : null;
}

// ── Main class ───────────────────────────────────────────────

class GoogleSheetsHandler {
  constructor(config) {
    this.spreadsheetId = config.spreadsheetId;
  }

  // Called after each drop's queue read
  // ipResults: array of { ip, server, target, reallySent, rcpt, serverDown }
  // ipServerMap: { ip -> serverName }
  // downServers: array of server names that were down
  async saveDropResults(dropNumber, ipResults, toleranceRate = 0, ipServerMap = {}, downServers = []) {
    try {
      const now        = new Date();
      const sheetName  = `Warmup_${_formatDate(now)}`;
      const dateTime   = _formatDateTime(now);

      console.log(`[Sheets] Saving Drop ${dropNumber} → sheet "${sheetName}"`);

      const creds      = await _getCredentials();
      const token      = await _getAccessToken(creds);

      // Ensure daily sheet exists
      const meta       = await _sheetsGet(`${this.spreadsheetId}?fields=sheets.properties`, token);
      const exists     = (meta.sheets || []).some(s => s.properties.title === sheetName);

      if (!exists) {
        await this._createSheet(sheetName, token);
      }

      // Write drop column group
      await this._writeDropColumns(sheetName, dropNumber, ipResults, dateTime, token, toleranceRate, downServers);

      // Update summary row for this drop
      await this._updateSummaryRow(sheetName, dropNumber, ipResults, dateTime, token);

      // ── Global IP Stats sheet ──────────────────────────────
      // Re-fetch meta (sheet may have been created above) to check for Global IP Stats
      const meta2          = await _sheetsGet(`${this.spreadsheetId}?fields=sheets.properties`, token);
      const globalExists   = (meta2.sheets || []).some(s => s.properties.title === 'Global IP Stats');

      if (!globalExists) {
        await this._createGlobalIpStatsSheet(token);
      }

      await this._updateGlobalIpStats(dropNumber, ipResults, dateTime, token, toleranceRate);

      console.log(`[Sheets] ✅ Drop ${dropNumber} saved to "${sheetName}" + Global IP Stats updated`);
      return { success: true, sheetName };

    } catch (err) {
      console.error('[Sheets] ❌ Error saving Drop ' + dropNumber + ':', err);
      console.error('[Sheets] Stack:', err.stack || '(no stack)');
      return { success: false, error: err.message };
    }
  }

  // ── Create a new daily sheet ───────────────────────────────
  async _createSheet(sheetName, token) {
    const totalCols = SUMMARY_COLS + 30 * DROP_GROUP; // room for 30 drops
    await _sheetsPost(`${this.spreadsheetId}:batchUpdate`, token, {
      requests: [{
        addSheet: {
          properties: {
            title: sheetName,
            gridProperties: {
              frozenRowCount: 2,
              frozenColumnCount: SUMMARY_COLS,
              columnCount: totalCols,
              rowCount: 200
            }
          }
        }
      }]
    });

    // Write SUMMARY header (rows 1-2, cols A-D)
    await _sheetsPut(
      `${this.spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:D2?valueInputOption=RAW`,
      token,
      { values: [
          ['SUMMARY', '', '', ''],
          ['Drop', 'Total IN', 'Total OUT', 'Date / Time']
        ] }
    );

    // Format SUMMARY header
    const sheetId = await _getSheetId(this.spreadsheetId, sheetName, token);
    await this._formatSummaryHeader(sheetId, token);

    console.log(`[Sheets] ✅ Created sheet "${sheetName}"`);
  }

  // ── Write drop column group ────────────────────────────────
  // Layout: Server | IP | IN | OUT  (4 data cols + 1 spacer = 5 total per drop)
  // After IP rows, per-server subtotal rows are appended.
  async _writeDropColumns(sheetName, dropNumber, ipResults, dateTime, token, toleranceRate = 0, downServers = []) {
    const startCol  = _dropStartCol(dropNumber);
    const c0 = _col(startCol);      // Server
    const c1 = _col(startCol + 1);  // IP
    const c2 = _col(startCol + 2);  // IN (Target)
    const c3 = _col(startCol + 3);  // OUT (Really Sent)
    const endDataCol = startCol + DROP_COLS; // exclusive

    // Ensure enough columns exist
    await this._ensureColumns(sheetName, startCol + DROP_GROUP + 5, token);

    // Row 1: DROP N header (merged across 4 cols)
    await _sheetsPut(
      `${this.spreadsheetId}/values/${encodeURIComponent(sheetName)}!${c0}1:${c3}1?valueInputOption=RAW`,
      token,
      { values: [[`DROP ${dropNumber}`, '', '', '']] }
    );

    // Row 2: column sub-headers
    await _sheetsPut(
      `${this.spreadsheetId}/values/${encodeURIComponent(sheetName)}!${c0}2:${c3}2?valueInputOption=RAW`,
      token,
      { values: [['SERVER', 'IP', 'IN', 'OUT']] }
    );

    // Rows 3+: IP data rows
    // null target/reallySent means the IP was "at rest" this drop → blank cells
    const ipRows = ipResults.map(r => [
      r.server || '',
      r.ip,
      r.serverDown ? 'DOWN' : (r.target     === null ? '' : r.target),
      r.serverDown ? 'DOWN' : (r.reallySent === null ? '' : r.reallySent)
    ]);
    const ipEndRow = 2 + ipRows.length;
    await _sheetsPut(
      `${this.spreadsheetId}/values/${encodeURIComponent(sheetName)}!${c0}3:${c3}${ipEndRow}?valueInputOption=RAW`,
      token,
      { values: ipRows }
    );

    // Per-server subtotal rows (after IP rows, separated by a blank row)
    const serverOrder = [];
    const seenSrv = new Set();
    ipResults.forEach(r => {
      if (r.server && !seenSrv.has(r.server)) { seenSrv.add(r.server); serverOrder.push(r.server); }
    });

    let subtotalStartRow = ipEndRow + 1; // +1 for blank separator row
    const subtotalRows = [];
    if (serverOrder.length > 0) {
      // Blank separator row
      subtotalRows.push(['', '', '', '']);
      // Sub-header
      subtotalRows.push(['SERVER TOTAL', '', 'TOTAL IN', 'TOTAL OUT']);

      serverOrder.forEach(srv => {
        const srvIps  = ipResults.filter(r => r.server === srv);
        const isDown  = downServers.includes(srv) || srvIps.every(r => r.serverDown);
        // If every IP in this server group is resting (null), leave subtotal blank
        const allResting = srvIps.every(r => r.target === null && !r.serverDown);
        const srvIn  = isDown ? 'DOWN' : allResting ? '' : srvIps.reduce((s, r) => s + (r.target     ?? 0), 0);
        const srvOut = isDown ? 'DOWN' : allResting ? '' : srvIps.reduce((s, r) => s + (r.reallySent ?? 0), 0);
        subtotalRows.push([srv, '', srvIn, srvOut]);
      });

      const subEndRow = subtotalStartRow + subtotalRows.length - 1;
      await _sheetsPut(
        `${this.spreadsheetId}/values/${encodeURIComponent(sheetName)}!${c0}${subtotalStartRow}:${c3}${subEndRow}?valueInputOption=RAW`,
        token,
        { values: subtotalRows }
      );
    }

    // Formatting
    const sheetId = await _getSheetId(this.spreadsheetId, sheetName, token);
    await this._formatDropGroup(
      sheetId, startCol, endDataCol,
      ipRows.length, ipResults,
      subtotalStartRow, subtotalRows, serverOrder, downServers,
      token, toleranceRate
    );

    console.log(`[Sheets] ✅ Written ${ipRows.length} IPs + ${serverOrder.length} server subtotals for Drop ${dropNumber} (cols ${c0}-${c3})`);
  }

  // ── Update / insert summary row for this drop ──────────────
  async _updateSummaryRow(sheetName, dropNumber, ipResults, dateTime, token) {
    // Resting-group IPs have null target/reallySent — exclude them from totals
    const totalTarget     = ipResults.reduce((s, r) => s + (r.target     ?? 0), 0);
    const totalReallySent = ipResults.reduce((s, r) => s + (r.reallySent ?? 0), 0);

    // Read existing summary rows (A3:D200)
    let existingRows = [];
    try {
      const data = await _sheetsGet(
        `${this.spreadsheetId}/values/${encodeURIComponent(sheetName)}!A3:D200`,
        token
      );
      existingRows = data.values || [];
    } catch (_) {}

    const label     = `Drop ${dropNumber}`;
    let targetRow   = 3 + existingRows.length; // default: append

    for (let i = 0; i < existingRows.length; i++) {
      if (existingRows[i][0] === label) { targetRow = 3 + i; break; }
    }

    await _sheetsPut(
      `${this.spreadsheetId}/values/${encodeURIComponent(sheetName)}!A${targetRow}:D${targetRow}?valueInputOption=RAW`,
      token,
      { values: [[label, totalTarget, totalReallySent, dateTime]] }
    );

    console.log(`[Sheets] ✅ Summary row for Drop ${dropNumber} written at row ${targetRow}`);
  }

  // ── Ensure sheet has enough columns ───────────────────────
  async _ensureColumns(sheetName, needed, token) {
    const meta  = await _sheetsGet(`${this.spreadsheetId}?fields=sheets.properties`, token);
    const sheet = (meta.sheets || []).find(s => s.properties.title === sheetName);
    if (!sheet) return;
    const cur   = sheet.properties.gridProperties.columnCount;
    if (cur >= needed) return;
    const sid   = sheet.properties.sheetId;
    await _sheetsPost(`${this.spreadsheetId}:batchUpdate`, token, {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId: sid, gridProperties: { columnCount: needed + 50 } },
          fields: 'gridProperties.columnCount'
        }
      }]
    });
  }

  // ── Format: SUMMARY header (A1:D2) ────────────────────────
  async _formatSummaryHeader(sheetId, token) {
    const blue   = { red: 0.26, green: 0.52, blue: 0.96 };
    const white  = { red: 1, green: 1, blue: 1 };
    const lblue  = { red: 0.85, green: 0.92, blue: 0.99 };
    const border = { style: 'SOLID', width: 2, color: blue };

    await _sheetsPost(`${this.spreadsheetId}:batchUpdate`, token, {
      requests: [
        // Merge A1:D1 for "SUMMARY"
        { mergeCells: {
            range: { sheetId, startRowIndex:0, endRowIndex:1, startColumnIndex:0, endColumnIndex:SUMMARY_COLS },
            mergeType: 'MERGE_ALL' } },
        // Style row 1
        { repeatCell: {
            range: { sheetId, startRowIndex:0, endRowIndex:1, startColumnIndex:0, endColumnIndex:SUMMARY_COLS },
            cell: { userEnteredFormat: {
              backgroundColor: blue,
              textFormat: { foregroundColor: white, fontSize: 12, bold: true },
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }},
            fields: 'userEnteredFormat' } },
        // Style row 2 (sub-headers)
        { repeatCell: {
            range: { sheetId, startRowIndex:1, endRowIndex:2, startColumnIndex:0, endColumnIndex:SUMMARY_COLS },
            cell: { userEnteredFormat: {
              backgroundColor: lblue,
              textFormat: { fontSize: 10, bold: true },
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }},
            fields: 'userEnteredFormat' } },
        // Border A1:D2
        { updateBorders: {
            range: { sheetId, startRowIndex:0, endRowIndex:2, startColumnIndex:0, endColumnIndex:SUMMARY_COLS },
            top: border, bottom: border, left: border, right: border,
            innerVertical: { style:'SOLID', width:1, color:blue },
            innerHorizontal: { style:'SOLID', width:1, color:blue } } }
      ]
    });
  }

  // ── Format: DROP group header + data rows ─────────────────
  async _formatDropGroup(
    sheetId, startCol, endCol,
    rowCount, ipResults,
    subtotalStartRow, subtotalRows, serverOrder, downServers,
    token, toleranceRate = 0
  ) {
    const blue     = { red: 0.26, green: 0.52, blue: 0.96 };
    const white    = { red: 1,    green: 1,    blue: 1    };
    const lblue    = { red: 0.85, green: 0.92, blue: 0.99 };
    const grey     = { red: 0.85, green: 0.85, blue: 0.85 };
    const yellow   = { red: 1.0,  green: 0.96, blue: 0.6  };
    const red      = { red: 1.0,  green: 0.82, blue: 0.82 };   // down-server rows
    const orange   = { red: 1.0,  green: 0.9,  blue: 0.7  };   // server subtotal header
    const border   = { style: 'SOLID', width: 2, color: blue };
    const thinB    = { style: 'SOLID', width: 1, color: grey };

    const requests = [
      // Merge row 1 for DROP N header
      { mergeCells: {
          range: { sheetId, startRowIndex:0, endRowIndex:1, startColumnIndex:startCol, endColumnIndex:endCol },
          mergeType: 'MERGE_ALL' } },
      // Style DROP N header (row 1)
      { repeatCell: {
          range: { sheetId, startRowIndex:0, endRowIndex:1, startColumnIndex:startCol, endColumnIndex:endCol },
          cell: { userEnteredFormat: {
            backgroundColor: blue,
            textFormat: { foregroundColor: white, fontSize: 11, bold: true },
            horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
          }},
          fields: 'userEnteredFormat' } },
      // Style sub-headers (row 2)
      { repeatCell: {
          range: { sheetId, startRowIndex:1, endRowIndex:2, startColumnIndex:startCol, endColumnIndex:endCol },
          cell: { userEnteredFormat: {
            backgroundColor: lblue,
            textFormat: { fontSize: 10, bold: true },
            horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
          }},
          fields: 'userEnteredFormat' } },
      // Border header rows
      { updateBorders: {
          range: { sheetId, startRowIndex:0, endRowIndex:2, startColumnIndex:startCol, endColumnIndex:endCol },
          top: border, bottom: border, left: border, right: border,
          innerVertical: { style:'SOLID', width:1, color:blue },
          innerHorizontal: { style:'SOLID', width:1, color:blue } } },
    ];

    if (rowCount > 0) {
      // Style all IP data rows (alignment + borders)
      requests.push(
        { repeatCell: {
            range: { sheetId, startRowIndex:2, endRowIndex:2+rowCount, startColumnIndex:startCol, endColumnIndex:endCol },
            cell: { userEnteredFormat: {
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }},
            fields: 'userEnteredFormat' } },
        { updateBorders: {
            range: { sheetId, startRowIndex:2, endRowIndex:2+rowCount, startColumnIndex:startCol, endColumnIndex:endCol },
            top: thinB, bottom: thinB, left: thinB, right: thinB,
            innerVertical: thinB, innerHorizontal: thinB } }
      );

      // Per-IP row highlights
      ipResults.forEach((r, i) => {
        const rowIndex = 2 + i;
        if (r.serverDown) {
          // Red highlight for down-server IPs
          requests.push({
            repeatCell: {
              range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: startCol, endColumnIndex: endCol },
              cell: { userEnteredFormat: { backgroundColor: red } },
              fields: 'userEnteredFormat.backgroundColor'
            }
          });
        } else {
          const deliveryRate  = r.target > 0 ? (r.reallySent / r.target) * 100 : 100;
          const passThreshold = 100 - toleranceRate;
          if (deliveryRate < passThreshold) {
            requests.push({
              repeatCell: {
                range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: startCol, endColumnIndex: endCol },
                cell: { userEnteredFormat: { backgroundColor: yellow } },
                fields: 'userEnteredFormat.backgroundColor'
              }
            });
          }
        }
      });
    }

    // Per-server subtotal section formatting
    // subtotalStartRow is 1-based sheet row; convert to 0-based index
    if (subtotalRows && subtotalRows.length > 0 && serverOrder && serverOrder.length > 0) {
      const subHeaderRowIdx  = subtotalStartRow;     // row after blank separator (1-based = subtotalStartRow+1 → 0-based = subtotalStartRow)
      const subDataStartIdx  = subHeaderRowIdx + 1;  // 0-based index of first server subtotal data row

      // Style "SERVER TOTAL" sub-header row
      requests.push({
        repeatCell: {
          range: { sheetId,
            startRowIndex: subHeaderRowIdx, endRowIndex: subHeaderRowIdx + 1,
            startColumnIndex: startCol, endColumnIndex: endCol },
          cell: { userEnteredFormat: {
            backgroundColor: lblue,
            textFormat: { fontSize: 10, bold: true },
            horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
          }},
          fields: 'userEnteredFormat'
        }
      });

      // Per-server subtotal data rows
      serverOrder.forEach((srv, si) => {
        const rowIdx   = subDataStartIdx + si;
        const isDown   = downServers.includes(srv);
        const bgColor  = isDown ? red : orange;
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: startCol, endColumnIndex: endCol },
            cell: { userEnteredFormat: {
              backgroundColor: bgColor,
              textFormat: { bold: true },
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }},
            fields: 'userEnteredFormat'
          }
        });
        requests.push({
          updateBorders: {
            range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: startCol, endColumnIndex: endCol },
            top: thinB, bottom: thinB, left: thinB, right: thinB,
            innerVertical: thinB
          }
        });
      });
    }

    await _sheetsPost(`${this.spreadsheetId}:batchUpdate`, token, { requests });
  }

  // ── Create the "Global IP Stats" sheet ────────────────────
  // Layout:
  //   Row 1 : "DROP NUMBER"  | (empty) | Drop1 | Drop2 | Drop3 …   (merged per drop col)
  //   Row 2 : "DROP DATE/TIME"| (empty) | date  | date  | date …
  //   Row 3 : "SERVER"        | "IP"    | OUT   | OUT   | OUT  …
  //   Row 4+ : one row per IP
  //
  // Columns:
  //   col 0 (A) = SERVER
  //   col 1 (B) = IP
  //   col 2+    = one column per sequential drop number
  //
  // The sheet is created with frozen rows 1-3 and frozen cols A-B.
  async _createGlobalIpStatsSheet(token) {
    const SHEET_NAME = 'Global IP Stats';
    await _sheetsPost(`${this.spreadsheetId}:batchUpdate`, token, {
      requests: [{
        addSheet: {
          properties: {
            title: SHEET_NAME,
            gridProperties: {
              frozenRowCount   : 3,
              frozenColumnCount: 2,
              columnCount      : 152,  // 2 fixed + 150 drop columns
              rowCount         : 500
            }
          }
        }
      }]
    });

    // Write the static header labels in A1:B3
    await _sheetsPut(
      `${this.spreadsheetId}/values/${encodeURIComponent("'Global IP Stats'!A1:B3")}?valueInputOption=RAW`,
      token,
      { values: [
          ['DROP NUMBER',    ''],
          ['DROP DATE/TIME', ''],
          ['SERVER',         'IP']
        ] }
    );

    // Format the fixed-column header area (A1:B3)
    const sheetId = await _getSheetId(this.spreadsheetId, SHEET_NAME, token);
    await this._formatGlobalIpStatsHeaders(sheetId, token);

    console.log('[Sheets] ✅ Created "Global IP Stats" sheet');
  }

  // ── Format the header rows of Global IP Stats ─────────────
  async _formatGlobalIpStatsHeaders(sheetId, token) {
    const darkBlue = { red: 0.13, green: 0.27, blue: 0.60 };
    const midBlue  = { red: 0.26, green: 0.52, blue: 0.96 };
    const lblue    = { red: 0.85, green: 0.92, blue: 0.99 };
    const white    = { red: 1,    green: 1,    blue: 1    };
    const border   = { style: 'SOLID', width: 2, color: midBlue };

    await _sheetsPost(`${this.spreadsheetId}:batchUpdate`, token, {
      requests: [
        // Row 1 A:B — dark blue, white bold text
        { repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
            cell: { userEnteredFormat: {
              backgroundColor: darkBlue,
              textFormat: { foregroundColor: white, bold: true, fontSize: 11 },
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }},
            fields: 'userEnteredFormat' } },
        // Row 2 A:B — mid blue, white bold text
        { repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 },
            cell: { userEnteredFormat: {
              backgroundColor: midBlue,
              textFormat: { foregroundColor: white, bold: true, fontSize: 10 },
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }},
            fields: 'userEnteredFormat' } },
        // Row 3 A:B — light blue, bold text
        { repeatCell: {
            range: { sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 },
            cell: { userEnteredFormat: {
              backgroundColor: lblue,
              textFormat: { bold: true, fontSize: 10 },
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }},
            fields: 'userEnteredFormat' } },
        // Border A1:B3
        { updateBorders: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 },
            top: border, bottom: border, left: border, right: border,
            innerVertical: { style: 'SOLID', width: 1, color: midBlue },
            innerHorizontal: { style: 'SOLID', width: 1, color: midBlue } } }
      ]
    });
  }

  // ── Update Global IP Stats for one drop ───────────────────
  //
  // KEY RULE: Google Sheets range notation for sheet names with spaces uses
  // single-quoted names: 'Global IP Stats'!A1  — NOT encodeURIComponent.
  // encodeURIComponent is only for the URL path segment (after /values/).
  // Here we keep the sheet name raw inside range strings, and only
  // URL-encode the overall path segment where required by the REST API.
  //
  // Algorithm:
  //   1. Read row 1 to count existing drop columns → determine next col index.
  //   2. Read A4:B500 to build ip→row map for existing IPs.
  //   3. Ensure enough columns exist.
  //   4. Write all values in ONE batchUpdate values call (headers + data).
  //   5. Format header + data rows in ONE batchUpdate formatting call.
  async _updateGlobalIpStats(dropNumber, ipResults, dateTime, token, toleranceRate = 0) {
    const SHEET_NAME  = 'Global IP Stats';
    const FIXED_COLS  = 2;  // SERVER(0) + IP(1)

    // Helper: build a properly quoted Sheets range string.
    // Sheet names with spaces must be wrapped in single quotes in A1 notation.
    const range = (r) => `'${SHEET_NAME}'!${r}`;

    // ── Step 1: count existing drop columns ───────────────────
    // Read row 1; the API returns only as many cells as have content.
    let headerRow1 = [];
    try {
      const r = await _sheetsGet(
        `${this.spreadsheetId}/values/${encodeURIComponent("'" + SHEET_NAME + "'!1:1")}`,
        token
      );
      headerRow1 = (r.values && r.values[0]) ? r.values[0] : [];
    } catch(_) {}

    const existingDropCols  = Math.max(0, headerRow1.length - FIXED_COLS);
    const newDropColIndex   = FIXED_COLS + existingDropCols;   // 0-based
    const newDropColLetter  = _col(newDropColIndex);
    const seqDropLabel      = `Drop${existingDropCols + 1}`;

    // ── Step 2: read existing IP rows ─────────────────────────
    let existingIpRows = [];
    try {
      const r = await _sheetsGet(
        `${this.spreadsheetId}/values/${encodeURIComponent("'" + SHEET_NAME + "'!A4:B500")}`,
        token
      );
      existingIpRows = r.values || [];
    } catch(_) {}

    // ip → 0-based index in existingIpRows (sheet row = idx + 4, 1-based)
    const ipRowMap = {};
    existingIpRows.forEach((row, idx) => {
      const ip = (row[1] || '').trim();
      if (ip) ipRowMap[ip] = idx;
    });

    // ── Step 3: ensure enough columns exist ───────────────────
    await this._ensureColumns(SHEET_NAME, newDropColIndex + 10, token);

    // ── Step 4: build all value writes, send in ONE batchUpdate ─
    // This avoids hitting Google's per-minute write quota (60 req/min)
    // by collapsing headers + existing-IP updates + new-IP rows into
    // a single values:batchUpdate call.
    const valueData = [];  // array of { range, values } for batchUpdate

    // 4a. Drop column headers (rows 1-3 in the new column)
    valueData.push({
      range : range(`${newDropColLetter}1:${newDropColLetter}3`),
      values: [[seqDropLabel], [dateTime], ['OUT']]
    });

    // 4b. Separate existing IPs (update) from new IPs (append)
    const cellUpdates = [];  // { sheetRow (1-based), outVal }
    const newIpRows   = [];  // { server, ip, outVal }

    for (const r of ipResults) {
      const outVal = r.serverDown ? 'DOWN' : (r.reallySent === null ? '' : r.reallySent);
      if (r.ip in ipRowMap) {
        cellUpdates.push({ sheetRow: ipRowMap[r.ip] + 4, outVal });
      } else {
        newIpRows.push({ server: r.server || '', ip: r.ip, outVal });
      }
    }

    // 4c. Updates for IPs that already exist in the sheet
    cellUpdates.forEach(({ sheetRow, outVal }) => {
      valueData.push({
        range : range(`${newDropColLetter}${sheetRow}`),
        values: [[outVal]]
      });
    });

    // 4d. New IP rows — append below existing data
    if (newIpRows.length > 0) {
      const emptyPrevDrops  = Array(existingDropCols).fill('');
      const appendStartRow  = 4 + existingIpRows.length;
      const appendEndCol    = _col(newDropColIndex);

      newIpRows.forEach(({ server, ip, outVal }, i) => {
        const sheetRow = appendStartRow + i;
        valueData.push({
          range : range(`A${sheetRow}:${appendEndCol}${sheetRow}`),
          values: [[server, ip, ...emptyPrevDrops, outVal]]
        });
        // Keep map up-to-date for formatting step
        ipRowMap[ip] = existingIpRows.length + i;
      });
    }

    // Send all value writes in one request
    const batchValResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values:batchUpdate`,
      {
        method : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body   : JSON.stringify({ valueInputOption: 'RAW', data: valueData })
      }
    );
    if (!batchValResp.ok) {
      const errText = await batchValResp.text().catch(() => '(unreadable)');
      throw new Error(`Global IP Stats values:batchUpdate failed: ${errText}`);
    }

    // ── Step 5: format everything in ONE batchUpdate ──────────
    const sheetId = await _getSheetId(this.spreadsheetId, SHEET_NAME, token);
    const totalIpRows      = existingIpRows.length + newIpRows.length;
    const grey             = { red: 0.85, green: 0.85, blue: 0.85 };
    const bgLight          = { red: 0.97, green: 0.97, blue: 0.97 };
    const thinB            = { style: 'SOLID', width: 1, color: grey };

    const fmtRequests = [];

    // 5a. Format new drop column header (rows 1-3)
    const darkBlue = { red: 0.13, green: 0.27, blue: 0.60 };
    const midBlue  = { red: 0.26, green: 0.52, blue: 0.96 };
    const lblue    = { red: 0.85, green: 0.92, blue: 0.99 };
    const white    = { red: 1,    green: 1,    blue: 1    };
    const boldBorder = { style: 'SOLID', width: 2, color: midBlue };

    fmtRequests.push(
      { repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1,
            startColumnIndex: newDropColIndex, endColumnIndex: newDropColIndex + 1 },
          cell: { userEnteredFormat: {
            backgroundColor: darkBlue,
            textFormat: { foregroundColor: white, bold: true, fontSize: 11 },
            horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
          }},
          fields: 'userEnteredFormat' } },
      { repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 2,
            startColumnIndex: newDropColIndex, endColumnIndex: newDropColIndex + 1 },
          cell: { userEnteredFormat: {
            backgroundColor: midBlue,
            textFormat: { foregroundColor: white, bold: true, fontSize: 9 },
            horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
          }},
          fields: 'userEnteredFormat' } },
      { repeatCell: {
          range: { sheetId, startRowIndex: 2, endRowIndex: 3,
            startColumnIndex: newDropColIndex, endColumnIndex: newDropColIndex + 1 },
          cell: { userEnteredFormat: {
            backgroundColor: lblue,
            textFormat: { bold: true, fontSize: 10 },
            horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
          }},
          fields: 'userEnteredFormat' } },
      { updateBorders: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 3,
            startColumnIndex: newDropColIndex, endColumnIndex: newDropColIndex + 1 },
          top: boldBorder, bottom: boldBorder, left: boldBorder, right: boldBorder,
          innerHorizontal: { style: 'SOLID', width: 1, color: midBlue } } }
    );

    // 5b. Format data rows for the new drop column
    if (totalIpRows > 0) {
      fmtRequests.push(
        { repeatCell: {
            range: { sheetId, startRowIndex: 3, endRowIndex: 3 + totalIpRows,
              startColumnIndex: newDropColIndex, endColumnIndex: newDropColIndex + 1 },
            cell: { userEnteredFormat: {
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }},
            fields: 'userEnteredFormat' } },
        { updateBorders: {
            range: { sheetId, startRowIndex: 3, endRowIndex: 3 + totalIpRows,
              startColumnIndex: newDropColIndex, endColumnIndex: newDropColIndex + 1 },
            top: thinB, bottom: thinB, left: thinB, right: thinB,
            innerHorizontal: thinB } }
      );

      // Per-IP colour: yellow = failed threshold, red = server down
      const yellow        = { red: 1.0, green: 0.96, blue: 0.6  };
      const red           = { red: 1.0, green: 0.82, blue: 0.82 };
      const passThreshold = 100 - toleranceRate;

      ipResults.forEach(r => {
        if (!(r.ip in ipRowMap)) return;
        // ipRowMap value is the 0-based index inside existingIpRows array;
        // sheet data rows start at row index 3 (0-based), so:
        const sheetRowIdx = ipRowMap[r.ip] + 3;
        let bg = null;
        if (r.serverDown) {
          bg = red;
        } else {
          const deliveryRate = r.target > 0 ? (r.reallySent / r.target) * 100 : 100;
          if (deliveryRate < passThreshold) bg = yellow;
        }
        if (bg) {
          fmtRequests.push({
            repeatCell: {
              range: { sheetId,
                startRowIndex   : sheetRowIdx,
                endRowIndex     : sheetRowIdx + 1,
                startColumnIndex: newDropColIndex,
                endColumnIndex  : newDropColIndex + 1 },
              cell  : { userEnteredFormat: { backgroundColor: bg } },
              fields : 'userEnteredFormat.backgroundColor'
            }
          });
        }
      });
    }

    // 5c. Format newly-appended IP rows in cols A-B
    if (newIpRows.length > 0) {
      const appendStartRowIdx = 3 + existingIpRows.length;  // 0-based
      fmtRequests.push(
        { repeatCell: {
            range: { sheetId,
              startRowIndex: appendStartRowIdx,
              endRowIndex  : appendStartRowIdx + newIpRows.length,
              startColumnIndex: 0, endColumnIndex: 2 },
            cell: { userEnteredFormat: {
              backgroundColor: bgLight,
              horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
              textFormat: { bold: false }
            }},
            fields: 'userEnteredFormat' } },
        { updateBorders: {
            range: { sheetId,
              startRowIndex: appendStartRowIdx,
              endRowIndex  : appendStartRowIdx + newIpRows.length,
              startColumnIndex: 0, endColumnIndex: 2 },
            top: thinB, bottom: thinB, left: thinB, right: thinB,
            innerHorizontal: thinB } }
      );
    }

    await _sheetsPost(`${this.spreadsheetId}:batchUpdate`, token, { requests: fmtRequests });

    console.log(`[Sheets] ✅ Global IP Stats updated — ${seqDropLabel}, ${ipResults.length} IPs`);
  }

}