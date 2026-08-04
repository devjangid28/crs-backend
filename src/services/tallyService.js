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
    salesVoucherType: process.env.TALLY_SALES_VOUCHER_TYPE || 'Sales',
    salesLedger: process.env.TALLY_SALES_LEDGER || 'Sales',
    cgstLedger: process.env.TALLY_CGST_LEDGER || 'Output CGST @9%',
    sgstLedger: process.env.TALLY_SGST_LEDGER || 'Output SGST @9%',
    igstLedger: process.env.TALLY_IGST_LEDGER || 'OUTPUT IGST @ 18%',
    bankLedger: process.env.TALLY_BANK_LEDGER || '',
    taxUnit: process.env.TALLY_TAX_UNIT || 'Gujarat Registration',
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
    name === 'ALLINVENTORYENTRIES.LIST' ||
    name === 'SERIALNUMBERLIST' ||
    name === 'COMPANY' ||
    name === 'LEDGER' ||
    name === 'ACCOUNT' ||
    name === 'STOCKITEM' ||
    name === 'STOCKGROUP' ||
    name === 'STOCKCATEGORY' ||
    name === 'BATCH' ||
    name === 'SERIALNUMBER',
});

let poller = null;
let lastSyncDate = null;
let lastConnectionStatus = { reachable: false, companyFound: false, lastChecked: null };
let companyInfoCache = null;
let companyInfoCacheAt = 0;

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

