const fs = require("fs");
const ocr = require("../src/services/invoiceOcr");
(async () => {
  const identity = await ocr.companyIdentity.buildCompanyIdentity({});
  const r = await ocr.extractInvoice({ buffer: fs.readFileSync(process.argv[2]), fileName: "jbr.pdf", mimeType: "application/pdf", ownCompany: {}, identity, checkDuplicates: false });
  console.log(JSON.stringify(r.purchaseDraft, null, 1));
})();
