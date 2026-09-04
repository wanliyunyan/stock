# 东方财富条件选股结果

这是一个部署在 GitHub Pages 上的单页股票筛选页面。前端通过 Cloudflare Worker
读取东方财富数据，并按表格方式做分组和汇总展示。

## 功能

- 通过 Cloudflare Worker 读取东方财富数据
- 展示最新价、市盈率、市净率、总市值等基础指标
- 展示净资产收益率、毛利率、净利率等财务指标
- 展示合同负债及其同比、环比增长数据
- 表头按时间和指标分层显示，便于横向对比
- 页面可直接部署到 GitHub Pages

## 直接使用

打开 <https://wanliyunyan.github.io/stock/> 即可。未进行任何配置时，页面默认使用：

```text
https://stock.88527712pan.workers.dev
```

## 配置自己的 Worker

用户可以通过 `api` 查询参数切换到自己的 Worker。例如：

```text
https://wanliyunyan.github.io/stock/?api=https://your-worker.workers.dev
```

访问一次后，Worker 地址会保存到当前浏览器。以后直接打开页面时，仍会使用该地址。

Worker 地址按以下优先级选择：

1. 当前 URL 中的 `api` 参数
2. 当前浏览器已经保存的 Worker 地址
3. 项目内置的默认 Worker 地址

更换 Worker 时，使用新的 `api` 参数重新访问一次即可。要清除自定义配置并恢复默认值，
先访问 `https://wanliyunyan.github.io/stock/?api=`，再重新打开首页。

## 部署到 GitHub Pages

前端不需要构建，可以直接发布为静态站点：

1. 把 `index.html` 推到 GitHub 仓库根目录
2. 在 GitHub 仓库设置里打开 Pages
3. 选择 `main` 分支和根目录作为发布源
4. 保存后等待 GitHub Pages 生成链接

## 部署自己的 Cloudflare Worker

仓库根目录的 `worker.js` 是 Cloudflare Worker 模块代码：

1. 在 Cloudflare Workers 中创建一个 Worker
2. 使用 `worker.js` 的内容替换默认代码
3. 部署并取得形如 `https://your-worker.workers.dev` 的访问地址
4. 直接打开该地址，确认返回内容中的 `ok` 为 `true`
5. 按“配置自己的 Worker”一节将地址写入页面

Worker URL 是公开的接口地址，不是密钥。不要把 Cloudflare API Token、账户凭证或其他密钥
写入 `index.html`、`worker.js` 或提交到 Git 仓库。

## 说明

- 当前版本默认通过 Cloudflare Worker 访问东方财富数据
- Worker 提供 `/api/stocks` 和 `/api/quotes` 两个接口
- 没有本地快照兜底逻辑
- 适合做公开演示、个人看盘页、静态部署
