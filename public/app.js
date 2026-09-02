Warning: truncated output (original token count: 26644)
Total output lines: 2539

// ==================== 全局状态 ====================
let currentStoreId = null;
let currentProductId = null;
let stores = [];
let products = [];
let records = [];
let growthChartInstance = null;
let editingRecordId = null;
let editingStoreId = null;
let productSearchQuery = '';
let batchSearchQuery = '';
let productSortMode = 'default';
let activeBatchPasteZone = null;
let editProductScreenshotFilename = '';
let editProductOcrRaw = '';
let _storeGrowthSinceData = null;
let storeTooltipEl = null;

// ==================== 全局错误处理 ====================
window.addEventListener('error', (e) => {
  console.error('[PDD Tracker] 全局错误:', e.error || e.message);
  const errDiv = document.createElement('div');
  errDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#ef4444;color:#fff;padding:12px;font-size:13px;text-align:center;';
  errDiv.textContent = '页面错误: ' + (e.message || '未知错误');
  document.body.appendChild(errDiv);
  setTimeout(() => errDiv.remove(), 5000);
});

// 检测 Chart.js 是否加载成功
if (typeof Chart === 'undefined') {
  console.error('[PDD Tracker] Chart.js 未加载，图表功能不可用');
}

// ==================== API ====================
const API = {
  async get(url) { const r = await fetch(url); return r.json(); },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  },
  async put(url, body) {
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE' });
    return r.json();
  },
  async upload(url, formData) {
    const r = await fetch(url, { method: 'POST', body: formData });
    const text = await r.text();
    let result;
    try { result = JSON.parse(text); } catch (_) { result = { success: false, error: `上传失败（HTTP ${r.status}）` }; }
    if (!r.ok && !result.error) result.error = `上传失败（HTTP ${r.status}）`;
    return result;
  },
};

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
  try {
    bindEvents();
  } catch (err) {
    console.error('[PDD Tracker] bindEvents 出错:', err);
  }
  loadStores();
  document.addEventListener('paste', (event) => {
    const editModal = document.getElementById('editProductModal');
    if (editModal?.style.display === 'flex') {
      // 粘贴在蓝色区域时由区域自己的监听处理；弹窗其他位置则在这里兜底。
      if (!event.target?.closest?.('#editProductPasteZone')) handleEditProductPaste(event);
      return;
    }
    if (document.getElementById('batchRecordModal')?.style.display !== 'flex') return;
    if (event.target?.closest?.('.batch-paste-zone')) return;
    const zone = activeBatchPasteZone || document.querySelector('.batch-paste-zone');
    if (zone) handleBatchScreenshotPaste(event, zone.closest('.batch-record-item'));
  });
});