function rawHttpRequest(url, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const timeout = timeoutMs || 30000;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: headers || {},
      timeout: timeout,
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
    lastConnectionStatus = { reachable: true, companyFound: false, lastChecked: new Date().toISOString() };
  } catch (err) {
    result.error = err.message;
    result.errorDetail = { code: err.code, errno: err.errno, syscall: err.syscall, address: err.address, port: err.port };
    lastConnectionStatus = { reachable: false, companyFound: false, lastChecked: new Date().toISOString() };
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

      lastConnectionStatus = { reachable: true, companyFound: result.companyFound, lastChecked: new Date().toISOString() };
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

            if (!serialNos.length && batchName && batchName !== 'Primary' && !/^Primary\s*Batch$/i.test(batchName) && batchName.trim()) {
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
      const serialStr = String(entry.serial_number || '').trim();
      if (!serialStr || serialStr === 'Primary' || /^Primary\s*Batch$/i.test(serialStr)) {
        skipped++;
        continue;
      }

      const existing = await pool.query('SELECT id, status FROM inventory_items WHERE serial_number = $1', [serialStr]);
      if (!existing.rows.length) {
        skipped++;
        // Skip noise:
        // 1) This voucher+serial was already logged before (dedupe, so the 5-min
        //    poller does not re-add the same no_match entry every cycle).
        // 2) This serial was already pushed/synced by CRS itself (e.g. an invoice
        //    pushed to Tally) - Tally renumbers vouchers, so match by serial.
        const dupCheck = await pool.query(
          `SELECT id FROM tally_sync_log
           WHERE (sync_status = $1 AND voucher_number = $2 AND serial_number = $3)
              OR (serial_number = $3 AND sync_status IN ('pushed','synced'))
           LIMIT 1`,
          ['no_match', entry.voucher_number, serialStr]
        );
        if (dupCheck.rows.length) continue;
        await pool.query(`INSERT INTO tally_sync_log (voucher_number, voucher_date, stock_item_name, batch_name, serial_number, company_name, sync_status, error_message, raw_data) VALUES ($1, $2, $3, $4, $5, $6, 'no_match', 'No matching inventory item found', $7)`, [entry.voucher_number, entry.voucher_date, entry.stock_item_name, entry.batch_name, serialStr, entry.company_name || null, JSON.stringify(entry)]).catch(e => logError('DB log insert error', e));
        continue;
      }

      const inv = existing.rows[0];
      if (inv.status === 'Sold') { skipped++; continue; }

      const alreadySynced = await pool.query('SELECT id FROM tally_sync_log WHERE serial_number = $1 AND sync_status = $2', [serialStr, 'synced']);
      if (alreadySynced.rows.length) { skipped++; continue; }

      await pool.query(`UPDATE inventory_items SET status = 'Sold', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status != 'Sold'`, [inv.id]);
      await pool.query(`INSERT INTO inventory_history (inventory_item_id, action, performed_by, remarks) VALUES ($1, 'status_change', 'Tally Auto-Sync', $2)`, [inv.id, `Auto-marked Sold via Tally (${entry.company_name || 'unknown'}). Voucher: ${entry.voucher_number}`]);
      await pool.query(`INSERT INTO tally_sync_log (voucher_number, voucher_date, stock_item_name, batch_name, serial_number, company_name, matched_inventory_id, sync_status, raw_data) VALUES ($1, $2, $3, $4, $5, $6, $7, 'synced', $8)`, [entry.voucher_number, entry.voucher_date, entry.stock_item_name, entry.batch_name, serialStr, entry.company_name || null, inv.id, JSON.stringify(entry)]);
      synced++;
      log('SYNC', `Synced serial ${serialStr} -> inventory #${inv.id} (${entry.company_name || 'unknown'})`);
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

function escapeXml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildSalesVoucherXml(voucherData) {
  const cfg = getTallyConfig();
  let dateStr = voucherData.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (!/^\d{8}$/.test(dateStr)) {
    dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
  const partyName = escapeXml(voucherData.partyName || 'Walk-in Customer');
  const partyLedger = escapeXml(voucherData.partyLedger || voucherData.partyName || 'Walk-in Customer');
  const voucherNumber = escapeXml(voucherData.voucherNumber || '');
  const narration = escapeXml(voucherData.narration || 'Sales via CRS');
  const voucherType = escapeXml(voucherData.voucherType || cfg.salesVoucherType || 'Sales');
  const salesLedger = escapeXml(cfg.salesLedger || 'SALES @ 18%');
  const cgstLedger = escapeXml(voucherData.cgstLedger || cfg.cgstLedger || 'OUTPUT CGST @ 9%');
  const sgstLedger = escapeXml(voucherData.sgstLedger || cfg.sgstLedger || 'OUTPUT SGST @ 9%');
  const igstLedger = escapeXml(voucherData.igstLedger || cfg.igstLedger || 'OUTPUT IGST @ 18%');

  // Company (dispatch-from / our GSTIN) details
  const company = {
    name: voucherData.company?.name || '',
    gstin: voucherData.company?.gstin || '',
    state: voucherData.company?.state || '',
    pincode: voucherData.company?.pincode || '',
    place: voucherData.company?.place || '',
    country: voucherData.company?.country || 'India',
    address: Array.isArray(voucherData.company?.address) ? voucherData.company.address : [],
    taxUnit: voucherData.company?.taxUnit || cfg.taxUnit || '',
  };

  // Party details
  const partyGstin = String(voucherData.partyGstin || '').trim();
  const partyState = String(voucherData.partyState || '').trim();
  const partyPincode = String(voucherData.partyPincode || '').trim();
  const partyPlace = String(voucherData.partyPlace || '').trim();
  const partyAddress = Array.isArray(voucherData.partyAddress)
    ? voucherData.partyAddress
    : String(voucherData.partyAddress || '').split('\n').map(s => s.trim()).filter(Boolean);
  const placeOfSupply = String(voucherData.placeOfSupply || partyState || company.state || '').trim();
  const isInterState = !!placeOfSupply && !!company.state &&
    placeOfSupply.toLowerCase() !== String(company.state).toLowerCase();
  const panNumber = partyGstin && /^[0-9A-Z]{15}$/i.test(partyGstin) ? partyGstin.slice(0, 10).toUpperCase() : '';

  let companyTag = '';
  if (cfg.company && cfg.company.trim()) {
    companyTag = `<SVCURRENTCOMPANY>${escapeXml(cfg.company)}</SVCURRENTCOMPANY>`;
  }

  let inventoryEntries = '';
  let skipSalesEntries = '';
  let totalAmount = 0;
  const items = voucherData.items || [];
  const defaultTaxRate = parseFloat(voucherData.taxRate) || 18;
  // One tax bucket per distinct GST rate, exactly like a manually entered voucher.
  const taxBuckets = new Map();

  function bucket(rate) {
    if (!taxBuckets.has(rate)) taxBuckets.set(rate, { rate, base: 0 });
    return taxBuckets.get(rate);
  }

  for (const item of items) {
    const qty = parseInt(item.qty || item.quantity) || 1;
    const rate = parseFloat(item.price || item.unitPrice) || 0;
    const disc = parseFloat(item.discount || 0);
    const amount = (rate - disc) * qty;
    const displayRate = rate - disc;
    const itemName = escapeXml(item.name || item.description || 'Service');
    const taxRate = parseFloat(item.taxRate) || defaultTaxRate;
    const unit = escapeXml(item.unit || 'Qty');
    const typeOfSupply = /service/i.test(item.typeOfSupply || item.name || '') ? 'Services' : 'Goods';

    bucket(taxRate).base += amount;

    if (item.skipInventory) {
      // Service / non-stock line: credited directly to the sales ledger (no stock
      // reduction). Keeps the voucher balanced like a manual "Sales" entry.
      totalAmount += amount;
      bucket(taxRate).skipBase = (bucket(taxRate).skipBase || 0) + amount;
      continue;
    }

    totalAmount += amount;

    const rawBatch = (item.batch || '').trim();
    const batchName = escapeXml(rawBatch);
    const usesExplicitBatch = !!rawBatch && rawBatch !== 'Primary' && !/^Primary\s*Batch$/i.test(rawBatch);
    const batchAlloc = usesExplicitBatch ? `
        <BATCHALLOCATIONS.LIST>
          <GODOWNNAME>Main Location</GODOWNNAME>
          <BATCHNAME>${batchName}</BATCHNAME>
          <AMOUNT>${amount.toFixed(2)}</AMOUNT>
          <ACTUALQTY> ${qty} ${unit}</ACTUALQTY>
          <BILLEDQTY> ${qty} ${unit}</BILLEDQTY>
        </BATCHALLOCATIONS.LIST>` : '';
    const itemDesc = escapeXml(item.description || item.name || '');
    inventoryEntries += `
      <ALLINVENTORYENTRIES.LIST>
        <BASICUSERDESCRIPTION.LIST TYPE="String">
          <BASICUSERDESCRIPTION>${itemDesc}</BASICUSERDESCRIPTION>
        </BASICUSERDESCRIPTION.LIST>
        <STOCKITEMNAME>${itemName}</STOCKITEMNAME>
        <GSTOVRDNINELIGIBLEITC>&#4; Applicable</GSTOVRDNINELIGIBLEITC>
        <GSTOVRDNISREVCHARGEAPPL>&#4; Not Applicable</GSTOVRDNISREVCHARGEAPPL>
        <GSTOVRDNTAXABILITY>Taxable</GSTOVRDNTAXABILITY>
        <GSTSOURCETYPE>Ledger</GSTSOURCETYPE>
        <GSTLEDGERSOURCE>${salesLedger}</GSTLEDGERSOURCE>
        <HSNSOURCETYPE>Stock Item</HSNSOURCETYPE>
        <HSNITEMSOURCE>${itemName}</HSNITEMSOURCE>
        <GSTOVRDNTYPEOFSUPPLY>${typeOfSupply}</GSTOVRDNTYPEOFSUPPLY>
        <GSTRATEINFERAPPLICABILITY>As per Masters/Company</GSTRATEINFERAPPLICABILITY>
        <GSTHSNINFERAPPLICABILITY>As per Masters/Company</GSTHSNINFERAPPLICABILITY>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>
        <RATE>${displayRate.toFixed(2)}/${unit}</RATE>
        <DISCOUNT>${disc.toFixed(2)}</DISCOUNT>
        <AMOUNT>${amount.toFixed(2)}</AMOUNT>
        <ACTUALQTY> ${qty} ${unit}</ACTUALQTY>
        <BILLEDQTY> ${qty} ${unit}</BILLEDQTY>${batchAlloc}
        <ACCOUNTINGALLOCATIONS.LIST>
          <LEDGERNAME>${salesLedger}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${amount.toFixed(2)}</AMOUNT>
        </ACCOUNTINGALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>`;
  }

  // Sales-ledger entries for non-stock (skipInventory) lines, grouped by rate
  for (const [rate, b] of taxBuckets) {
    const skipBase = b.skipBase || 0;
    if (skipBase > 0) {
      skipSalesEntries += `
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>${salesLedger}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <ROUNDTYPE>&#4; Not Applicable</ROUNDTYPE>
      <AMOUNT>${skipBase.toFixed(2)}</AMOUNT>
      <RATEOFINVOICETAX.LIST TYPE="Number">
        <RATEOFINVOICETAX> ${rate}</RATEOFINVOICETAX>
      </RATEOFINVOICETAX.LIST>
    </LEDGERENTRIES.LIST>`;
    }
  }

  // Tax amounts, computed per rate bucket (sum of per-line base x rate) so they
  // match Tally's own calculation and never trigger the tax-mismatch warning.
  let rawGrandTotal = totalAmount;
  const taxEntries = [];
  for (const [rate, b] of taxBuckets) {
    const half = rate / 2;
    if (isInterState) {
      const igstAmt = b.base * rate / 100;
      rawGrandTotal += igstAmt;
      taxEntries.push(`    <LEDGERENTRIES.LIST>
      <LEDGERNAME>${igstLedger}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <ROUNDTYPE>&#4; Not Applicable</ROUNDTYPE>
      <AMOUNT>${igstAmt.toFixed(2)}</AMOUNT>
      <RATEOFINVOICETAX.LIST TYPE="Number">
        <RATEOFINVOICETAX> ${rate}</RATEOFINVOICETAX>
      </RATEOFINVOICETAX.LIST>
    </LEDGERENTRIES.LIST>`);
    } else {
      const cgstAmt = b.base * half / 100;
      const sgstAmt = b.base * half / 100;
      rawGrandTotal += cgstAmt + sgstAmt;
      taxEntries.push(`    <LEDGERENTRIES.LIST>
      <LEDGERNAME>${cgstLedger}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <ROUNDTYPE>&#4; Not Applicable</ROUNDTYPE>
      <AMOUNT>${cgstAmt.toFixed(2)}</AMOUNT>
      <RATEOFINVOICETAX.LIST TYPE="Number">
        <RATEOFINVOICETAX> ${half}</RATEOFINVOICETAX>
      </RATEOFINVOICETAX.LIST>
    </LEDGERENTRIES.LIST>
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>${sgstLedger}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <ROUNDTYPE>&#4; Not Applicable</ROUNDTYPE>
      <AMOUNT>${sgstAmt.toFixed(2)}</AMOUNT>
      <RATEOFINVOICETAX.LIST TYPE="Number">
        <RATEOFINVOICETAX> ${half}</RATEOFINVOICETAX>
      </RATEOFINVOICETAX.LIST>
    </LEDGERENTRIES.LIST>`);
    }
  }

  // Round off (Tally-style): round the grand total to a whole rupee and balance the
  // difference through the ROUND OFF ledger, exactly like a voucher entered manually.
  let grandTotal = rawGrandTotal;
  let roundOffEntry = '';
  let roundOffMaster = '';
  if (voucherData.roundOff === true) {
    const rounded = Math.round(rawGrandTotal);
    const diff = rounded - rawGrandTotal;
    grandTotal = rounded;
    if (diff !== 0) {
      const roundOffLedger = voucherData.roundOffLedger || 'Round Off';
      roundOffEntry = `
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>${escapeXml(roundOffLedger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>${diff.toFixed(2)}</AMOUNT>
    </LEDGERENTRIES.LIST>`;
      if (voucherData.includeRoundOffMaster === true) {
        roundOffMaster = `
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <LEDGER NAME="${escapeXml(roundOffLedger)}" ACTION="Create">
              <NAME>${escapeXml(roundOffLedger)}</NAME>
              <PARENT>Indirect Expenses</PARENT>
            </LEDGER>
          </TALLYMESSAGE>`;
      }
    }
  }

  const partyBillAlloc = voucherNumber ? `
      <BILLALLOCATIONS.LIST>
        <BILLTYPE>New Ref</BILLTYPE>
        <NAME>${voucherNumber}</NAME>
        <AMOUNT>${grandTotal.toFixed(2)}</AMOUNT>
      </BILLALLOCATIONS.LIST>` : '';
  const ledgerEntries = `
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>${partyLedger}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
      <AMOUNT>-${grandTotal.toFixed(2)}</AMOUNT>${partyBillAlloc}
    </LEDGERENTRIES.LIST>
    ${skipSalesEntries}
    ${taxEntries.join('\n')}
    ${roundOffEntry}`;

  // Party header / address block (mirrors the manual voucher field order)
  const partyHeader = `
        ${partyAddress.length ? `<ADDRESS.LIST TYPE="String">
${partyAddress.map(a => `          <ADDRESS>${escapeXml(a)}</ADDRESS>`).join('\n')}
        </ADDRESS.LIST>` : ''}
        <DATE>${dateStr}</DATE>
        <REFERENCEDATE>${dateStr}</REFERENCEDATE>
        <VCHSTATUSDATE>${dateStr}</VCHSTATUSDATE>
        ${company.gstin ? `<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : ''}
        ${company.state ? `<STATENAME>${escapeXml(company.state)}</STATENAME>` : ''}
        ${company.country ? `<COUNTRYOFRESIDENCE>${escapeXml(company.country)}</COUNTRYOFRESIDENCE>` : ''}
        ${partyGstin ? `<PARTYGSTIN>${escapeXml(partyGstin)}</PARTYGSTIN>` : ''}
        ${placeOfSupply ? `<PLACEOFSUPPLY>${escapeXml(placeOfSupply)}</PLACEOFSUPPLY>` : ''}
        <VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME>
        <PARTYNAME>${partyName}</PARTYNAME>
        ${company.gstin ? `<GSTREGISTRATION TAXTYPE="GST" TAXREGISTRATION="${escapeXml(company.gstin)}">${escapeXml(company.taxUnit)}</GSTREGISTRATION>` : ''}
        ${company.gstin ? `<CMPGSTIN>${escapeXml(company.gstin)}</CMPGSTIN>` : ''}
        <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
        ${voucherNumber ? `<VOUCHERNUMBER>${voucherNumber}</VOUCHERNUMBER>` : ''}
        <BASICBUYERNAME>${partyName}</BASICBUYERNAME>
        ${company.gstin ? `<CMPGSTREGISTRATIONTYPE>Regular</CMPGSTREGISTRATIONTYPE>` : ''}
        <PARTYMAILINGNAME>${partyName}</PARTYMAILINGNAME>
        ${partyPincode ? `<PARTYPINCODE>${escapeXml(partyPincode)}</PARTYPINCODE>` : ''}
        ${partyPlace ? `<BILLTOPLACE>${escapeXml(partyPlace)}</BILLTOPLACE>` : ''}
        ${company.name ? `<DISPATCHFROMNAME>${escapeXml(company.name)}</DISPATCHFROMNAME>` : ''}
        ${company.state ? `<DISPATCHFROMSTATENAME>${escapeXml(company.state)}</DISPATCHFROMSTATENAME>` : ''}
        ${company.pincode ? `<DISPATCHFROMPINCODE>${escapeXml(company.pincode)}</DISPATCHFROMPINCODE>` : ''}
        ${company.place ? `<DISPATCHFROMPLACE>${escapeXml(company.place)}</DISPATCHFROMPLACE>` : ''}
        ${partyPlace ? `<SHIPTOPLACE>${escapeXml(partyPlace)}</SHIPTOPLACE>` : ''}
        ${partyGstin ? `<CONSIGNEEGSTIN>${escapeXml(partyGstin)}</CONSIGNEEGSTIN>` : ''}
        <CONSIGNEEMAILINGNAME>${partyName}</CONSIGNEEMAILINGNAME>
        ${partyPincode ? `<CONSIGNEEPINCODE>${escapeXml(partyPincode)}</CONSIGNEEPINCODE>` : ''}
        ${partyState ? `<CONSIGNEESTATENAME>${escapeXml(partyState)}</CONSIGNEESTATENAME>` : ''}
        ${company.state ? `<CMPGSTSTATE>${escapeXml(company.state)}</CMPGSTSTATE>` : ''}
        <CONSIGNEECOUNTRYNAME>${escapeXml(company.country || 'India')}</CONSIGNEECOUNTRYNAME>
        <BASICBASEPARTYNAME>${partyName}</BASICBASEPARTYNAME>
        <NUMBERINGSTYLE>Auto Retain</NUMBERINGSTYLE>
        ${company.taxUnit ? `<VCHSTATUSTAXUNIT>${escapeXml(company.taxUnit)}</VCHSTATUSTAXUNIT>` : ''}
        ${panNumber ? `<BUYERPINNUMBER>${escapeXml(panNumber)}</BUYERPINNUMBER>
        <CONSIGNEEPINNUMBER>${escapeXml(panNumber)}</CONSIGNEEPINNUMBER>` : ''}
        <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
        <ISINVOICE>Yes</ISINVOICE>
        <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
        <NARRATION>${narration}</NARRATION>`;

  return `<ENVELOPE>
    <HEADER>
      <TALLYREQUEST>Import Data</TALLYREQUEST>
    </HEADER>
    <BODY>
      <IMPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>Vouchers</REPORTNAME>
          <STATICVARIABLES>${companyTag}</STATICVARIABLES>
        </REQUESTDESC>
        <REQUESTDATA>
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <LEDGER NAME="${partyLedger}" ACTION="Create">
              <NAME>${partyLedger}</NAME>
              <PARENT>Sundry Debtors</PARENT>
            </LEDGER>
          </TALLYMESSAGE>
          ${roundOffMaster}
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <VOUCHER VCHTYPE="${voucherType}" ACTION="Create" OBJVIEW="Invoice Voucher View">
              ${partyHeader}
              ${inventoryEntries}
              ${ledgerEntries}
            </VOUCHER>
          </TALLYMESSAGE>
        </REQUESTDATA>
      </IMPORTDATA>
    </BODY>
  </ENVELOPE>`;
}

async function pushSalesVoucher(voucherData) {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  log('PUSH', `Pushing sales voucher to Tally: ${voucherData.voucherNumber || '(auto)'}`);

  const payload = { ...voucherData };
  if (voucherData.roundOff === true) {
    try {
      const names = await ledgerNamesSnapshot(false);
      const existing = names.find(n => /round\s*off/i.test(n));
      payload.roundOffLedger = existing || 'Round Off';
      payload.includeRoundOffMaster = !existing;
      log('PUSH', `Round off ledger resolved: "${payload.roundOffLedger}" (create master: ${payload.includeRoundOffMaster})`);
    } catch (err) {
      payload.roundOffLedger = 'Round Off';
      payload.includeRoundOffMaster = true;
    }
  }

  const xml = buildSalesVoucherXml(payload);
  log('PUSH', `XML length: ${xml.length} bytes`);

  try {
    const response = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml),
    }, xml);

    log('PUSH', `Response status: ${response.statusCode}, length: ${response.body.length}`);

    const parsed = deepParseResponse(response.body);
    // TallyPrime returns results inside <RESPONSE> tag (not IMPORTRESULT)
    const importResult = parsed?.ENVELOPE?.BODY?.IMPORTDATA?.IMPORTRESULT
      || parsed?.ENVELOPE?.BODY?.DATA?.IMPORTRESULT
      || parsed?.RESPONSE
      || null;

    // Also check top-level RESPONSE (TallyPrime format)
    const topResponse = parsed?.RESPONSE || null;

    // Extract LINEERROR from raw response body (Tally returns it inside <RESPONSE> tag)
    let tallyLineError = '';
    if (response.body.includes('LINEERROR')) {
      const match = response.body.match(/<LINEERROR>(.*?)<\/LINEERROR>/);
      tallyLineError = match ? match[1] : '';
    }

    if (importResult) {
      const created = parseInt(importResult.CREATED) || 0;
      const errors = parseInt(importResult.ERRORS) || 0;
      const exceptions = parseInt(importResult.EXCEPTIONS) || 0;
      const lastVchId = importResult.LASTVCHID || null;

      const hasProblems = errors > 0 || exceptions > 0;
      const errMsg = tallyLineError || `Tally reported errors:${errors} exceptions:${exceptions}`;

      if (created > 0 && hasProblems) {
        log('PUSH', `Sales voucher created (${created}) but with exceptions: ${exceptions}, errors: ${errors}. ${errMsg}`);
        return { success: false, message: `Voucher created but with errors: ${errMsg}`, created, lastVchId, errors, exceptions, synced: false };
      }

      if (created > 0) {
        log('PUSH', `Sales voucher created: ${created}, LastVchID: ${lastVchId}`);
        return { success: true, message: 'Sales voucher pushed to Tally', created, lastVchId, errors: 0, exceptions: 0, synced: true };
      }

      if (hasProblems) {
        logError('Push sales voucher failed', errMsg);
        return { success: false, message: errMsg, created: 0, errors, exceptions, synced: false };
      }

      log('PUSH', `Sales voucher result: created=${created}, errors=${errors}, exceptions=${exceptions}`);
      return { success: created > 0, message: created > 0 ? 'Sales voucher pushed to Tally' : 'No voucher created', created, lastVchId, errors: 0, exceptions: 0, synced: created > 0 };
    }

    if (tallyLineError) {
      logError('Push sales voucher LINEERROR', tallyLineError);
      return { success: false, message: tallyLineError, created: 0, errors: 1, synced: false };
    }

    return { success: true, message: 'Request sent to Tally', created: 0, errors: 0, synced: false, raw: response.body.substring(0, 500) };
  } catch (err) {
    logError('Push sales voucher HTTP error', err);
    return { success: false, message: err.message, created: 0, errors: 1, synced: false };
  }
}

async function pushSalesVoucherWithRetry(voucherData, maxRetries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log('PUSH', `Attempt ${attempt}/${maxRetries} for voucher: ${voucherData.voucherNumber || '(auto)'}`);
    try {
      const result = await pushSalesVoucher(voucherData);
      if (result.success) {
        lastConnectionStatus = { reachable: true, companyFound: true, lastChecked: new Date().toISOString() };
        return result;
      }
      lastError = result.message;
      log('PUSH', `Attempt ${attempt} failed: ${result.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    } catch (err) {
      lastError = err.message;
      logError(`Push attempt ${attempt} error`, err);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  lastConnectionStatus = { reachable: false, companyFound: false, lastChecked: new Date().toISOString() };
  return { success: false, message: `Failed after ${maxRetries} attempts: ${lastError}`, created: 0, errors: 1, synced: false };
}

async function pingTally() {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  try {
    const result = await rawHttpRequest(url, 'GET', { 'User-Agent': 'CRS-Ping' }, null, 10000);
    const reachable = result.statusCode >= 200 && result.statusCode < 500;
    lastConnectionStatus = { reachable, companyFound: reachable, lastChecked: new Date().toISOString() };
    return { reachable, status: result.statusCode };
  } catch (err) {
    lastConnectionStatus = { reachable: false, companyFound: false, lastChecked: new Date().toISOString() };
    return { reachable: false, error: err.message, code: err.code };
  }
}

function getConnectionStatus() {
  return lastConnectionStatus;
}

// ============================================================
// SERIAL NUMBER -> STOCK ITEM NAME LOOKUP
// Queries Tally to find which stock item has a given serial number
// so we don't need CRS product_name to match Tally stock item name.
// ============================================================
let serialCache = null;
let serialCacheTime = 0;
const SERIAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function buildStockItemsExportRequest() {
  const cfg = getTallyConfig();
  let companyTag = '';
  if (cfg.company && cfg.company.trim()) {
    companyTag = `<SVCURRENTCOMPANY>${escapeXml(cfg.company)}</SVCURRENTCOMPANY>`;
  }
  return `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Stock Query</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyTag}<SVINCLUDEBATCHES>Yes</SVINCLUDEBATCHES><SVSHOWITEMWISERATE>Yes</SVSHOWITEMWISERATE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
}

function buildStockItemsListRequest() {
  const cfg = getTallyConfig();
  let companyTag = '';
  if (cfg.company && cfg.company.trim()) {
    companyTag = `<SVCURRENTCOMPANY>${escapeXml(cfg.company)}</SVCURRENTCOMPANY>`;
  }
  return `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Stock Items</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyTag}</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
}

async function fetchStockSerialMap() {
  const now = Date.now();
  if (serialCache && (now - serialCacheTime) < SERIAL_CACHE_TTL_MS) {
    log('SERIAL-LOOKUP', `Using cached serial map (${Object.keys(serialCache).length} entries, age ${Math.round((now - serialCacheTime) / 1000)}s)`);
    return serialCache;
  }

  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const map = {};

  // Strategy 1: Scan stock item NAMES for a trailing "[serial]" suffix. The add flow now
  // creates one Tally stock item per serial named "{product} [{serial}]", so the serial
  // travels inside the item NAME - this works even though serial tracking is disabled on the
  // stock items (a plain SERIALNUMBERLIST is silently dropped by Tally). CRSStockFull is the
  // same proven read-only collection used for stock verification.
  log('SERIAL-LOOKUP', 'Scanning stock item names for "[serial]" suffix (CRSStockFull)...');
  try {
    const xml = buildMasterCollectionRequest('StockItem', 'CRSStockFull', ['Name', 'Parent', 'ClosingBalance']);
    const response = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml),
    }, xml, 30000);

    if (response.body && response.body.length > 200) {
      const parsed = parser.parse(response.body);
      const data = parsed?.ENVELOPE?.BODY?.DATA;
      let collections = data?.COLLECTION;
      if (collections) {
        const collArr = Array.isArray(collections) ? collections : [collections];
        for (const coll of collArr) {
          const stockItems = coll?.STOCKITEM;
          if (!stockItems) continue;
          const itemArr = Array.isArray(stockItems) ? stockItems : [stockItems];
          for (const item of itemArr) {
            const stockName = (item?.NAME || item?.['@_NAME'] || '').trim();
            if (!stockName) continue;
            const match = stockName.match(/\[([^\[\]]+)\]$/);
            if (match && match[1] && match[1].trim()) {
              const serialFromName = match[1].trim();
              if (!map[serialFromName]) {
                map[serialFromName] = stockName;
                log('SERIAL-LOOKUP', `Serial "${serialFromName}" -> Stock Item "${stockName}" (from item name)`);
              }
            }
          }
        }
      }
    }
    log('SERIAL-LOOKUP', `Stock item name scan: found ${Object.keys(map).length} serial mappings`);
  } catch (err) {
    logError('Failed to scan stock item names', err);
  }

  // Strategy 2: Try "List of Stock Items" which returns stock items with batch/serial info.
  // Only needed when the name scan found nothing (real serial-tracking data lives here).
  if (Object.keys(map).length === 0) {
    log('SERIAL-LOOKUP', 'Fetching stock items from Tally to build serial number map...');
    try {
      const xml = buildStockItemsListRequest();
    const response = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml),
    }, xml, 30000);

    if (response.body && response.body.length > 200) {
      const parsed = parser.parse(response.body);
      const body = parsed?.ENVELOPE?.BODY;
      let messages = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
      if (!messages) messages = body?.DATA?.TALLYMESSAGE;

      if (messages) {
        const msgArr = Array.isArray(messages) ? messages : [messages];
        log('SERIAL-LOOKUP', `Processing ${msgArr.length} TALLYMESSAGE entries from stock items list`);

        for (const msg of msgArr) {
          const stockItems = msg?.STOCKITEM;
          if (!stockItems) continue;
          const itemArr = Array.isArray(stockItems) ? stockItems : [stockItems];

          for (const item of itemArr) {
            const stockName = item?.NAME || item?.['@_NAME'] || '';
            if (!stockName) continue;

            // Check BATCHALLOCATIONS.LIST for serial numbers
            const batches = item?.['BATCHALLOCATIONS.LIST'] || [];
            const batchArr = Array.isArray(batches) ? batches : [batches];
            for (const batch of batchArr) {
              const serialNos = batch?.SERIALNUMBERLIST?.SERIALNUMBER || [];
              const serialArr = Array.isArray(serialNos) ? serialNos : [serialNos];
              for (const serial of serialArr) {
                const serialStr = (typeof serial === 'string' ? serial : serial?.['#text'] || '').trim();
                if (serialStr) {
                  map[serialStr] = stockName;
                  log('SERIAL-LOOKUP', `Serial "${serialStr}" -> Stock Item "${stockName}"`);
                }
              }
              // Also check batch name as potential serial
              const batchName = batch?.BATCHNAME || '';
              if (batchName && batchName !== 'Primary' && !/^Primary\s*Batch$/i.test(batchName) && batchName.trim()) {
                const bn = batchName.trim();
                if (!map[bn]) {
                  map[bn] = stockName;
                }
              }
            }

            // Also check ADDITIONALNAME
            const additionalName = item?.ADDITIONALNAME || '';
            if (additionalName && additionalName.trim() && !map[additionalName.trim()]) {
              map[additionalName.trim()] = stockName;
            }
          }
        }
      }
    }
    log('SERIAL-LOOKUP', `List of Stock Items: found ${Object.keys(map).length} serial mappings`);
    } catch (err) {
      logError('Failed to fetch stock items list', err);
    }
  }

  // Strategy 3: If the strategies above found nothing, try fetching Day Book vouchers to extract serial->stockitem mapping from past sales
  if (Object.keys(map).length === 0) {
    log('SERIAL-LOOKUP', 'No serials from stock items list, trying Day Book vouchers as fallback...');
    try {
      const exportXml = buildExportRequest(null, cfg.company);
      const response = await rawHttpRequest(url, 'POST', {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(exportXml),
      }, exportXml, 30000);

      if (response.body && response.body.length > 200) {
        const parsed = parser.parse(response.body);
        const body = parsed?.ENVELOPE?.BODY;
        let messages = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
        if (!messages) messages = body?.DATA?.TALLYMESSAGE;

        if (messages) {
          const msgArr = Array.isArray(messages) ? messages : [messages];
          for (const msg of msgArr) {
            const vouchers = msg?.VOUCHER;
            if (!vouchers) continue;
            const vchArr = Array.isArray(vouchers) ? vouchers : [vouchers];
            for (const vch of vchArr) {
              const invAll = vch?.['ALLINVENTORYENTRIES.LIST'] || vch?.INVENTORYENTRIES?.LIST || [];
              const invArr = Array.isArray(invAll) ? invAll : [invAll];
              for (const inv of invArr) {
                const stockName = inv?.STOCKITEMNAME || '';
                const batches = inv?.['BATCHALLOCATIONS.LIST'] || inv?.BATCHALLOCATIONS?.LIST || [];
                const batchArr = Array.isArray(batches) ? batches : [batches];
                for (const batch of batchArr) {
                  const serialNos = batch?.SERIALNUMBERLIST?.SERIALNUMBER || [];
                  const serialArr = Array.isArray(serialNos) ? serialNos : [serialNos];
                  for (const serial of serialArr) {
                    const serialStr = (typeof serial === 'string' ? serial : serial?.['#text'] || '').trim();
                    if (serialStr && stockName) {
                      map[serialStr] = stockName;
                    }
                  }
                  const batchName = batch?.BATCHNAME || '';
                  if (batchName && batchName !== 'Primary' && !/^Primary\s*Batch$/i.test(batchName) && batchName.trim() && stockName) {
                    map[batchName.trim()] = stockName;
                  }
                }
              }
            }
          }
        }
      }
      log('SERIAL-LOOKUP', `Day Book fallback: found ${Object.keys(map).length} serial mappings total`);
    } catch (err) {
      logError('Day Book fallback failed', err);
    }
  }

  serialCache = map;
  serialCacheTime = now;
  log('SERIAL-LOOKUP', `Serial map built: ${Object.keys(map).length} entries cached for ${SERIAL_CACHE_TTL_MS / 1000}s`);
  return map;
}

