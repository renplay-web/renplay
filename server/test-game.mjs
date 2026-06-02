import { chromium } from 'playwright';

const GAME = process.argv[2] || 'our-red-string';
const URL = `http://localhost:8080/play/${GAME}/`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const logs = [];
const errors = [];
const requests = [];

page.on('console', msg => {
  const text = msg.text();
  logs.push({ type: msg.type(), text });
  if (msg.type() === 'error') errors.push(text);
  if (text.includes('[renplay]')) console.log(`    CONSOLE: ${text}`);
});

page.on('request', req => {
  const url = req.url().replace(`http://localhost:8080/play/${GAME}/`, '');
  const method = req.method();
  requests.push({ url, method });
});

page.on('response', res => {
  if (!res.ok()) {
    console.log(`  HTTP ${res.status()}: ${res.url().replace(`http://localhost:8080/play/${GAME}/`, '')}`);
  }
});

console.log(`Loading ${URL}...`);
try {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
} catch (e) {
  console.log(`Navigation: ${e.message.substring(0, 200)}`);
}

await page.waitForTimeout(5000);

console.log(`\n=== ALL network requests (${requests.length}) ===`);
const counts = {};
for (const r of requests) {
  const ext = r.url.split('.').pop() || '(root)';
  counts[ext] = (counts[ext] || 0) + 1;
  if (['zip', 'data', 'wasm', 'json', 'js'].includes(ext)) {
    console.log(`  [${ext}] ${r.url} (${r.method})`);
  }
}
console.log(`  Totals by type:`, counts);

console.log(`\n=== Console logs (${logs.length}) ===`);
for (const l of logs) {
  console.log(`[${l.type}] ${l.text}`);
}

console.log(`\n=== Errors (${errors.length}) ===`);
for (const e of errors) {
  console.log(e);
}

await browser.close();
