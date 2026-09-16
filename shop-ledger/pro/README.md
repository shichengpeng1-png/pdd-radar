# 店账 Pro

电脑与手机浏览器使用的单用户网店收支账本。后端 SQLite 保存数据，带密码登录，前端原生 JavaScript。Ubuntu 24.04 + Python 3.12 + nginx。

## 功能

- 多账本、收支、转账、退款、报销；两级分类、标签、渠道、数量、单价、备注、凭证。
- 多账户、余额、信用账户、组合付款，多币种和手动汇率。
- 明细搜索筛选、批量修改、CSV 导出、CSV/XLS/XLSX 列映射导入。
- 截图上传/粘贴/拖入，浏览器本地中文 OCR，识别结果逐条核对、选择分类和付款账户，再入账。
- 日历、趋势、分类统计、周/月/年预算、周期账单、分期、模板和存钱目标。
- 浅色/深色、JSON 全量备份恢复、每日数据库备份、登录保护与修改冲突检测。

这是独立开发的网页账本，不是 iCost 官方产品。未实现 iCloud、手机小组件、Face ID、系统快捷指令、语音记账或全部第三方账单专用适配器。OCR 可能识别错误，必须核对再导入；汇率需手动维护。账户余额汇总全部账本，复制账本中的交易会同时影响账户余额。

## 本地启动

Python 3.12 或以上运行 `python vendor.py` 下载固定版本 OCR / Excel 组件，再运行 `python server.py --set-password`，然后 `python server.py`。打开 http://127.0.0.1:18761 。生产环境不要使用开发服务器。

## 部署到已有 nginx 的服务器

先运行 `python vendor.py`，将本目录上传服务器；不要上传本地 `data` 目录。以 root 依次运行：

```sh
bash deploy.sh prepare
bash deploy.sh password
bash deploy.sh activate
```

脚本专用于此项目已有 `/etc/nginx/conf.d/shop-ledger-8081.conf` 的升级。只代理 8081 到本机 18761，保留其他端口服务。nginx 旧配置备份在 `/opt/shop-ledger-pro/backups`，旧网站 `/var/www/shop-ledger` 保留。云防火墙须在实际服务器实例允许 TCP 8081，创建模板本身不会生效。网站使用正式账单前应配置域名和 HTTPS；单纯 HTTP IP 地址不提供传输加密。

服务为 `shop-ledger-pro`，定时器 `shop-ledger-pro-tick.timer`。数据位于 `/var/lib/shop-ledger-pro`，每日数据库备份位于该目录 `backups`，图片位于 `receipts`。备份整目录时使用 SQLite 在线备份或停止服务；仅复制数据库不包含图片。网页“完整备份”包含凭证。旧浏览器版数据需从旧页面导出 JSON，再用新版设置中的旧版导入核对。

## 验证

```sh
python -m unittest discover -s tests -v
node tests/test_core.cjs
```

OCR 第三方包版本：tesseract.js/core 5.1.1、chi_sim/eng 数据 1.0.0、xlsx 0.18.5。组件本地托管，不把账单截图发送到外部 OCR 平台。
