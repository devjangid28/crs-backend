require('dotenv').config({ path: 'C:/Users/DELL/OneDrive/Desktop/CRS Software/crs-backend/.env' });

const WABA = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const BASE = `https://graph.facebook.com/v21.0/${WABA}`;

async function call(url, options) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
  });
  return { status: res.status, body: await res.json() };
}

async function findTemplate(name) {
  const r = await call(`${BASE}/message_templates?fields=name,id,status&limit=100`);
  if (r.body.error) return { error: r.body.error };
  return r.body.data.find(t => t.name === name) || null;
}

async function deleteTemplate(name) {
  const t = await findTemplate(name);
  if (!t) return { skipped: true, id: null };
  const r = await call(`${BASE}/message_templates/${t.id}`, { method: 'DELETE' });
  return { skipped: false, id: t.id, status: r.status, body: r.body };
}

async function createTemplate(payload) {
  const r = await call(`${BASE}/message_templates`, { method: 'POST', body: JSON.stringify(payload) });
  return { status: r.status, body: r.body };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('--- DELETE device_collection ---');
  console.log(JSON.stringify(await deleteTemplate('device_collection'), null, 2));
  await sleep(2000);

  console.log('--- DELETE service_invoice ---');
  console.log(JSON.stringify(await deleteTemplate('service_invoice'), null, 2));
  await sleep(2000);

  console.log('--- CREATE device_collection (clean URL) ---');
  const dcPayload = {
    name: 'device_collection',
    language: 'en_IN',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hello {{1}}, your device is repaired and is ready for collection. Click the button below to complete the collection process.',
        example: { body_text: [['Rohit Sharma']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Collection Link',
            url: 'https://crs-api.bccsgroup.in/collect/{{1}}',
          },
        ],
      },
    ],
  };
  console.log(JSON.stringify(await createTemplate(dcPayload), null, 2));

  console.log('--- CREATE service_invoice (en_IN + document header) ---');
  const siPayload = {
    name: 'service_invoice',
    language: 'en_IN',
    category: 'UTILITY',
    components: [
      {
        type: 'HEADER',
        format: 'DOCUMENT',
        example: { header_handle: ['ServiceInvoice_sample.pdf'] },
      },
      {
        type: 'BODY',
        text: 'Dear {{1}}, your service invoice for ticket {{2}} is attached with this message. Please keep this invoice for your records. Thank you for choosing us.',
        example: { body_text: [['Rohit Sharma', 'TKT-2026-SEP-0011']] },
      },
    ],
  };
  console.log(JSON.stringify(await createTemplate(siPayload), null, 2));

  await sleep(3000);
  console.log('--- FINAL LIST STATE ---');
  const r = await call(`${BASE}/message_templates?fields=name,status,language&limit=100`);
  (r.body.data || []).filter(t => t.name === 'device_collection' || t.name === 'service_invoice')
    .forEach(t => console.log(t.name, '|', t.status, '|', t.language));
})().catch(e => { console.error('SCRIPT ERROR', e.message); process.exit(1); });