async function lookupStockItemBySerial(serialNumber) {
  if (!serialNumber || !serialNumber.trim()) return null;
  const map = await fetchStockSerialMap();
  const result = map[serialNumber.trim()] || null;
  if (result) {
    log('SERIAL-LOOKUP', `Found: "${serialNumber}" -> "${result}"`);
  } else {
    log('SERIAL-LOOKUP', `Not found in Tally: "${serialNumber}"`);
  }
  return result;
}

function clearSerialCache() {
  serialCache = null;
  serialCacheTime = 0;
  log('SERIAL-LOOKUP', 'Cache cleared');
}

function buildMasterCollectionRequest(type, collectionName, nativeMethods) {
  const cfg = getTallyConfig();
  let companyTag = '';
  if (cfg.company && cfg.company.trim()) {
    companyTag = `<SVCURRENTCOMPANY>${escapeXml(cfg.company)}</SVCURRENTCOMPANY>`;
  }
  const methods = (nativeMethods || []).map(m => `            <NATIVEMETHOD>${m}</NATIVEMETHOD>`).join('\n');
  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>${collectionName}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${companyTag}
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="${collectionName}" ISINITIALIZE="Yes">
            <TYPE>${type}</TYPE>
${methods}
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

function cleanMasterParent(val) {
  if (!val) return '';
  return String(val).replace(/^[^A-Za-z0-9_]+/, '').trim();
}

async function fetchStockCategories() {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const categories = [];
  const groups = [];

  async function fetchList(type, collectionName, nativeMethods, tagName, target) {
    try {
      const xml = buildMasterCollectionRequest(type, collectionName, nativeMethods);
      const response = await rawHttpRequest(url, 'POST', {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(xml),
      }, xml, 30000);
      if (!response.body || response.body.length < 100) return;
      const parsed = parser.parse(response.body);
      const data = parsed?.ENVELOPE?.BODY?.DATA;
      let collections = data?.COLLECTION;
      if (!collections) return;
      const collArr = Array.isArray(collections) ? collections : [collections];
      for (const coll of collArr) {
        const entries = coll?.[tagName];
        if (!entries) continue;
        const list = Array.isArray(entries) ? entries : [entries];
        for (const entry of list) {
          const name = entry?.NAME || entry?.['@_NAME'] || '';
          if (name && name.trim()) {
            target.push({
              name: name.trim(),
              parent: cleanMasterParent(entry?.PARENT?.['#text'] || entry?.PARENT || ''),
            });
          }
        }
      }
    } catch (err) {
      logError(`Failed to fetch ${tagName} from Tally`, err);
    }
  }

  await fetchList('StockGroup', 'CRSStockGroups', ['Name', 'Parent'], 'STOCKGROUP', groups);
  await fetchList('StockCategory', 'CRSStockCategories', ['Name', 'Parent'], 'STOCKCATEGORY', categories);

  log('CATEGORIES', `Fetched ${categories.length} stock categories, ${groups.length} stock groups from Tally`);
  return { categories, groups };
}

async function fetchLedgers() {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const ledgers = [];
  try {
    const xml = buildMasterCollectionRequest('Ledger', 'CRSLedgers', ['Name', 'Parent'], 'LEDGER', []);
    const response = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml),
    }, xml, 30000);
    if (!response.body || response.body.length < 100) return { ledgers: [], count: 0 };
    const parsed = parser.parse(response.body);
    const data = parsed?.ENVELOPE?.BODY?.DATA;
    let collections = data?.COLLECTION;
    if (!collections) return { ledgers: [], count: 0 };
    const collArr = Array.isArray(collections) ? collections : [collections];
    for (const coll of collArr) {
      const entries = coll?.LEDGER;
      if (!entries) continue;
      const list = Array.isArray(entries) ? entries : [entries];
      for (const entry of list) {
        const name = entry?.NAME || entry?.['@_NAME'] || '';
        if (name && name.trim()) {
          ledgers.push({
            name: name.trim(),
            parent: cleanMasterParent(entry?.PARENT?.['#text'] || entry?.PARENT || ''),
          });
        }
      }
    }
  } catch (err) {
    logError('Failed to fetch ledgers from Tally', err);
  }
  log('LEDGERS', `Fetched ${ledgers.length} ledgers from Tally`);
  return { ledgers, count: ledgers.length };
}

