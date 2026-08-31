const fs = require('fs');
const path = require('path');

let captureQueue = Promise.resolve();

function findBrowserExecutable(puppeteer) {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  try {
    const preferred = puppeteer.executablePath();
    if (preferred && fs.existsSync(preferred)) return preferred;
  } catch (_) { /* 继续发现 headless shell */ }
  const cacheRoot = process.env.PUPPETEER_CACHE_DIR || '/root/.cache/puppeteer';
  const shellRoot = path.join(cacheRoot, 'chrome-headless-shell');
  if (fs.existsSync(shellRoot)) {
    const versions = fs.readdirSync(shellRoot).sort().reverse();
    for (const version of versions) {
      const executable = path.join(shellRoot, version, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(executable)) return executable;
    }
  }
  throw new Error('服务器截图浏览器未安装完成');
}

function normalizePddUrl(targetUrl) {
  const value = String(targetUrl || '').trim();
  if (!value) throw new Error('该商品未设置拼多多链接');
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'yangkeduo.com' && !hostname.endsWith('.yangkeduo.com')) {
    throw new Error('自动截图仅支持拼多多官方商品链接');
  }
  return url.toString();
}

async function performCapture(targetUrl, outputDir, cookie) {
  let browser;
  let outputPath;
  try {
    const puppeteer = require('puppeteer');
    const url = normalizePddUrl(targetUrl);
    const filename = `shot_auto_${Date.now()}_${Math.floor(Math.random() * 10000)}.png`;
    outputPath = path.join(outputDir, filename);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: findBrowserExecutable(puppeteer),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148');
    if (cookie) await page.setExtraHTTPHeaders({ Cookie: String(cookie) });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 35000 });
    await new Promise(resolve => setTimeout(resolve, 2500));
    const currentUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    if (/login/i.test(currentUrl) || /登录后继续|手机号登录/.test(bodyText)) {
      throw new Error('拼多多要求登录，商品页已打开；请登录后手动粘贴截图');
    }
    const dimensions = await page.evaluate(() => ({
      width: Math.max(1, Math.min(430, document.documentElement.clientWidth || 430)),
      height: Math.max(360, Math.min(820, document.documentElement.scrollHeight || 820)),
    }));
    await page.screenshot({
      path: outputPath,
      type: 'png',
      clip: { x: 0, y: 0, width: dimensions.width, height: dimensions.height },
      captureBeyondViewport: false,
    });
    return { filename, path: outputPath, pageText: bodyText, finalUrl: currentUrl };
  } catch (error) {
    if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    if (error && error.name === 'TimeoutError') throw new Error('商品页加载超时，已打开页面，请手动粘贴截图');
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function captureProductCard(targetUrl, outputDir, cookie) {
  const task = captureQueue.then(() => performCapture(targetUrl, outputDir, cookie));
  captureQueue = task.catch(() => {});
  return task;
}

module.exports = { captureProductCard };

