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
  const deviceType = pick(b, ['deviceType', 'device_type']);
  const brand = pick(b, ['brand']);
  const model = pick(b, ['model']);
  const issueCategory = pick(b, ['issueCategory', 'issue_category']);
  const problemDescription = pick(b, ['problemDescription', 'problem_description', 'issue']);

  const errors = [];

  if (!customerName || !String(customerName).trim()) {
    errors.push({ field: 'customerName', message: 'Customer Name is required' });
  }
  if (!primaryPhone || !String(primaryPhone).trim()) {
    errors.push({ field: 'primaryPhone', message: 'Phone Number is required' });
  }
  if (!deviceType || !String(deviceType).trim()) {
    errors.push({ field: 'deviceType', message: 'Device Type is required' });
  }
  if (!brand || !String(brand).trim()) {
    errors.push({ field: 'brand', message: 'Brand is required' });
  }
  if (!model || !String(model).trim()) {
    errors.push({ field: 'model', message: 'Model is required' });
  }
  if (!issueCategory || !String(issueCategory).trim()) {
    errors.push({ field: 'issueCategory', message: 'Issue Category is required' });
  }
  if (!problemDescription || !String(problemDescription).trim()) {
    errors.push({ field: 'problemDescription', message: 'Problem Description is required' });
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
