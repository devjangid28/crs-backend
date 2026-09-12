const fetch = require('node-fetch');
(async () => {
  try {
    const res = await fetch('http://localhost:5000/api/tickets/102', { method: 'DELETE' });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Body:', text.substring(0, 2000));
  } catch (e) {
    console.error('Request failed:', e.message);
  }
})();