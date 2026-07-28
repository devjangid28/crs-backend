const http = require('http');
const net = require('net');
const dns = require('dns');
const { XMLParser } = require('fast-xml-parser');
const path = require('path');
const fs = require('fs');

const ENV_PATH = path.join(__dirname, '../../.env');

function getTallyConfig() {
  return {
    host: process.env.TALLY_HOST || 'localhost',
    port: parseInt(process.env.TALLY_PORT, 10) || 9000,
    company: process.env.TALLY_COMPANY || '',
    pollIntervalMs: parseInt(process.env.TALLY_POLL_INTERVAL_MS, 10) || 300000,
  };
}

function persistConfig(updates) {
  try {
    let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }
    fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
    console.log('[TallyService] Config persisted to .env');
  } catch (err) {
    console.error('[TallyService] Failed to persist config:', err.message);
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    name === 'VOUCHER' ||
    name === 'BATCHALLOCATIONS.LIST' ||
    name === 'ALLLEDGERENTRIES.LIST' ||
    name === 'INVENTORYENTRIES.LIST' ||
    name === 'SERIALNUMBERLIST' ||
    name === 'COMPANY' ||
    name === 'LEDGER' ||
    name === 'ACCOUNT' ||
    name === 'STOCKITEM',
});

let poller = null;
let lastSyncDate = null;

function log(tag, msg) {
  console.log(`[TallyService ${new Date().toISOString()}] [${tag}] ${msg}`);
}

function logError(msg, err) {
  if (err && typeof err === 'object') {
    console.error(`[TallyService ${new Date().toISOString()}] [ERROR] ${msg}`);
    console.error(`  error.code    = ${err.code}`);
    console.error(`  error.errno   = ${err.errno}`);
    console.error(`  error.syscall = ${err.syscall}`);
    console.error(`  error.address = ${err.address}`);
    console.error(`  error.port    = ${err.port}`);
    console.error(`  error.message = ${err.message}`);
    if (err.stack) console.error(`  error.stack   = ${err.stack.split('\n').slice(0, 3).join(' | ')}`);
  } else {
    console.error(`[TallyService ${new Date().toISOString()}] [ERROR] ${msg} ${err || ''}`);
  }
}

function getBackendLocalIP() {
  try {
    const interfaces = require('os').networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  } catch (_) {}
  return 'unknown';
}

function buildCompanyListRequest() {
  return `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Accounts</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
}

function buildListCompaniesRequest() {
  const cfg = getTallyConfig();
  let companyTag = '';
  if (cfg.company && cfg.company.trim()) {
    companyTag = `<SVCURRENTCOMPANY>${cfg.company}</SVCURRENTCOMPANY>`;
  }
  return `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyTag}</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
}

