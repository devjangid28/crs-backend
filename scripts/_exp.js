// Experiment: targeted crop + upscale OCR of the header band.
const fs = require('fs');
const sharp = require('sharp');
const ocrEngine = require('../src/services/invoiceOcr/ocrEngine');

(async () => {
  const file = process.argv[2];
  const region = process.argv[3]; // 'top' | 'right' | 'left' | 'band'
  let input = sharp(fs.readFileSync(file));
  const meta = await input.metadata();
  const w = meta.width, h = meta.height;
  console.log('size', w, h);
  let crop;
  if (region === 'top') crop = { left: 0, top: Math.round(h * 0.12), width: w, height: Math.round(h * 0.35) };
  else if (region === 'right') crop = { left: Math.round(w * 0.57), top: Math.round(h * 0.10), width: w - Math.round(w * 0.57), height: Math.round(h * 0.22) };
  else if (region === 'left') crop = { left: 0, top: Math.round(h * 0.10), width: Math.round(w * 0.57), height: Math.round(h * 0.22) };
  else if (process.argv[4] && process.argv[4] === 'custom') {
    const x0 = Number(process.argv[5] || 0.0);
    const y0 = Number(process.argv[6] || 0.14);
    const x1 = Number(process.argv[7] || 0.66);
    const y1 = Number(process.argv[8] || 0.30);
    const sc = Number(process.argv[9] || 4);
    crop = { left: Math.round(w * x0), top: Math.round(h * y0), width: Math.max(2, Math.round(w * (x1 - x0))), height: Math.max(2, Math.round(h * (y1 - y0))), scale: sc };
  }
  else crop = { left: 0, top: Math.round(h * 0.08), width: w, height: Math.round(h * 0.45) };
  const { data } = await input.extract(crop).resize({ width: Math.round(crop.width * (crop.scale || 3)) }).jpeg().toBuffer();
  const recognised = await ocrEngine.recognizePage(data);
  for (const [i, l] of recognised.lines.entries()) {
    console.log(String(i).padStart(3), 'c=' + String(Math.round(l.confidence)).padStart(3), '|', l.text);
  }
  await ocrEngine.shutdown();
})().catch((e) => { console.error(e); process.exit(1); });