function bindEvents() {
  // 店铺
  try {
    document.getElementById('addStoreBtn').addEventListener('click', () => showModal('addStoreModal'));
    document.getElementById('confirmAddStore').addEventListener('click', handleAddStore);
    document.getElementById('confirmEditStore').addEventListener('click', handleEditStore);
    document.getElementById('headerBackBtn').addEventListener('click', () => { window.location.href = '/'; });
  } catch (e) { console.error('[PDD Tracker] 店铺事件绑定失败:', e); }

  // 商品
  try {
    document.getElementById('addProductBtn').addEventListener('click', handleOpenAddProduct);
    document.getElementById('confirmAddProduct').addEventListener('click', handleAddProduct);
    document.getElementById('batchRecordBtn').addEventListener('click', openBatchRecordModal);
    document.getElementById('confirmBatchRecord').addEventListener('click', handleBatchRecord);
  } catch (e) { console.error('[PDD Tracker] 商品事件绑定失败:', e); }

  // 商品搜索
  try {
    const searchInput = document.getElementById('productSearchInput');
    if (searchInput) {
      let _searchTimer = null;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => {
          productSearchQuery = e.target.value.trim().toLowerCase();
          renderProductList();
        }, 300);
      });
    }
  } catch (e) { console.error('[PDD Tracker] 搜索事件绑定失败:', e); }

  // 商品排序
  try {
    const sortSelect = document.getElementById('productSortSelect');
    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        productSortMode = e.target.value;
        renderProductList();
      });
    }
  } catch (e) { console.error('[PDD Tracker] 排序事件绑定失败:', e); }

  // 批量记录搜索
  try {
    const batchSearchInput = document.getElementById('batchSearchInput');
    if (batchSearchInput) {
      let _batchSearchTimer = null;
      batchSearchInput.addEventListener('input', (e) => {
        clearTimeout(_batchSearchTimer);
        _batchSearchTimer = setTimeout(() => {
          batchSearchQuery = e.target.value.trim().toLowerCase();
          renderBatchList();
        }, 300);
      });
    }
  } catch (e) { console.error('[PDD Tracker] 批量搜索事件绑定失败:', e); }

  // 删除商品（详情页按钮）
  try {
    document.getElementById('deleteProductBtn').addEventListener('click', () => {
      if (currentProductId) handleDeleteProduct(currentProductId);
    });
  } catch (e) { console.error('[PDD Tracker] 删除商品事件绑定失败:', e); }

  // 修改商品标题
  try {
    document.getElementById('editProductBtn').addEventListener('click', openEditProductModal);
    document.getElementById('confirmEditProduct').addEventListener('click', handleEditProduct);
    document.getElementById('openRecordListFromEdit').addEventListener('click', openRecordListFromEditModal);
    const editPasteZone = document.getElementById('editProductPasteZone');
    const editScreenshotInput = document.getElementById('editProductScreenshotInput');
    editPasteZone.addEventListener('click', (event) => {
      const preview = event.target.closest('img');
      if (preview) { event.stopPropagation(); viewImage(preview.src); return; }
      editScreenshotInput.click();
    });
    editPasteZone.addEventListener('paste', handleEditProductPaste);
    editScreenshotInput.addEventListener('change', () => {
      const file = editScreenshotInput.files?.[0];
      if (file) processEditProductImage(file);
      editScreenshotInput.value = '';
    });
    document.getElementById('editProductSales').addEventListener('input', updateEditProductSalesDelta);
    const detailPrice = document.getElementById('currentProductPrice');
    detailPrice.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); detailPrice.blur(); }
    });
    detailPrice.addEventListener('blur', saveCurrentProductPrice);
  } catch (e) { console.error('[PDD Tracker] 修改商品事件绑定失败:', e); }

  // 底部导航栏切换
  try {
    document.querySelectorAll('.tab-bar-item').forEach(item => {
      item.addEventListener('click', () => switchPanel(item.dataset.panel));
    });
  } catch (e) { console.error('[PDD Tracker] 导航栏事件绑定失败:', e); }

  // 添加记录
  try {
    document.getElementById('uploadBtn').addEventListener('click', openAddRecordModal);
    document.getElementById('cancelUpload').addEventListener('click', () => hideModal('uploadModal'));
    document.getElementById('confirmUpload').addEventListener('click', handleSaveRecord);
  } catch (e) { console.error('[PDD Tracker] 记录事件绑定失败:', e); }

  // 实时解析数值
  try {
    document.getElementById('ocrSalesText').addEventListener('input', updateOcrNumbers);
    document.getElementById('ocrReviewsText').addEventListener('input', updateOcrNumbers);
  } catch (e) { console.error('[PDD Tracker] OCR解析事件绑定失败:', e); }

  // 商品截图上传
  try {
    document.getElementById('uploadProductScreenshotBtn').addEventListener('click', () => {
      document.getElementById('productScreenshotInput').click();
    });
    document.getElementById('productScreenshotInput').addEventListener('change', (e) => {
      if (e.target.files[0]) handleProductScreenshotUpload(e.target.files[0]);
    });
  } catch (e) { console.error('[PDD Tracker] 截图上传事件绑定失败:', e); }

  // 访问当前商品网址
  try {
    document.getElementById('fetchSalesBtn').addEventListener('click', handleVisitCurrentProduct);
    document.getElementById('editProductVisitUrl').addEventListener('click', handleVisitEditProductUrl);
  } catch (e) { console.error('[PDD Tracker] 访问网址按钮绑定失败:', e); }

  // 标签切换
  try {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  } catch (e) { console.error('[PDD Tracker] 标签切换事件绑定失败:', e); }

  // 图表类型切换
  try {
    document.getElementById('chartType').addEventListener('change', () => {
      const chartType = document.getElementById('chartType').value;
      const customControls = document.getElementById('customIntervalControls');
      if (customControls) {
        customControls.style.display = chartType === 'custom-interval' ? 'flex' : 'none';
      }
      if (chartType === 'custom-interval') {
        populateCustomIntervalSelects();
      }
      renderGrowthChart();
    });
    const customStart = document.getElementById('customIntervalStart');
    const customEnd = document.getElementById('customIntervalEnd');
    if (customStart) customStart.addEventListener('change', renderGrowthChart);
    if (customEnd) customEnd.addEventListener('change', renderGrowthChart);
  } catch (e) { console.error('[PDD Tracker] 图表类型切换事件绑定失败:', e); }

  // 商品面板子Tab切换
  try {
    document.querySelectorAll('.sub-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchSubTab(btn.dataset.subtab));
    });
  } catch (e) { console.error('[PDD Tracker] 子Tab切换事件绑定失败:', e); }

  // 整店图表类型切换
  try {
    const storeChartTypeEl = document.getElementById('storeChartType');
    const customSinceInput = document.getElementById('customSinceTime');
    if (storeChartTypeEl) {
      storeChartTypeEl.addEventListener('change', () => {
        const customControls = document.getElementById('customSinceControls');
        if (customControls) {
          customControls.style.display = storeChartTypeEl.value === 'customSince' ? 'flex' : 'none';
        }
        if (storeChartTypeEl.value === 'customSince') {
          ensureCustomSinceDefault();
        }
        renderStoreChart();
      });
    }
    if (customSinceInput) {
      customSinceInput.addEventListener('focus', openCustomSincePicker);
      customSinceInput.addEventListener('click', openCustomSincePicker);
      customSinceInput.addEventListener('touchend', openCustomSincePicker);
      customSinceInput.addEventListener('change', () => {
        if (currentStoreId && customSinceInput.value) loadStoreGrowthSinceTime(currentStoreId, customSinceInput.value);
      });
    }
    document.querySelectorAll('.custom-since-quick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        applyCustomSinceHours(Number(btn.dataset.hours || 24));
      });
    });
    const customSinceBtn = document.getElementById('customSinceBtn');
    if (customSinceBtn) {
      customSinceBtn.addEventListener('click', () => {
        const sinceTime = document.getElementById('customSinceTime').value;
        if (!sinceTime) {
          showToast('请先选择时间', 'error');
          return;
        }
        if (currentStoreId) loadStoreGrowthSinceTime(currentStoreId, sinceTime);
      });
    }
  } catch (e) { console.error('[PDD Tracker] 整店图表切换事件绑定失败:', e); }

  // 截图查看
  try {
    document.getElementById('closeImageModal').addEventListener('click', () => hideModal('imageModal'));
  } catch (e) { console.error('[PDD Tracker] 截图查看事件绑定失败:', e); }

  // 编辑记录
  try {
    document.getElementById('confirmEditRecord').addEventListener('click', handleEditRecord);
  } catch (e) { console.error('[PDD Tracker] 编辑记录事件绑定失败:', e); }

  // 通用 modal 关闭：点击 .modal-cancel
  try {
    document.querySelectorAll('.modal-cancel').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal');
        if (modal) hideModal(modal.id);
      });
    });
  } catch (e) { console.error('[PDD Tracker] modal关闭事件绑定失败:', e); }

  // === 事件委托：店铺列表 ===
  try {
    const storeListEl = document.getElementById('storeList');
    storeListEl.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.list-item-edit');
      if (editBtn) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const item = editBtn.closest('.list-item');
        if (item) {
          const id = parseInt(item.dataset.id);
          openEditStoreModal(id);
        }
        return;
      }

      if (e.target.closest('.store-home-link')) {
        e.stopPropagation();
        return;
      }

      const item = e.target.closest('.list-item');
      if (!item) return;
      selectStore(parseInt(item.dataset.id));
    });
  } catch (e) { console.error('[PDD Tracker] 店铺列表委托绑定失败:', e); }

  // === 事件委托：商品列表 ===
  try {
    const productListEl = document.getElementById('productList');
    productListEl.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.list-item-copy');
      if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const item = copyBtn.closest('.list-item');
        if (item) handleBatchCopyName(parseInt(item.dataset.id));
        return;
      }

      const editBtn = e.target.closest('.list-item-product-edit');
      if (editBtn) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const item = editBtn.closest('.list-item');
        if (item) {
          currentProductId = parseInt(item.dataset.id);
          openEditProductModal();
        }
        return;
      }

      // 点击缩略图占位符 → 打开图片查看
      const thumbClick = e.target.closest('.list-item-thumb-clickable');
      if (thumbClick) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const screenshot = thumbClick.dataset.screenshot;
        if (screenshot) viewImage('/screenshots/' + screenshot);
        return;
      }

      const deleteBtn = e.target.closest('.list-item-delete');
      if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const item = deleteBtn.closest('.list-item');
        if (item) {
          const id = parseInt(item.dataset.id);
          handleDeleteProduct(id);
        }
        return;
      }

      const item = e.target.closest('.list-item');
      if (!item) return;
      selectProduct(parseInt(item.dataset.id));
    });
  } catch (e) { console.error('[PDD Tracker] 商品列表委托绑定失败:', e); }

  // === 事件委托：记录列表 ===
  try {
    const recordListEl = document.getElementById('recordList');
    recordListEl.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const recordId = parseInt(el.dataset.id);
      const action = el.dataset.action;

      if (action === 'view-screenshot') {
        const screenshot = el.dataset.screenshot;
        if (screenshot) viewImage('/screenshots/' + screenshot);
      } else if (action === 'edit') {
        openEditRecord(recordId);
      } else if (action === 'delete') {
        handleDeleteRecord(recordId);
      }
    });
  } catch (e) { console.error('[PDD Tracker] 记录列表委托绑定失败:', e); }

  // Enter 键提交
  try {
    document.getElementById('newStoreName').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleAddStore();
    });
    document.getElementById('newProductName').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleAddProduct();
    });
  } catch (e) { console.error('[PDD Tracker] Enter键事件绑定失败:', e); }
}

