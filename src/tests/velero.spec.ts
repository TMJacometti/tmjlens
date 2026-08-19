import { expect, test } from '@playwright/test';

/**
 * The Velero screen's guarantees, which are about what it refuses to do.
 *
 * Restoring is the one action in the app that recreates resources in a live cluster
 * from a file written days earlier, so the screen has to be unambiguous about which
 * backups can be restored from and what a restore will and will not change.
 */
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/preview.html?view=velero');
  await page.waitForSelector('.vel-page');
});

const rowFor = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('row').filter({ hasText: name });

test('a failed backup cannot be restored from', async ({ page }) => {
  // There is nothing in it. Offering the button with a warning would invite the click.
  const failed = rowFor(page, 'ledger-adhoc').getByRole('button', { name: 'Restore' });
  await expect(failed).toBeDisabled();

  const running = rowFor(page, 'checkout-api-manual').getByRole('button', { name: 'Restore' });
  await expect(running).toBeDisabled();
});

test('a completed and a partially failed backup can be restored from', async ({ page }) => {
  await expect(rowFor(page, 'nightly-full-20260819').getByRole('button', { name: 'Restore' })).toBeEnabled();
  // Partial is incomplete, not empty: it holds something worth recovering.
  await expect(rowFor(page, 'payments-preupgrade').getByRole('button', { name: 'Restore' })).toBeEnabled();
});

test('an incomplete backup states why it is flagged, in words', async ({ page }) => {
  await expect(page.locator('.vel-caveat').first()).toContainText('some resources are missing');
  await expect(rowFor(page, 'ledger-adhoc')).toContainText('Do not restore from it');
});

test('restore is refused until the operator acknowledges what it does', async ({ page }) => {
  await rowFor(page, 'payments-preupgrade').getByRole('button', { name: 'Restore' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('This writes into the running cluster');
  await expect(dialog).toContainText('does not roll a running Deployment back');
  await expect(dialog).toContainText('This backup is not complete');

  const confirm = dialog.getByRole('button', { name: 'Restore' });
  await expect(confirm).toBeDisabled();

  await dialog.locator('.vel-acknowledge input').check();
  await expect(confirm).toBeEnabled();
});

test('volume snapshots are opt-in rather than assumed', async ({ page }) => {
  await page.getByRole('button', { name: /Back up now/ }).click();
  const dialog = page.getByRole('dialog');
  const snapshot = dialog.locator('.vel-check-block input');
  await expect(snapshot).not.toBeChecked();
  await expect(dialog).toContainText('billed by the cloud provider');
});

test('a backup of chosen namespaces will not submit with none chosen', async ({ page }) => {
  await page.getByRole('button', { name: /Back up now/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio').nth(1).check();
  await dialog.getByRole('button', { name: 'Take backup' }).click();
  await expect(dialog).toContainText('Pick at least one namespace');
});

test('an absent Velero is reported as absent, not as an error', async ({ page }) => {
  await page.goto('/preview.html?view=velero-absent');
  await expect(page.getByText('No Velero in this cluster.')).toBeVisible();
  // The screen also says what it would have read, so the answer is not just "no".
  await expect(page.locator('.vel-page')).toContainText('needs no bucket credential of its own');
});

test('an expired cloud session names the fix and states that nothing is stored', async ({ page }) => {
  await page.goto('/preview.html?view=velero-expired');
  const callout = page.locator('.viz-callout-critical');
  await expect(callout).toContainText('Your AWS session has expired');
  await expect(callout).toContainText('aws sso login');
  await expect(callout).toContainText('does not hold cloud credentials');
  // The raw error stays available for anything the explanation does not cover.
  await expect(callout).toContainText('exit code: 255');
});
