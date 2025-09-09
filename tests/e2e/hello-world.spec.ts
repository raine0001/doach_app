import { test, expect } from '@playwright/test';

test('hello world functionality', async ({ page }) => {
    await page.goto('http://localhost:3000'); // Adjust the URL as needed
    const helloWorldText = await page.locator('h1').textContent();
    expect(helloWorldText).toBe('Hello World');
});