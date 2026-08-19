import { expect, test } from '@playwright/test';

/**
 * The deploy report's defining behaviour is that it does nothing until asked. Opening
 * the screen must not read a cluster-wide list, and the filter must be refused until
 * at least one namespace is chosen.
 */
test.describe('deploy report', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=deploys');
    await page.waitForSelector('.rep-page');
  });

  test('the screen opens with no results and says so', async ({ page }) => {
    await expect(page.locator('.rep-idle')).toContainText('Pick one or more namespaces');
    await expect(page.locator('.rep-idle')).toContainText('Nothing is read from the cluster until you do');
    await expect(page.locator('.rep-results')).toHaveCount(0);
  });

  test('filtering is refused until a namespace is chosen', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^Filter/ })).toBeDisabled();
    await page.getByRole('button', { name: 'payments', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Filter/ })).toBeEnabled();
  });

  test('several namespaces can be selected and the results are grouped by them', async ({ page }) => {
    for (const ns of ['payments', 'ledger']) {
      await page.getByRole('button', { name: ns, exact: true }).click();
    }
    await expect(page.locator('.rep-count')).toContainText('2 selected');

    await page.getByRole('button', { name: /^Filter/ }).click();
    const groups = page.locator('.rep-group h3');
    await expect(groups).toHaveCount(2);
    await expect(groups.first()).toContainText('ledger');
  });

  test('the selected window is visibly selected', async ({ page }) => {
    // The class marking the current tab was inert once; this is why it is asserted.
    await expect(page.locator('.rep-field .wl-switch button.is-active')).toHaveText('Today');
    await page.getByRole('tab', { name: 'Last 7 days' }).click();
    await expect(page.locator('.rep-field .wl-switch button.is-active')).toHaveText('Last 7 days');
  });

  test('the summary leads with what is not running', async ({ page }) => {
    await page.getByRole('button', { name: 'payments', exact: true }).click();
    await page.getByRole('button', { name: /^Filter/ }).click();
    await expect(page.locator('.rep-summary')).toContainText('not running');
  });

  test('a cron job shows its schedule and a job its completions', async ({ page }) => {
    await page.getByRole('button', { name: 'payments', exact: true }).click();
    await page.getByRole('button', { name: 'payments-jobs', exact: true }).click();
    await page.getByRole('button', { name: /^Filter/ }).click();

    await expect(page.getByRole('row').filter({ hasText: 'settlement-nightly' })).toContainText('0 2 * * *');
    await expect(page.getByRole('row').filter({ hasText: 'reindex-2026-08-19' })).toContainText('1/1 complete');
    await expect(page.getByRole('row').filter({ hasText: 'ledger-backfill' })).toContainText('Workflow');
  });

  test('what created a workload is named, including when nothing did', async ({ page }) => {
    await page.getByRole('button', { name: 'payments', exact: true }).click();
    await page.getByRole('button', { name: 'payments-jobs', exact: true }).click();
    await page.getByRole('button', { name: /^Filter/ }).click();

    await expect(page.getByRole('row').filter({ hasText: 'checkout-api' })).toContainText('Argo CD');
    await expect(page.getByRole('row').filter({ hasText: 'reindex-2026-08-19' })).toContainText('by hand');
  });

  test('selecting all then clearing leaves nothing selected', async ({ page }) => {
    await page.getByRole('button', { name: 'Select all' }).click();
    await expect(page.locator('.rep-count')).toContainText('12 selected');
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.locator('.rep-count')).toContainText('none selected');
    await expect(page.getByRole('button', { name: /^Filter/ })).toBeDisabled();
  });
});

test.describe('namespaces', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=ns');
    await page.waitForSelector('.ns-page');
  });

  test('a namespace stuck terminating names the finalizer holding it open', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'analytics-old' });
    await expect(row).toContainText('Terminating');
    await expect(row).toContainText('metrics.k8s.io/v1beta1');
    await expect(row).toContainText('Deleting for 6d');
  });

  test('the stuck namespace is sorted above the healthy ones', async ({ page }) => {
    const first = page.locator('tbody tr').first();
    await expect(first).toContainText('analytics-old');
  });

  test('the selected namespace is marked in words, not only by highlight', async ({ page }) => {
    await expect(page.getByRole('row').filter({ hasText: 'payments' })).toContainText('selected');
  });

  test('selecting a different namespace moves the marker', async ({ page }) => {
    await page.getByRole('button', { name: 'ledger', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: 'ledger' })).toContainText('selected');
    await expect(page.locator('.cfg-tag', { hasText: 'selected' })).toHaveCount(1);
  });

  test('pods that are not running are called out per namespace', async ({ page }) => {
    await expect(page.getByRole('row').filter({ hasText: 'kube-system' })).toContainText('1 not running');
    await expect(page.getByRole('row').filter({ hasText: 'payments' })).toContainText('3 not running');
  });
});
