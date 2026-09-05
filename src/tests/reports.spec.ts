import { expect, test } from '@playwright/test';

/**
 * The reports screen does nothing until asked, defaults to the whole cluster, and
 * renders every report through one table regardless of the columns it carries.
 */
test.describe('reports', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=reports');
    await page.waitForSelector('.rep-page');
  });

  const pick = (page: import('@playwright/test').Page, title: string) =>
    page.locator('.rep-kind').filter({ hasText: title }).click();

  const run = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: 'Run report' }).click();

  test('the screen opens with no results and says nothing is read yet', async ({ page }) => {
    await expect(page.locator('.rep-idle')).toContainText('Choose a report');
    await expect(page.locator('.rep-idle')).toContainText('Nothing is read from the cluster until you do');
    await expect(page.locator('.rep-results')).toHaveCount(0);
  });

  test('every report in the catalogue is offered with what it answers', async ({ page }) => {
    await expect(page.locator('.rep-kind')).toHaveCount(6);
    await expect(page.locator('.rep-kind').filter({ hasText: 'Idle cost' }))
      .toContainText('provisioned, billed, and doing nothing');
  });

  test('a report runs over the whole cluster with no namespace chosen', async ({ page }) => {
    // "What is idle" and "what is over-privileged" are cluster-wide questions; making
    // them depend on picking namespaces first would be friction, not safety.
    await expect(page.getByRole('button', { name: 'Run report' })).toBeEnabled();
    await expect(page.locator('.rep-count')).toContainText('the whole cluster');
    await expect(page.locator('.rep-selection')).toContainText('Every namespace in the cluster');
  });

  test('choosing namespaces narrows it and says so', async ({ page }) => {
    await page.getByRole('button', { name: 'payments', exact: true }).click();
    await expect(page.locator('.rep-count')).toContainText('1 selected');
    await expect(page.locator('.rep-selection')).toContainText('payments');
  });

  test('only the reports that need a window offer one', async ({ page }) => {
    await pick(page, 'What was deployed');
    await expect(page.getByRole('tab', { name: 'Today' })).toBeVisible();

    await pick(page, 'Idle cost');
    await expect(page.getByRole('tab', { name: 'Today' })).toHaveCount(0);
  });

  test('idle cost leads with the volumes that are still billed', async ({ page }) => {
    await pick(page, 'Idle cost');
    await run(page);

    await expect(page.locator('.rep-summary')).toContainText('1.7Ti');
    // Worst first: a released volume outranks an unused config map.
    await expect(page.locator('tbody tr').first()).toContainText('Released with Retain');
  });

  test('upgrade readiness names what blocks a drain', async ({ page }) => {
    await pick(page, 'Upgrade readiness');
    await run(page);

    await expect(page.getByRole('row').filter({ hasText: 'checkout-api-pdb' }))
      .toContainText('blocks until the budget is met');
    await expect(page.getByRole('row').filter({ hasText: 'debug-shell' }))
      .toContainText('Nothing will recreate it');
  });

  test('security posture names the container, not only the workload', async ({ page }) => {
    await pick(page, 'Security posture');
    await run(page);

    const row = page.getByRole('row').filter({ hasText: 'Privileged' });
    await expect(row).toContainText('collector');
    await expect(row).toContainText('root on the node');
  });

  test('image hygiene separates the registry from the tag', async ({ page }) => {
    await pick(page, 'Image hygiene');
    await run(page);

    const row = page.getByRole('row').filter({ hasText: 'acme/checkout-api' });
    await expect(row).toContainText('registry.example.com');
    await expect(row).toContainText('latest');
    await expect(row).toContainText('Not pinned');
  });

  test('the change trail names both versions of an image', async ({ page }) => {
    await pick(page, 'Change trail');
    await run(page);

    await expect(page.getByRole('row').filter({ hasText: 'checkout-api' }))
      .toContainText('checkout-api:1.8.4 → checkout-api:1.9.0');
  });

  test('the table changes shape with the report', async ({ page }) => {
    await pick(page, 'Idle cost');
    await run(page);
    await expect(page.locator('thead th')).toContainText(['State', 'Namespace', 'Kind', 'Name', 'Amount']);

    await pick(page, 'Image hygiene');
    await run(page);
    await expect(page.locator('thead th')).toContainText(['State', 'Registry', 'Repository', 'Tag']);
  });

  test('the summary tallies rows by severity', async ({ page }) => {
    await pick(page, 'Idle cost');
    await run(page);
    await expect(page.locator('.rep-tally')).toContainText('2 critical');
    await expect(page.locator('.rep-tally')).toContainText('1 serious');
  });

  test("rows can be filtered on any of that report's own columns", async ({ page }) => {
    await pick(page, 'Idle cost');
    await run(page);
    await expect(page.locator('tbody tr')).toHaveCount(5);

    await page.getByLabel('Filter rows').fill('ttlSecondsAfterFinished');
    await expect(page.locator('tbody tr')).toHaveCount(1);
  });

  test('export appears only once there is a report to export', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Export CSV/ })).toHaveCount(0);
    await pick(page, 'Idle cost');
    await run(page);
    await expect(page.getByRole('button', { name: /Export CSV/ })).toBeEnabled();
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
    await expect(page.locator('tbody tr').first()).toContainText('analytics-old');
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

test.describe('namespace management', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=ns');
    await page.waitForSelector('.ns-page');
  });

  test('creating is offered, and active namespaces offer delete', async ({ page }) => {
    await expect(page.getByLabel('New namespace name')).toBeVisible();
    const active = page.getByRole('row').filter({ hasText: 'payments' });
    await expect(active.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  test('a stuck namespace offers force finalize and names what it skips', async ({ page }) => {
    const stuck = page.getByRole('row').filter({ hasText: 'analytics-old' });
    const release = stuck.getByRole('button', { name: 'Force finalize' });
    await expect(release).toBeEnabled();
    // The risk is stated on the control itself: clearing finalizers skips cleanup.
    await expect(release).toHaveAttribute('title', /skips whatever cleanup/);
    // A stuck namespace must never offer plain Delete — it is already deleting.
    await expect(stuck.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  });

  test('deleting demands the namespace name typed back', async ({ page }) => {
    page.on('dialog', (dialog) => void dialog.accept('wrong-name'));
    await page.getByRole('row').filter({ hasText: 'ledger' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('status')).toContainText('Confirmation did not match');
  });
});
