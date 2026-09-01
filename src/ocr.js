const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');

// ===================== 配置 =====================
const ACCESS_KEY_ID = process.env.OCR_ACCESS_KEY_ID || '';
const ACCESS_KEY_SECRET = process.env.OCR_ACCESS_KEY_SECRET || '';
const ENDPOINT = 'ocr-api.cn-hangzhou.aliyuncs.com';

// ===================== 签名函数 =====================
function percentEncode(str) {
  if (str == null) return '';
  return encodeURIComponent(str)
    .replace(/%20/g, '+')
    .replace(/%21/g, '!')
    .replace(/%2A/g, '*')
    .replace(/%27/g, "'")
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%7E/g, '~');
}

function buildQueryString(params) {
  return Object.keys(params)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
}

function getSignature(accessKeySecret, httpMethod, query) {
  const stringToSign = `${httpMethod}&${percentEncode('/')}&${percentEncode(query)}`;
  const secret = `${accessKeySecret}&`;
  const hash = crypto.createHmac('sha1', secret).update(stringToSign, 'utf-8').digest();
  return hash.toString('base64');
}

function buildCommonParams() {
  return {
    Action: 'RecognizeGeneral',
    Version: '2021-07-07',
    Format: 'JSON',
    AccessKeyId: ACCESS_KEY_ID,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString(),
  };
}