// ==================== 店铺管理 ====================
async function loadStores() {
  try {
    const result = await API.get('/api/stores');
    if (result.success) {
      stores = result.data;
      renderStoreList();
    }
  } catch (err) {
    showToast('加载店铺失败: ' + err.message, 'error');
  }
}

function renderStoreList() {
  const list = document.getElementById('storeList');
  if (stores.length === 0) {
    list.innerHTML = '<div class="list-empty">暂无店铺<br>点击上方"+"添加</div>';
    renderProductList();
    return;
  }

  const escapeText = value => String(value || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const displayUrl = value => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return `<a class="store-home-link" href="${escapeText(href)}" target="_blank" rel="noopener" title="${escapeText(raw)}">${escapeText(raw)}</a>`;
  };
  list.innerHTML = stores.map(s => `
    <div class="list-item ${s.id === currentStoreId ? 'active' : ''}" data-id="${s.id}">
      <div class="list-item-info store-list-info">
        <div class="list-item-name">${escapeText(s.name)}</div>
        ${displayUrl(s.url)}
        <div class="list-item-meta"><span>${s.product_count || 0} 个商品</span></div>
      </div>
      <button class="list-item-edit">编辑</button>
    </div>
  `).join('');
}

async function handleAddStore() {
  const name = document.getElementById('newStoreName').value.trim();
  const url = document.getElementById('newStoreUrl').value.trim();
  if (!name) { showToast('请输入店铺名称', 'error'); return; }

  try {
    const result = await API.post('/api/stores', { name, url });
    if (result.success) {
      hideModal('addStoreModal');
      document.getElementById('newStoreName').value = '';
      document.getElementById('newStoreUrl').value = '';
      showToast('店铺添加成功', 'success');
      await loadStores();
      selectStore(result.data.id);
    } else {
      showToast(result.error || '添加失败', 'error');
    }
  } catch (err) {
    showToast('添加失败: ' + err.message, 'error');
  }
}

function openEditStoreModal(id) {
  const store = stores.find(s => s.id === id);
  if (!store) return;
  editingStoreId = id;
  document.getElementById('editStoreName').value = store.name || '';
  document.getElementById('editStoreUrl').value = store.url || '';
  showModal('editStoreModal');
}

async function handleEditStore() {
  if (!editingStoreId) return;
  const name = document.getElementById('editStoreName').value.trim();
  const url = document.getElementById('editStoreUrl').value.trim();
  if (!name) { showToast('请输入店铺名称', 'error'); return; }
  try {
    const result = await API.put(`/api/stores/${editingStoreId}`, { name, url });
    if (!result.success) throw new Error(result.error || '修改失败');
    hideModal('editStoreModal');
    showToast('店铺信息已更新', 'success');
    const editedId = editingStoreId;
    editingStoreId = null;
    await loadStores();
    if (currentStoreId === editedId) {
      const current = stores.find(s => s.id === editedId);
      if (current) document.getElementById('productsTitle').textContent = current.name;
    }
  } catch (err) {
    showToast('修改失败: ' + err.message, 'error');
  }
}

