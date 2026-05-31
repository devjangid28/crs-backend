const validateTicket = (req, res, next) => {
  const {
    customerName, primaryPhone, customerPhone, deviceType, brand, model, issueCategory,
    problemDescription, issue
  } = req.body;

  const errors = [];

  if (!customerName || !customerName.trim()) {
    errors.push({ field: 'customerName', message: 'Customer Name is required' });
  }
  if ((!primaryPhone || !primaryPhone.trim()) && (!customerPhone || !customerPhone.trim())) {
    errors.push({ field: 'primaryPhone', message: 'Phone Number is required' });
  }
  if (!deviceType || !deviceType.trim()) {
    errors.push({ field: 'deviceType', message: 'Device Type is required' });
  }
  if (!brand || !brand.trim()) {
    errors.push({ field: 'brand', message: 'Brand is required' });
  }
  if (!model || !model.trim()) {
    errors.push({ field: 'model', message: 'Model is required' });
  }
  if (!issueCategory || !issueCategory.trim()) {
    errors.push({ field: 'issueCategory', message: 'Issue Category is required' });
  }
  if ((!problemDescription || !problemDescription.trim()) && (!issue || !issue.trim())) {
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
