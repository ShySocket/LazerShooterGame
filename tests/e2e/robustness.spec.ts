import { test, expect } from '@playwright/test';
import { closeAll, createRoom, deleteRoom, openPhone, type Phone } from './helpers';

const phones: Phone[] = [];
let code = '';

test.afterAll(async () => {
  if (phones[0] && code) await deleteRoom(phones[0], code);
  await closeAll(phones);
});

test('[camera-denied] a denied camera permission gives a readable message and a Retry button, not a blank screen', async ({ browser }) => {
  const phone = await openPhone(browser, 'NoCam', { camera: false });
  phones.push(phone);
  code = await createRoom(phone);
  await expect(phone.page.getByText('Camera permission was denied')).toBeVisible({ timeout: 25_000 });
  await expect(phone.page.getByRole('button', { name: 'Retry camera' })).toBeVisible();
  await expect(phone.page.getByRole('button', { name: 'Restart scan' })).toBeVisible();
  expect(phone.errors).toEqual([]);
});