async function handleDeleteStore(id) {
  const store = stores.find(s => s.id === id);
  if (!store) return;
  const ok = await showConfirm(`确定删除店铺「${store.name}」及其下所有商品和记录？此操作不可撤销。`, '删除店铺');
  if (!ok) return;

  try {
    await API.del(`/api/stores/${id}`);
    showToast('店铺已删除', 'success');
    if (currentStoreId === id) {
      currentStoreId = null;
      currentProductId = null;
      showEmptyState();
    }
    await loadStores();
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
}

function selectStore(id) {
  currentStoreId = id;
  currentProductId = null;
  _storeGrowthData = null;
  _storeGrowthSinceData = null;
  if (storeChartInstance) { storeChartInstance.destroy(); storeChartInstance = null; }
  productSearchQuery = '';
  productSortMode = 'default';
  const searchInput = document.getElementById('productSearchInput');
  if (searchInput) searchInput.value = '';
  const sortSelect = document.getElementById('productSortSelect');
  if (sortSelect) sortSelect.value = 'default';
  const store = stores.find(s => s.id === id);
  if (!store) return;

  document.getElementById('productsTitle').textContent = store.name;
  document.getElementById('addProductBtn').disabled = false;
  document.getElementById('batchRecordBtn').disabled = false;
  renderStoreList();
  showEmptyState();
  loadProducts(id);
  switchPanel('products');
}

// ==================== 商品管理 ====================
async function loadProducts(storeId) {
  try {
    const result = await API.get(`/api/stores/${storeId}/products`);
    if (storeId !== currentStoreId) return;
    if (result.success) {
      products = result.data;
      renderProductList();
    }
  } catch (err) {
    showToast('加载商品失败: ' + err.message, 'error');
  }
}

function renderProductList() {
  const list = document.getElementById('productList');
  if (!currentStoreId || products.length === 0) {
    list.innerHTML = '<div class="list-empty">暂无商品<br>点击上方"+"添加</div>';
    return;
  }

  // 按搜索关键词过滤
  let filtered = productSearchQuery
    ? products.filter(p => p.name.toLowerCase().includes(productSearchQuery))
    : products;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="list-empty">未找到匹配「${productSearchQuery}」的商品</div>`;
    return;
  }

  // 按销量增长排序
  if (productSortMode === 'growth-desc') {
    filtered = [...filtered].sort((a, b) => (b.sales_growth || 0) - (a.sales_growth || 0));
  } else if (productSortMode === 'growth-asc') {
    filtered = [...filtered].sort((a, b) => (a.sales_growth || 0) - (b.sales_growth || 0));
  } else if (productSortMode === 'first-growth-desc') {
    filtered = [...filtered].sort((a, b) => (b.sales_growth || 0) - (a.sales_growth || 0));
  } else if (productSortMode === 'first-growth-asc') {
    filtered = [...filtered].sort((a, b) => (a.sales_growth || 0) - (b.sales_growth || 0));
  }

  list.innerHTML = filtered.map((p, index) => {
    const thumbFile = p.screenshot_filename || p.latest_screenshot;
    // 图片懒加载：不自动加载缩略图，点击才打开
    const thumb = thumbFile
      ? `<div class="list-item-thumb-placeholder list-item-thumb-clickable" data-screenshot="${thumbFile}">📷</div>`
      : '<div class="list-item-thumb-placeholder">📦</div>';
    // 销量增长显示
    let growthHtml = '';
    if (p.sales_growth !== null && p.sales_growth !== undefined && p.record_count >= 2) {
      const g = p.sales_growth;
      const cls = g > 0 ? 'growth-positive' : g < 0 ? 'growth-negative' : '';
      const sign = g > 0 ? '+' : '';
      growthHtml = `<span class="sales ${cls}">新增${sign}${formatNumber(g)}</span>`;
    }
    return `
    <div class="list-item ${p.id === currentProductId ? 'active' : ''}" data-id="${p.id}">
      <span class="list-item-index" aria-label="第 ${index + 1} 个商品">${index + 1}</span>
      ${thumb}
      <div class="list-item-info">
        <div class="list-item-name">${p.price ? `<span style="color:var(--accent);font-weight:600;margin-right:6px;">¥${p.price}</span>` : ''}${p.name}</div>
        <div class="list-item-meta">
          <span>${p.record_count || 0} 条记录</span>
          ${p.latest_sales_text ? `<span class="sales">${p.latest_sales_text}</span>` : ''}
          ${growthHtml}
        </div>
      </div>
      <button class="list-item-copy" title="复制完整商品标题">复制标题</button>
      <button class="list-item-product-edit">编辑</button>
    </div>
  `}).join('');
}

function handleOpenAddProduct() {
  if (!currentStoreId) { showToast('请先选择店铺', 'error'); return; }
  const store = stores.find(s => s.id === currentStoreId);
  document.getElementById('addProductStoreName').textContent = '— ' + store.name;
  document.getElementById('newProductName').value = '';
  document.getElementById('newProductUrl').value = '';
  showModal('addProductModal');
}

async function handleAddProduct() {
  if (!currentStoreId) return;
  const name = document.getElementById('newProductName').value.trim();
  const pddUrl = document.getElementById('newProductUrl').value.trim();
  if (!name) { showToast('请输入商品名称', 'error'); return; }

  try {
    const result = await API.post(`/api/stores/${currentStoreId}/products`, { name, pddUrl });
    if (result.success) {
      hideModal('addProductModal');
      showToast('商品添加成功', 'success');
      await loadProducts(currentStoreId);
      selectProduct(result.data.id);
    } else {
      showToast(result.error || '添加失败', 'error');
    }
  } catch (err) {
    showToast('添加失败: ' + err.message, 'error');
  }
}

async function selectProduct(id) {
  currentProductId = id;
  const product = products.find(p => p.id === id);
  if (!product) return;

  const store = stores.find(s => s.id === currentStoreId);

  // 第一步：立即切换面板 + 更新列表选中态（极轻量，同步执行）
  // 先 switchTab('records') 再 switchPanel('detail')，避免 switchPanel 误触发图表加载
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('productDetail').style.display = 'block';
  switchTab('records');
  switchPanel('detail');

  // 更新列表项 active 状态
  document.querySelectorAll('#productList .list-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.id) === id);
  });

  // 第二步：用 rAF 延迟详情内容渲染，让面板切换先绘制到屏幕
  requestAnimationFrame(() => {
    document.getElementById('breadcrumb').textContent = `${store ? store.name : ''} >`;
    document.getElementById('currentProductName').textContent = product.name;
    document.getElementById('currentProductPrice').value = product.price || '';

    const urlEl = document.getElementById('currentProductUrl');
    const fetchBtn = document.getElementById('fetchSalesBtn');
    if (product.pdd_url) {
      urlEl.textContent = product.pdd_url;
      urlEl.href = product.pdd_url;
      urlEl.style.display = 'block';
      if (fetchBtn) fetchBtn.style.display = 'inline-block';
    } else {
      urlEl.style.display = 'none';
      if (fetchBtn) fetchBtn.style.display = 'none';
    }

    updateProductScreenshotDisplay(product);

    // 显示加载中状态
    const recordList = document.getElementById('recordList');
    if (recordList) {
      recordList.innerHTML = '<p style="color:var(--text-muted);padding:40px;text-align:center;">加载中...</p>';
    }

    // 异步加载记录，不阻塞渲染
    loadRecords(id);
  });
}

function updateProductScreenshotDisplay(product) {
  const img = document.getElementById('productScreenshotImg');
  const placeholder = document.getElementById('productScreenshotPlaceholder');
  const thumbFile = product.screenshot_filename || product.latest_screenshot;
  if (thumbFile) {
    const src = '/screenshots/' + thumbFile;
    img.src = src;
    img.style.display = 'block';
    placeholder.style.display = 'none';
    img.onclick = () => viewImage('/screenshots/' + thumbFile);
  } else {
    img.style.display = 'none';
    placeholder.style.display = 'flex';
    img.onclick = null;
  }
}

async function handleProductScreenshotUpload(file) {
  if (!currentProductId) return;
  if (!file.type.startsWith('image/')) { showToast('请上传图片文件', 'error'); return; }
  if (file.size > 20 * 1024 * 1024) { showToast('图片大小不能超过20MB', 'error'); return; }

  showLoading('正在上传商品截图...');
  const formData = new FormData();
  formData.append('screenshot', file);

  try {
    const result = await API.upload(`/api/products/${currentProductId}/screenshot`, formData);
    hideLoading();
    if (result.success) {
      showToast('商品截图上传成功', 'success');
      // 更新本地商品数据
      const product = products.find(p => p.id === currentProductId);
      if (product) product.screenshot_filename = result.data.screenshot_filename;
      updateProductScreenshotDisplay(product);
      renderProductList();
    } else {
      showToast(result.error || '上传失败', 'error');
    }
  } catch (err) {
    hideLoading();
    showToast('上传失败: ' + err.message, 'error');
  }
}

async function handleDeleteProduct(id) {
  const ok = await showConfirm('确定删除该商品及所有记录？此操作不可撤销。', '删除商品');
  if (!ok) return;
  try {
    await API.del(`/api/products/${id}`);
    showToast('商品已删除', 'success');
    if (currentProductId === id) {
      currentProductId = null;
      showEmptyState();
    }
    await loadProducts(currentStoreId);

…11644 tokens truncated…title: { display: true, text: '销量增长量', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });

    // 显示自定义区间统计摘要
    const sg = totalGrowth > 0 ? 'positive' : totalGrowth < 0 ? 'negative' : '';
    const rg = totalReviewsGrowth > 0 ? 'positive' : totalReviewsGrowth < 0 ? 'negative' : '';
    const avgDaily = daysDiff > 0 ? Math.round(totalGrowth / daysDiff) : null;
    document.getElementById('growthSummary').innerHTML = `
      <div class="growth-summary-card"><span class="label">起始记录</span><span class="value">第${startIdx}次</span></div>
      <div class="growth-summary-card"><span class="label">结束记录</span><span class="value">第${endIdx}次</span></div>
      <div class="growth-summary-card"><span class="label">区间天数</span><span class="value">${daysDiff} 天</span></div>
      <div class="growth-summary-card"><span class="label">起始销量</span><span class="value">${formatNumber(selectedRecords[0].salesNumber)}</span></div>
      <div class="growth-summary-card"><span class="label">结束销量</span><span class="value">${formatNumber(selectedRecords[selectedRecords.length - 1].salesNumber)}</span></div>
      <div class="growth-summary-card"><span class="label">区间销量增长</span><span class="value ${sg}">${totalGrowth >= 0 ? '+' : ''}${formatNumber(totalGrowth)}</span></div>
      <div class="growth-summary-card"><span class="label">区间评价增长</span><span class="value ${rg}">${totalReviewsGrowth >= 0 ? '+' : ''}${formatNumber(totalReviewsGrowth)}</span></div>
      <div class="growth-summary-card"><span class="label">平均日增销量</span><span class="value ${sg}">${avgDaily !== null ? (avgDaily >= 0 ? '+' : '') + formatNumber(avgDaily) + '/天' : '-'}</span></div>
      <div class="growth-summary-card"><span class="label">区间记录数</span><span class="value">${selectedRecords.length}</span></div>
    `;
    return; // 跳过底部的 renderGrowthSummary

  } else if (chartType === 'cumulative') {
    // 每个点相对首次记录计算，和“距首次销量增长趋势”的名称保持一致。
    const firstSalesGrowth = data.cumulative.map(item => Number(item.salesGrowth || 0));
    const firstReviewsGrowth = data.cumulative.map(item => Number(item.reviewsGrowth || 0));
    // 悬浮提示中的“距上次”单独按相邻两条记录计算。
    const previousSalesGrowth = data.records.map((_, index) =>
      index === 0 ? 0 : Number(data.intervals[index - 1]?.salesGrowth || 0)
    );
    chartData = {
      labels,
      datasets: [
        { label: '距首次增长销量', data: firstSalesGrowth, borderColor: accentColor, backgroundColor: accentBg, tension: 0.3, fill: true, pointRadius: 5, pointBackgroundColor: accentColor },
        { label: '距首次增长评价', data: firstReviewsGrowth, borderColor: warnColor, backgroundColor: warnBg, tension: 0.3, fill: false, pointRadius: 4, pointBackgroundColor: warnColor },
      ],
    };

    growthChartInstance = new Chart(ctx, {
      type: 'line', data: chartData,
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: '距首次记录的销量增长趋势', color: '#e4e7ed', font: { size: 16 } },
          legend: { labels: { color: '#9ca3af' } },
          tooltip: { callbacks: { afterLabel: (c) => {
            const d = data.cumulative[c.dataIndex];
            const lines = [
              `当时销量: ${formatNumber(d.sales)}`,
              `当时评价: ${formatNumber(d.reviews)}`,
              `距上次增长销量: ${previousSalesGrowth[c.dataIndex] >= 0 ? '+' : ''}${formatNumber(previousSalesGrowth[c.dataIndex])}`,
              `距首次增长评价: ${firstReviewsGrowth[c.dataIndex] >= 0 ? '+' : ''}${formatNumber(firstReviewsGrowth[c.dataIndex])}`,
            ];
            if (d.avgDailySalesGrowth !== null) {
              const sign = d.avgDailySalesGrowth >= 0 ? '+' : '';
              lines.push(`平均日增销量: ${sign}${formatNumber(Math.round(d.avgDailySalesGrowth))}/天`);
              lines.push(`平均日增评价: ${d.avgDailyReviewsGrowth >= 0 ? '+' : ''}${formatNumber(Math.round(d.avgDailyReviewsGrowth))}/天`);
              lines.push(`距首次: ${d.daysSinceFirst} 天`);
            }
            return lines;
          }}}
        },
        scales: {
          x: { ticks: { color: '#9ca3af', maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { title: { display: true, text: '增长量', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });

  } else if (chartType === 'total') {
    chartData = { labels, datasets: [{ label: '总销量', data: data.records.map(r => r.salesNumber), borderColor: accentColor, backgroundColor: accentBg, tension: 0.3, fill: true, pointRadius: 5, pointBackgroundColor: accentColor }] };

    growthChartInstance = new Chart(ctx, {
      type: 'line', data: chartData,
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: '商品总销量趋势', color: '#e4e7ed', font: { size: 16 } }, legend: { labels: { color: '#9ca3af' } } },
        scales: {
          x: { ticks: { color: '#9ca3af', maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { title: { display: true, text: '销量', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });

  } else if (chartType === 'reviews') {
    chartData = { labels, datasets: [{ label: '商品评价', data: data.records.map(r => r.reviewsNumber), borderColor: warnColor, backgroundColor: warnBg, tension: 0.3, fill: true, pointRadius: 5, pointBackgroundColor: warnColor }] };

    growthChartInstance = new Chart(ctx, {
      type: 'line', data: chartData,
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: '商品评价趋势', color: '#e4e7ed', font: { size: 16 } }, legend: { labels: { color: '#9ca3af' } } },
        scales: {
          x: { ticks: { color: '#9ca3af', maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { title: { display: true, text: '商品评价', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });
  }

  renderGrowthSummary(data.summary);
}

function renderGrowthSummary(summary) {
  if (!summary) { document.getElementById('growthSummary').innerHTML = ''; return; }

  const sg = summary.totalSalesGrowth > 0 ? 'positive' : summary.totalSalesGrowth < 0 ? 'negative' : '';
  const rg = summary.totalReviewsGrowth > 0 ? 'positive' : summary.totalReviewsGrowth < 0 ? 'negative' : '';
  const sp = summary.totalSalesGrowthPercent !== null ? `(${summary.totalSalesGrowthPercent}%)` : '';
  const rp = summary.totalReviewsGrowthPercent !== null ? `(${summary.totalReviewsGrowthPercent}%)` : '';
  const avgSales = summary.avgDailySalesGrowth !== null && summary.avgDailySalesGrowth !== undefined
    ? `${summary.avgDailySalesGrowth >= 0 ? '+' : ''}${formatNumber(Math.round(summary.avgDailySalesGrowth))}/天` : '-';
  const avgReviews = summary.avgDailyReviewsGrowth !== null && summary.avgDailyReviewsGrowth !== undefined
    ? `${summary.avgDailyReviewsGrowth >= 0 ? '+' : ''}${formatNumber(Math.round(summary.avgDailyReviewsGrowth))}/天` : '-';

  document.getElementById('growthSummary').innerHTML = `
    <div class="growth-summary-card"><span class="label">记录次数</span><span class="value">${summary.recordCount}</span></div>
    <div class="growth-summary-card"><span class="label">首次销量</span><span class="value">${formatNumber(summary.firstSales)}</span></div>
    <div class="growth-summary-card"><span class="label">最新销量</span><span class="value">${formatNumber(summary.latestSales)}</span></div>
    <div class="growth-summary-card"><span class="label">销量总增长 ${sp}</span><span class="value ${sg}">${summary.totalSalesGrowth >= 0 ? '+' : ''}${formatNumber(summary.totalSalesGrowth)}</span></div>
    <div class="growth-summary-card"><span class="label">首次评价</span><span class="value">${formatNumber(summary.firstReviews)}</span></div>
    <div class="growth-summary-card"><span class="label">最新评价</span><span class="value">${formatNumber(summary.latestReviews)}</span></div>
    <div class="growth-summary-card"><span class="label">评价总增长 ${rp}</span><span class="value ${rg}">${summary.totalReviewsGrowth >= 0 ? '+' : ''}${formatNumber(summary.totalReviewsGrowth)}</span></div>
    <div class="growth-summary-card"><span class="label">记录天数</span><span class="value">${summary.totalDays || 0} 天</span></div>
    <div class="growth-summary-card"><span class="label">平均日增销量</span><span class="value ${sg}">${avgSales}</span></div>
    <div class="growth-summary-card"><span class="label">平均日增评价</span><span class="value ${rg}">${avgReviews}</span></div>
  `;
}

// ==================== Tab 切换 ====================
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tabName}`);
  });
  if (tabName === 'charts' && currentProductId) {
    loadGrowthChart(currentProductId);
  }
}

