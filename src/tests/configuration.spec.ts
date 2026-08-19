import { expect, test } from '@playwright/test';

/**
 * The Configuration screen's guarantees, which are mostly about secrets.
 *
 * A secret value must not appear because a table was opened, must not appear because a
 * panel was opened, and must appear only when that one key is asked for.
 */
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/preview.html?view=config');
  await page.waitForSelector('.cfg-page');
});

const openSecret = async (page: import('@playwright/test').Page, name: string) => {
  await page.getByRole('tab', { name: /Secrets/ }).click();
  await page.getByRole('button', { name, exact: true }).click();
  return page.getByRole('dialog');
};

test('the secrets table shows no value anywhere on the page', async ({ page }) => {
  await page.getByRole('tab', { name: /Secrets/ }).click();
  // The fixture's password. If listing ever carried values, this would find it.
  await expect(page.locator('body')).not.toContainText('s3cr3t-do-not-share');
  await expect(page.locator('body')).toContainText('This table carries no secret values');
});

test('opening a secret still shows nothing until a key is asked for', async ({ page }) => {
  const dialog = await openSecret(page, 'checkout-api-db');
  await expect(dialog).toContainText('password');
  await expect(dialog).not.toContainText('s3cr3t-do-not-share');
  await expect(dialog.locator('.cfg-value.is-masked').first()).toBeVisible();
});

test('a revealed key can be hidden again', async ({ page }) => {
  const dialog = await openSecret(page, 'checkout-api-db');
  await dialog.getByRole('button', { name: 'Reveal' }).first().click();
  await expect(dialog).toContainText('s3cr3t-do-not-share');

  await dialog.getByRole('button', { name: 'Hide' }).first().click();
  await expect(dialog).not.toContainText('s3cr3t-do-not-share');
});

test('revealing one key does not reveal the others', async ({ page }) => {
  const dialog = await openSecret(page, 'checkout-api-db');
  await dialog.getByRole('button', { name: 'Reveal' }).first().click();
  await expect(dialog).toContainText('s3cr3t-do-not-share');
  // The second key was never asked for, so it is still masked.
  await expect(dialog.locator('.cfg-value.is-masked')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Reveal' })).toHaveCount(1);
});

test('a secret panel offers no export', async ({ page }) => {
  const dialog = await openSecret(page, 'checkout-api-db');
  await expect(dialog.getByRole('button', { name: /export|download|save as/i })).toHaveCount(0);
  await expect(dialog).toContainText('this screen has no export');
});

test('an object owned by Helm warns that an edit will be reverted', async ({ page }) => {
  const dialog = await openSecret(page, 'stripe-webhook-signing');
  await expect(dialog).toContainText('Helm owns this object');
  await expect(dialog).toContainText('reverted the next time Helm syncs');
});

test('an immutable object cannot be edited', async ({ page }) => {
  const dialog = await openSecret(page, 'registry-pull');
  await expect(dialog).toContainText('This object is immutable');
  await expect(dialog.getByRole('button', { name: 'Edit' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Remove' })).toBeDisabled();
});

test('a config map shows its values without being asked, having none to protect', async ({ page }) => {
  await page.getByRole('button', { name: 'feature-flags', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('retry-on-timeout');
  await expect(dialog).not.toContainText('no export');
});

test('a binary key is named as binary rather than shown as broken text', async ({ page }) => {
  await page.getByRole('button', { name: 'legacy-migration-map', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('binary — not text');
  await expect(dialog).toContainText('of binary data');
});

test('an unmeasurable quota says so instead of drawing a bar', async ({ page }) => {
  await page.getByRole('tab', { name: /Resource Quotas/ }).click();
  const row = page.getByRole('row').filter({ hasText: 'count/jobs.batch' });
  await expect(row).toContainText('not measurable');
  await expect(row.locator('.cfg-meter-fill')).toHaveCount(0);
});

test('findings are one line each and open to their explanation', async ({ page }) => {
  const finding = page.locator('.cfg-finding').first();
  await expect(finding).toContainText('An admission webhook points at a service that does not exist');
  // Collapsed: the explanation is not taking up the first screen.
  await expect(finding.locator('p')).toBeHidden();

  await finding.locator('summary').click();
  await expect(finding.locator('p')).toBeVisible();
  await expect(finding).toContainText('failure policy is Fail, so the API server rejects');
});

test('a webhook whose service is gone is called out in the table too', async ({ page }) => {
  await page.getByRole('tab', { name: /Webhooks/ }).click();
  const row = page.getByRole('row').filter({ hasText: 'validation.gatekeeper.sh' });
  await expect(row).toContainText('does not exist');
  await expect(row).toContainText('Critical');
});
