import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const directory = `artifacts/ground-contact-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5173');
  const result = await page.evaluate(async () => (await import('/scripts/grounding-probe.ts')).verifyGrounding());
  await writeFile(`${directory}/report.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} finally { await browser.close(); }
