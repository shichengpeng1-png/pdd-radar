const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'tracker.db');
const SCREENSHOT_DIR = path.join(__dirname, '..', 'data', 'screenshots');

let db;

function getDB() {
  if (!db) {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTables();
  }
  return db;
}

function initTables() {
  const d = getDB();

  // 店铺表
  d.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // 商品表 - 增加 store_id 和 screenshot_filename
  d.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      pdd_url TEXT,
      screenshot_filename TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (store_id) REFERENCES stores(id)
    )
  `);

  // 记录表 - screenshot_filename 改为可选
  d.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      screenshot_filename TEXT,
      sales_text TEXT,
      sales_number INTEGER DEFAULT 0,
      reviews_text TEXT,
      reviews_number INTEGER DEFAULT 0,
      ocr_raw TEXT,
      notes TEXT,
      captured_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
    CREATE INDEX IF NOT EXISTS idx_records_product ON records(product_id);
    CREATE INDEX IF NOT EXISTS idx_records_time ON records(captured_at);
  `);

  // 迁移：为已有 products 表添加 screenshot_filename 列（如果不存在）
  try {
    const cols = d.prepare("PRAGMA table_info(products)").all();
    if (!cols.some(c => c.name === 'screenshot_filename')) {
      d.exec('ALTER TABLE products ADD COLUMN screenshot_filename TEXT');
    }
  } catch (e) { /* 列可能已存在 */ }

  // 迁移：为已有 products 表添加 price 列（如果不存在）
  try {
    const cols = d.prepare("PRAGMA table_info(products)").all();
    if (!cols.some(c => c.name === 'price')) {
      d.exec('ALTER TABLE products ADD COLUMN price TEXT');
    }
  } catch (e) { /* 列可能已存在 */ }

  // 迁移：records 表的 screenshot_filename 从 NOT NULL 改为可空
  // SQLite 不支持 ALTER COLUMN，需要重建表
  try {
    const recCols = d.prepare("PRAGMA table_info(records)").all();
    const ssCol = recCols.find(c => c.name === 'screenshot_filename');
    if (ssCol && ssCol.notnull) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS records_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL,
          screenshot_filename TEXT,
          sales_text TEXT,
          sales_number INTEGER DEFAULT 0,
          reviews_text TEXT,
          reviews_number INTEGER DEFAULT 0,
          ocr_raw TEXT,
          notes TEXT,
          captured_at TEXT DEFAULT (datetime('now', 'localtime')),
          FOREIGN KEY (product_id) REFERENCES products(id)
        );
        INSERT INTO records_new SELECT * FROM records;
        DROP TABLE records;
        ALTER TABLE records_new RENAME TO records;
        CREATE INDEX IF NOT EXISTS idx_records_product ON records(product_id);
        CREATE INDEX IF NOT EXISTS idx_records_time ON records(captured_at);
      `);
    }
  } catch (e) { console.error('迁移 records 表失败:', e.message); }
}

// ==================== 店铺操作 ====================

function addStore(name, url) {
  const d = getDB();
  const info = d.prepare('INSERT INTO stores (name, url) VALUES (?, ?)').run(name, url || null);
  return getStore(info.lastInsertRowid);
}

function getStores() {
  const d = getDB();
  return d.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM products WHERE store_id = s.id) as product_count,
      (SELECT MAX(r.captured_at) FROM records r
       JOIN products p ON r.product_id = p.id
       WHERE p.store_id = s.id) as last_updated
    FROM stores s
    ORDER BY s.created_at DESC
  `).all();
}

function getStore(id) {
  const d = getDB();
  return d.prepare('SELECT * FROM stores WHERE id = ?').get(id);
}

function deleteStore(id) {
  const d = getDB();
  // 删除该店铺下所有商品的记录和截图
  const products = getProducts(id);
  for (const p of products) {
    const records = getRecords(p.id);
    for (const r of records) {
      deleteScreenshotFile(r.screenshot_filename);
    }
    d.prepare('DELETE FROM records WHERE product_id = ?').run(p.id);
  }
  d.prepare('DELETE FROM products WHERE store_id = ?').run(id);
  d.prepare('DELETE FROM stores WHERE id = ?').run(id);
}

function updateStore(id, name, url) {
  const d = getDB();
  d.prepare('UPDATE stores SET name = ?, url = ? WHERE id = ?').run(name, url, id);
  return getStore(id);
}

// ==================== 商品操作 ====================

