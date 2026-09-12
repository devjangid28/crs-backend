require('dotenv').config({ path: 'C:/Users/DELL/OneDrive/Desktop/CRS Software/crs-backend/.env' });
const WABA = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

async function listTemplates() {
  const url = `https://graph.facebook.com/v21.0/${WABA}/message_templates?fields=id,name,status&limit=100`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  return res.json();
}
async function call(url, opts) {
  const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } });
  return { status: res.status, body: await res.json() };
}

(async () => {
  const list = await listTemplates();
  const targets = (list.data || []).filter(t => t.name === 'device_collection' || t.name === 'service_invoice');

  for (const t of targets) {
    console.log('=== DELETE', t.name, 'id', t.id, '=== ');
    const attempts = [
      `https://graph.facebook.com/v21.0/${WABA}/message_templates/${t.id}`,
      `https://graph.facebook.com/v21.0/${WABA}/message_templates?name=${t.name}`,
      `https://graph.facebook.com/v21.0/${WABA}/message_templates?name=${t.name}&access_token=${TOKEN}`,
    ];
    for (let i = 0; i < attempts.length; i++) {
      const r = await call(attempts[i], { method: 'DELETE' });
      console.log(`  attempt ${i + 1}: status=${r.status}`, JSON.stringify(r.body));
      if (r.status === 200) break;
    }
  }
})().catch(e => { console.error(e); process.exit(1); });