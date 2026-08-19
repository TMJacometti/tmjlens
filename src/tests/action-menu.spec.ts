import { expect, test } from '@playwright/test';

/**
 * Regression tests for the row action menu.
 *
 * Every panel sets `overflow: hidden` so its border radius clips the table.
 * The menu used to be absolutely positioned inside the row, so the last row's
 * menu was clipped by the panel edge and appeared as a sliver below the layout.
 * It is now portalled to document.body and positioned fixed.
 */
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 420 });
  await page.goto('/preview.html?view=actions');
  await page.waitForSelector('.panel');
});

const triggers = (page: import('@playwright/test').Page) => page.locator('.action-cell button');

test('the last row menu is not clipped by the panel', async ({ page }) => {
  await triggers(page).last().click();
  const menu = page.locator('.tmj-menu');
  await expect(menu).toBeVisible();

  const box = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

  // Being inside the viewport is not enough — the menu must actually be the
  // painted element there, which is what a clip would take away.
  const painted = await page.evaluate(
    ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.tmj-menu'),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(painted).toBe(true);
});

test('the menu flips above the trigger when there is no room below', async ({ page }) => {
  await triggers(page).last().click();
  const menu = (await page.locator('.tmj-menu').boundingBox())!;
  const trigger = (await triggers(page).last().boundingBox())!;
  expect(menu.y + menu.height).toBeLessThanOrEqual(trigger.y + 1);
});

test('the menu opens below the trigger when there is room', async ({ page }) => {
  await triggers(page).first().click();
  const menu = (await page.locator('.tmj-menu').boundingBox())!;
  const trigger = (await triggers(page).first().boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(trigger.y + trigger.height);
});

test('escape closes the menu', async ({ page }) => {
  await triggers(page).first().click();
  await expect(page.locator('.tmj-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tmj-menu')).toHaveCount(0);
});

test('clicking outside closes the menu', async ({ page }) => {
  await triggers(page).first().click();
  await expect(page.locator('.tmj-menu')).toBeVisible();
  await page.mouse.click(600, 60);
  await expect(page.locator('.tmj-menu')).toHaveCount(0);
});

test('scrolling closes the menu rather than stranding it beside the wrong row', async ({ page }) => {
  await triggers(page).first().click();
  await expect(page.locator('.tmj-menu')).toBeVisible();
  await page.mouse.wheel(0, 200);
  await expect(page.locator('.tmj-menu')).toHaveCount(0);
});
