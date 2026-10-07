import { expect, test } from '@playwright/test';

test.describe('rightsizing', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.goto('/preview.html?view=rightsizing');
    await page.waitForSelector('.rs-page');
  });

  test('the invoice warning is stated, not implied by a dollar figure', async ({ page }) => {
    await expect(page.locator('.rs-page')).toContainText('only lowers the bill if the node autoscaler consolidates');
  });

  test('a cold-start row is labelled limited and does not invent a dollar saving', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'payments' });
    await expect(row).toContainText('limited');
    await expect(row).toContainText('OOM');
    await expect(row).toContainText('low');
  });

  test('HPA apply lives inside the preview and stays blocked when the install flag is off', async ({ page }) => {
    await page.getByRole('tab', { name: 'HPA' }).click();
    await expect(page.locator('.rs-hpa')).toContainText('hpaManager.enabled=false');
    // No Apply until there is something to review — the preview is the review.
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('region', { name: 'HPA change under review' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Back to the form' }).click();
    await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
  });

  test('columns sort, and waste comes biggest-first by default', async ({ page }) => {
    await page.keyboard.press('Escape');
    const first = page.locator('tbody tr').first();
    await expect(first).toContainText('ledger-db');
    await page.getByRole('button', { name: /^Waste/ }).click();
    await expect(first).toContainText('payments');
    await page.getByRole('button', { name: /^Workload/ }).click();
    await expect(first).toContainText('ledger-db');
    await page.getByRole('button', { name: /^Workload/ }).click();
    await expect(first).toContainText('payments');
  });

  test('the namespace filter narrows the list and says how many it holds', async ({ page }) => {
    await expect(page.getByLabel('Namespace')).toContainText('All namespaces (3)');
    await page.getByLabel('Namespace').selectOption('shop');
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('tbody')).not.toContainText('ledger-db');
  });

  test('a workload that left the cluster is marked as history', async ({ page }) => {
    await expect(page.getByRole('row').filter({ hasText: 'ledger-db' })).toContainText('no longer in the cluster');
  });

  test('the recommendation carries the numbers that produced it', async ({ page }) => {
    await expect(page.locator('.rs-reason')).toContainText('p95');
    await expect(page.locator('.rs-reason')).toContainText('peak working set');
    await expect(page.locator('.rs-rec')).toContainText('Recommended CPU');
  });
});

test.describe('rightsizing coverage', () => {
  test('nodes without a running collector are named, with the scheduler reason', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=rightsizing');
    const banner = page.locator('.viz-callout-critical').filter({ hasText: 'The collector runs on' });
    await expect(banner).toContainText('5 of 9 nodes');
    await expect(banner).toContainText('the other 4 are NOT measured');
    await expect(banner).toContainText('ip-10-42-7-11');
    await expect(banner).toContainText('Too many pods');
    // The fix is spelled out next to the problem, not left to a search.
    await expect(banner).toContainText('collector.priorityClassName');
  });
});

test.describe('resource editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=rightsizing');
    await page.getByRole('tab', { name: 'Resources' }).click();
    await page.waitForSelector('.rs-resources');
  });

  test('the form opens pre-filled with the recommendation, limits kept', async ({ page }) => {
    await expect(page.getByLabel('CPU request millicores')).toHaveValue('110');
    await expect(page.getByLabel('Memory request MiB')).toHaveValue('144');
    // Limits are not part of the recommendation; the current ones stay.
    await expect(page.getByLabel('CPU limit millicores')).toHaveValue('1000');
    await expect(page.getByLabel('Memory limit MiB')).toHaveValue('1024');
  });

  test('current and recommended are both on screen, so the change is legible', async ({ page }) => {
    const panel = page.locator('.rs-resources');
    await expect(panel).toContainText('500m / 1.0 cores');
    await expect(panel).toContainText('512 MiB / 1.0 GiB');
    await expect(panel).toContainText('2 replica(s) restart');
  });

  test('apply lives inside the preview and stays blocked while the install flag is off', async ({ page }) => {
    await expect(page.locator('.rs-resources')).toContainText('resourceEditor.enabled=false');
    await expect(page.getByRole('button', { name: 'Apply resources' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Preview resources' }).click();
    const review = page.getByRole('region', { name: 'Resources change under review' });
    await expect(review).toContainText('110m');
    await expect(review).toContainText('2 replica(s) restart');
    await expect(page.getByRole('button', { name: 'Apply resources' })).toBeDisabled();
  });

  test('reset to current puts the live numbers back in the form', async ({ page }) => {
    await page.getByRole('button', { name: 'Reset to current' }).click();
    await expect(page.getByLabel('CPU request millicores')).toHaveValue('500');
    await page.getByRole('button', { name: 'Use recommendation' }).click();
    await expect(page.getByLabel('CPU request millicores')).toHaveValue('110');
  });
});

test.describe('rightsizing detail popup', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=rightsizing');
    await page.waitForSelector('.rs-page');
  });

  test('selecting a workload opens its detail over the table, not below the fold', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: /Rightsizing Deployment\/checkout/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Recommended CPU');
    // One tab at a time: Overview first, the others a click away.
    await expect(dialog.locator('.rs-hpa')).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'HPA' }).click();
    await expect(dialog.locator('.rs-hpa')).toBeVisible();
    await dialog.getByRole('tab', { name: 'Resources' }).click();
    await expect(dialog.locator('.rs-resources')).toBeVisible();
  });

  test('escape closes it and a row click reopens it', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('row').filter({ hasText: 'payments' }).click();
    await expect(page.getByRole('dialog', { name: /payments/ })).toBeVisible();
  });
});
