import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  await page.setContent('<html><body style="margin:0;width:256px;height:256px;background:#16734c;border-radius:44px;display:grid;place-items:center;color:white"><i data-lucide="square-terminal"></i></body></html>');
  await page.addScriptTag({ path: path.resolve('public/lucide.js') });
  await page.evaluate(() => { lucide.createIcons(); const svg = document.querySelector('svg'); svg.style.width = '174px'; svg.style.height = '174px'; svg.setAttribute('stroke-width', '1.5'); });
  await fs.mkdir('assets', { recursive: true });
  const png = await page.screenshot({ path: 'assets/icon.png', omitBackground: true });
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  await fs.writeFile('assets/icon.ico', Buffer.concat([header, png]));
} finally { await browser.close(); }