function companyInfoFromEnv() {
  return {
    name: process.env.TALLY_COMPANY_NAME || getTallyConfig().company || '',
    gstin: process.env.TALLY_COMPANY_GSTIN || '',
    state: process.env.TALLY_COMPANY_STATE || '',
    pincode: process.env.TALLY_COMPANY_PINCODE || '',
    place: process.env.TALLY_COMPANY_PLACE || '',
    country: process.env.TALLY_COMPANY_COUNTRY || 'India',
    address: (process.env.TALLY_COMPANY_ADDRESS || '').split('|').filter(Boolean),
    taxUnit: getTallyConfig().taxUnit || '',
  };
}

// Builds the Company master query. Only the fast native methods are used here
// (Name/PinCode/CountryName); the heavier GST registration master makes Tally's
// TDL compiler hang, so GSTIN/state/dispatch-address are derived from the Day
// Book sales vouchers instead (see fetchCompanyInfo).
function buildCompanyInfoRequest() {
  const cfg = getTallyConfig();
  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRSCompany</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${escapeXml(cfg.company)}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRSCompany" ISINITIALIZE="Yes">
            <TYPE>Company</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
            <NATIVEMETHOD>PinCode</NATIVEMETHOD>
            <NATIVEMETHOD>CountryName</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

// Fetches the CRS company's own details from Tally (company master + GST details
// carried on Sales vouchers). Result is cached in memory and persisted to .env so
// subsequent calls are instant and work even when Tally is unreachable.
async function fetchCompanyInfo(force = false) {
  const now = Date.now();
  if (!force && companyInfoCache && now - companyInfoCacheAt < 5 * 60 * 1000) {
    return { success: true, company: companyInfoCache, cached: true };
  }
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const company = companyInfoFromEnv();

  // 1. Company master (Name / PinCode / CountryName)
  try {
    const res = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(buildCompanyInfoRequest()),
    }, buildCompanyInfoRequest(), 20000);
    const name = res.body.match(/<COMPANY NAME="([^"]*)"/);
    const pin = res.body.match(/<PINCODE TYPE="String">([^<]*)<\/PINCODE>/);
    const country = res.body.match(/<COUNTRYNAME TYPE="String">([^<]*)<\/COUNTRYNAME>/);
    if (name) company.name = name[1];
    if (pin) company.pincode = pin[1];
    if (country) company.country = country[1];
  } catch (err) {
    log('COMPANY', `Company master fetch failed: ${err.message}`);
  }

  // 2. GSTIN / state / dispatch address from the Sales vouchers. Scans every voucher
  // in the Day Book (not just the first) so we take the first non-empty value of each
  // field across all vouchers - robust to a mix of vouchers with/without these fields.
  try {
    const dayBookXml = buildExportRequest('01-Apr-2024', cfg.company);
    const res = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(dayBookXml),
    }, dayBookXml, 30000);
    const body = res.body || '';

    const firstOf = (tag) => {
      const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g');
      let m;
      while ((m = re.exec(body)) !== null) {
        if (m[1] && m[1].trim()) return m[1].trim();
      }
      return null;
    };
    const gstin = firstOf('CMPGSTIN');
    const state = firstOf('CMPGSTSTATE');
    const dfName = firstOf('DISPATCHFROMNAME');
    const dfPlace = firstOf('DISPATCHFROMPLACE');
    const dfPin = firstOf('DISPATCHFROMPINCODE');
    if (gstin) company.gstin = gstin;
    if (state) company.state = state;
    if (dfName) company.name = dfName;
    if (dfPlace) company.place = dfPlace;
    if (dfPin) company.pincode = dfPin;
    const dfAddr = [...body.matchAll(/<DISPATCHFROMADDRESS>([^<]*)<\/DISPATCHFROMADDRESS>/g)].map(m => m[1].trim()).filter(Boolean);
    if (dfAddr.length) company.address = dfAddr;
    if (company.state) company.taxUnit = getTallyConfig().taxUnit || `${company.state} Registration`;
  } catch (err) {
    log('COMPANY', `Day Book company info fetch failed: ${err.message}`);
  }

  // Persist so restarts keep the last known-good values
  persistConfig({
    TALLY_COMPANY_NAME: company.name,
    TALLY_COMPANY_GSTIN: company.gstin,
    TALLY_COMPANY_STATE: company.state,
    TALLY_COMPANY_PINCODE: company.pincode,
    TALLY_COMPANY_PLACE: company.place,
    TALLY_COMPANY_COUNTRY: company.country,
    TALLY_COMPANY_ADDRESS: company.address.join('|'),
  });

  const hasRealData = !!(company.gstin || company.state || company.address.length);
  companyInfoCache = company;
  companyInfoCacheAt = now;
  log('COMPANY', `Company info resolved: ${company.name}, GSTIN: ${company.gstin || '(none)'}, state: ${company.state || '(none)'}`);
  return { success: hasRealData, company, cached: false };
}

function buildLedgerCreateXml(name, company, options = {}) {
  const cfg = getTallyConfig();
  const companyName = company || cfg.company || '';
  let companyTag = '';
  if (companyName && companyName.trim()) {
    companyTag = `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`;
  }
  const ledgerName = escapeXml(name || '');
  const parent = escapeXml(options.parent || 'Sundry Creditors');
  const gstNo = escapeXml(options.gstNo || '');
  const gstRegistrationType = escapeXml(options.gstRegistrationType || 'Unregistered');
  const typeOfSupply = escapeXml(options.typeOfSupply || 'Goods');

  let gstXml = '';
  if (gstNo) {
    gstXml = `
          <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
          <GSTTYPEOFSUPPLY>${typeOfSupply}</GSTTYPEOFSUPPLY>
          <GSTREGISTRATIONTYPE>${gstRegistrationType}</GSTREGISTRATIONTYPE>
          <GSTDETAILS.LIST>
            <GSTNUMBER>${gstNo}</GSTNUMBER>
          </GSTDETAILS.LIST>`;
  } else {
    gstXml = `
          <GSTAPPLICABLE>&#4; Not Applicable</GSTAPPLICABLE>
          <GSTTYPEOFSUPPLY>${typeOfSupply}</GSTTYPEOFSUPPLY>`;
  }

  return `<ENVELOPE>
    <HEADER>
      <TALLYREQUEST>Import Data</TALLYREQUEST>
    </HEADER>
    <BODY>
      <IMPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>All Masters</REPORTNAME>
          <STATICVARIABLES>${companyTag}</STATICVARIABLES>
        </REQUESTDESC>
        <REQUESTDATA>
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <LEDGER NAME="${ledgerName}" ACTION="Create">
              <NAME>${ledgerName}</NAME>
              <PARENT>${parent}</PARENT>${gstXml}
            </LEDGER>
          </TALLYMESSAGE>
        </REQUESTDATA>
      </IMPORTDATA>
    </BODY>
  </ENVELOPE>`;
}

