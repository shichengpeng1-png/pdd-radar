# 拼多多销量追踪中心

已包含销量追踪、批量记录、截图保存、OCR 识别、店铺/单品增长分析、TOP 20 排行与移动端界面。

## 服务器更新

在 Ubuntu 服务器上以 `root` 身份执行：

```bash
apt-get update && apt-get install -y git curl build-essential
curl -fsSL https://raw.githubusercontent.com/shichengpeng1-png/pdd-radar/main/deploy-server.sh -o /tmp/pdd-deploy.sh
bash /tmp/pdd-deploy.sh
```

项目会部署在 `/opt/pdd-radar-v2-full`，数据库、截图和 `.env` 均会备份并恢复，不会提交到 GitHub。

访问地址：`http://服务器公网IP:8080/`。

## OCR 配置

服务器的 `/opt/pdd-radar-v2-full/.env` 需要保留：

```env
OCR_ACCESS_KEY_ID=你的阿里云AccessKeyId
OCR_ACCESS_KEY_SECRET=你的阿里云AccessKeySecret
```

