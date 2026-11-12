import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

export function launchBattleBrowser() {
  const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
  return chromium.launch({
    executablePath: process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined),
    args: process.env.BATTLE_SOFTWARE ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--force_high_performance_gpu'],
  });
}

/** Run the standalone browser fixture without a listening server or a shared RUN library. */
export async function serveBattleBuild(context, url) {
  if (process.env.BATTLE_STATIC !== '1') return;
  const root = resolve('artifacts/browser-build');
  if (!existsSync(resolve(root, 'index.html'))) throw new Error('Run npm run build:browser-fixture before using BATTLE_STATIC=1.');
  await context.route(`${new URL(url).origin}/**`, route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    return file.startsWith(root + sep) && existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
  });
}