// ==================== 商品面板子Tab切换 ====================
let storeChartInstance = null;
let _storeGrowthData = null;

function switchSubTab(subtabName) {
  document.querySelectorAll('.sub-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.subtab === subtabName);
  });
  document.querySelectorAll('.sub-tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `subtab-${subtabName}`);
  });
  if (subtabName === 'store-stats' && currentStoreId) {
    loadStoreGrowthChart(currentStoreId);
  }
}

function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ensureCustomSinceDefault() {
  const input = document.getElementById('customSinceTime');
  if (!input) return;
  input.max = toDatetimeLocalValue(new Date());
  if (!input.value) {
    const defaultDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    input.value = toDatetimeLocalValue(defaultDate);
  }
}

function openCustomSincePicker(event) {
  const input = document.getElementById('customSinceTime');
  if (!input) return;
  ensureCustomSinceDefault();
  if (typeof input.showPicker === 'function') {
    if (event) event.preventDefault();
    try { input.showPicker(); } catch (_) {}
  }
}

function applyCustomSinceHours(hours) {
  const input = document.getElementById('customSinceTime');
  if (!input) return;
  const date = new Date(Date.now() - hours * 60 * 60 * 1000);
  input.value = toDatetimeLocalValue(date);
  input.max = toDatetimeLocalValue(new Date());
  if (currentStoreId) loadStoreGrowthSinceTime(currentStoreId, input.value);
}

