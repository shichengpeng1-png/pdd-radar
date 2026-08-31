const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// systemd 直接启动 Node 时主动读取项目 .env，避免 OCR 密钥未注入进程。
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const storage = require('./storage');
const pdd = require('./pdd');
const ocr = require('./ocr');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 动态返回 index.html，注入时间戳版本号，确保移动端每次都加载最新 JS/CSS
const noCacheHeaders = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
};

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const ver = Date.now();
  // 替换所有 ?v=xxx 为时间戳
  html = html.replace(/\?v=\d+/g, `?v=${ver}`);
  res.set(noCacheHeaders);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// 静态文件禁用缓存
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));
app.use('/screenshots', express.static(storage.SCREENSHOT_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// ==================== Multer 配置 ====================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, storage.SCREENSHOT_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `shot_${Date.now()}_${Math.round(Math.random() * 1e4)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif/;
    const ok = allowed.test(file.mimetype) || allowed.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('仅支持图片文件'), ok);
  },
});

// ==================== 店铺 API ====================

app.get('/api/stores', (req, res) => {
  try {
    res.json({ success: true, data: storage.getStores() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/stores', (req, res) => {
  try {
    const { name, url } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, error: '请输入店铺名称' });
    res.json({ success: true, data: storage.addStore(name.trim(), url) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/stores/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, url } = req.body;
    res.json({ success: true, data: storage.updateStore(id, name, url) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/stores/:id', (req, res) => {
  try {
    storage.deleteStore(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 商品 API ====================

app.get('/api/stores/:id/products', (req, res) => {
  try {
    res.json({ success: true, data: storage.getProducts(parseInt(req.params.id)) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/stores/:id/products', (req, res) => {
  try {
    const storeId = parseInt(req.params.id);
    const { name, pddUrl, price } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, error: '请输入商品名称' });
    res.json({ success: true, data: storage.addProduct(storeId, name.trim(), pddUrl, price) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/products/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, pddUrl, price } = req.body;
    res.json({ success: true, data: storage.updateProduct(id, name, pddUrl, price) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/products/:id', (req, res) => {
  try {
    storage.deleteProduct(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 商品截图上传
app.post('/api/products/:id/screenshot', upload.single('screenshot'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!req.file) return res.status(400).json({ success: false, error: '请上传图片文件' });
    const product = storage.updateProductScreenshot(id, req.file.filename);
    res.json({ success: true, data: product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 批量记录：上传剪切板截图并通过阿里云 OCR 预识别销量。
// 图片先保存在截图目录，确认保存记录时由前端把文件名一并提交。
app.post('/api/products/:id/ocr-preview', upload.fields([
  { name: 'screenshot', maxCount: 1 },
  { name: 'ocrImage', maxCount: 1 },
]), async (req, res) => {
  let ocrTempPath = '';
  try {
    const id = parseInt(req.params.id);
    if (!storage.getProduct(id)) return res.status(404).json({ success: false, error: '商品不存在' });
    const screenshot = req.files?.screenshot?.[0];
    const ocrImage = req.files?.ocrImage?.[0];
    if (!screenshot) return res.status(400).json({ success: false, error: '请粘贴图片' });
    if (!ocr.isConfigured()) return res.status(503).json({ success: false, error: 'OCR 服务暂不可用' });
    ocrTempPath = ocrImage?.path || '';
    const recognized = await ocr.recognizeByFile(ocrImage?.path || screenshot.path);
    const extracted = ocr.extractSalesFromOCRText(recognized.content);
    res.json({
      success: true,
      data: {
        screenshotFilename: screenshot.filename,
        salesText: extracted.salesText || '',
        ocrRaw: recognized.content || '',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (ocrTempPath) fs.unlink(ocrTempPath, () => {});
  }
});

// ==================== 记录 API ====================

app.get('/api/products/:id/records', (req, res) => {
  try {
    res.json({ success: true, data: storage.getRecords(parseInt(req.params.id)) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/products/:id/records', (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const { salesText, reviewsText, notes, screenshotFilename, ocrRaw } = req.body;
    const salesNumber = storage.parseSalesNumber(salesText || '');
    const reviewsNumber = storage.parseSalesNumber(reviewsText || '');

    const record = storage.addRecord(
      productId, screenshotFilename || null,
      salesText || null, salesNumber,
      reviewsText || null, reviewsNumber,
      ocrRaw || null, notes || null
    );
    res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/records/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { salesText, reviewsText, notes } = req.body;
    const salesNumber = storage.parseSalesNumber(salesText || '');
    const reviewsNumber = storage.parseSalesNumber(reviewsText || '');
    res.json({ success: true, data: storage.updateRecord(id, salesText, salesNumber, reviewsText, reviewsNumber, notes) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/records/:id', (req, res) => {
  try {
    storage.deleteRecord(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 通过拼多多链接获取当前销量
app.post('/api/products/:id/fetch-sales', async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const product = storage.getProduct(productId);
    if (!product) return res.status(404).json({ success: false, error: '商品不存在' });
    if (!product.pdd_url) return res.status(400).json({ success: false, error: '该商品未设置拼多多链接' });

    const cookie = req.body.cookie || '';
    const result = await pdd.fetchSales(product.pdd_url, cookie);
    // 如果需要登录，返回 needLogin 标识和登录链接
    if (result.needLogin) {
      return res.json({ success: false, needLogin: true, loginUrl: result.loginUrl, goodsUrl: result.goodsUrl, error: '该商品需要登录拼多多才能查看销量' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 增长统计 API ====================

app.get('/api/products/:id/growth', (req, res) => {
  try {
    res.json({ success: true, data: storage.getGrowthData(parseInt(req.params.id)) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/stores/:id/growth', (req, res) => {
  try {
    res.json({ success: true, data: storage.getStoreGrowthData(parseInt(req.params.id)) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/stores/:id/growth-since', (req, res) => {
  try {
    const since = req.query.since;
    if (!since) return res.status(400).json({ success: false, error: '请提供 since 时间参数' });
    const data = storage.getStoreGrowthSinceTime(parseInt(req.params.id), since);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  storage.getDB();
  console.log(`\n========================================`);
  console.log(`  拼多多截图销量追踪器 v2.0`);
  console.log(`  服务地址: http://localhost:${PORT}`);
  console.log(`========================================\n`);
});

