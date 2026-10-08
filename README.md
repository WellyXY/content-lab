# Content Lab

TikTok 素材監控、爆量報警、Agent 打標與相對排名。公開前端由 GPT Site 承載；TikTok 採集、SQLite、ffmpeg 與 Codex 分析只在這台 Mac 上執行。

公開頁面：<https://content-lab-welly.biii38839.chatgpt.site>

正式頁面僅顯示真實資料：空資料與讀取失敗不會替換成示範內容，原有 demo 路由與 synthetic seed 已移除。2026-10-08 首次匯入規格引用的 13 條 FrameLab VN 真實連結；來源及逐條 Git 行號見 [`docs/source-imports/`](docs/source-imports/)。只匯入網址，播放數與媒體由 TikWM 重新取得，沒有匯入舊分析或補造歷史。

Excel/CSV 入口在 `/bind`：XLSX 讀取全部工作表、提取並去重 TikTok 網址，再以頁面選定的市場／項目送出。單次超過 50 條會要求分批，不會默默截斷。Git 未包含原始 Excel 工作簿，已保留可重用的來源 CSV；本機 CLI 另支援逐列市場與來源欄位。

## 架構

```text
外部瀏覽器
  ↕ HTTPS
GPT Site（Dashboard + D1 讀模型 + 綁定工作佇列）
  ↕ 本機 worker 主動發起的出站 HTTPS
Mac（TikWM / oEmbed → SQLite → ffmpeg → Codex → 飛書）
```

GPT Site 永遠可開；Mac 睡眠時只會暫停新採集與分析，工作保留在佇列，醒來後續跑。公開站點無法連入 localhost，也碰不到 Codex、SQLite 或本機網路。專案完全不需要 Cloudflare Tunnel、cloudflared 或入站端口。

## 目錄

- `site/`：GPT Site 前端、D1 schema、公開 API 與本機 worker bridge。
- `service/`：只監聽 `127.0.0.1:4320` 的 Hono API、SQLite durable queue、採集器與 Codex worker。
- `docs/taxonomy/v3.json`：Agent 使用的封閉分類詞表。
- `docs/superpowers/specs/`：原始產品規格；部署架構以本 README 的 GPT Site 版本為準。

## 本機啟動

需要 Node 22.5+、已登入的 Codex CLI 與 ffmpeg。

```bash
cd service
npm ci
npm run build
npm run doctor
npm start
```

另開一個 shell 啟動 worker；`SITE_SYNC_TOKEN` 必須與 GPT Site 的同名 secret 相同：

```bash
cd service
SITE_SYNC_URL=https://content-lab-welly.biii38839.chatgpt.site \
SITE_SYNC_TOKEN='your-pairing-token' \
npm run worker
```

目前這台 Mac 已安裝 `com.welly.content-lab.web` 與 `com.welly.content-lab.worker` 兩個 LaunchAgent，登入時啟動、崩潰時重啟。配對 token 保存在 macOS Keychain，不在 Git 或 plist 裡。Feishu 是選配，設定 `FEISHU_WEBHOOK_URL` 後才會送群通知。

## 主要能力

- 公開 Dashboard：總覽、帖子列表、內容詳情、缺失時段與採集狀態。
- 綁定：貼網址或匯入 CSV/XLSX；TikTok 網域嚴格驗證、去重、每 IP/每日/活躍量限額。
- 採集：TikWM 節流與重試，TikTok oEmbed 只作 metadata-only fallback，不捏造指標。
- 分析：ffmpeg 抽幀，Codex read-only/ephemeral 執行，taxonomy v3 二次驗證。
- 媒體：影片播放器與 TikTok 官方嵌入備援；本機產生的關鍵幀經驗證後上傳 GPT Site 儲存，AI 尚在分析時也可查看圖片。
- 信號：里程碑、加速、採集失敗、Codex 登入失效與可選 Feishu outbox。
- 同步：D1 工作租約、事件去重、hosted/local post ID 關聯，以及本機 exponential-backoff outbox。

更完整的本機 API、環境變數與同步協議見 [`service/README.md`](service/README.md)。