async function pushLedgerToTally(name, company, options = {}) {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const xml = buildLedgerCreateXml(name, company, options);
  log('LEDGER-PUSH', `Pushing ledger "${name}" to Tally (parent: ${options.parent || 'Sundry Creditors'})`);
  try {
    const response = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml),
    }, xml, 30000);
    let tallyLineError = '';
    if (response.body.includes('LINEERROR')) {
      const match = response.body.match(/<LINEERROR>(.*?)<\/LINEERROR>/);
      tallyLineError = match ? match[1] : '';
    }
    const errors = /<ERRORS>[1-9]/.test(response.body) || /<EXCEPTIONS>[1-9]/.test(response.body) || /<CANCELLED>[1-9]/.test(response.body);
    if (errors || tallyLineError) {
      logError('Ledger push had errors', tallyLineError || response.body);
      return { success: false, message: tallyLineError || `Tally reported errors creating ledger "${name}"` };
    }
    lastConnectionStatus = { reachable: true, companyFound: true, lastChecked: new Date().toISOString() };
    return { success: true, message: `Ledger "${name}" created in Tally under ${options.parent || 'Sundry Creditors'}`, created: /<CREATED>[1-9]/.test(response.body) };
  } catch (err) {
    logError('Push ledger HTTP error', err);
    return { success: false, message: err.message };
  }
}

function buildGstDetailsXml(item) {
  const gstApplicable = String(item.gstApplicability || 'Applicable').trim().toLowerCase();
  const isApplicable = gstApplicable !== 'not applicable' && gstApplicable !== 'no';
  const hsnCode = escapeXml(item.hsnCode || '');
  const hsnDescription = escapeXml(item.hsnDescription || '');
  const typeOfSupply = escapeXml(item.typeOfSupply || 'Goods');
  const taxability = escapeXml(item.gstTaxability || 'Taxable');
  const hsnSource = escapeXml(item.hsnSource || 'Specify Details Here');
  const gstSource = escapeXml(item.gstSource || 'Specify Details Here');
  const totalRate = parseFloat(item.gstRate) || 0;
  const applicableFrom = '20240401';

  let xml = `
        <GSTAPPLICABLE>&#4; ${isApplicable ? 'Applicable' : 'Not Applicable'}</GSTAPPLICABLE>`;
  xml += `\n        <GSTTYPEOFSUPPLY>${typeOfSupply}</GSTTYPEOFSUPPLY>`;
  xml += `
        <GSTDETAILS.LIST>
          <APPLICABLEFROM>${applicableFrom}</APPLICABLEFROM>
          <HSNCODE>${hsnCode}</HSNCODE>
          <SRCOFGSTDETAILS>${gstSource}</SRCOFGSTDETAILS>
          <TAXABILITY>${taxability}</TAXABILITY>`;
  if (isApplicable && totalRate > 0) {
    const cgst = (totalRate / 2).toFixed(2);
    const sgst = (totalRate / 2).toFixed(2);
    xml += `
          <STATEWISEDETAILS.LIST>
            <STATENAME>&#4; Any</STATENAME>
            <RATEDETAILS.LIST>
              <GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD>
              <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
              <GSTRATE> ${cgst}</GSTRATE>
              <GSTRATEPERUNIT>0</GSTRATEPERUNIT>
            </RATEDETAILS.LIST>
            <RATEDETAILS.LIST>
              <GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD>
              <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
              <GSTRATE> ${sgst}</GSTRATE>
              <GSTRATEPERUNIT>0</GSTRATEPERUNIT>
            </RATEDETAILS.LIST>
          </STATEWISEDETAILS.LIST>`;
  }
  xml += `
        </GSTDETAILS.LIST>`;
  if (hsnCode) {
    xml += `
        <HSNDETAILS.LIST>
          <APPLICABLEFROM>${applicableFrom}</APPLICABLEFROM>
          <HSNCODE>${hsnCode}</HSNCODE>
          <HSN>${hsnDescription}</HSN>
          <SRCOFHSNDETAILS>${hsnSource}</SRCOFHSNDETAILS>
        </HSNDETAILS.LIST>`;
  }
  return xml;
}

function buildStockItemMastersXml(items, company, options = {}) {
  const cfg = getTallyConfig();
  const companyName = company || cfg.company || '';
  let companyTag = '';
  if (companyName && companyName.trim()) {
    companyTag = `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`;
  }

  // stripConflictFields: used as a fallback when the full create/alter fails with a
  // permanent config conflict (e.g. item already exists in Tally with different units
  // or is locked in another group). Omitting BASEUNITS/PARENT/CATEGORY lets Tally ALTER
  // the existing item and add the opening batch stock without error.
  const stripConflictFields = !!options.stripConflictFields;

  let tallyMessages = '';
  for (const item of items) {
    const name = escapeXml(item.name || '');
    if (!name) continue;
    const qty = parseInt(item.qty, 10) || 1;
    const rate = parseFloat(item.rate) || 0;
    const serials = (item.serials || []).map(s => String(s).trim()).filter(Boolean);
    const categoryName = escapeXml(item.category || '');
    const categoryType = String(item.categoryType || 'category').toLowerCase();

    let serialXml = '';
    if (serials.length) {
      serialXml = `
        <SERIALNUMBERLIST>
          ${serials.map(s => `<SERIALNUMBER>${escapeXml(s)}</SERIALNUMBER>`).join('\n          ')}
        </SERIALNUMBERLIST>`;
    }

    const baseUnitsXml = stripConflictFields ? '' : '<BASEUNITS>Qty</BASEUNITS>';
    const categoryXml = stripConflictFields ? '' : (categoryName && categoryType === 'group'
      ? `\n          <PARENT>${categoryName}</PARENT>`
      : categoryName
        ? `\n          <CATEGORY>${categoryName}</CATEGORY>`
        : '');

    const gstXml = buildGstDetailsXml(item);

    tallyMessages += `
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <STOCKITEM NAME="${name}" ACTION="Create">
          <NAME>${name}</NAME>
          ${baseUnitsXml}${categoryXml}${gstXml}
          <BATCHALLOCATIONS.LIST>
            <GODOWNNAME>Main Location</GODOWNNAME>
            <BATCHNAME>Primary</BATCHNAME>
            <OPENINGQTY> ${qty} Qty</OPENINGQTY>
            <ACTUALQTY> ${qty} Qty</ACTUALQTY>
            <RATE>${rate.toFixed(2)}</RATE>
            <AMOUNT>${(qty * rate).toFixed(2)}</AMOUNT>${serialXml}
          </BATCHALLOCATIONS.LIST>
        </STOCKITEM>
      </TALLYMESSAGE>`;
  }

  return `<ENVELOPE>
    <HEADER>
      <TALLYREQUEST>Import Data</TALLYREQUEST>
    </HEADER>
    <BODY>
      <IMPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>All Masters</REPORTNAME>
          <STATICVARIABLES>${companyTag}</STATICVARIABLES>
        </REQUESTDESC>
        <REQUESTDATA>
          ${tallyMessages}
        </REQUESTDATA>
      </IMPORTDATA>
    </BODY>
  </ENVELOPE>`;
}

async function pushStockItemsToTally(items, company, options = {}) {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  log('STOCK-PUSH', `Pushing ${items.length} stock item master(s) to Tally${options.stripConflictFields ? ' (stripped: units/group unchanged)' : ''}`);

  const xml = buildStockItemMastersXml(items, company, options);
  log('STOCK-PUSH', `XML length: ${xml.length} bytes`);

  try {
    const response = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml),
    }, xml, 60000);

    const parsed = deepParseResponse(response.body);
    const importResult = parsed?.ENVELOPE?.BODY?.IMPORTDATA?.IMPORTRESULT
      || parsed?.ENVELOPE?.BODY?.DATA?.IMPORTRESULT
      || parsed?.RESPONSE
      || null;

    let tallyLineError = '';
    if (response.body.includes('LINEERROR')) {
      const match = response.body.match(/<LINEERROR>(.*?)<\/LINEERROR>/);
      tallyLineError = match ? match[1] : '';
    }

    if (importResult) {
      const created = parseInt(importResult.CREATED) || 0;
      const altered = parseInt(importResult.ALTERED) || 0;
      const errors = parseInt(importResult.ERRORS) || 0;
      const exceptions = parseInt(importResult.EXCEPTIONS) || 0;
      if (errors > 0 || exceptions > 0) {
        const errMsg = tallyLineError || `Tally reported errors:${errors} exceptions:${exceptions}`;
        logError('Stock item push had errors', errMsg);
        return { success: false, message: errMsg, created, altered, errors, exceptions };
      }
      return { success: created > 0 || altered > 0, message: `Stock items pushed: created=${created}, altered=${altered}`, created, altered, errors, exceptions };
    }

    if (tallyLineError) {
      logError('Stock item push LINEERROR', tallyLineError);
      return { success: false, message: tallyLineError, created: 0, altered: 0, errors: 1 };
    }

    return { success: true, message: 'Request sent to Tally', created: 0, altered: 0, errors: 0, raw: response.body.substring(0, 500) };
  } catch (err) {
    logError('Push stock items HTTP error', err);
    return { success: false, message: err.message, created: 0, altered: 0, errors: 1 };
  }
}

// Classify stock-master push failures. Some Tally errors are PERMANENT because the
// stock item already exists in Tally with an incompatible configuration (different
// units, or no 'Primary' batch). Retrying can never fix these, so callers mark the
// serials 'stock_skipped' (never retried automatically) instead of 'stock_error'
// (retried on every sync-inventory). Transient failures (network/Tally down) stay
// 'stock_error' so they are retried.
function isPermanentStockError(message) {
  if (!message) return false;
  const m = String(message);
  return /Cannot alter Units/i.test(m)
    || /Stock Group .*does not exist/i.test(m)
    || /Stock Item .*does not exist/i.test(m)
    || /Already exists/i.test(m);
}

// Config conflicts are permanent for the FULL push (units/group can't be altered on an
// existing item), but the stock can still be added by retrying without those fields.
function isConfigConflictError(message) {
  if (!message) return false;
  const m = String(message);
  return /Cannot alter Units/i.test(m)
    || /Stock Group .*does not exist/i.test(m)
    || /Cannot (move|change|alter)/i.test(m)
    || /does not exist/i.test(m);
}

