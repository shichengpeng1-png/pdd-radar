const { execSync } = require('child_process');
const { URL } = require('url');

// ===================== 配 =====================
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ===================== 从 URL 提取 goods_id =====================
function extractGoodsId(url) {
  if (!url) return null;
  const match = url.match(/goods_id[=:](\d+)/);
  if (match) return match[1];
  const pathMatch = url.match(/\/goods\/(\d+)/);
  if (pathMatch) return pathMatch[1];
  return null;
}

// ===================== HTTP 请求（使用 curl，自动支持代理）=====================
function fetchPage(targetUrl, userAgent, cookie) {
  const ua = userAgent || MOBILE_UA;
  const args = [
    '-s', '-L', '--max-time', '15',
    '-o', '-',
    '-w', '\n---HTTP_STATUS:%{http_code}---',
    '-H', `User-Agent: ${ua}`,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.3',
    '--compressed',
  ];
  if (cookie) {
    args.push('-H', `Cookie: ${cookie}`);
  }
  args.push(targetUrl);

  try {
    const output = execSync(`curl ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, {
      encoding: 'utf-8',
      timeout: 20000,
      maxBuffer: 5 * 1024 * 1024,
    });

    // 提取 HTTP 状态码
    const statusMatch = output.match(/---HTTP_STATUS:(\d+)---/);
    const statusCode = statusMatch ? parseInt(statusMatch[1]) : 200;
    const body = output.replace(/\n---HTTP_STATUS:\d+---$/, '');

    return { statusCode, body };
  } catch (err) {
    throw new Error(`请求失败: ${err.message}`);
  }
}

// ===================== 从 HTML 中提取销量 =====================
function extractSalesFromHtml(html) {
  if (!html) return { salesText: null, salesNumber: null, source: null, needLogin: false };

  // 策略1：从 window.rawData 提取（使用括号匹配提取完整JSON）
  try {
    const rawData = extractJsonObject(html, /window\.rawData\s*=\s*\{/);
    if (rawData) {
      // 检查是否需要登录
      const store = rawData.store || {};
      const initData = store.initDataObj || {};
      if (initData.needLogin === true) {
        return { salesText: null, salesNumber: null, source: null, needLogin: true };
      }
      const salesInfo = findSalesInObject(rawData);
      if (salesInfo) {
        return { ...salesInfo, source: 'rawData', needLogin: false };
      }
    }
  } catch (e) { /* 解析失败，继续其他策略 */ }

  // 策略2：从 initDataObj 提取
  try {
    const initData = extractJsonObject(html, /initDataObj\s*[:=]\s*\{/);
    if (initData) {
      if (initData.needLogin === true) {
        return { salesText: null, salesNumber: null, source: null, needLogin: true };
      }
      const salesInfo = findSalesInObject(initData);
      if (salesInfo) {
        return { ...salesInfo, source: 'initDataObj', needLogin: false };
      }
    }
  } catch (e) { /* 继续 */ }

  // 策略3：正则匹配页面中的销量文案
  const patterns = [
    /已拼\s*([\d,.]+\s*[万千亿]?)\s*件/,
    /已售\s*([\d,.]+\s*[万千亿]?)\s*件/,
    /已拼\s*([\d,.]+\s*[万千亿]?)/,
    /已售\s*([\d,.]+\s*[万千亿]?)/,
    /销量[：:]\s*([\d,.]+\s*[万千亿]?)/,
    /"salesTip"\s*:\s*"([^"]+)"/,
    /"sales"\s*:\s*"?(\d+)"?/,
    /"soldQuantity"\s*:\s*"?(\d+)"?/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const salesText = match[1].trim();
      const salesNumber = parseSalesNumber(salesText);
      if (salesNumber > 0) {
        return { salesText, salesNumber, source: 'regex', needLogin: false };
      }
    }
  }

  // 策略4：查找所有可能的数字+件/万的组合
  const allSalesMatches = html.matchAll(/已拼([\d,.]+[万千亿]?)件?/g);
  for (const m of allSalesMatches) {
    const salesText = m[1].trim();
    const salesNumber = parseSalesNumber(salesText);
    if (salesNumber > 0) {
      return { salesText, salesNumber, source: 'regex-fallback', needLogin: false };
    }
  }

  return { salesText: null, salesNumber: null, source: null, needLogin: false };
}

// ===================== 使用括号匹配提取完整 JSON 对象 =====================
function extractJsonObject(html, regex) {
  const match = html.match(regex);
  if (!match) return null;

  const start = match.index + match[0].length - 1; // 指向 {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escape) { escape = false; }
      else if (ch === '\\') { escape = true; }
      else if (ch === '"') { inString = false; }
    } else {
      if (ch === '"') { inString = true; }
      else if (ch === '{') { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = html.substring(start, i + 1);
          try {
            return JSON.parse(jsonStr);
          } catch (e) {
            return null;
          }
        }
      }
    }
  }
  return null;
}

// ===================== 递归查找对象中的销量字段 =====================
function findSalesInObject(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;

  // 检查常见销量字段名
  const salesKeys = ['salesTip', 'sales', 'soldQuantity', 'sold_quantity', 'salesCount', 'salesNum', 'salesVolume'];
  for (const key of salesKeys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      const val = String(obj[key]);
      const num = parseSalesNumber(val);
      if (num > 0) {
        return { salesText: val, salesNumber: num };
      }
    }
  }

  // 检查包含"已拼"的字符串值
  for (const key in obj) {
    if (typeof obj[key] === 'string') {
      const salesMatch = obj[key].match(/已拼\s*([\d,.]+\s*[万千亿]?)\s*件?/);
      if (salesMatch) {
        const salesText = salesMatch[0];
        const salesNumber = parseSalesNumber(salesMatch[1]);
        if (salesNumber > 0) {
          return { salesText, salesNumber };
        }
      }
    }
  }

  // 递归搜索子对象
  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      const result = findSalesInObject(obj[key], (depth || 0) + 1);
      if (result) return result;
    }
  }

  return null;
}

// ===================== 解析销量数字 =====================
function parseSalesNumber(text) {
  if (!text) return 0;
  const cleaned = String(text).trim();
  const wanMatch = cleaned.match(/([\d.]+)\s*万/);
  if (wanMatch) return Math.round(parseFloat(wanMatch[1]) * 10000);
  const yiMatch = cleaned.match(/([\d.]+)\s*亿/);
  if (yiMatch) return Math.round(parseFloat(yiMatch[1]) * 100000000);
  const numMatch = cleaned.match(/([\d,]+)/);
  if (numMatch) return parseInt(numMatch[1].replace(/,/g, ''), 10);
  return 0;
}

// ===================== 主函数：获取商品销量 =====================
async function fetchSales(pddUrl, cookie) {
  if (!pddUrl) {
    throw new Error('请提供拼多多链接');
  }

  // 确保 URL 是完整格式
  let url = pddUrl.trim();
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  // 提取 goods_id 用于构建标准 URL
  const goodsId = extractGoodsId(url);
  if (goodsId) {
    url = `https://mobile.yangkeduo.com/goods.html?goods_id=${goodsId}`;
  }

  let response;
  try {
    response = fetchPage(url, MOBILE_UA, cookie);
  } catch (err) {
    throw new Error(`请求拼多多页面失败: ${err.message}`);
  }

  if (response.statusCode !== 200) {
    throw new Error(`拼多多返回状态码 ${response.statusCode}，可能被反爬拦截`);
  }

  const html = response.body;
  if (!html || html.length < 100) {
    throw new Error('页面内容为空，可能被反爬拦截');
  }

  const result = extractSalesFromHtml(html);

  // 拼多多登录页 URL
  const pddLoginUrl = 'https://mobile.yangkeduo.com/login.html';

  if (result.needLogin) {
    return { needLogin: true, loginUrl: pddLoginUrl, goodsUrl: url };
  }

  if (!result.salesNumber || result.salesNumber === 0) {
    // 尝试桌面 UA 再请求一次
    try {
      const desktopRes = fetchPage(url, DESKTOP_UA, cookie);
      if (desktopRes.statusCode === 200 && desktopRes.body) {
        const desktopResult = extractSalesFromHtml(desktopRes.body);
        if (desktopResult.needLogin) {
          return { needLogin: true, loginUrl: pddLoginUrl, goodsUrl: url };
        }
        if (desktopResult.salesNumber && desktopResult.salesNumber > 0) {
          return {
            salesText: desktopResult.salesText,
            salesNumber: desktopResult.salesNumber,
            source: desktopResult.source,
          };
        }
      }
    } catch (e) {
      if (e.message && e.message.includes('需要登录')) {
        return { needLogin: true, loginUrl: pddLoginUrl, goodsUrl: url };
      }
      /* 忽略桌面请求失败 */
    }

    // 最后再检查一次是否需要登录
    if (result.needLogin) {
      return { needLogin: true, loginUrl: pddLoginUrl, goodsUrl: url };
    }

    throw new Error('未能从页面中提取到销量数据。拼多多可能需要登录或存在反爬限制。请使用截图 + OCR 识别方式记录销量。');
  }

  return {
    salesText: result.salesText,
    salesNumber: result.salesNumber,
    source: result.source,
  };
}

module.exports = { fetchSales, extractGoodsId };

