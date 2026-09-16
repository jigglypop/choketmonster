import { expect, test } from '@playwright/test';

test('changing route lengths submit valid WebGPU vertex buffers', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/gpu-route-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('/gpu-route-fixture');
  const result = await page.evaluate(async () => {
    const path = '/tests/ui/helpers/webgpu-route.ts';
    const { exerciseRouteUpdates } = await import(/* @vite-ignore */ path);
    return exerciseRouteUpdates() as Promise<{ errors: string[]; meshes: string[]; indexCounts: number[]; backend: string }>;
  });
  expect(result.backend).toBe('webgpu');
  expect(result.indexCounts).toEqual([3024, 2880, 3264, 3552, 3120, 2112, 3024]);
  expect(result.errors).toEqual([]);
  expect(errors).toEqual([]);
});