function addProduct(storeId, name, pddUrl, price) {
  const d = getDB();
  const info = d.prepare('INSERT INTO products (store_id, name, pdd_url, price) VALUES (?, ?, ?, ?)').run(storeId, name, pddUrl || null, price || null);
  return getProduct(info.lastInsertRowid);
}

function getProducts(storeId) {
  const d = getDB();
  // 优化：用窗口函数一次性获取每个商品的最新记录、上次记录和记录数
  return d.prepare(`
    WITH latest_records AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY captured_at DESC, id DESC) as rn,
        COUNT(*) OVER (PARTITION BY product_id) as record_count
      FROM records
    ),
    first_records AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY captured_at ASC, id ASC) as rn
      FROM records
    )
    SELECT p.*,
      COALESCE(lr.record_count, 0) as record_count,
      lr.sales_number as latest_sales,
      lr.sales_text as latest_sales_text,
      lr.reviews_number as latest_reviews,
      lr.reviews_text as latest_reviews_text,
      lr.captured_at as last_updated,
      lr.screenshot_filename as latest_screenshot,
      lr2.sales_number as prev_sales,
      lr2.captured_at as previous_record_time,
      fr.sales_number as first_sales,
      fr.captured_at as first_record_time
    FROM products p
    LEFT JOIN latest_records lr ON lr.product_id = p.id AND lr.rn = 1
    LEFT JOIN latest_records lr2 ON lr2.product_id = p.id AND lr2.rn = 2
    LEFT JOIN first_records fr ON fr.product_id = p.id AND fr.rn = 1
    WHERE p.store_id = ?
    ORDER BY last_updated DESC
  `).all(storeId).map(p => {
    // 计算距上次销量的增长
    if (p.latest_sales !== null && p.latest_sales !== undefined && p.prev_sales !== null && p.prev_sales !== undefined) {
      p.sales_growth = p.latest_sales - p.prev_sales;
    } else {
      p.sales_growth = null;
    }
    if (p.latest_sales !== null && p.latest_sales !== undefined && p.first_sales !== null && p.first_sales !== undefined) {
      p.first_growth = p.latest_sales - p.first_sales;
    } else {
      p.first_growth = null;
    }
    return p;
  });
}

function getProduct(id) {
  const d = getDB();
  return d.prepare(`
    SELECT p.*, s.name as store_name, s.url as store_url
    FROM products p
    JOIN stores s ON p.store_id = s.id
    WHERE p.id = ?
  `).get(id);
}

function deleteProduct(id) {
  const d = getDB();
  const product = getProduct(id);
  if (product && product.screenshot_filename) {
    deleteScreenshotFile(product.screenshot_filename);
  }
  const records = getRecords(id);
  for (const r of records) {
    deleteScreenshotFile(r.screenshot_filename);
  }
  d.prepare('DELETE FROM records WHERE product_id = ?').run(id);
  d.prepare('DELETE FROM products WHERE id = ?').run(id);
}

function updateProduct(id, name, pddUrl, price) {
  const d = getDB();
  d.prepare('UPDATE products SET name = ?, pdd_url = ?, price = ? WHERE id = ?').run(name, pddUrl, price || null, id);
  return getProduct(id);
}

function updateProductScreenshot(id, filename) {
  const d = getDB();
  const product = getProduct(id);
  if (product && product.screenshot_filename) {
    deleteScreenshotFile(product.screenshot_filename);
  }
  d.prepare('UPDATE products SET screenshot_filename = ? WHERE id = ?').run(filename, id);
  return getProduct(id);
}

// ==================== 记录操作 ====================

function deleteScreenshotFile(filename) {
  if (!filename) return;
  const filePath = path.join(SCREENSHOT_DIR, filename);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
  }
}