async function loadStoreGrowthChart(storeId) {
  try {
    const res = await API.get(`/api/stores/${storeId}/growth`);
    if (storeId !== currentStoreId) return;
    if (!res.success) throw new Error(res.error || '加载失败');
    _storeGrowthData = res.data;
    renderStoreChart();
  } catch (err) {
    showToast('加载整店统计失败: ' + err.message, 'error');
  }
}

async function loadStoreGrowthSinceTime(storeId, sinceTime) {
  try {
    const res = await API.get(`/api/stores/${storeId}/growth-since?since=${encodeURIComponent(sinceTime)}`);
    if (storeId !== currentStoreId) return;
    if (!res.success) throw new Error(res.error || '加载失败');
    _storeGrowthSinceData = res.data;
    renderStoreChart();
  } catch (err) {
    showToast('加载自定义时间增长失败: ' + err.message, 'error');
  }
}

function ensureStoreTooltip() {
  if (storeTooltipEl) return storeTooltipEl;
  storeTooltipEl = document.createElement('div');
  storeTooltipEl.id = 'storeChartTooltip';
  storeTooltipEl.style.cssText = 'position:fixed;z-index:99999;display:none;width:min(440px,calc(100vw - 24px));max-height:min(70vh,560px);overflow-y:auto;background:#11151c;color:#f8fafc;border:1px solid #2b3440;border-radius:10px;padding:12px;box-shadow:0 14px 30px rgba(0,0,0,.45);font-size:12px;line-height:1.55;pointer-events:none;';
  document.body.appendChild(storeTooltipEl);
  return storeTooltipEl;
}

function hideStoreTooltip() {
  ensureStoreTooltip().style.display = 'none';
}

