// Headless browser check: serves the project, opens it in headless Edge/Chrome,
// runs a list of steps, saves screenshots and prints console output + page errors.
// Real headless Chromium runs requestAnimationFrame, so the game loop actually ticks here.
//
// Usage:
//   node tools/snap.mjs --steps tools/steps/smoke.json
//   node tools/snap.mjs --path "/?debug=1" --wait 2000 --shot out/title.png
//   node tools/snap.mjs --path "/" --eval "window.__ss.debug.quickStart('crater')" --wait 3000 --shot out/game.png
//
// Steps file: JSON array of objects, each one of:
//   {"goto": "/?debug=1"}            navigate (path relative to server root)
//   {"wait": 1000}                   wait ms
//   {"waitFor": "js expression"}     poll until the expression is truthy (default 30 s, "timeout": ms);
//                                    e.g. {"waitFor": "window.__ss && __ss.debug"} before debug calls
//   evals may use await: they run inside an async function when they contain 'await'
//   {"eval": "js expression"}        evaluate in page (awaited); result is printed
//   {"click": [x, y]}                mouse click at CSS pixel coords
//   {"move": [x, y]}                 mouse move
//   {"key": "q"}                     key press
//   {"shot": "out/name.png"}         screenshot (path relative to project root)
//   {"size": [1600, 900]}            set viewport
// Flags: --size WxH (default 1600x900), --mobile (390x844 touch), --keep-open-ms N
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);
const executablePath = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!executablePath) { console.error('No Chrome/Edge found'); process.exit(2); }

let steps = [];
if (flag('steps')) steps = JSON.parse(fs.readFileSync(path.resolve(ROOT, flag('steps')), 'utf8'));
else {
  steps.push({ goto: flag('path', '/') });
  steps.push({ wait: Number(flag('wait0', 800)) });
  // allow repeated --eval / --wait / --shot in order of appearance
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--eval') steps.push({ eval: args[i + 1] });
    if (args[i] === '--wait') steps.push({ wait: Number(args[i + 1]) });
    if (args[i] === '--shot') steps.push({ shot: args[i + 1] });
    if (args[i] === '--click') steps.push({ click: args[i + 1].split(',').map(Number) });
    if (args[i] === '--key') steps.push({ key: args[i + 1] });
  }
}

const server = createServer(ROOT);
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const [w, h] = (has('mobile') ? '390x844' : flag('size', '1600x900')).split('x').map(Number);
const browser = await puppeteer.launch({
  executablePath, headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: has('mobile'), hasTouch: has('mobile') });
const errors = [];
page.on('console', (m) => { const t = m.type(); if (/favicon/.test(m.location()?.url || '')) return; if (t === 'error' || t === 'warning' || has('verbose') || t === 'log') console.log(`[console.${t}] ${m.text()}`); if (t === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => { console.log(`[pageerror] ${e.message}\n${e.stack || ''}`); errors.push(e.message); });
page.on('requestfailed', (r) => { console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`); });
page.on('response', (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });

for (const s of steps) {
  try {
    // Git Bash rewrites "/foo" args into "C:/Program Files/Git/foo"; undo that.
    if (s.goto !== undefined) s.goto = s.goto.replace(/^[A-Za-z]:\/Program Files\/Git/, '');
    if (s.goto !== undefined) { await page.goto(base + s.goto, { waitUntil: 'load', timeout: 30000 }); console.log(`goto ${s.goto}`); }
    else if (s.wait !== undefined) await new Promise((r) => setTimeout(r, s.wait));
    else if (s.waitFor !== undefined) {
      await page.waitForFunction((code) => { try { return !!(0, eval)(code); } catch { return false; } }, { timeout: s.timeout || 30000, polling: 100 }, s.waitFor);
      console.log(`ready: ${s.waitFor.slice(0, 80)}`);
    }
    else if (s.eval !== undefined) {
      // code containing `await` runs inside an async function (return the result explicitly)
      const code = /\bawait\b/.test(s.eval) && !/^\s*\(async/.test(s.eval) ? `(async()=>{${s.eval}})()` : s.eval;
      const res = await page.evaluate(async (c) => { const v = await (0, eval)(c); try { return JSON.stringify(v, null, 0)?.slice(0, 4000); } catch { return String(v); } }, code);
      console.log(`eval> ${s.eval.slice(0, 120)}\n  = ${res}`);
    }
    else if (s.click) { await page.mouse.click(s.click[0], s.click[1]); }
    else if (s.move) { await page.mouse.move(s.move[0], s.move[1]); }
    else if (s.key) { await page.keyboard.press(s.key); }
    else if (s.size) { await page.setViewport({ width: s.size[0], height: s.size[1] }); }
    else if (s.shot) {
      const out = path.resolve(ROOT, s.shot);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await page.screenshot({ path: out });
      console.log(`shot ${s.shot}`);
    }
  } catch (e) { console.log(`[step error] ${JSON.stringify(s).slice(0, 200)}: ${e.message}`); errors.push(e.message); }
}
await browser.close();
server.close();
console.log(errors.length ? `DONE with ${errors.length} error(s)` : 'DONE, no errors');
process.exit(errors.length ? 1 : 0);
