import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://127.0.0.1:5173';
const directory = `artifacts/autohunt-browser-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [], samples = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(url);
  await page.locator('[data-starter="4"]').click();
  await page.locator('#ow-host[data-ready=true] canvas').waitFor({ timeout: 45000 });
  await page.locator('#world-learning').uncheck();
  const start = Date.now();
  while (Date.now() - start < 80000) {
    await page.waitForTimeout(2000);
    const sample = await page.evaluate(() => ({
      tick: Number(document.querySelector('#ow-host').dataset.tick),
      state: document.querySelector('#world-battle-state').textContent,
      respawn: document.querySelector('#world-respawn')?.textContent ?? '',
      feed: document.querySelector('.world-feed')?.textContent ?? '',
    }));
    samples.push({ seconds: (Date.now() - start) / 1000, ...sample });
    if (sample.state !== samples.at(-2)?.state) console.log(JSON.stringify(samples.at(-1)));
  }
  await page.locator('#world-pause').click();
  await page.screenshot({ path: `${directory}/world.png` });
  await page.locator('[data-tab="lab"]').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-save').click();
  const save = JSON.parse(await readFile((await (await download).path()), 'utf8'));
  await writeFile(`${directory}/checkpoint.json`, JSON.stringify(save));
  const result = { url, errors, samples, tick: save.view.openWorld.tick, spawnSerial: save.view.openWorld.spawnSerial,
    money: save.game.player.money, lead: { speciesId: save.game.player.team[0].speciesId, level: save.game.player.team[0].level, xp: save.game.player.team[0].xp },
    pending: save.view.openWorld.respawnQueue.length, log: save.game.logs };
  await writeFile(`${directory}/report.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, errors, tick: result.tick, spawnSerial: result.spawnSerial, money: result.money, lead: result.lead }));
  if (errors.length || result.tick < 100 || result.spawnSerial <= 16) throw new Error('Autonomous browser loop did not complete a respawn');
} finally { await browser.close(); }