// ===================== OCR 识别 =====================
function recognizeByAliyun(filePath) {
  return new Promise((resolve, reject) => {
    if (!ACCESS_KEY_ID || !ACCESS_KEY_SECRET) {
      reject(new Error('OCR 未配置：请设置 OCR_ACCESS_KEY_ID 和 OCR_ACCESS_KEY_SECRET 环境变量'));
      return;
    }

    const params = buildCommonParams();
    const query = buildQueryString(params);
    const signature = getSignature(ACCESS_KEY_SECRET, 'POST', query);
    const requestUrl = `https://${ENDPOINT}/?${query}&Signature=${percentEncode(signature)}`;

    const fileBuffer = fs.readFileSync(filePath);

    const req = https.request(
      requestUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileBuffer.length,
        },
      },
      res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.Code || result.Message) {
              reject(new Error(`OCR 错误: ${result.Code} - ${result.Message}`));
              return;
            }
            // Data 是 JSON 字符串，需要二次解析
            if (result.Data && typeof result.Data === 'string') {
              const data = JSON.parse(result.Data);
              resolve({
                requestId: result.RequestId,
                content: data.content || '',
                words: (data.prism_wordsInfo || []).map(w => ({
                  word: w.word,
                  x: w.x,
                  y: w.y,
                  width: w.width,
                  height: w.height,
                })),
              });
            } else {
              resolve({ requestId: result.RequestId, content: '', words: [] });
            }
          } catch (e) {
            reject(new Error(`解析 OCR 结果失败: ${e.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
}

function runTesseract(filePath, psm) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/tesseract', [filePath, 'stdout', '-l', 'chi_sim+eng', '--psm', String(psm)],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, OMP_THREAD_LIMIT: '2' } },
      (error, stdout, stderr) => error
        ? reject(new Error(`本地 OCR 识别失败: ${(stderr || error.message || '').trim()}`))
        : resolve(stdout || ''));
  });
}

async function recognizeByLocalTesseract(filePath) {
  // 先按文本块识别；未发现销量关键字时再用稀疏文本模式补一次，
  // 以应对拼多多截图中数字和“已拼/已售”被拆成不同区域的情况。
  let content = await runTesseract(filePath, 6);
  if (!extractSalesFromOCRText(content).salesText) {
    try {
      const sparseContent = await runTesseract(filePath, 11);
      if (sparseContent) content = `${content}\n${sparseContent}`;
    } catch (_) {
      // 保留首次识别结果，避免补充模式失败影响正常上传。
    }
  }
  if (!content) throw new Error('本地 OCR 未返回识别内容');
  return { requestId: `local-${Date.now()}`, content, words: [], provider: 'local-tesseract-fast' };
}

// 本地 OCR 优先，避免已过期的云服务为每张图片增加网络等待；本地不可用时再尝试阿里云。
async function recognizeByFile(filePath) {
  if (fs.existsSync('/usr/bin/tesseract')) return recognizeByLocalTesseract(filePath);
  if (ACCESS_KEY_ID && ACCESS_KEY_SECRET) {
    const result = await recognizeByAliyun(filePath);
    return { ...result, provider: 'aliyun' };
  }
  throw new Error('OCR 服务不可用：阿里云未配置且本地 OCR 未安装');
}

// ===================== 从 OCR 文本中提取销量和评价数 =====================
function extractSalesFromOCRText(content) {
  if (!content) return { salesText: '', reviewsText: '' };

  let salesText = '';
  let reviewsText = '';
  // 本地 OCR 经常会把同一句拆成多行；压缩空白后再匹配。
  const normalized = String(content)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[，]/g, ',')
    .trim();
  const compact = normalized.replace(/\s+/g, '');

  // 尝试匹配销量 - 包括"已抢X件"模式
  const salesPatterns = [
    /([\d,.]+\s*[万千亿]?\+?)\s*(?:人)?已提前发货/,
    /([\d,.]+\s*[万千亿]?\+?)\s*人已拼/,
    /([\d,.]+\s*[万千亿]?\+?)\s*(?:人)?已付款/,
    /([\d,.]+\s*[万千亿]?\+?)\s*(?:人)?已购买/,
    /已抢\s*([\d,.]+\s*[万千亿]?\+?\s*件?)/,
    /已拼\s*([\d,.]+\s*[万千亿]?\+?\s*件?)/,
    /已售\s*([\d,.]+\s*[万千亿]?\+?\s*件?)/,
    /销量\s*[:：]?\s*([\d,.]+\s*[万千亿]?\+?)/,
    /总销量\s*[:：]?\s*([\d,.]+\s*[万千亿]?\+?)/,
    /全网销量\s*[:：]?\s*([\d,.]+\s*[万千亿]?\+?)/,
    /月销\s*([\d,.]+\s*[万千亿]?\+?)/,
    /(\d[\d,.]*\s*[万千亿]\+?\s*件)/,
    /(\d[\d,]+\+?\s*件)/,
  ];

  for (const pattern of salesPatterns) {
    const match = compact.match(pattern);
    if (match) {
      salesText = match[1].trim().replace(/\s+/g, '').replace(/件/g, '');
      break;
    }
  }

  // 尝试匹配评价数
  const reviewPatterns = [
    /评价\s*[:：]?\s*(\d[\d,.]*\s*万?\s*条?\+?)/,
    /全部评价\s*[:：]?\s*(\d[\d,.]*\s*万?\s*条?\+?)/,
    /评论\s*[:：]?\s*(\d[\d,.]*\s*万?\s*条?\+?)/,
    /(\d[\d,.]+\s*万\s*条评价)/,
    /(\d[\d,]+\s*条评价)/,
    /(\d[\d,]+\s*条评论)/,
  ];

  for (const pattern of reviewPatterns) {
    const match = compact.match(pattern);
    if (match) {
      reviewsText = match[1].trim().replace(/\s+/g, '');
      break;
    }
  }

  return { salesText, reviewsText };
}

// ===================== 从 OCR 文本中提取所有价格-销量对 =====================
// 适用于拼多多店铺截图，一张图含多个商品
function extractAllPriceSalesPairs(content) {
  if (!content) return [];

  const pairs = [];

  // 匹配所有 ￥XX.XX 已抢/已拼 X件 的组合
  // 模式1: ￥102.69已抢1477件
  // 模式2: ￥179.69已拼3件
  // 模式3: ￥208.56已抢54件
  // 模式4: 券后￥39.5已拼17件 (券后价格也匹配)
  const combinedPattern = /[￥¥]\s*(\d+(?:\.\d+)?)\s*(?:已抢|已拼|已售)\s*([\d,.]+\s*[万千亿]?\+?\s*件?)/g;

  let match;
  while ((match = combinedPattern.exec(content)) !== null) {
    pairs.push({
      price: match[1],
      salesText: match[2].trim().replace(/\s+/g, ''),
    });
  }

  // 如果组合匹配没结果，分别提取价格和销量
  if (pairs.length === 0) {
    const priceMatch = content.match(/[￥¥]\s*(\d+(?:\.\d+)?)/);
    const salesMatch = content.match(/(?:已抢|已拼|已售)\s*([\d,.]+\s*[万千亿]?\+?\s*件?)/);
    if (priceMatch) {
      pairs.push({
        price: priceMatch[1],
        salesText: salesMatch ? salesMatch[1].trim().replace(/\s+/g, '') : '',
      });
    }
  }

  // 去重（相同价格+销量只保留一条）
  const seen = new Set();
  return pairs.filter(p => {
    const key = p.price + '_' + p.salesText;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===================== 从 OCR 文本中提取价格 =====================
function extractPriceFromOCRText(content) {
  if (!content) return null;

  // 匹配 ￥XX.XX 或 ¥XX.XX 格式
  const pricePatterns = [
    /[￥¥]\s*(\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*元/,
  ];

  for (const pattern of pricePatterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

module.exports = {
  recognizeByFile,
  extractSalesFromOCRText,
  extractPriceFromOCRText,
  extractAllPriceSalesPairs,
  isConfigured: () => (!!ACCESS_KEY_ID && !!ACCESS_KEY_SECRET) || fs.existsSync('/usr/bin/tesseract'),
};