function buildExportRequest(fromDate, companyName) {
  const cfg = getTallyConfig();
  const dateStr = fromDate || '01-Apr-2024';
  const company = companyName || cfg.company || '';

  let companyTag = '';
  if (company && company.trim()) {
    companyTag = `<SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>`;
  }

  return `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyTag}<SVFROMDATE>${dateStr}</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
}

function rawHttpRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: headers || {},
      timeout: 15000,
    };

    log('REQ', `${method} ${url}`);
    log('REQ', `Options: hostname=${options.hostname}, port=${options.port}, path=${options.path}`);
    log('REQ', `Headers: ${JSON.stringify(options.headers)}`);
    if (body) log('REQ', `Body (${body.length} bytes): ${body.substring(0, 500)}`);

    const startTime = Date.now();
    const req = http.request(options, (res) => {
      const elapsed = Date.now() - startTime;
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        log('RES', `Status: ${res.statusCode} (${elapsed}ms)`);
        log('RES', `Response Headers: ${JSON.stringify(res.headers)}`);
        log('RES', `Response Body (${data.length} bytes): ${data.substring(0, 1000)}`);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data, elapsed });
      });
    });

    req.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      logError(`HTTP ${method} ${url} failed after ${elapsed}ms`, err);
      reject(err);
    });

    req.on('timeout', () => {
      const elapsed = Date.now() - startTime;
      req.destroy();
      const timeoutErr = new Error(`Timeout after ${elapsed}ms connecting to ${url}`);
      timeoutErr.code = 'ETIMEDOUT';
      timeoutErr.address = urlObj.hostname;
      timeoutErr.port = parseInt(urlObj.port, 10);
      logError(`HTTP ${method} ${url} timed out after ${elapsed}ms`, timeoutErr);
      reject(timeoutErr);
    });

    if (body) req.write(body);
    req.end();
  });
}

function testTcpSocket(host, port) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on('connect', () => {
      const elapsed = Date.now() - startTime;
      socket.destroy();
      log('TCP', `Socket connected to ${host}:${port} in ${elapsed}ms`);
      resolve({ connected: true, elapsed });
    });

    socket.on('timeout', () => {
      const elapsed = Date.now() - startTime;
      socket.destroy();
      log('TCP', `Socket timeout to ${host}:${port} after ${elapsed}ms`);
      resolve({ connected: false, error: 'ETIMEDOUT', elapsed });
    });

    socket.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      logError(`TCP socket error to ${host}:${port}`, err);
      resolve({ connected: false, error: err.code || err.message, elapsed });
    });

    socket.connect(port, host);
  });
}

function resolveDns(host) {
  return new Promise((resolve) => {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      log('DNS', `${host} is already an IP, skipping lookup`);
      resolve({ resolved: host, isIp: true });
      return;
    }
    dns.lookup(host, (err, address, family) => {
      if (err) {
        logError(`DNS lookup failed for ${host}`, err);
        resolve({ resolved: null, error: err.message });
      } else {
        log('DNS', `${host} resolved to ${address} (IPv${family})`);
        resolve({ resolved: address, isIp: false, family });
      }
    });
  });
}

function extractCompanies(xmlBody) {
  const companies = [];
  try {
    const parsed = parser.parse(xmlBody);

    log('PARSE', `Parsed response keys: ${JSON.stringify(Object.keys(parsed || {}))}`);

    const body = parsed?.ENVELOPE?.BODY;
    if (body) {
      log('PARSE', `BODY keys: ${JSON.stringify(Object.keys(body))}`);
    }

    let messages = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
    if (!messages) messages = body?.DATA?.TALLYMESSAGE;
    if (!messages) {
      log('PARSE', 'No TALLYMESSAGE found in response');
      return companies;
    }

    const msgArr = Array.isArray(messages) ? messages : [messages];
    log('PARSE', `Found ${msgArr.length} TALLYMESSAGE entries`);

    for (const msg of msgArr) {
      const companyList = msg?.COMPANY || msg?.LEDGER || msg?.ACCOUNT;
      if (!companyList) continue;

      const items = Array.isArray(companyList) ? companyList : [companyList];
      for (const item of items) {
        const name = item?.NAME || item?.NAME?.['#text'] || item?.['@_NAME'] || '';
        if (name && name.trim()) {
          companies.push(name.trim());
          log('PARSE', `Found company/account: ${name.trim()}`);
        }
      }
    }
  } catch (err) {
    logError('Error extracting companies', err);
  }
  return companies;
}

function extractAccounts(xmlBody) {
  const accounts = [];
  try {
    const parsed = parser.parse(xmlBody);
    const body = parsed?.ENVELOPE?.BODY;

    let messages = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
    if (!messages) messages = body?.DATA?.TALLYMESSAGE;
    if (!messages) return accounts;

    const msgArr = Array.isArray(messages) ? messages : [messages];

    for (const msg of msgArr) {
      const ledger = msg?.LEDGER;
      const account = msg?.ACCOUNT;
      const item = ledger || account;
      if (!item) continue;

      const items = Array.isArray(item) ? item : [item];
      for (const entry of items) {
        const name = entry?.NAME || entry?.['@_NAME'] || '';
        if (name) accounts.push(name);
      }
    }
  } catch (err) {
    logError('Error extracting accounts', err);
  }
  return accounts;
}

function deepParseResponse(xmlBody) {
  try {
    const parsed = parser.parse(xmlBody);
    return parsed;
  } catch (err) {
    logError('XML parse failed', err);
    return null;
  }
}

async function debug() {
  const cfg = getTallyConfig();
  const backendIP = getBackendLocalIP();
  const url = `http://${cfg.host}:${cfg.port}`;
  const isLocalhost = ['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(cfg.host);
  const isDifferentMachine = !isLocalhost;

  const result = {
    timestamp: new Date().toISOString(),
    backendIP,
    configuredHost: cfg.host,
    configuredPort: cfg.port,
    configuredCompany: cfg.company || '(empty)',
    finalUrl: url,
    isLocalhost,
    isDifferentMachine,
    warning: null,
  };

  if (isDifferentMachine && backendIP !== 'unknown') {
    log('DEBUG', `Backend IP: ${backendIP}`);
    log('DEBUG', `Tally Host: ${cfg.host}`);
  }

  if (isDifferentMachine && ['localhost', '127.0.0.1'].includes(cfg.host)) {
    result.warning = `Host is "${cfg.host}" but backend runs on ${backendIP}. localhost will never reach another computer. Change Host to the Tally PC's IP address.`;
    log('WARN', result.warning);
  }

  log('DEBUG', `--- Step 1: DNS Resolution ---`);
  const dnsResult = await resolveDns(cfg.host);
  result.dns = dnsResult;

  log('DEBUG', `--- Step 2: TCP Socket Test (${cfg.host}:${cfg.port}) ---`);
  const tcpResult = await testTcpSocket(cfg.host, cfg.port);
  result.tcp = tcpResult;

  log('DEBUG', `--- Step 3: HTTP GET ${url} ---`);
  try {
    const httpResult = await rawHttpRequest(url, 'GET', { 'User-Agent': 'CRS-Backend-Diagnostic' });
    result.http = {
      reachable: true,
      status: httpResult.statusCode,
      headers: httpResult.headers,
      body: httpResult.body,
      elapsed: httpResult.elapsed,
    };
    result.tallyServerRunning = httpResult.body.includes('TallyPrime Server is Running') || httpResult.body.includes('Tally');
  } catch (err) {
    result.http = {
      reachable: false,
      error: {
        code: err.code,
        errno: err.errno,
        syscall: err.syscall,
        address: err.address,
        port: err.port,
        message: err.message,
      },
    };
    result.tallyServerRunning = false;
  }

  log('DEBUG', `--- Step 4: XML POST (Day Book - auto-detect company) ---`);
  try {
    const xml = buildListCompaniesRequest();
    const xmlResult = await rawHttpRequest(url, 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml);
    const parsed = deepParseResponse(xmlResult.body);
    const respBody = parsed?.ENVELOPE?.BODY;
    const messages = respBody?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE || respBody?.DATA?.TALLYMESSAGE;
    let detectedCompany = null;
    let voucherCount = 0;
    if (messages) {
      const msgArr = Array.isArray(messages) ? messages : [messages];
      for (const msg of msgArr) {
        if (msg?.VOUCHER) voucherCount++;
        if (msg?.COMPANY?.REMOTECMPINFO?.LIST?.REMOTECMPNAME) {
          detectedCompany = msg.COMPANY.REMOTECMPINFO.LIST.REMOTECMPNAME;
        }
      }
    }
    result.dayBook = {
      status: xmlResult.statusCode,
      elapsed: xmlResult.elapsed,
      voucherCount,
      detectedCompany: detectedCompany || cfg.company || null,
      rawXml: xmlResult.body.substring(0, 3000),
    };
    log('DEBUG', `Day Book: ${voucherCount} vouchers, company: ${detectedCompany || 'not detected'}`);
  } catch (err) {
    result.dayBook = { error: err.message, code: err.code };
    logError('Day Book request failed', err);
  }

  log('DEBUG', `--- Debug complete ---`);
  return result;
}

async function testConnection() {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const result = { reachable: false, companyFound: false, company: cfg.company || '(not set)', companies: [], rawXml: '', error: null };

  log('TEST', `Testing connection to ${url}`);

  try {
    const httpResult = await rawHttpRequest(url, 'GET', { 'User-Agent': 'CRS-Backend' });
    result.reachable = true;
    result.httpStatus = httpResult.statusCode;
    result.pingBody = httpResult.body;

    if (httpResult.body.includes('TallyPrime Server is Running') || httpResult.body.includes('Tally')) {
      log('TEST', 'Tally server confirmed running');
    }
  } catch (err) {
    result.error = err.message;
    result.errorDetail = { code: err.code, errno: err.errno, syscall: err.syscall, address: err.address, port: err.port };
    logError('Test connection failed', err);
    return result;
  }

  log('TEST', '--- Step 2: Day Book (auto-detect company + data) ---');
  try {
    const xml = buildListCompaniesRequest();
    const xmlResult = await rawHttpRequest(url, 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml);
    result.rawXml = xmlResult.body.substring(0, 2000);

    const parsed = deepParseResponse(xmlResult.body);
    const respBody = parsed?.ENVELOPE?.BODY;

    const lineError = respBody?.LINEERROR || parsed?.RESPONSE?.LINEERROR;
    if (lineError) {
      result.error = lineError;
      log('TEST', 'Tally error: ' + lineError);
      return result;
    }

    const messages = respBody?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE || respBody?.DATA?.TALLYMESSAGE;
    if (messages) {
      const msgArr = Array.isArray(messages) ? messages : [messages];
      let companyDetected = null;
      let voucherCount = 0;

      for (const msg of msgArr) {
        const vouchers = msg?.VOUCHER;
        if (vouchers) {
          voucherCount++;
          if (!companyDetected) {
            const vchArr = Array.isArray(vouchers) ? vouchers : [vouchers];
            for (const vch of vchArr) {
              if (vch?.PARTYNAME || vch?.VOUCHERNUMBER) {
                companyDetected = true;
              }
            }
          }
        }
        const company = msg?.COMPANY;
        if (company?.REMOTECMPINFO?.LIST) {
          const cmpList = company.REMOTECMPINFO.LIST;
          result.company = cmpList.REMOTECMPNAME || cfg.company || '(detected)';
          result.companyFound = true;
        }
      }

      if (!result.companyFound && companyDetected) {
        result.companyFound = true;
        result.company = cfg.company || '(active)';
      }

      result.voucherCount = voucherCount;
      log('TEST', 'Day Book vouchers found: ' + voucherCount + ', Company: ' + result.company);
    } else {
      result.dataAccessError = 'Tally responded but no data found. Response: ' + xmlResult.body.substring(0, 300);
      log('TEST', result.dataAccessError);
    }
  } catch (err) {
    result.error = err.message;
    result.errorDetail = { code: err.code, errno: err.errno, syscall: err.syscall, address: err.address, port: err.port };
    logError('Day Book test failed', err);
  }

  return result;
}

function extractSerialNumbers(xmlResult) {
  const serials = [];
  try {
    const body = xmlResult?.ENVELOPE?.BODY;
    let messages = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
    if (!messages) messages = body?.DATA?.TALLYMESSAGE;
    if (!messages) {
      log('EXTRACT', 'No TALLYMESSAGE found in sales response');
      log('EXTRACT', `Response body keys: ${body ? JSON.stringify(Object.keys(body)) : 'no BODY'}`);
      return serials;
    }

    const msgArr = Array.isArray(messages) ? messages : [messages];
    log('EXTRACT', `Processing ${msgArr.length} TALLYMESSAGE entries`);

    for (const msg of msgArr) {
      const vouchers = msg?.VOUCHER;
      if (!vouchers) continue;

      const voucherArr = Array.isArray(vouchers) ? vouchers : [vouchers];

      for (const v of voucherArr) {
        const vchType = v?.VOUCHERTYPE || v?.['@_VCHTYPE'] || '';
        const voucherNumber = v?.VOUCHERNUMBER || '';
        const voucherDate = v?.DATE || '';
        const partyName = v?.PARTYNAME || v?.PARTYLEDGERNAME || '';

        const invAll = v?.['ALLINVENTORYENTRIES.LIST'] || v?.INVENTORYENTRIES?.LIST || [];
        const invArr = Array.isArray(invAll) ? invAll : [invAll];

        for (const inv of invArr) {
          const itemName = inv?.STOCKITEMNAME || '';

          const batches = inv?.['BATCHALLOCATIONS.LIST'] || inv?.BATCHALLOCATIONS?.LIST || [];
          const batchArr = Array.isArray(batches) ? batches : [batches];

          for (const batch of batchArr) {
            const batchName = batch?.BATCHNAME || '';
            let serialNos = [];

            if (batch?.SERIALNUMBERLIST) {
              serialNos = batch.SERIALNUMBERLIST.SERIALNUMBER || [];
            }

            if (!serialNos.length && batch?.ADDITIONALNAME) {
              const maybeSerial = batch.ADDITIONALNAME;
              if (maybeSerial && /^[A-Z0-9\-]+$/i.test(maybeSerial)) serialNos = [maybeSerial];
            }

            if (!serialNos.length && batchName && batchName !== 'Primary' && batchName.trim()) {
              serialNos = [batchName];
            }

            const serialArr = Array.isArray(serialNos) ? serialNos : [serialNos];

            for (const serial of serialArr) {
              if (serial && serial.trim()) {
                serials.push({ voucher_number: voucherNumber, voucher_date: voucherDate, stock_item_name: itemName, batch_name: batchName, serial_number: serial.trim(), party_name: partyName, voucher_type: vchType });
                log('EXTRACT', `Found serial: ${serial.trim()} (voucher: ${voucherNumber}, item: ${itemName})`);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    logError('Error extracting serial numbers', err);
  }
  return serials;
}

function extractCompanyName(xmlBody) {
  try {
    const match = xmlBody.match(/SVCURRENTCOMPANY>([^<]+)</);
    if (match && match[1].trim()) return match[1].trim();
  } catch (_) {}
  return null;
}

async function discoverCompanies(pool) {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const discovered = new Set();

  if (cfg.company && cfg.company.trim() && cfg.company.trim() !== '(auto-detect)') {
    discovered.add(cfg.company.trim());
    log('DISCOVER', `Configured company: ${cfg.company.trim()}`);
  }

  const knownRows = await pool.query(`SELECT DISTINCT company_name FROM tally_sync_log WHERE company_name IS NOT NULL AND company_name != ''`).catch(() => ({ rows: [] }));
  for (const row of knownRows.rows) {
    if (row.company_name) discovered.add(row.company_name);
  }

  log('DISCOVER', `Known companies: ${[...discovered].join(', ') || '(none)'}`);

  const probeXml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>01-Apr-2024</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

  for (const companyName of discovered) {
    log('DISCOVER', `Probing company: ${companyName}`);
    const xml = buildExportRequest(lastSyncDate, companyName);
    try {
      const response = await rawHttpRequest(url, 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml);
      if (response.body && response.body.length > 1000) {
        const detectedCompany = extractCompanyName(response.body) || companyName;
        if (detectedCompany !== companyName) {
          log('DISCOVER', `Company name mismatch: configured="${companyName}" actual="${detectedCompany}"`);
          discovered.add(detectedCompany);
        }
        log('DISCOVER', `Company "${companyName}" responded with ${response.body.length} bytes - OK`);
      } else {
        log('DISCOVER', `Company "${companyName}" returned ${response.body?.length || 0} bytes - may not be loaded`);
      }
    } catch (err) {
      logError(`Probe failed for company "${companyName}"`, err);
    }
  }

  const companies = [...discovered];
  log('DISCOVER', `Total companies to sync: ${companies.length} - ${companies.join(', ')}`);
  return companies;
}

async function fetchRecentSales(fromDate, companyName) {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const xml = buildExportRequest(fromDate || lastSyncDate, companyName);

  log('FETCH', `Fetching sales from Tally`);
  log('FETCH', `Company: ${companyName || cfg.company || '(not set)'}`);

  const response = await rawHttpRequest(url, 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml);

  log('FETCH', `Response status: ${response.statusCode}, length: ${response.body.length}`);

  if (!response.body || response.body.trim().length === 0) {
    logError('Tally returned empty response for sales export');
    return [];
  }

  const parsed = parser.parse(response.body);
  const serials = extractSerialNumbers(parsed);

  const detectedCompany = extractCompanyName(response.body);
  for (const s of serials) {
    if (!s.company_name && detectedCompany) s.company_name = detectedCompany;
  }

  return serials;
}

async function syncSales(pool) {
  log('SYNC', 'Starting sync...');

  const companies = await discoverCompanies(pool);
  if (!companies.length) {
    log('SYNC', 'No companies configured or discovered.');
    return { synced: 0, skipped: 0, errors: 0, serials: [], companies: [], message: 'No Tally companies found. Set TALLY_COMPANY in config.' };
  }

  let allSerials = [];
  const companyResults = {};

  for (const company of companies) {
    log('SYNC', `--- Syncing company: ${company} ---`);
    try {
      const serials = await fetchRecentSales(lastSyncDate, company);
      companyResults[company] = serials.length;
      allSerials = allSerials.concat(serials);
      log('SYNC', `Company "${company}": ${serials.length} serial(s) found`);
    } catch (err) {
      companyResults[company] = 0;
      logError(`Failed to fetch sales for company "${company}"`, err);
    }
  }

  if (!allSerials.length) {
    log('SYNC', 'No serial numbers found in any company sales.');
    return { synced: 0, skipped: 0, errors: 0, serials: [], companies: companyResults, message: 'No serial numbers found in Tally sales vouchers across ' + companies.length + ' company/companies.' };
  }

  log('SYNC', `Found ${allSerials.length} total serial number(s) across ${companies.length} company/companies`);
  let synced = 0, skipped = 0, errors = 0;

  for (const entry of allSerials) {
    try {
      const existing = await pool.query('SELECT id, status FROM inventory_items WHERE serial_number = $1', [entry.serial_number]);
      if (!existing.rows.length) {
        skipped++;
        await pool.query(`INSERT INTO tally_sync_log (voucher_number, voucher_date, stock_item_name, batch_name, serial_number, company_name, sync_status, error_message, raw_data) VALUES ($1, $2, $3, $4, $5, $6, 'no_match', 'No matching inventory item found', $7)`, [entry.voucher_number, entry.voucher_date, entry.stock_item_name, entry.batch_name, entry.serial_number, entry.company_name || null, JSON.stringify(entry)]).catch(e => logError('DB log insert error', e));
        continue;
      }

      const inv = existing.rows[0];
      if (inv.status === 'Sold') { skipped++; continue; }

      const alreadySynced = await pool.query('SELECT id FROM tally_sync_log WHERE serial_number = $1 AND sync_status = $2', [entry.serial_number, 'synced']);
      if (alreadySynced.rows.length) { skipped++; continue; }

      await pool.query(`UPDATE inventory_items SET status = 'Sold', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status != 'Sold'`, [inv.id]);
      await pool.query(`INSERT INTO inventory_history (item_id, action, performed_by, remarks) VALUES ($1, 'status_change', 'Tally Auto-Sync', $2)`, [inv.id, `Auto-marked Sold via Tally (${entry.company_name || 'unknown'}). Voucher: ${entry.voucher_number}`]);
      await pool.query(`INSERT INTO tally_sync_log (voucher_number, voucher_date, stock_item_name, batch_name, serial_number, company_name, matched_inventory_id, sync_status, raw_data) VALUES ($1, $2, $3, $4, $5, $6, $7, 'synced', $8)`, [entry.voucher_number, entry.voucher_date, entry.stock_item_name, entry.batch_name, entry.serial_number, entry.company_name || null, inv.id, JSON.stringify(entry)]);
      synced++;
      log('SYNC', `Synced serial ${entry.serial_number} -> inventory #${inv.id} (${entry.company_name || 'unknown'})`);
    } catch (err) {
      errors++;
      logError(`Error syncing serial ${entry.serial_number}`, err);
      await pool.query(`INSERT INTO tally_sync_log (voucher_number, voucher_date, stock_item_name, batch_name, serial_number, company_name, sync_status, error_message, raw_data) VALUES ($1, $2, $3, $4, $5, $6, 'error', $7, $8)`, [entry.voucher_number, entry.voucher_date, entry.stock_item_name, entry.batch_name, entry.serial_number, entry.company_name || null, err.message, JSON.stringify(entry)]).catch(() => {});
    }
  }

  lastSyncDate = new Date().toISOString().split('T')[0];
  log('SYNC', `Complete: ${synced} synced, ${skipped} skipped, ${errors} errors across ${companies.length} company/companies`);
  return { synced, skipped, errors, serials: allSerials, companies: companyResults, message: `Sync complete: ${synced} synced, ${skipped} skipped, ${errors} errors across ${companies.length} company/companies` };
}

function startPoller(pool) {
  if (poller) clearInterval(poller);
  const cfg = getTallyConfig();
  log('POLLER', `Starting (interval: ${cfg.pollIntervalMs}ms = ${Math.round(cfg.pollIntervalMs / 60000)}min)`);
  poller = setInterval(async () => {
    try {
      log('POLLER', 'Running scheduled sync...');
      await syncSales(pool);
    } catch (err) {
      logError('Poller error', err);
    }
  }, cfg.pollIntervalMs);
}

function stopPoller() {
  if (poller) { clearInterval(poller); poller = null; log('POLLER', 'Stopped'); }
}

module.exports = {
  testConnection,
  fetchRecentSales,
  syncSales,
  startPoller,
  stopPoller,
  debug,
  rawHttpRequest,
  getTallyConfig,
  persistConfig,
  extractSerialNumbers,
  extractCompanyName,
  discoverCompanies,
  buildExportRequest,
  buildCompanyListRequest,
  buildListCompaniesRequest,
};
