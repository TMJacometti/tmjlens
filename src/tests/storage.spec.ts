import { expect, test } from '@playwright/test';

/**
 * The Storage screen exists to answer one question a plain listing does not: which of
 * the storage being paid for is doing any work.
 */
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/preview.html?view=storage');
  await page.waitForSelector('.stg-page');
});

test('idle and stranded capacity are stated as a size and as a share', async ({ page }) => {
  const waste = page.locator('.stg-waste');
  await expect(waste).toContainText('1.8Ti');
  await expect(waste).toContainText('2.0Ti');
  await expect(waste).toContainText('90%');
  await expect(waste).toContainText('The provider bills it the same');
});

test('every segment of the capacity bar is named, not left to colour', async ({ page }) => {
  const legend = page.locator('.stg-legend');
  await expect(legend).toContainText('Doing work 200Gi');
  await expect(legend).toContainText('Bound, not mounted 1.1Ti');
  await expect(legend).toContainText('Released, not reclaimed 700Gi');
});

test('a bound claim nothing mounts is flagged rather than shown as healthy', async ({ page }) => {
  const row = page.getByRole('row').filter({ hasText: 'data-postgres-2' });
  await expect(row).toContainText('Bound');
  await expect(row).toContainText('not mounted by any running pod');
  await expect(row).toContainText('provisioned and billed');
});

test('a claim mounted by a pod names the pod', async ({ page }) => {
  const row = page.getByRole('row').filter({ hasText: 'data-postgres-0' });
  await expect(row).toContainText('postgres-0');
  await expect(row).toContainText('Mounted by 1 pod(s)');
});

test('a claim bound to a larger volume than it asked for says so', async ({ page }) => {
  const row = page.getByRole('row').filter({ hasText: 'ledger-archive' });
  await expect(row).toContainText('1000Gi provisioned for a 500Gi request');
});

test('a lost claim states that the data is gone', async ({ page }) => {
  const row = page.getByRole('row').filter({ hasText: 'legacy-uploads' });
  await expect(row).toContainText('Lost');
  await expect(row).toContainText('Data written to it is gone');
});

test('a released volume names the cloud disk so it can be checked before deletion', async ({ page }) => {
  await page.getByRole('tab', { name: /Volumes/ }).click();
  const row = page.getByRole('row').filter({ hasText: 'pvc-3d1f8b66' });
  await expect(row).toContainText('Released');
  await expect(row).toContainText('keeps billing');
  await expect(row).toContainText('vol-0c3d4e5f60718293a');
  await expect(row).toContainText('no longer exists');
});

test('an NFS export keeps its host rather than being trimmed to a folder', async ({ page }) => {
  await page.getByRole('tab', { name: /Volumes/ }).click();
  const row = page.getByRole('row').filter({ hasText: 'nfs-shared-reports' });
  await expect(row).toContainText('nfs.internal:/exports/reports');
});

test('a class that binds immediately is flagged as a scheduling trap', async ({ page }) => {
  await page.getByRole('tab', { name: /Storage Classes/ }).click();
  const row = page.getByRole('row').filter({ hasText: 'fast-nvme' });
  await expect(row).toContainText('Immediate');
  await expect(row).toContainText('unschedulable');
  await expect(row).toContainText('cannot be grown later');
});

test('the default class is marked, and only one is', async ({ page }) => {
  await page.getByRole('tab', { name: /Storage Classes/ }).click();
  await expect(page.locator('.cfg-tag', { hasText: 'default' })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: 'gp3' })).toContainText('default');
});

test('a class that destroys data on claim deletion says so', async ({ page }) => {
  await page.getByRole('tab', { name: /Storage Classes/ }).click();
  const row = page.getByRole('row').filter({ hasText: 'gp3' });
  await expect(row).toContainText('Deleting a claim destroys the data');
});
