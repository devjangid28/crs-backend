const pick = (body, names) => {
  for (const n of names) {
    const v = body[n];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};

const validateTicket = (req, res, next) => {
  const b = req.body;
  const customerName = pick(b, ['customerName', 'customer_name']);
  const primaryPhone = pick(b, ['primaryPhone', 'primary_phone', 'customerPhone', 'customer_phone', 'phone', 'mobile_number']);

  const errors = [];

  if (!customerName || !String(customerName).trim()) {
    errors.push({ field: 'customerName', message: 'Customer Name is required' });
  }
  if (!primaryPhone || !String(primaryPhone).trim()) {
    errors.push({ field: 'primaryPhone', message: 'Phone Number is required' });
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  next();
};

const validateCustomer = (req, res, next) => {
  const { name, phone } = req.body;
  const errors = [];

  if (!name || !name.trim()) {
    errors.push({ field: 'name', message: 'Customer name is required' });
  }
  if (!phone || !phone.trim()) {
    errors.push({ field: 'phone', message: 'Phone number is required' });
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  next();
};

const validateInvoice = (req, res, next) => {
  const { customerName, items } = req.body;
  const errors = [];

  if (!customerName || !customerName.trim()) {
    errors.push({ field: 'customerName', message: 'Customer name is required' });
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    errors.push({ field: 'items', message: 'At least one invoice item is required' });
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  next();
};

module.exports = { validateTicket, validateCustomer, validateInvoice };
