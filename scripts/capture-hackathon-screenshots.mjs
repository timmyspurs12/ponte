// Regenerates the current hackathon screenshots from the running local application.
// Requires a seeded development database and `npm run dev` on localhost:3000.
// Windows/macOS use ordinary Playwright Chromium after `npm run test:install`.
// Only the restricted Linux fallback needs PONTE_BROWSER_FALLBACK=1.
import { loadEnvFile, env } from 'node:process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { prepareBrowser } from './prepare-browser.mjs';

loadEnvFile('.env.local');

const baseURL = 'http://localhost:3000';
const token = env.PONTE_DEV_TOKEN;
const output = 'docs/screenshots';
const reference = 'PNT-2026-1048';

if (!token) throw new Error('PONTE_DEV_TOKEN is required in .env.local');
fs.mkdirSync(output, { recursive: true });

const launchOptions = {};
if (env.PONTE_BROWSER_FALLBACK === '1') {
  const { default: sparticuzChromium } = await import('@sparticuz/chromium');
  const browser = await prepareBrowser();
  env.LD_LIBRARY_PATH = [browser.libraryPath, env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(':');
  launchOptions.executablePath = browser.executablePath;
  launchOptions.args = sparticuzChromium.args.filter(
    (arg) => arg !== '--single-process',
  );
}

const browser = await chromium.launch({ headless: true, ...launchOptions });
try {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 950 },
  });
  await context.addCookies([
    { name: 'ponte-dev-session', value: token, domain: 'localhost', path: '/' },
    { name: 'ponte-locale', value: 'en-US', domain: 'localhost', path: '/' },
  ]);
  const page = await context.newPage();

  async function shot(name) {
    await page.waitForTimeout(500);
    // Remove only development chrome/transient toasts, never product content.
    await page.evaluate(() => {
      document.querySelector('nextjs-portal')?.remove();
      document.querySelectorAll('.toast').forEach((node) => node.remove());
    });
    const path = `${output}/${name}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(path);
  }

  async function settledHeroVisible() {
    await page.waitForFunction(() => {
      const node = document.querySelector('.hero-visual');
      return node && getComputedStyle(node).opacity === '1';
    });
  }

  const list = await page.request.get('/api/v1/invoices?limit=100');
  if (!list.ok()) throw new Error(`API refused local access: ${list.status()}`);
  const { data: invoices } = await list.json();
  const invoice = invoices.find((item) => item.reference === reference);
  if (!invoice || invoice.status !== 'Pending payment')
    throw new Error(
      `${reference} must be Pending payment; reset with npm run db:reset -- --confirm-local-reset && npm run db:fixtures`,
    );

  await page.goto('/');
  await settledHeroVisible();
  await shot('home-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await settledHeroVisible();
  await shot('home-390');

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto('/app');
  await page.waitForSelector('.metrics');
  await shot('overview-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app');
  await page.waitForSelector('.metrics');
  await shot('overview-mobile');

  const funding = await page.request.post(
    `/api/v1/invoices/${invoice.id}/payments`,
    {
      data: {},
      headers: { 'Idempotency-Key': randomUUID() },
    },
  );
  if (!funding.ok())
    throw new Error(`Could not simulate Pix funding: ${funding.status()}`);

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto(`/app/invoices/${invoice.id}`);
  await page.getByRole('heading', { name: 'Compare illustrative routes' });
  await shot('invoice-routes-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/invoices/${invoice.id}`);
  await page.getByRole('heading', { name: 'Compare illustrative routes' });
  await shot('invoice-routes-mobile');

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto(`/app/invoices/${invoice.id}`);
  await page.getByRole('radio', { name: /Split liquidity/ }).click();
  await page.getByRole('button', { name: 'Select route & continue' }).click();
  await page.getByRole('heading', { name: 'Ready for settlement' });
  // The status transition is persisted server-side; reload so the action button
  // renders the settled-state control ('Simulate settlement').
  await page.reload();
  await page.getByRole('heading', { name: 'Ready for settlement' });
  await page.getByRole('button', { name: 'Simulate settlement', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Confirm simulation' }).click();
  await page.getByRole('heading', { name: 'Settlement receipt' });
  const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
  if (await dismiss.count()) await dismiss.click();
  await shot('receipt-desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/invoices/${invoice.id}`);
  await page.getByRole('heading', { name: 'Settlement receipt' });
  await shot('receipt-mobile');

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto('/developers');
  await page.getByRole('heading', { name: /One bridge/ });
  await shot('developers-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/developers');
  await page.getByRole('heading', { name: /One bridge/ });
  await shot('developers-mobile');

  console.log('Screenshots regenerated from the running application.');
} finally {
  await browser.close();
}
