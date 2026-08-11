const admin = require('firebase-admin');
const { getMessaging } = require('firebase-admin/messaging');
console.log('apps before init:', admin.apps.length);
if (admin.apps.length === 0) {
  admin.initializeApp({ credential: admin.cert(require('./serviceAccountKey.json')) });
}
console.log('apps after init:', admin.apps.length, admin.apps.map((a) => a.name));
try {
  const m = getMessaging();
  console.log('getMessaging() no-arg OK');
} catch (e) {
  console.log('getMessaging() no-arg FAILED:', e.message);
}
const app0 = admin.app();
const m2 = getMessaging(app0);
console.log('getMessaging(default app) OK');