async function pushStockItemsToTallyWithRetry(items, maxRetries = 3, company) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log('STOCK-PUSH', `Attempt ${attempt}/${maxRetries} for ${items.length} stock item(s)`);
    try {
      const result = await pushStockItemsToTally(items, company);
      if (result.success) {
        lastConnectionStatus = { reachable: true, companyFound: true, lastChecked: new Date().toISOString() };
        return result;
      }
      lastError = result.message;
      log('STOCK-PUSH', `Attempt ${attempt} failed: ${result.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    } catch (err) {
      lastError = err.message;
      logError(`Push stock attempt ${attempt} error`, err);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  // Fallback: the full master create/alter failed with a config conflict (item already
  // exists in Tally with incompatible units or locked in another group). Retry with the
  // conflict fields stripped so the opening stock is still added "any how" instead of
  // being permanently skipped.
  if (isConfigConflictError(lastError)) {
    log('STOCK-PUSH', 'Config conflict detected; retrying with stripped masters (units/group unchanged)');
    try {
      const stripped = await pushStockItemsToTally(items, company, { stripConflictFields: true });
      if (stripped.success) {
        lastConnectionStatus = { reachable: true, companyFound: true, lastChecked: new Date().toISOString() };
        return {
          ...stripped,
          message: `Stock items added (units/group unchanged): created=${stripped.created}, altered=${stripped.altered}`,
          fallbackStripped: true,
        };
      }
      lastError = stripped.message;
    } catch (err) {
      lastError = err.message;
      logError('Stripped fallback push error', err);
    }
  }

  lastConnectionStatus = { reachable: false, companyFound: false, lastChecked: new Date().toISOString() };
  return { success: false, message: `Failed after ${maxRetries} attempts: ${lastError}`, created: 0, altered: 0, errors: 1 };
}

// ============================================================
// PURCHASE VOUCHER FLOW
// Mirrors Tally's own purchase voucher XML (Invoice Voucher View)
// so an item added in CRS lands in Tally STOCK under its assigned
// category, with GST statutory details and a serial, via a real
// Purchase voucher (not just a ledger).
// ============================================================

let ledgerNamesCache = { at: 0, names: [] };

async function ledgerNamesSnapshot(force) {
  const now = Date.now();
  if (!force && now - ledgerNamesCache.at < 30000 && ledgerNamesCache.names.length) return ledgerNamesCache.names;
  try {
    const r = await fetchLedgers();
    ledgerNamesCache = { at: now, names: (r.ledgers || []).map(l => l.name) };
  } catch (err) {
    logError('ledgerNamesSnapshot failed', err);
  }
  return ledgerNamesCache.names;
}

function purchaseTaxLedgers(gstRate, purchaseLedger) {
  const rate = parseFloat(gstRate) || 0;
  const half = rate / 2;
  if (/IGST/i.test(String(purchaseLedger || ''))) {
    return { igst: { name: `INPUT IGST @ ${rate}%`, rate } };
  }
  return {
    cgst: { name: `INPUT CGST @ ${half}%`, rate: half },
    sgst: { name: `INPUT SGST @ ${half}%`, rate: half },
  };
}

function buildPurchaseVoucherXml(voucherData) {
  const cfg = getTallyConfig();
  const company = voucherData.company || cfg.company || '';
  let companyTag = '';
  if (company && company.trim()) {
    companyTag = `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`;
  }

  let dateStr = voucherData.date || '';
  if (!/^\d{8}$/.test(dateStr)) {
    dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
  const voucherType = escapeXml(voucherData.voucherType || 'Purchase');
  const partyLedger = escapeXml(voucherData.partyLedger || 'Walk-in Supplier');
  const purchaseLedger = escapeXml(voucherData.purchaseLedger || 'PURCHASE @ 18%');
  const voucherNumber = escapeXml(voucherData.voucherNumber || '');
  const refNumber = escapeXml(voucherData.refNumber || '');
  const poNumber = escapeXml(voucherData.poNumber || '');
  const narration = escapeXml(voucherData.narration || 'Purchase via CRS');
  const gstRate = parseFloat(voucherData.gstRate) || 18;

  const entries = voucherData.entries || [];
  let stockMasters = '';
  let inventoryEntries = '';
  let totalAmount = 0;
  // Tax ledger entries are aggregated per rate bracket (one INPUT CGST/SGST line per
  // rate), matching how Tally stores a manually entered purchase voucher instead of
  // emitting a separate tax line per inventory item.
  const taxBuckets = [];

  function addTaxBucket(name, rate, amt) {
    const existing = taxBuckets.find(b => b.name === name);
    if (existing) existing.amount += amt;
    else taxBuckets.push({ name, rate, amount: amt });
  }

  for (const item of entries) {
    const itemName = escapeXml(item.name || '');
    const category = escapeXml(item.category || item.parent || 'Primary');
    const qty = parseFloat(item.qty ?? item.quantity ?? 1) || 1;
    const rate = parseFloat(item.rate ?? item.price ?? item.unitPrice ?? 0) || 0;
    const amount = qty * rate;
    totalAmount += amount;

    const itemGstRate = parseFloat(item.gstRate ?? gstRate) || 0;
    const tax = purchaseTaxLedgers(itemGstRate, purchaseLedger);
    const hsnCode = escapeXml(item.hsnCode || '');
    const hsnDescription = escapeXml(item.hsnDescription || hsnCode);
    const gstApplicable = String(item.gstApplicability || 'Applicable').trim().toLowerCase();
    const isApplicable = gstApplicable !== 'not applicable' && gstApplicable !== 'no';
    const half = itemGstRate / 2;
    const typeOfSupply = escapeXml(item.typeOfSupply || 'Goods');

    stockMasters += `
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <STOCKITEM NAME="${itemName}" ACTION="Create">
              <NAME>${itemName}</NAME>
              <PARENT>${category}</PARENT>
              <BASEUNITS>Qty</BASEUNITS>
              <GSTAPPLICABLE>&#4; ${isApplicable ? 'Applicable' : 'Not Applicable'}</GSTAPPLICABLE>
              <GSTTYPEOFSUPPLY>${typeOfSupply}</GSTTYPEOFSUPPLY>
              <GSTDETAILS.LIST>
                <APPLICABLEFROM>20240401</APPLICABLEFROM>
                <HSNCODE>${hsnCode}</HSNCODE>
                <HSN>${hsnDescription}</HSN>
                <SRCOFGSTDETAILS>${escapeXml(item.gstSource || 'Specify Details Here')}</SRCOFGSTDETAILS>
                <TAXABILITY>${escapeXml(item.gstTaxability || 'Taxable')}</TAXABILITY>
                <STATEWISEDETAILS.LIST>
                  <STATENAME>&#4; Any</STATENAME>
                  <RATEDETAILS.LIST>
                    <GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD>
                    <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
                    <GSTRATE> ${itemGstRate ? half : 0}</GSTRATE>
                    <GSTRATEPERUNIT>0</GSTRATEPERUNIT>
                  </RATEDETAILS.LIST>
                  <RATEDETAILS.LIST>
                    <GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD>
                    <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
                    <GSTRATE> ${itemGstRate ? half : 0}</GSTRATE>
                    <GSTRATEPERUNIT>0</GSTRATEPERUNIT>
                  </RATEDETAILS.LIST>
                </STATEWISEDETAILS.LIST>
              </GSTDETAILS.LIST>
            </STOCKITEM>
          </TALLYMESSAGE>`;

    const serials = (item.serials && item.serials.length)
      ? item.serials
      : (item.serialNo ? [item.serialNo] : []);
    let serialXml = '';
    if (serials.length) {
      serialXml = `
                  <SERIALNUMBERLIST>
                    ${serials.map(s => `  <SERIALNUMBER>${escapeXml(String(s))}</SERIALNUMBER>`).join('\n')}
                  </SERIALNUMBERLIST>`;
    }

    inventoryEntries += `
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>${itemName}</STOCKITEMNAME>
          <GSTSOURCETYPE>Ledger</GSTSOURCETYPE>
          <GSTLEDGERSOURCE>${purchaseLedger}</GSTLEDGERSOURCE>
          <HSNSOURCETYPE>Stock Item</HSNSOURCETYPE>
          <GSTHSNNAME>${hsnCode}</GSTHSNNAME>
          <GSTHSNDESCRIPTION>${hsnDescription}</GSTHSNDESCRIPTION>
          <GSTOVRDNTYPEOFSUPPLY>${typeOfSupply}</GSTOVRDNTYPEOFSUPPLY>
          <GSTRATEINFERAPPLICABILITY>As per Masters/Company</GSTRATEINFERAPPLICABILITY>
          <GSTHSNINFERAPPLICABILITY>As per Masters/Company</GSTHSNINFERAPPLICABILITY>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>
          <RATE>${rate.toFixed(2)}/Qty</RATE>
          <DISCOUNT>0</DISCOUNT>
          <AMOUNT>-${amount.toFixed(2)}</AMOUNT>
          <ACTUALQTY> ${qty} Qty</ACTUALQTY>
          <BILLEDQTY> ${qty} Qty</BILLEDQTY>
          <BATCHALLOCATIONS.LIST>
            <GODOWNNAME>Main Location</GODOWNNAME>
            <BATCHNAME>Primary Batch</BATCHNAME>
            <AMOUNT>-${amount.toFixed(2)}</AMOUNT>
            <ACTUALQTY> ${qty} Qty</ACTUALQTY>
            <BILLEDQTY> ${qty} Qty</BILLEDQTY>${serialXml}
          </BATCHALLOCATIONS.LIST>
          <ACCOUNTINGALLOCATIONS.LIST>
            <LEDGERNAME>${purchaseLedger}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-${amount.toFixed(2)}</AMOUNT>
          </ACCOUNTINGALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>`;

    const itemTax = amount * itemGstRate / 100;
    if (tax.igst) {
      addTaxBucket(tax.igst.name, tax.igst.rate, itemTax);
    } else {
      addTaxBucket(tax.cgst.name, tax.cgst.rate, itemTax / 2);
      addTaxBucket(tax.sgst.name, tax.sgst.rate, itemTax / 2);
    }
  }

  const taxTotal = taxBuckets.reduce((sum, b) => sum + b.amount, 0);
  let grandTotal = totalAmount + taxTotal;

  // Round off (Tally-style): round the grand total to a whole rupee and balance the
  // difference through the ROUND OFF ledger, exactly like a manually entered voucher.
  let roundOffEntry = '';
  let roundOffMaster = '';
  if (voucherData.roundOff === true) {
    const rounded = Math.round(grandTotal);
    const diff = rounded - grandTotal;
    grandTotal = rounded;
    if (diff !== 0) {
      const roundOffLedger = voucherData.roundOffLedger || 'Round Off';
      roundOffEntry = `
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>${escapeXml(roundOffLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>${(-diff).toFixed(2)}</AMOUNT>
        </LEDGERENTRIES.LIST>`;
      if (voucherData.includeRoundOffMaster === true) {
        roundOffMaster = `
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <LEDGER NAME="${escapeXml(roundOffLedger)}" ACTION="Create">
              <NAME>${escapeXml(roundOffLedger)}</NAME>
              <PARENT>Indirect Expenses</PARENT>
            </LEDGER>
          </TALLYMESSAGE>`;
      }
    }
  }

  let taxEntries = '';
  for (const b of taxBuckets) {
    taxEntries += `
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>${escapeXml(b.name)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <ROUNDTYPE>&#4; Not Applicable</ROUNDTYPE>
          <AMOUNT>-${b.amount.toFixed(2)}</AMOUNT>
          <RATEOFINVOICETAX.LIST TYPE="Number">
            <RATEOFINVOICETAX> ${b.rate}</RATEOFINVOICETAX>
          </RATEOFINVOICETAX.LIST>
        </LEDGERENTRIES.LIST>`;
  }

  let partyMaster = '';
  if (voucherData.includePartyLedger !== false) {
    partyMaster = `
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <LEDGER NAME="${partyLedger}" ACTION="Create">
              <NAME>${partyLedger}</NAME>
              <PARENT>Sundry Creditors</PARENT>
            </LEDGER>
          </TALLYMESSAGE>`;
  }

  const billName = refNumber || voucherNumber;
  const partyEntry = `
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>${partyLedger}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
          <AMOUNT>${grandTotal.toFixed(2)}</AMOUNT>${billName ? `
          <BILLALLOCATIONS.LIST>
            <BILLTYPE>New Ref</BILLTYPE>
            <NAME>${billName}</NAME>
            <AMOUNT>${grandTotal.toFixed(2)}</AMOUNT>
          </BILLALLOCATIONS.LIST>` : ''}
        </LEDGERENTRIES.LIST>`;

  return `<ENVELOPE>
    <HEADER>
      <TALLYREQUEST>Import Data</TALLYREQUEST>
    </HEADER>
    <BODY>
      <IMPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>Vouchers</REPORTNAME>
          <STATICVARIABLES>${companyTag}</STATICVARIABLES>
        </REQUESTDESC>
        <REQUESTDATA>
          ${stockMasters}
          ${partyMaster}
          ${roundOffMaster}
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <VOUCHER VCHTYPE="${voucherType}" ACTION="Create" OBJVIEW="Invoice Voucher View">
              <DATE>${dateStr}</DATE>
              <VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME>
              ${voucherNumber ? `<VOUCHERNUMBER>${voucherNumber}</VOUCHERNUMBER>` : ''}
              ${refNumber ? `<REFERENCE>${refNumber}</REFERENCE>` : ''}
              ${poNumber ? `<CURRBASICPURCHASEORDERNO>${poNumber}</CURRBASICPURCHASEORDERNO>` : ''}
              <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
              <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
              <ISINVOICE>Yes</ISINVOICE>
              <NUMBERINGSTYLE>Auto Retain</NUMBERINGSTYLE>
              <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
              <NARRATION>${narration}</NARRATION>
              ${inventoryEntries}
              ${partyEntry}
              ${taxEntries}
              ${roundOffEntry}
            </VOUCHER>
          </TALLYMESSAGE>
        </REQUESTDATA>
      </IMPORTDATA>
    </BODY>
  </ENVELOPE>`;
}

async function pushPurchaseVoucher(voucherData) {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;

  let includePartyLedger = true;
  if (voucherData.partyLedger) {
    try {
      const names = await ledgerNamesSnapshot(false);
      includePartyLedger = !names.includes(voucherData.partyLedger);
    } catch (err) {
      includePartyLedger = true;
    }
  }

  const payload = { ...voucherData, includePartyLedger };
  if (voucherData.roundOff === true) {
    try {
      const names = await ledgerNamesSnapshot(false);
      const existing = names.find(n => /round\s*off/i.test(n));
      payload.roundOffLedger = existing || 'Round Off';
      payload.includeRoundOffMaster = !existing;
      log('PURCHASE-PUSH', `Round off ledger resolved: "${payload.roundOffLedger}" (create master: ${payload.includeRoundOffMaster})`);
    } catch (err) {
      payload.roundOffLedger = 'Round Off';
      payload.includeRoundOffMaster = true;
    }
  }

  const xml = buildPurchaseVoucherXml(payload);
  log('PURCHASE-PUSH', `Pushing purchase voucher to Tally for "${voucherData.partyLedger}" (partyLedgerMaster=${includePartyLedger})`);

  try {
    const response = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml),
    }, xml, 40000);

    const parsed = deepParseResponse(response.body);
    const importResult = parsed?.ENVELOPE?.BODY?.IMPORTDATA?.IMPORTRESULT
      || parsed?.ENVELOPE?.BODY?.DATA?.IMPORTRESULT
      || parsed?.RESPONSE
      || null;

    let tallyLineError = '';
    if (response.body.includes('LINEERROR')) {
      const match = response.body.match(/<LINEERROR>(.*?)<\/LINEERROR>/);
      tallyLineError = match ? match[1] : '';
    }

    if (importResult) {
      const created = parseInt(importResult.CREATED) || 0;
      const altered = parseInt(importResult.ALTERED) || 0;
      const errors = parseInt(importResult.ERRORS) || 0;
      const exceptions = parseInt(importResult.EXCEPTIONS) || 0;

      if (errors > 0 || exceptions > 0) {
        const errMsg = tallyLineError || `Tally reported errors:${errors} exceptions:${exceptions}`;
        logError('Purchase voucher push had errors', errMsg);
        return { success: false, message: errMsg, created, altered, errors, exceptions, synced: false };
      }
      if (created > 0) {
        lastConnectionStatus = { reachable: true, companyFound: true, lastChecked: new Date().toISOString() };
        log('PURCHASE-PUSH', `Purchase voucher created: ${created}`);
        return { success: true, message: 'Purchase voucher created in Tally', created, altered, errors, exceptions, synced: true };
      }
      return { success: false, message: tallyLineError || 'Tally did not create the purchase voucher', created, altered, errors, exceptions, synced: false };
    }

    if (tallyLineError) {
      return { success: false, message: tallyLineError, created: 0, altered: 0, errors: 1, synced: false };
    }
    lastConnectionStatus = { reachable: true, companyFound: true, lastChecked: new Date().toISOString() };
    return { success: true, message: 'Request sent to Tally', created: 0, altered: 0, errors: 0, synced: true, raw: response.body.substring(0, 500) };
  } catch (err) {
    logError('Push purchase voucher HTTP error', err);
    return { success: false, message: err.message, created: 0, altered: 0, errors: 1, synced: false };
  }
}

async function pushPurchaseVoucherWithRetry(voucherData, maxRetries = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log('PURCHASE-PUSH', `Attempt ${attempt}/${maxRetries}`);
    try {
      const result = await pushPurchaseVoucher(voucherData);
      if (result.success && (result.created > 0 || result.errors === 0)) {
        return result;
      }
      lastError = result.message;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      lastError = err.message;
      logError('Purchase push retry error', err);
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return { success: false, message: `Failed after ${maxRetries} attempts: ${lastError}`, created: 0, altered: 0, errors: 1, synced: false };
}

async function fetchPurchaseOrders(company) {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const companyName = company || cfg.company || '';
  const now = new Date();
  let fyStartYear = now.getFullYear();
  if (now.getMonth() < 3) fyStartYear -= 1;
  const fromDate = `01-Apr-${fyStartYear}`;
  const toDate = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

  const xml = `<ENVELOPE>
    <HEADER>
      <TALLYREQUEST>Export Data</TALLYREQUEST>
    </HEADER>
    <BODY>
      <EXPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>Day Book</REPORTNAME>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
            <SVFROMDATE>${fromDate}</SVFROMDATE>
            <SVTODATE>${toDate}</SVTODATE>
          </STATICVARIABLES>
        </REQUESTDESC>
      </EXPORTDATA>
    </BODY>
  </ENVELOPE>`;

  try {
    const response = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml),
    }, xml, 60000);
    const parsed = parser.parse(response.body);
    const body = parsed?.ENVELOPE?.BODY;
    let messages = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE || body?.DATA?.TALLYMESSAGE;
    if (!messages) return { purchaseOrders: [], count: 0 };
    const msgArr = Array.isArray(messages) ? messages : [messages];
    const pos = [];
    for (const msg of msgArr) {
      const vs = msg?.VOUCHER;
      if (!vs) continue;
      const vArr = Array.isArray(vs) ? vs : [vs];
      for (const v of vArr) {
        const vtype = v?.VOUCHERTYPENAME || v?.['@_VOUCHERTYPENAME'] || '';
        if (/purchase order/i.test(vtype)) {
          pos.push({
            number: v?.VOUCHERNUMBER || v?.['@_VOUCHERNUMBER'] || '',
            date: v?.DATE || v?.['@_DATE'] || '',
            party: v?.PARTYLEDGERNAME || v?.PARTYNAME || '',
          });
        }
      }
    }
    pos.sort((a, b) => String(b.number).localeCompare(String(a.number)));
    log('PURCHASE-ORDERS', `Fetched ${pos.length} purchase orders from Tally`);
    return { purchaseOrders: pos, count: pos.length };
  } catch (err) {
    logError('Failed to fetch purchase orders', err);
    return { purchaseOrders: [], count: 0, error: err.message };
  }
}

async function fetchLedgerBalances(company) {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const companyName = company || cfg.company || '';
  try {
    const xml = `<ENVELOPE>
      <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CRSLedgerBals</ID></HEADER>
      <BODY><DESC>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
        <TDL><TDLMESSAGE>
          <COLLECTION NAME="CRSLedgerBals" ISINITIALIZE="Yes">
            <TYPE>Ledger</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
            <NATIVEMETHOD>Parent</NATIVEMETHOD>
            <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE></TDL>
      </DESC></BODY>
    </ENVELOPE>`;
    const response = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml),
    }, xml, 40000);
    if (!response.body || response.body.length < 100) return { ledgers: [], count: 0 };
    const parsed = parser.parse(response.body);
    const collections = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
    if (!collections) return { ledgers: [], count: 0 };
    const collArr = Array.isArray(collections) ? collections : [collections];
    const ledgers = [];
    for (const coll of collArr) {
      const entries = coll?.LEDGER;
      if (!entries) continue;
      const list = Array.isArray(entries) ? entries : [entries];
      for (const entry of list) {
        const name = entry?.NAME || entry?.['@_NAME'] || '';
        if (!name || !name.trim()) continue;
        const rawBal = entry?.CLOSINGBALANCE;
        let closing = null;
        if (rawBal && typeof rawBal === 'object') closing = rawBal['#text'] ?? '';
        else if (rawBal !== undefined && rawBal !== null) closing = rawBal;
        ledgers.push({
          name: name.trim(),
          parent: cleanMasterParent(entry?.PARENT?.['#text'] || entry?.PARENT || ''),
          closing,
        });
      }
    }
    log('LEDGER-BALS', `Fetched ${ledgers.length} ledger balances from Tally`);
    return { ledgers, count: ledgers.length };
  } catch (err) {
    logError('Failed to fetch ledger balances', err);
    return { ledgers: [], count: 0, error: err.message };
  }
}

async function getLedgerBalance(name, company) {
  if (!name) return null;
  const r = await fetchLedgerBalances(company);
  const found = (r.ledgers || []).find(l => l.name === name);
  return found ? found : null;
}

// Bank ledgers = ledgers created under the "Bank Accounts" / "Bank OD A/c" groups
// (used for the Receipt / Payment vouchers). Returns the configured TALLY_BANK_LEDGER
// first when it is also present in Tally, so the UI can show the saved selection.
async function fetchBankLedgers() {
  const cfg = getTallyConfig();
  const result = await fetchLedgers();
  const bankLedgers = (result.ledgers || [])
    .filter(l => /bank/i.test(l.parent))
    .map(l => l.name)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a.localeCompare(b));
  return {
    success: true,
    bankLedgers,
    count: bankLedgers.length,
    selected: cfg.bankLedger,
  };
}

// Receipt voucher (money received from a customer against a sales invoice). Mirrors
// the manual TallyPrime entry: party credited (+amount) with a bill allocation to the
// outstanding sales voucher, bank debited (-amount) with a bank allocation. Ledger
// entries live in ALLLEDGERENTRIES.LIST for accounting vouchers.
function buildReceiptVoucherXml(voucherData) {
  const cfg = getTallyConfig();
  let dateStr = voucherData.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (!/^\d{8}$/.test(dateStr)) {
    dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
  const amount = parseFloat(voucherData.amount) || 0;
  const partyLedger = escapeXml(voucherData.partyLedger || voucherData.partyName || 'Walk-in Customer');
  const bankLedger = escapeXml(voucherData.bankLedger || cfg.bankLedger || '');
  const voucherNumber = escapeXml(voucherData.voucherNumber || '');
  const refVoucherNumber = escapeXml(voucherData.refVoucherNumber || '');
  const narration = escapeXml(voucherData.narration || 'Receipt via CRS');
  const voucherType = escapeXml(voucherData.voucherType || 'Receipt');

  if (!bankLedger) {
    return { success: false, message: 'No bank ledger configured. Select a bank ledger in Tally settings first.', xml: null };
  }

  let companyTag = '';
  if (cfg.company && cfg.company.trim()) {
    companyTag = `<SVCURRENTCOMPANY>${escapeXml(cfg.company)}</SVCURRENTCOMPANY>`;
  }

  const amountStr = amount.toFixed(2);
  const billAlloc = refVoucherNumber ? `
        <BILLALLOCATIONS.LIST>
          <BILLTYPE>Agnst Ref</BILLTYPE>
          <NAME>${refVoucherNumber}</NAME>
          <AMOUNT>${amountStr}</AMOUNT>
        </BILLALLOCATIONS.LIST>` : '';

  const xml = `<ENVELOPE>
    <HEADER>
      <TALLYREQUEST>Import Data</TALLYREQUEST>
    </HEADER>
    <BODY>
      <IMPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>Vouchers</REPORTNAME>
          <STATICVARIABLES>${companyTag}</STATICVARIABLES>
        </REQUESTDESC>
        <REQUESTDATA>
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <VOUCHER VCHTYPE="${voucherType}" ACTION="Create" OBJVIEW="Accounting Voucher View">
              <DATE>${dateStr}</DATE>
              <REFERENCEDATE>${dateStr}</REFERENCEDATE>
              <VCHSTATUSDATE>${dateStr}</VCHSTATUSDATE>
              <VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME>
              ${voucherNumber ? `<VOUCHERNUMBER>${voucherNumber}</VOUCHERNUMBER>` : ''}
              <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
              <BASICBUYERNAME>${partyLedger}</BASICBUYERNAME>
              <NUMBERINGSTYLE>Auto Retain</NUMBERINGSTYLE>
              <VCHENTRYMODE>Account Invoice</VCHENTRYMODE>
              <ISINVOICE>No</ISINVOICE>
              <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
              <NARRATION>${narration}</NARRATION>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>${partyLedger}</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
                <AMOUNT>${amountStr}</AMOUNT>${billAlloc}
              </ALLLEDGERENTRIES.LIST>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>${bankLedger}</LEDGERNAME>
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <AMOUNT>-${amountStr}</AMOUNT>
                <BANKALLOCATIONS.LIST>
                  <NAME>${bankLedger}</NAME>
                  <AMOUNT>-${amountStr}</AMOUNT>
                </BANKALLOCATIONS.LIST>
              </ALLLEDGERENTRIES.LIST>
            </VOUCHER>
          </TALLYMESSAGE>
        </REQUESTDATA>
      </IMPORTDATA>
    </BODY>
  </ENVELOPE>`;
  return { success: true, xml };
}

async function pushReceiptVoucher(voucherData) {
  const cfg = getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  log('PUSH', `Pushing receipt voucher to Tally: ${voucherData.voucherNumber || '(auto)'}`);

  const built = buildReceiptVoucherXml(voucherData);
  if (!built.success) return built;
  const xml = built.xml;
  log('PUSH', `XML length: ${xml.length} bytes`);

  try {
    const response = await rawHttpRequest(url, 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml),
    }, xml);
    const parsed = deepParseResponse(response.body);
    const importResult = parsed?.ENVELOPE?.BODY?.IMPORTDATA?.IMPORTRESULT
      || parsed?.ENVELOPE?.BODY?.DATA?.IMPORTRESULT
      || parsed?.RESPONSE
      || null;

    let tallyLineError = '';
    if (response.body.includes('LINEERROR')) {
      const match = response.body.match(/<LINEERROR>(.*?)<\/LINEERROR>/);
      tallyLineError = match ? match[1] : '';
    }

    if (importResult) {
      const created = parseInt(importResult.CREATED) || 0;
      const errors = parseInt(importResult.ERRORS) || 0;
      const exceptions = parseInt(importResult.EXCEPTIONS) || 0;
      const lastVchId = importResult.LASTVCHID || null;
      const hasProblems = errors > 0 || exceptions > 0;
      const errMsg = tallyLineError || `Tally reported errors:${errors} exceptions:${exceptions}`;

      if (created > 0 && hasProblems) {
        return { success: false, message: `Receipt created but with errors: ${errMsg}`, created, lastVchId, errors, exceptions, synced: false };
      }
      if (created > 0) {
        return { success: true, message: 'Receipt voucher pushed to Tally', created, lastVchId, errors: 0, exceptions: 0, synced: true };
      }
      if (hasProblems) {
        logError('Push receipt voucher failed', errMsg);
        return { success: false, message: errMsg, created: 0, errors, exceptions, synced: false };
      }
      return { success: created > 0, message: created > 0 ? 'Receipt voucher pushed to Tally' : 'No receipt created', created, lastVchId, errors: 0, exceptions: 0, synced: created > 0 };
    }

    if (tallyLineError) {
      logError('Push receipt voucher LINEERROR', tallyLineError);
      return { success: false, message: tallyLineError, created: 0, errors: 1, synced: false };
    }

    return { success: true, message: 'Request sent to Tally', created: 0, errors: 0, synced: false, raw: response.body.substring(0, 500) };
  } catch (err) {
    logError('Push receipt voucher HTTP error', err);
    return { success: false, message: err.message, created: 0, errors: 1, synced: false };
  }
}

async function pushReceiptVoucherWithRetry(voucherData, maxRetries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log('PUSH', `Attempt ${attempt}/${maxRetries} for receipt: ${voucherData.voucherNumber || '(auto)'}`);
    try {
      const result = await pushReceiptVoucher(voucherData);
      if (result.success) {
        lastConnectionStatus = { reachable: true, companyFound: true, lastChecked: new Date().toISOString() };
        return result;
      }
      lastError = result.message;
      if (attempt < maxRetries) {
        const delay = 1500 * attempt;
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      lastError = err.message;
      if (attempt < maxRetries) {
        const delay = 1500 * attempt;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return { success: false, message: lastError || 'Failed to push receipt voucher', created: 0, errors: 1, synced: false };
}

// Pre-push validation: verifies Tally is reachable, all required ledgers exist, the
// stock items referenced will be found, and the GST computation matches Tally's own
// calculation (per-line base x rate) so the tax-mismatch warning is never triggered.
async function validatePrePush(voucherData = {}) {
  const cfg = getTallyConfig();
  const warnings = [];
  const errors = [];

  // 1. Reachability
  let reachable = false;
  try {
    const ping = await pingTally();
    reachable = !!ping.reachable;
  } catch (_) { reachable = false; }
  if (!reachable) {
    errors.push(`Tally is not reachable at ${cfg.host}:${cfg.port}`);
  }

  // 2. Required ledgers exist
  const required = new Set();
  const salesLedger = cfg.salesLedger || 'SALES @ 18%';
  required.add(salesLedger);
  required.add(voucherData.cgstLedger || cfg.cgstLedger || 'OUTPUT CGST @ 9%');
  required.add(voucherData.sgstLedger || cfg.sgstLedger || 'OUTPUT SGST @ 9%');
  const igstLedger = voucherData.igstLedger || cfg.igstLedger || 'OUTPUT IGST @ 18%';
  required.add(igstLedger);
  if (voucherData.voucherType === 'Receipt' || voucherData.receipt) {
    required.add(voucherData.bankLedger || cfg.bankLedger || '');
  }
  if (voucherData.roundOff) {
    required.add(voucherData.roundOffLedger || 'Round Off');
  }

  let names = [];
  try {
    const snap = await ledgerNamesSnapshot(false);
    names = snap || [];
  } catch (_) { /* keep empty */ }

  const existingNames = new Set(names.map(n => String(n).toLowerCase()));
  const missing = [];
  for (const ledger of required) {
    if (!ledger) continue;
    if (!existingNames.has(String(ledger).toLowerCase())) missing.push(ledger);
  }
  if (missing.length) {
    errors.push(`Ledger(s) not found in Tally (will need to be created): ${missing.join(', ')}`);
  }

  // 3. GST computation vs Tally (never trigger the tax-mismatch warning)
  const items = voucherData.items || [];
  const defaultTaxRate = parseFloat(voucherData.taxRate) || 18;
  const buckets = new Map();
  for (const item of items) {
    const qty = parseInt(item.qty || item.quantity) || 1;
    const rate = parseFloat(item.price || item.unitPrice) || 0;
    const disc = parseFloat(item.discount || 0);
    const amount = (rate - disc) * qty;
    const tr = parseFloat(item.taxRate) || defaultTaxRate;
    if (!buckets.has(tr)) buckets.set(tr, 0);
    buckets.set(tr, buckets.get(tr) + amount);
  }
  let computedTax = 0;
  for (const [tr, base] of buckets) {
    computedTax += base * tr / 100;
  }

  // Explicit taxAmount mismatch (when caller supplies one) is the #1 cause of the
  // "Amount of Taxes & 18%" mismatch warning - catch it before the push.
  if (voucherData.taxAmount !== undefined && voucherData.taxAmount !== null) {
    const declared = parseFloat(voucherData.taxAmount) || 0;
    if (Math.abs(declared - computedTax) > 0.005) {
      errors.push(`Tax mismatch: declared tax ${declared.toFixed(2)} does not match Tally's computation ${computedTax.toFixed(2)} (${[...buckets.entries()].map(([r, b]) => `${b.toFixed(2)} x ${r}%`).join(' + ')}).`);
    }
  }

  // 4. GST override fields that Tally would reject / warn about
  for (const item of items) {
    const overrideFields = ['GSTOVRDNTAXABILITY', 'GSTOVRDNELIGIBLEITC', 'GSTOVRDNISREVCHARGEAPPL', 'GSTOVRDNISRCM', 'GSTOVRDNTYPEOFSUPPLY'];
    for (const f of overrideFields) {
      if (item[f] !== undefined && item[f] !== null) {
        warnings.push(`Item "${item.name || item.description || '?'}" carries override field ${f} - the manual voucher never sets it; consider removing it to avoid a Tally tax warning.`);
      }
    }
  }

  // 5. Stock items (for non-skip lines) - warn if the referenced item is unknown.
  // Only attempted when Tally responded, since the serial map fetch is expensive.
  if (reachable) {
    try {
      const serialMap = await fetchStockSerialMap();
      for (const item of items) {
        if (item.skipInventory) continue;
        if (item.serialNumber && !serialMap[item.serialNumber]) {
          warnings.push(`Serial ${item.serialNumber} was not found in Tally's stock items; the push will use the CRS name "${item.name || item.description}".`);
        }
      }
    } catch (_) { /* serial check is best-effort */ }
  }

  const taxDetail = {
    computedTax: round2(computedTax),
    buckets: [...buckets.entries()].map(([r, b]) => ({ rate: r, base: round2(b), tax: round2(b * r / 100) })),
  };

  return { ok: errors.length === 0, reachable, errors, warnings, taxDetail };
}

function round2(n) {
  return Math.round((parseFloat(n) + Number.EPSILON) * 100) / 100;
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
  pushSalesVoucher,
  pushSalesVoucherWithRetry,
  buildSalesVoucherXml,
  pingTally,
  getConnectionStatus,
  lookupStockItemBySerial,
  fetchStockSerialMap,
  clearSerialCache,
  buildStockItemMastersXml,
  pushStockItemsToTally,
  pushStockItemsToTallyWithRetry,
  isPermanentStockError,
  fetchStockCategories,
  fetchLedgers,
  pushLedgerToTally,
  buildLedgerCreateXml,
  buildPurchaseVoucherXml,
  pushPurchaseVoucher,
  pushPurchaseVoucherWithRetry,
  fetchPurchaseOrders,
  fetchLedgerBalances,
  getLedgerBalance,
  fetchCompanyInfo,
  fetchBankLedgers,
  buildReceiptVoucherXml,
  pushReceiptVoucher,
  pushReceiptVoucherWithRetry,
  validatePrePush,
};
