require('dotenv').config({ path: 'C:/Users/DELL/OneDrive/Desktop/CRS Software/crs-backend/.env' });
const WABA = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const BASE = `https://graph.facebook.com/v21.0/${WABA}`;

async function createTemplate(payload) {
  const res = await fetch(`${BASE}/message_templates`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function tryCreate(label, payloads, attempts) {
  for (let i = 0; i < attempts.length; i++) {
    const r = await createTemplate({ ...payloads, ...attempts[i] });
    console.log(`--- ${label} attempt ${i + 1}: status=${r.status}`);
    console.log(JSON.stringify(r.body));
    if (r.status === 200) return true;
  }
  return false;
}

(async () => {
  const dcBase = {
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
          { type: 'URL', text: 'Collection Link', url: 'https://crs-api.bccsgroup.in/collect/{{1}}' },
        ],
      },
    ],
  };
  const dcVariants = [
    { components: [...dcBase.components.slice(0, 1), { ...dcBase.components[1], example: [ { type: 'URL', text: 'Collection Link', example: ['103/sampletoken'] } ] }] },
    { components: [...dcBase.components.slice(0, 1), { ...dcBase.components[1], example: { button_text: [['103/sampletoken']] } }] },
  ];
  await tryCreate('CREATE device_collection', dcBase, dcVariants);

  const siBase = {
    name: 'service_invoice',
    language: 'en_IN',
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'DOCUMENT' },
      {
        type: 'BODY',
        text: 'Dear {{1}}, your service invoice for ticket {{2}} is attached with this message. Please keep this invoice for your records. Thank you for choosing us.',
        example: { body_text: [['Rohit Sharma', 'TKT-2026-SEP-0011']] },
      },
    ],
  };
  await tryCreate('CREATE service_invoice', siBase, [{}]);
})().catch(e => { console.error(e); process.exit(1); });