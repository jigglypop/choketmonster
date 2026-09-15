import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Windows video-overlay composition must also be checked in a real window.
// This optional local suite requires an installed Google Chrome.
export default defineConfig(base, {
  use: {
    channel: 'chrome', headless: false,
    launchOptions: { args: ['--enable-unsafe-webgpu'] },
  },
});