function addRecord(productId, screenshotFilename, salesText, salesNumber, reviewsText, reviewsNumber, ocrRaw, notes) {
  const d = getDB();
  const info = d.prepare(`
    INSERT INTO records (product_id, screenshot_filename, sales_text, sales_number, reviews_text, reviews_number, ocr_raw, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(productId, screenshotFilename, salesText, salesNumber, reviewsText, reviewsNumber, ocrRaw, notes);
  return getRecord(info.lastInsertRowid);
}

function getRecords(productId) {
  const d = getDB();
  return d.prepare('SELECT * FROM records WHERE product_id = ? ORDER BY captured_at ASC, id ASC').all(productId);
}

function getRecord(id) {
  const d = getDB();
  return d.prepare('SELECT * FROM records WHERE id = ?').get(id);
}

function deleteRecord(id) {
  const d = getDB();
  const record = getRecord(id);
  if (record) {
    deleteScreenshotFile(record.screenshot_filename);
  }
  d.prepare('DELETE FROM records WHERE id = ?').run(id);
}

function updateRecord(id, salesText, salesNumber, reviewsText, reviewsNumber, notes) {
  const d = getDB();
  d.prepare('UPDATE records SET sales_text = ?, sales_number = ?, reviews_text = ?, reviews_number = ?, notes = ? WHERE id = ?')
    .run(salesText, salesNumber, reviewsText, reviewsNumber, notes, id);
  return getRecord(id);
}

// ==================== 增长统计 ====================

function getGrowthData(productId) {
  const d = getDB();
  const records = d.prepare('SELECT * FROM records WHERE product_id = ? ORDER BY captured_at ASC, id ASC').all(productId);

  if (records.length === 0) {
    return { records: [], intervals: [], cumulative: [], summary: null };
  }

  const firstSales = records[0].sales_number || 0;
  const latestSales = records[records.length - 1].sales_number || 0;
  const firstReviews = records[0].reviews_number || 0;
  const latestReviews = records[records.length - 1].reviews_number || 0;

  const intervals = [];
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const curr = records[i];
    intervals.push({
      fromTime: prev.captured_at,
      toTime: curr.captured_at,
      fromSales: prev.sales_number,
      toSales: curr.sales_number,
      salesGrowth: curr.sales_number - prev.sales_number,
      fromReviews: prev.reviews_number,
      toReviews: curr.reviews_number,
      reviewsGrowth: curr.reviews_number - prev.reviews_number,
    });
  }

  const cumulative = [];
  const firstTime = records.length > 0 ? new Date(records[0].captured_at.replace(' ', 'T')) : null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const salesGrowth = (r.sales_number || 0) - firstSales;
    const reviewsGrowth = (r.reviews_number || 0) - firstReviews;
    const curTime = new Date(r.captured_at.replace(' ', 'T'));
    const diffMs = curTime - firstTime;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    const avgDailySalesGrowth = diffDays > 0 ? salesGrowth / diffDays : null;
    const avgDailyReviewsGrowth = diffDays > 0 ? reviewsGrowth / diffDays : null;
    cumulative.push({
      time: r.captured_at,
      sales: r.sales_number,
      salesGrowth,
      reviews: r.reviews_number,
      reviewsGrowth,
      avgDailySalesGrowth,
      avgDailyReviewsGrowth,
      daysSinceFirst: Math.round(diffDays * 10) / 10,
    });
  }

  const totalSalesGrowth = latestSales - firstSales;
  const totalReviewsGrowth = latestReviews - firstReviews;

  return {
    records: records.map(r => ({
      id: r.id,
      salesText: r.sales_text,
      salesNumber: r.sales_number,
      reviewsText: r.reviews_text,
      reviewsNumber: r.reviews_number,
      capturedAt: r.captured_at,
      screenshotFilename: r.screenshot_filename,
      notes: r.notes,
    })),
    intervals,
    cumulative,
    summary: {
      firstSales,
      latestSales,
      totalSalesGrowth,
      totalSalesGrowthPercent: firstSales > 0 ? ((totalSalesGrowth / firstSales) * 100).toFixed(1) : null,
      firstReviews,
      latestReviews,
      totalReviewsGrowth,
      totalReviewsGrowthPercent: firstReviews > 0 ? ((totalReviewsGrowth / firstReviews) * 100).toFixed(1) : null,
      recordCount: records.length,
      avgDailySalesGrowth: cumulative.length > 0 && cumulative[cumulative.length - 1].avgDailySalesGrowth !== null
        ? cumulative[cumulative.length - 1].avgDailySalesGrowth : null,
      avgDailyReviewsGrowth: cumulative.length > 0 && cumulative[cumulative.length - 1].avgDailyReviewsGrowth !== null
        ? cumulative[cumulative.length - 1].avgDailyReviewsGrowth : null,
      totalDays: cumulative.length > 0 ? cumulative[cumulative.length - 1].daysSinceFirst : 0,
    },
  };
}

// ==================== 整店增长统计 ====================

function getStoreGrowthData(storeId) {
  const d = getDB();

  // 获取该店铺所有商品的所有记录
  const records = d.prepare(`
    SELECT r.*, p.name as product_name, p.price as product_price
    FROM records r
    JOIN products p ON r.product_id = p.id
    WHERE p.store_id = ?
    ORDER BY r.captured_at ASC, r.id ASC
  `).all(storeId);

  if (records.length === 0) {
    return { records: [], sessions: [], dailyGrowth: [], summary: null };
  }

  // 按商品分组记录
  const productRecords = {};
  for (const r of records) {
    if (!productRecords[r.product_id]) productRecords[r.product_id] = [];
    productRecords[r.product_id].push(r);
  }

  // 将记录按时间窗口分组为"记录批次"（15分钟内的算同一批次）
  const WINDOW_MS = 15 * 60 * 1000;
  const sessions = [];
  let currentSession = null;

  for (const r of records) {
    const t = new Date(r.captured_at).getTime();
    if (!currentSession || t - currentSession.endTime > WINDOW_MS) {
      // 新批次
      currentSession = {
        time: r.captured_at,
        endTime: t,
        records: [],
      };
      sessions.push(currentSession);
    }
    currentSession.records.push(r);
    if (t > currentSession.endTime) currentSession.endTime = t;
  }

  // 计算每个批次的销量增长总和
  // 对每个商品：找到它在该批次之前的最新记录，计算差值
  const sessionStats = sessions.map((session, sIdx) => {
    let totalSalesGrowth = 0;
    let totalReviewsGrowth = 0;
    let productCount = 0;
    const productGrowths = [];

    for (const r of session.records) {
      const prodRecs = productRecords[r.product_id];
      const thisIdx = prodRecs.findIndex(pr => pr.id === r.id);
      if (thisIdx > 0) {
        const prev = prodRecs[thisIdx - 1];
        const sg = (r.sales_number || 0) - (prev.sales_number || 0);
        const rg = (r.reviews_number || 0) - (prev.reviews_number || 0);
        totalSalesGrowth += sg;
        totalReviewsGrowth += rg;
        productCount++;
        productGrowths.push({
          productId: r.product_id,
          productName: r.product_name,
          productPrice: r.product_price,
          salesGrowth: sg,
          reviewsGrowth: rg,
        });
      } else {
        // 首次记录，没有增长
        productCount++;
        productGrowths.push({
          productId: r.product_id,
          productName: r.product_name,
          productPrice: r.product_price,
          salesGrowth: 0,
          reviewsGrowth: 0,
        });
      }
    }

    return {
      time: session.time,
      totalSalesGrowth,
      totalReviewsGrowth,
      productCount,
      productGrowths,
    };
  });

  // 计算平均每日增长（累积趋势）
  // 找出全店最早和最晚的记录时间
  const firstTime = new Date(records[0].captured_at);
  const lastTime = new Date(records[records.length - 1].captured_at);

  // 计算每个时间点的累计总销量和累计增长
  const productLatestSales = {};
  const productLatestReviews = {};
  const dailyGrowthData = [];
  let cumulativeSalesGrowth = 0;
  let cumulativeReviewsGrowth = 0;

  for (let i = 0; i < sessionStats.length; i++) {
    const session = sessionStats[i];
    const sessionTime = new Date(session.time);

    // 更新每个商品的最新销量
    for (const pg of session.productGrowths) {
      const prevSales = productLatestSales[pg.productId] || 0;
      const prevReviews = productLatestReviews[pg.productId] || 0;
      productLatestSales[pg.productId] = prevSales + pg.salesGrowth;
      productLatestReviews[pg.productId] = prevReviews + pg.reviewsGrowth;
    }

    // 重新计算累计总增长（所有商品当前值 - 所有商品初始值）
    // 简化：累计增长 = 所有商品各自的增长之和
    let totalSales = 0;
    let totalReviews = 0;
    for (const pid in productLatestSales) {
      totalSales += productLatestSales[pid];
      totalReviews += productLatestReviews[pid];
    }
    cumulativeSalesGrowth = totalSales;
    cumulativeReviewsGrowth = totalReviews;

    // 计算从首次记录到当前的天数
    const daysDiff = Math.max(1, (sessionTime - firstTime) / (1000 * 60 * 60 * 24));
    const avgDailySalesGrowth = cumulativeSalesGrowth / daysDiff;
    const avgDailyReviewsGrowth = cumulativeReviewsGrowth / daysDiff;

    dailyGrowthData.push({
      time: session.time,
      cumulativeSalesGrowth,
      cumulativeReviewsGrowth,
      avgDailySalesGrowth,
      avgDailyReviewsGrowth,
      days: Math.round(daysDiff * 10) / 10,
    });
  }

  // 汇总数据
  const totalDays = Math.max(1, (lastTime - firstTime) / (1000 * 60 * 60 * 24));
  const totalProducts = Object.keys(productRecords).length;

  return {
    sessions: sessionStats,
    dailyGrowth: dailyGrowthData,
    summary: {
      totalProducts,
      totalRecords: records.length,
      totalSessions: sessionStats.length,
      firstRecordTime: records[0].captured_at,
      latestRecordTime: records[records.length - 1].captured_at,
      totalSalesGrowth: cumulativeSalesGrowth,
      totalReviewsGrowth: cumulativeReviewsGrowth,
      avgDailySalesGrowth: cumulativeSalesGrowth / totalDays,
      avgDailyReviewsGrowth: cumulativeReviewsGrowth / totalDays,
      totalDays: Math.round(totalDays * 10) / 10,
    },
  };
}

// ==================== 自定义时间增长统计 ====================

function getStoreGrowthSinceTime(storeId, sinceTime) {
  const d = getDB();
  const since = new Date(sinceTime).getTime();

  // 获取该店铺所有商品的所有记录
  const records = d.prepare(`
    SELECT r.*, p.name as product_name, p.price as product_price
    FROM records r
    JOIN products p ON r.product_id = p.id
    WHERE p.store_id = ?
    ORDER BY r.captured_at ASC, r.id ASC
  `).all(storeId);

  if (records.length === 0) {
    return { products: [], summary: { totalSalesGrowth: 0, totalReviewsGrowth: 0, productCount: 0 } };
  }

  // 按商品分组记录
  const productRecords = {};
  for (const r of records) {
    if (!productRecords[r.product_id]) productRecords[r.product_id] = [];
    productRecords[r.product_id].push(r);
  }

  const productGrowths = [];
  let totalSalesGrowth = 0;
  let totalReviewsGrowth = 0;

  for (const pid in productRecords) {
    const recs = productRecords[pid];
    const productName = recs[0].product_name;
    const productPrice = recs[0].product_price;

    // 找到 selected time 之后最近的一条记录作为"当前值"
    // 如果没有 since 之后的记录，跳过该商品
    let currentRec = null;
    for (let i = recs.length - 1; i >= 0; i--) {
      if (new Date(recs[i].captured_at).getTime() > since) {
        currentRec = recs[i];
        break;
      }
    }
    if (!currentRec) continue;

    // 找到 since 及之前最近的一条记录作为"基线值"
    let baselineRec = null;
    for (let i = recs.length - 1; i >= 0; i--) {
      if (new Date(recs[i].captured_at).getTime() <= since) {
        baselineRec = recs[i];
        break;
      }
    }

    // 如果没有 since 之前的记录，基线为 0（即该商品的全部销量都算增长）
    const baselineSales = baselineRec ? (baselineRec.sales_number || 0) : 0;
    const baselineReviews = baselineRec ? (baselineRec.reviews_number || 0) : 0;

    const currentSales = currentRec.sales_number || 0;
    const currentReviews = currentRec.reviews_number || 0;

    const sg = currentSales - baselineSales;
    const rg = currentReviews - baselineReviews;

    totalSalesGrowth += sg;
    totalReviewsGrowth += rg;

    productGrowths.push({
      productId: parseInt(pid),
      productName,
      productPrice,
      baselineSales,
      currentSales,
      salesGrowth: sg,
      baselineReviews,
      currentReviews,
      reviewsGrowth: rg,
      baselineTime: baselineRec ? baselineRec.captured_at : null,
      currentTime: currentRec.captured_at,
    });
  }

  // 按销量增长降序排列
  productGrowths.sort((a, b) => b.salesGrowth - a.salesGrowth);

  return {
    products: productGrowths,
    summary: {
      totalSalesGrowth,
      totalReviewsGrowth,
      productCount: productGrowths.length,
      sinceTime: sinceTime,
    },
  };
}

// ==================== 数据解析辅助 ====================

function parseSalesNumber(text) {
  if (!text) return 0;
  const cleaned = text.trim();
  const wanMatch = cleaned.match(/([\d.]+)\s*万/);
  if (wanMatch) return Math.round(parseFloat(wanMatch[1]) * 10000);
  const yiMatch = cleaned.match(/([\d.]+)\s*亿/);
  if (yiMatch) return Math.round(parseFloat(yiMatch[1]) * 100000000);
  const numMatch = cleaned.match(/([\d,]+)/);
  if (numMatch) return parseInt(numMatch[1].replace(/,/g, ''), 10);
  return 0;
}

module.exports = {
  getDB,
  addStore, getStores, getStore, deleteStore, updateStore,
  addProduct, getProducts, getProduct, deleteProduct, updateProduct, updateProductScreenshot,
  addRecord, getRecords, getRecord, deleteRecord, updateRecord,
  getGrowthData,
  getStoreGrowthData,
  getStoreGrowthSinceTime,
  parseSalesNumber,
  SCREENSHOT_DIR,
};