function renderStoreSessionTooltip(context, sessions) {
  const tooltip = context.tooltip;
  const tip = ensureStoreTooltip();
  if (!tooltip || tooltip.opacity === 0) {
    tip.style.display = 'none';
    return;
  }

  const point = tooltip.dataPoints?.[0];
  const session = point ? sessions[point.dataIndex] : null;
  if (!session) {
    tip.style.display = 'none';
    return;
  }

  const allGrowths = [...(session.productGrowths || [])]
    .filter(pg => Number(pg.salesGrowth) !== 0 || Number(pg.reviewsGrowth) !== 0)
    .sort((a, b) => Math.abs(Number(b.salesGrowth || 0)) - Math.abs(Number(a.salesGrowth || 0)));

  tip.innerHTML = `
    <div style="font-weight:700;font-size:13px;margin-bottom:6px;">第${point.dataIndex + 1}次记录</div>
    <div>销量增长总和: ${session.totalSalesGrowth >= 0 ? '+' : ''}${formatNumber(session.totalSalesGrowth)}</div>
    <div>时间: ${formatTime(session.time)}</div>
    <div style="margin-bottom:6px;">涉及商品: ${session.productCount} 个</div>
    <div style="max-height:260px;overflow-y:auto;border-top:1px solid #303744;padding-top:6px;">
      ${allGrowths.length ? allGrowths.map(pg => `<div style="padding:2px 0;word-break:break-all;">¥${pg.productPrice || '—'} ${pg.productName}: <strong style="color:${Number(pg.salesGrowth) >= 0 ? '#22c55e' : '#ef4444'};">${Number(pg.salesGrowth) >= 0 ? '+' : ''}${formatNumber(pg.salesGrowth)}</strong>${Number(pg.reviewsGrowth) ? `　评价 ${Number(pg.reviewsGrowth) >= 0 ? '+' : ''}${formatNumber(pg.reviewsGrowth)}` : ''}</div>`).join('') : '<div style="color:#9ca3af;">本次没有变化商品</div>'}
    </div>
  `;

  tip.style.display = 'block';
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 12, tooltip.caretX + 18)}px`;
  tip.style.top = `${Math.max(12, tooltip.caretY - 24)}px`;
}

function renderStoreChart() {
  if (typeof Chart === 'undefined') {
    const container = document.querySelector('#subtab-store-stats .chart-container');
    if (container) container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:40px;">图表库未加载，无法显示图表</p>';
    return;
  }

  const chartType = document.getElementById('storeChartType').value;

  // 自定义时间增长图表单独处理
  if (chartType === 'customSince') {
    renderCustomSinceChart();
    return;
  }

  const data = _storeGrowthData;
  if (!data || !data.sessions || data.sessions.length === 0) {
    const container = document.querySelector('#subtab-store-stats .chart-container');
    container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:40px;">暂无数据，至少需要1条记录</p>';
    document.getElementById('storeGrowthSummary').innerHTML = '';
    if (storeChartInstance) { storeChartInstance.destroy(); storeChartInstance = null; }
    return;
  }

  const container = document.querySelector('#subtab-store-stats .chart-container');
  if (!container.querySelector('canvas')) {
    container.innerHTML = '<canvas id="storeChart"></canvas>';
  }

  const ctx = document.getElementById('storeChart').getContext('2d');

  if (storeChartInstance) storeChartInstance.destroy();

  const accentColor = 'rgba(224, 32, 32, 1)';
  const accentBg = 'rgba(224, 32, 32, 0.15)';
  const greenColor = 'rgba(34, 197, 94, 1)';
  const greenBg = 'rgba(34, 197, 94, 0.15)';
  const warnColor = 'rgba(245, 158, 11, 1)';
  const warnBg = 'rgba(245, 158, 11, 0.15)';

  if (chartType === 'sessionGrowth') {
    const labels = data.sessions.map((s, i) => `第${i + 1}次记录`);
    const salesValues = data.sessions.map(s => s.totalSalesGrowth);
    const reviewsValues = data.sessions.map(s => s.totalReviewsGrowth);

    storeChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '销量增长总和',
            data: salesValues,
            backgroundColor: salesValues.map(v => v >= 0 ? greenBg : 'rgba(239, 68, 68, 0.15)'),
            borderColor: salesValues.map(v => v >= 0 ? greenColor : 'rgba(239, 68, 68, 1)'),
            borderWidth: 2,
            borderRadius: 6,
          },
          {
            label: '评价增长总和',
            data: reviewsValues,
            backgroundColor: warnBg,
            borderColor: warnColor,
            borderWidth: 2,
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: '整店每次记录销量增长总和', color: '#e4e7ed', font: { size: 16 } },
          legend: { labels: { color: '#9ca3af' } },
          tooltip: {
            enabled: false,
            external: (context) => renderStoreSessionTooltip(context, data.sessions),
          }
        },
        scales: {
          x: { ticks: { color: '#9ca3af', maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { title: { display: true, text: '增长数量', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });

  } else if (chartType === 'avgDaily') {
    hideStoreTooltip();
    const labels = data.dailyGrowth.map(d => formatTime(d.time));
    const avgSales = data.dailyGrowth.map(d => d.avgDailySalesGrowth);
    const avgReviews = data.dailyGrowth.map(d => d.avgDailyReviewsGrowth);
    const cumulativeSales = data.dailyGrowth.map(d => d.cumulativeSalesGrowth);

    storeChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '平均每日销量增长',
            data: avgSales,
            borderColor: accentColor,
            backgroundColor: accentBg,
            tension: 0.3,
            fill: true,
            pointRadius: 5,
            pointBackgroundColor: accentColor,
            yAxisID: 'y',
          },
          {
            label: '平均每日评价增长',
            data: avgReviews,
            borderColor: warnColor,
            backgroundColor: warnBg,
            tension: 0.3,
            fill: false,
            pointRadius: 4,
            pointBackgroundColor: warnColor,
            yAxisID: 'y',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: '距首次记录平均每日增长趋势', color: '#e4e7ed', font: { size: 16 } },
          legend: { labels: { color: '#9ca3af' } },
          tooltip: {
            callbacks: {
              afterLabel: (c) => {
                const d = data.dailyGrowth[c.dataIndex];
                return [
                  `距首次记录: ${d.days} 天`,
                  `累计销量增长: ${formatNumber(d.cumulativeSalesGrowth)}`,
                  `累计评价增长: ${formatNumber(d.cumulativeReviewsGrowth)}`,
                ];
              }
            }
          }
        },
        scales: {
          x: { ticks: { color: '#9ca3af', maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { title: { display: true, text: '平均每日增长量', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        }
      }
    });
  }

  renderStoreGrowthSummary(data.summary);
}

function renderCustomSinceChart() {
  const data = _storeGrowthSinceData;
  const container = document.querySelector('#subtab-store-stats .chart-container');
  const summaryEl = document.getElementById('storeGrowthSummary');

  if (!data || !data.products || data.products.length === 0) {
    if (container) container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:40px;">请选择时间并点击"查询"按钮，查看距该时间的销量增长</p>';
    if (summaryEl) summaryEl.innerHTML = '';
    if (storeChartInstance) { storeChartInstance.destroy(); storeChartInstance = null; }
    return;
  }

  if (!container.querySelector('canvas')) {
    container.innerHTML = '<canvas id="storeChart"></canvas>';
  }
  if (storeChartInstance) storeChartInstance.destroy();

  const ctx = document.getElementById('storeChart').getContext('2d');
  const products = data.products;
  const displayProducts = products
    .filter(p => Number(p.salesGrowth) > 0);

  if (!displayProducts.length) {
    if (container) container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:40px;">当前时间范围内暂无正向销量增长，无法生成占比图</p>';
    if (summaryEl) summaryEl.innerHTML = '';
    if (storeChartInstance) { storeChartInstance.destroy(); storeChartInstance = null; }
    return;
  }

  const labels = displayProducts.map(p => `¥${p.productPrice || '—'} ${p.productName.length > 12 ? p.productName.slice(0, 12) + '…' : p.productName}`);
  const salesValues = displayProducts.map(p => Number(p.salesGrowth || 0));
  const totalSales = salesValues.reduce((sum, value) => sum + value, 0);
  const palette = ['#22c55e','#3b82f6','#f59e0b','#ef4444','#a855f7','#14b8a6','#f97316','#eab308','#ec4899','#6366f1','#84cc16','#06b6d4','#fb7185','#8b5cf6','#10b981','#f43f5e','#0ea5e9','#d946ef','#65a30d','#facc15'];

  hideStoreTooltip();

  storeChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          label: '销量增长占比',
          data: salesValues,
          backgroundColor: salesValues.map((_, index) => palette[index % palette.length]),
          borderColor: '#1f2937',
          borderWidth: 2,
          hoverOffset: 10,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: `距 ${data.summary.sinceTime ? data.summary.sinceTime.slice(0, 16) : '自定义时间'} 销量增长占比（全部增长商品）`,
          color: '#e4e7ed',
          font: { size: 16 },
        },
        legend: { labels: { color: '#9ca3af', boxWidth: 12 }, position: 'right' },
        tooltip: {
          callbacks: {
            label: (c) => {
              const p = displayProducts[c.dataIndex];
              const share = totalSales > 0 ? ((Number(p.salesGrowth || 0) / totalSales) * 100).toFixed(1) : '0.0';
              return [
                `${p.productName}`,
                `占比: ${share}%`,
                `基线销量: ${formatNumber(p.baselineSales)}`,
                `当前销量: ${formatNumber(p.currentSales)}`,
                `销量增长: +${formatNumber(p.salesGrowth)}`,
              ];
            }
          }
        },
      }
    }
  });

  // 渲染汇总卡片
  const sg = data.summary.totalSalesGrowth > 0 ? 'positive' : data.summary.totalSalesGrowth < 0 ? 'negative' : '';
  const topProduct = displayProducts[0];
  const topShare = totalSales > 0 ? ((Number(topProduct.salesGrowth || 0) / totalSales) * 100).toFixed(1) : '0.0';

  summaryEl.innerHTML = `
    <div class="growth-summary-card"><span class="label">统计起始时间</span><span class="value" style="font-size:13px;">${data.summary.sinceTime ? data.summary.sinceTime.slice(0, 16) : '-'}</span></div>
    <div class="growth-summary-card"><span class="label">涉及商品</span><span class="value">${data.summary.productCount}</span></div>
    <div class="growth-summary-card"><span class="label">销量增长总和</span><span class="value ${sg}">${data.summary.totalSalesGrowth >= 0 ? '+' : ''}${formatNumber(data.summary.totalSalesGrowth)}</span></div>
    <div class="growth-summary-card"><span class="label">头部商品占比</span><span class="value">${topShare}%</span></div>
  `;
}

function renderStoreGrowthSummary(summary) {
  if (!summary) { document.getElementById('storeGrowthSummary').innerHTML = ''; return; }

  const sg = summary.totalSalesGrowth > 0 ? 'positive' : summary.totalSalesGrowth < 0 ? 'negative' : '';
  const rg = summary.totalReviewsGrowth > 0 ? 'positive' : summary.totalReviewsGrowth < 0 ? 'negative' : '';

  document.getElementById('storeGrowthSummary').innerHTML = `
    <div class="growth-summary-card"><span class="label">商品数</span><span class="value">${summary.totalProducts}</span></div>
    <div class="growth-summary-card"><span class="label">记录批次</span><span class="value">${summary.totalSessions}</span></div>
    <div class="growth-summary-card"><span class="label">记录天数</span><span class="value">${summary.totalDays} 天</span></div>
    <div class="growth-summary-card"><span class="label">销量总增长</span><span class="value ${sg}">${summary.totalSalesGrowth >= 0 ? '+' : ''}${formatNumber(summary.totalSalesGrowth)}</span></div>
    <div class="growth-summary-card"><span class="label">评价总增长</span><span class="value ${rg}">${summary.totalReviewsGrowth >= 0 ? '+' : ''}${formatNumber(summary.totalReviewsGrowth)}</span></div>
    <div class="growth-summary-card"><span class="label">日均销量增长</span><span class="value ${sg}">+${formatNumber(Math.round(summary.avgDailySalesGrowth))}</span></div>
    <div class="growth-summary-card"><span class="label">日均评价增长</span><span class="value ${rg}">+${formatNumber(Math.round(summary.avgDailyReviewsGrowth))}</span></div>
  `;
}

// ==================== 工具函数 ====================

// 自定义确认弹窗（替代 confirm()，在移动端更可靠）
function showConfirm(message, title) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    if (!modal) {
      resolve(false);
      return;
    }

    const titleEl = document.getElementById('confirmTitle');
    const msgEl = document.getElementById('confirmMessage');
    const okBtn = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');

    if (!titleEl || !msgEl || !okBtn || !cancelBtn) {
      resolve(false);
      return;
    }

    titleEl.textContent = title || '确认操作';
    msgEl.textContent = message;
    modal.style.display = 'flex';

    const onOk = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      resolve(true);
    };
    const onCancel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      resolve(false);
    };
    const onBackdrop = (e) => {
      if (e.target === modal) {
        cleanup();
        resolve(false);
      }
    };

    const cleanup = () => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
  });
}

// 切换底部面板
function switchPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`panel-${name}`).classList.add('active');
  document.querySelectorAll('.tab-bar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.panel === name);
  });

  if (name === 'detail' && currentProductId) {
    const chartsTab = document.getElementById('tab-charts');
    if (chartsTab.classList.contains('active')) {
      loadGrowthChart(currentProductId);
    }
  }
}

function showModal(id) { document.getElementById(id).style.display = 'flex'; }
function hideModal(id) { document.getElementById(id).style.display = 'none'; }

function showLoading(text) {
  document.getElementById('loadingText').textContent = text || '加载中...';
  document.getElementById('loadingOverlay').style.display = 'flex';
}
function hideLoading() { document.getElementById('loadingOverlay').style.display = 'none'; }

function formatTime(timeStr) {
  if (!timeStr) return '-';
  const d = new Date(timeStr.replace(' ', 'T'));
  if (isNaN(d)) return timeStr;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatNumber(n) {
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return n.toString();
}

function viewImage(src) {
  document.getElementById('modalImage').src = src;
  showModal('imageModal');
}

function showToast(msg, type) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    padding: 12px 24px; border-radius: 8px; font-size: 14px; z-index: 10000;
    transition: opacity 0.3s;
    background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : '#3b82f6'};
    color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

