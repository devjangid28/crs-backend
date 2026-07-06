function fmt(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

function generateInwardReceiptHtml(ticket, settings) {
  const estCost = parseFloat(ticket.estimated_price || ticket.estimatedPrice || ticket.estimated_cost || ticket.estimatedCost || 0);
  const address = ticket.customer_address || ticket.service_address || '';
  const city = ticket.city || '';
  const pincode = ticket.pincode || '';
  const state = ticket.state || '';

  const formContent = `
  <div class="form-container">
    <div class="header-row">
      <div class="logo-section">
        ${settings.logo ? `<img src="${settings.logo}" alt="Logo" class="logo" />` : ''}
      </div>
      <div class="company-info">
        <div class="form-title">REPAIR ORDER FORM</div>
        <div class="company-address">
          ${settings.address || ''}<br/>
          ${[settings.city, settings.state].filter(Boolean).join(', ')}${settings.pincode ? ' - ' + settings.pincode : ''}<br/>
          ${settings.phone || ''}
        </div>
      </div>
    </div>

    <div class="row" style="min-height:28px;">
      <div class="cell" style="width:100%;"><span class="label">INWARD NO. : ${ticket.ticket_id || ticket.id || ''}</span></div>
    </div>

    <div class="row" style="min-height:28px;">
      <div class="cell" style="width:30%;"><span class="label">DATE : ${fmt(ticket.created_at) || ''}</span></div>
      <div class="cell" style="width:35%;"><span class="label">SERVICE TYPE : ${ticket.issue_category || ''}</span></div>
      <div class="cell" style="width:35%;"><span class="label">BRAND : ${ticket.brand || ''}</span></div>
    </div>

    <div class="row" style="min-height:90px;">
      <div class="cell" style="width:50%;flex-direction:column;align-items:flex-start;padding:8px;">
        <span class="label">CUSTOMER NAME & ADDRESS : ${ticket.customer_name || ''}${address ? ', ' + address : ''}${city ? ', ' + city : ''}${pincode ? ' - ' + pincode : ''}</span>
      </div>
      <div class="cell" style="width:50%;flex-direction:column;align-items:stretch;padding:0;">
        <div style="border-bottom:1px solid #000;padding:8px;min-height:30px;">
          <span class="label">MODEL NO. ${ticket.model || ''}</span>
        </div>
        <div style="border-bottom:1px solid #000;padding:8px;min-height:30px;">
          <span class="label">SERIAL NO. ${ticket.serial_number || ''}</span>
        </div>
        <div style="padding:8px;min-height:30px;">
          <span class="label">WARRANTY ${ticket.warranty ? 'YES' : 'NO'}</span>
        </div>
      </div>
    </div>

    <div class="row" style="min-height:28px;">
      <div class="cell" style="width:100%;"><span class="label">CUSTOMER MOBILE : ${ticket.customer_phone || ''}</span></div>
    </div>

    <div class="row" style="min-height:28px;">
      <div class="cell" style="width:100%;flex-direction:column;align-items:flex-start;padding:8px;">
        <span class="label">CUSTOMER COMPLAINT : ${ticket.problem_description || ''}</span>
      </div>
    </div>

    <div class="row" style="min-height:28px;">
      <div class="cell" style="width:100%;flex-direction:column;align-items:flex-start;padding:8px;">
        <span class="label">ISSUE IF ANY : ${ticket.issue || ticket.problem_description || ''}</span>
      </div>
    </div>

    <div class="row" style="min-height:14px;">
      <div class="cell" style="width:30%;flex-direction:column;align-items:flex-start;padding:2px 8px;">
        <span class="label">ACCESSORY LIST : ${ticket.accessories || ''}</span>
      </div>
      <div class="cell" style="width:70%;padding:2px 8px;"></div>
    </div>

    <div class="row" style="min-height:28px;">
      <div class="cell" style="width:33.33%;"><span class="label">BODY DAMAGE :${ticket.body_damage || 'NO'}</span></div>
      <div class="cell" style="width:33.33%;"><span class="label">DATA BACKUP : ${ticket.data_backup || 'NO'}</span></div>
      <div class="cell" style="width:33.33%;"><span class="label">ESTIMATE PRICE : ${estCost ? estCost.toFixed(2) : ''}</span></div>
    </div>

    <div class="terms-section">
      <div class="terms-title">TERMS AND CONDITIONS :</div>
      <div>
        <strong>1.</strong> Product warranty is subject to company warranty policies.<br/>
        <strong>2.</strong> Blue Chip Computer System is not responsible for pre-existing damage, missing parts, or related issues.<br/>
        <strong>3.</strong> Data backup is the customer's responsibility; we are not liable for data loss.<br/>
        <strong>4.</strong> Repair warranty is valid for 30 days for the same issue only.<br/>
        <strong>5.</strong> ₹250 inspection & ₹800 diagnostic charges applicable.<br/>
        <strong>6.</strong> Additional charges apply for parts, accessories, software, OS installation, and other services.<br/>
        <strong>7.</strong> Devices must be collected within 30 days of repair completion.<br/>
        <strong>8.</strong> After 30 days, Blue Chip Computer System is not responsible for the device, accessories, data, or storage condition.
      </div>
    </div>

    <div style="border-top: 2px solid #000; width: 100%;"></div>

    <div class="signature-row">
      <div class="signature-cell" style="width:50%; justify-content: flex-start; align-items: flex-start;">
        <div style="font-weight: bold; font-size: 8pt; margin-bottom: 10px; text-align: left; line-height: 1.4;">
          &#9744; I have received my device in good condition after repair/service.
        </div>
        <div style="font-weight: bold; font-size: 8pt; margin-bottom: 15px; text-align: left; line-height: 1.4;">
          &#9744; I have collected my device and approve closure of this service job.
        </div>
        <div class="signature-label" style="margin-top: auto; text-align: center; width: 100%;">Customer Signatory</div>
      </div>
      <div class="signature-cell" style="width:50%;">
        <div class="company-name">${settings.company_name || 'BLUECHIP COMPUTER SERVICES'}</div>
        <div class="signature-label">Authorized Signatory</div>
      </div>
    </div>
  </div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Repair Order Form - ${ticket.ticket_id || ticket.id}</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, sans-serif;
      font-size: 9pt;
      color: #000;
      line-height: 1.3;
      margin: 0;
      padding: 0;
      width: 210mm;
      height: 297mm;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .page-wrapper {
      width: 185mm;
      display: flex;
    }
    .copy-wrapper {
      flex: 1;
      display: flex;
    }
    .form-container {
      border: 2px solid #000;
      width: 100%;
    }
    .header-row {
      display: flex;
      border-bottom: 2px solid #000;
    }
    .logo-section {
      width: 35%;
      border-right: 2px solid #000;
      padding: 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      max-width: 140px;
      max-height: 80px;
      object-fit: contain;
      margin-bottom: 5px;
    }
    .company-info {
      width: 65%;
      padding: 8px 10px;
    }
    .form-title {
      font-size: 12pt;
      font-weight: bold;
      text-align: left;
      margin-bottom: 5px;
      text-transform: uppercase;
    }
    .company-address {
      font-size: 9pt;
      font-weight: bold;
      line-height: 1.4;
    }
    .row {
      display: flex;
      border-bottom: 1px solid #000;
    }
    .cell {
      padding: 5px 8px;
      border-right: 1px solid #000;
      display: flex;
      align-items: center;
    }
    .cell:last-child { border-right: none; }
    .label {
      font-weight: bold;
      font-size: 9pt;
      text-transform: uppercase;
    }
    .signature-row {
      display: flex;
      border-bottom: 1px solid #000;
      min-height: 70px;
    }
    .signature-cell {
      padding: 10px;
      border-right: 1px solid #000;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      align-items: center;
    }
    .signature-cell:last-child { border-right: none; }
    .signature-label {
      font-weight: bold;
      font-size: 9pt;
      margin-top: 10px;
    }
    .company-name {
      font-size: 9pt;
      font-weight: bold;
      text-align: center;
      margin-bottom: 5px;
    }
    .terms-section {
      padding: 8px 10px;
      font-size: 7.5pt;
      line-height: 1.5;
    }
    .terms-title {
      font-weight: bold;
      font-size: 9pt;
      text-transform: uppercase;
      margin-bottom: 5px;
    }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .form-container { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="page-wrapper">
    <div class="copy-wrapper">${formContent}</div>
  </div>
</body>
</html>`;
}

module.exports = { generateInwardReceiptHtml };
