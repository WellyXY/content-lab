# Content Lab v2：投放數據與註冊導向評估 — 設計 Spec

狀態：已確認，可以開始實作（2026-10-10，負責人要求「撰寫詳細 Spec 然後開始實作」）。
依據：運營提供的 `docs/kb/v0_1/`（Content Lab Agent Knowledge Base V0.1），本 Spec 以下簡稱「知識庫」。

## 0. 已確定的決定

| 項目 | 決定 |
|---|---|
| 主要目標 | 獨立註冊數；輔助指標有註冊成本、每週註冊量、投放壽命、CTR 和自然播放（知識庫 GP 主要 KPI） |
| 投放數據來源 | TikTok for Business 連接器（claude.ai，負責人已授權，可讀 8 個 PopUp 廣告帳號） |
| 分析模型 | Claude（負責人的訂閱，本機執行），不改用本地模型 |
| 審核流程 | 不做；分析結果照舊自動發布 |
| 市場 | 新增 IQ（伊拉克）；保留 ID、VN、TR、GCC、TH |
| 品牌 | 不對創作者帖子新增任何 PopUp 植入（沿用 2026-10-09 的決定） |
| 寫入權限 | 只讀；任何程式和 Agent 都不能修改廣告、預算或投放設定 |

## 1. 目標與範圍

**A. 投放數據（先做）**：網站上的每條帖子，只要被拿去投放過 Spark Ads，就自動顯示花費、註冊、註冊成本、CPI、CPM 等數據。內容動能總覽也按市場顯示這些數據。

**B. 照知識庫改版（接著做）**：
- 評估從「會不會高播放」改成兩個獨立分數：創意分、註冊潛力分。分析過程不讓模型看到任何成效數據（盲測）。
- 爆款文檔以註冊和註冊成本為準。
- 修改建議附上依據的參考案例。
- 新增 IQ 市場。

**不做**：修改任何廣告；Meta 廣告（Spark Ads 只在 TikTok）；人工審核流程；用播放量推斷註冊潛力。

---

## Part A：投放數據

### A1. 實測過的能力（2026-10-10）
- `auth_advertiser_get` 列出 8 個帳號。`report_integrated_get` 在 `AUCTION_AD` 層級能取得 `spend, impressions, clicks, app_install, registration, cost_per_registration, video_play_actions, ad_name, campaign_name`。
- 透過 `tool_execute(ad_get)` 取得的每條廣告都帶 `tiktok_item_id`，也就是原帖子的影片 ID，可以精準對應到 Content Lab 的 `posts.video_id`。越南 iOS 帳號有 662 條廣告，全部都帶。
- 本機在背景執行的 `claude -p` 能看到 `claude.ai TikTok for Business` 連接器，也能成功呼叫（測試回傳 8 個帳號）。

### A2. 抓數據的 Agent：程式規劃、Agent 代為呼叫
連接器的授權只存在使用者的 Claude 帳號裡，所以呼叫一定要經過 Claude。但**要呼叫什麼、參數是什麼、回傳的數字是多少，都不讓模型決定**：

1. 程式先規劃好每一次 API 呼叫：工具名稱加上完整參數。
2. 每次呼叫開一個短的 Agent 會話（Claude Haiku，`claude-haiku-5-5`）。Prompt 只說「用這組參數呼叫這個工具一次，然後結束」。
3. `canUseTool` 強制檢查：
   - 工具名稱必須是本次規劃的那一個，參數必須和規劃的**完全相同**（深度比對），否則拒絕。
   - `tool_execute` 只允許 `tool_name = "ad_get"`。
   - 其他任何工具一律拒絕（包括 Gmail、Drive、Meta 等其他連接器）。
4. 程式從訊息流裡的 `tool_result` 擷取 TikTok **原始 JSON**，自己解析數字。模型最後回覆的文字一律不採用。
5. 如果回傳 `code != 0`、結果不是 JSON，或模型沒有呼叫工具，這次呼叫就算失敗，最多重試 1 次。

這樣做的好處：
- 不可能誤改廣告：寫入類工具在程式層面就被擋掉。
- 數字不會被模型抄錯或編造：專案規則就是「數字由程式填入」。
- 每次會話的內容很小：只有一次回傳，不會因為上萬條廣告塞爆上下文。

### A3. 同步流程（`npm run ads` / 每天自動 / Agent 工具 `refresh_ads`）

```text
1. 帳號：auth_advertiser_get → ad_accounts（advertiser_id、名稱、最後掃描時間）
2. 廣告對應：每個帳號呼叫 ad_get，fields=[ad_id, ad_name, tiktok_item_id, campaign_id, campaign_name, adgroup_id, create_time, modify_time]，
   page_size=1000，exclude NULL_FIELD
   - 第一次全量掃描（含已刪除的廣告：primary_status=STATUS_ALL）
   - 之後只掃描 modified_after = 上次掃描時間 − 1 天
   → ad_links（ad_id → tiktok_item_id）
3. 篩選：只保留 tiktok_item_id 對得上 posts.video_id 的廣告
4. 累計數據：report_integrated_get，BASIC、AUCTION_AD、dimensions=[ad_id]、query_lifetime=true、ad_ids 每批最多 100、ad_status=STATUS_ALL
   → ad_lifetime
5. 每日數據：同上，但 dimensions=[ad_id, stat_time_day]，最近 14 天 → ad_daily（以 ad_id + 日期為鍵，重跑會覆蓋）
6. 按帖子加總 → posts.ads_json → 透過帖子讀取模型同步到網站
```

- **排程**：每天 1 次，台北時間 10:30。新綁定的帖子在下一輪就會被比對到。負責人也可以在飛書叫 Agent 立即刷新，或在本機執行 `npm run ads`。
- **上限**：每輪最多 60 次 API 呼叫，超過就停下，下一輪繼續（全量掃描會分幾輪做完）。

### A4. 資料表（service migration 7）

```sql
ad_accounts(advertiser_id PK, name, currency, timezone, last_link_scan_at, updated_at)
ad_links(ad_id PK, advertiser_id, tiktok_item_id, ad_name, campaign_id, campaign_name, adgroup_id,
         create_time, modify_time, updated_at)                     -- index on tiktok_item_id
ad_lifetime(ad_id PK, spend, impressions, clicks, installs, registrations, video_plays, currency, refreshed_at)
ad_daily(ad_id, stat_date, spend, impressions, clicks, installs, registrations, currency, timezone,
         refreshed_at, PRIMARY KEY(ad_id, stat_date))
ad_sync_runs(id PK, started_at, finished_at, calls, status, error)
```

### A5. 指標定義
- 加總順序：同一條帖子的所有廣告先加總，再計算比率；**不平均各列的比率**（知識庫校準流程第 3 點）。
- `花費` = Σspend；`註冊` = Σregistration；`安裝` = Σapp_install；`曝光` = Σimpressions；`點擊` = Σclicks。
- `註冊成本` = 花費 ÷ 註冊；`CPI` = 花費 ÷ 安裝；`CPM` = 花費 ÷ 曝光 × 1000；`CTR` = 點擊 ÷ 曝光。分母為 0 時顯示「—」，不顯示 0。
- 註冊成本和 CPI 是兩個不同的指標，介面上分開標示（沿用 popup-harness 的規則：註冊成本不等於安裝 CPI）。
- 沒有對到任何廣告的帖子：狀態是「未投放」，數值為 null，不是 0。缺少的花費是「沒有數據」，不是 0。
- 幣別：只加總 USD；其他幣別的廣告標示 `currency_excluded`，並在介面上提示。
- 時區：每日數據使用各廣告帳號自己的時區（API 本來就是這樣），頁面上註明。
- 7 天比較：`last7d` 是最近 7 個完整日，`prev7d` 是再往前 7 天。
- 金額顯示：前面加 $，小數截斷到兩位；變化只顯示百分比。其他數字顯示目前值、上期值、變化量和百分比。百分比用完整精度的數字計算。

### A6. 帖子讀取模型的 `ads` 欄位（同步到網站的 `posts.ads_json`）

```ts
ads: null | {
  status: "active" | "inactive";            // 最近 3 天有花費 = active（投放中）
  adCount: number; accounts: number;
  lifetime: Totals; last7d: Totals; prev7d: Totals;
  daily: Array<{ date: string; spend: number; registrations: number; installs: number }>; // 14 天
  topAds: Array<{ adId: string; adName: string; campaignName: string; advertiserName: string } & Totals>; // 依花費排序，最多 10 條
  refreshedAt: string; currencyExcluded: number;
}
Totals = { spend, impressions, clicks, installs, registrations, cpr, cpi, cpm, ctr }   // 比率可為 null
```

### A7. 網站
- **D1 migration 0007**：`posts.ads_json TEXT`。
- **帖子列表**：
  - 新增欄位：花費（累計）、註冊、註冊成本、CPI、CPM，以及「投放中」標籤。
  - 可以按花費、註冊、註冊成本排序；也可以篩選「已投放 / 未投放」。
  - 未投放的帖子顯示「未投放」。
- **帖子詳情**：新增「投放成效」卡片：
  - 累計數字，以及近 7 天對比前 7 天
  - 14 天的花費和註冊趨勢
  - 對應的廣告列表（廣告名、帳號、花費、註冊、註冊成本）
  - 最後更新時間
- **內容動能總覽**：新增「投放成效」區塊，按市場顯示：
  - 近 7 天和前 7 天的花費、註冊、註冊成本、CPI、CPM
  - 投放中的帖子數
  - 註冊最多的 5 條帖子

  這些全部由 D1 對 `ads_json` 加總（比率在伺服器端用加總後的數字重算）。

### A8. 飛書 Agent
- 讀取工具會帶上投放數據：`get_post`、`list_posts`（支援依花費、註冊、註冊成本排序）、`overview`。
- 新增只限負責人使用的 `refresh_ads`：排一次同步任務，每天最多 3 次。

### A9. 失敗處理
- 連接器授權失效或連不上時：本輪同步標為失敗，飛書私訊負責人「TikTok 連接器需要重新授權」。網站保留舊數據，並顯示最後更新時間。
- 單次呼叫失敗：重試 1 次，仍然失敗就跳過，下一輪補上。部分失敗不影響已經成功的數據。
- 額度錯誤：沿用分析流程的 30 分鐘暫停。

### A10. 測試與驗收
- **單元測試**：
  - 呼叫規劃（分頁、每批 100、增量掃描時間）。
  - `canUseTool` 守門：工具不符、參數不符、`tool_execute` 指向非 `ad_get`、其他連接器，一律拒絕。
  - 從訊息流擷取原始結果（包括模型改寫文字時，仍只採用原始結果）。
  - 解析和加總（總數相除、分母為 0、未投放、非 USD、7 天窗口）。
  - 讀取模型、網站加總 SQL、格式化規則。
- **實機驗收**：對 VN 帳號跑一次同步，抽查 3 條帖子的花費和註冊，和 TikTok 廣告後台的數字一致（允許同步報表和後台下載之間的正常誤差）。

---

## Part B：照知識庫改版

### B1. 新增 IQ 市場
- 市場代碼 `IQ`（伊拉克），時區 UTC+3，語言 `ar`（Whisper 的語言檢查允許 `ar`、`en`）。
- 涵蓋範圍：網站的市場清單、綁定表單、Agent 工具、日報和爆款文檔的排程。

### B2. 盲測分析 v2（取代 v1 的「評估」）
依照知識庫 `03_agent_instructions.md` 的輸出結構，輸出 JSON（中英雙語，和現在一樣）：

1. `source_status`（complete / partial / unavailable）、市場、時長和形式，以及缺少哪些素材（例如沒有音軌、沒有轉錄）。
2. `observed_content`：按時間排列的段落，附上原文、謹慎的翻譯，以及時間戳或圖片編號。
3. `mechanisms`：
   - 鉤子：觸發點和表現形式分開記錄，都可以多選。
   - 反轉：鋪墊的期待、揭曉內容、揭曉位置、情緒回報、是否連到動機；沒有反轉時記為 N/A，不扣分。
   - 趨勢與在地化。
   - 產品植入：可見度、敘事功能、和動機的關係。
4. `motivation`：
   - 觀眾想要什麼 → 為什麼是 PopUp → 我自己能不能有這種體驗。
   - 用戶可能的第一人稱想法。
   - 體驗的可信度。
   - 動機出現的時間點，以及後面是加強還是削弱。
   - 「好看」和「想下載」之間的落差。
5. `creative_score`：0–10 或 null，附信心程度、證據引用和保留意見。
6. `registration_potential`：0–10 或 null，和創意分各自獨立判斷。
7. `diagnosis`：優勢、阻礙、例外。不能宣稱因果已被證明。
8. `recommendations`：最多 3 條具體的腳本修改，每條附上預期作用的機制和要驗證的假設。
9. 每個論點標明證據類型：`OBSERVED_MEDIA`、`ADS_DATA`、`HUMAN_INSIGHT`、`AGENT_HYPOTHESIS`、`MISSING`。

**盲測規則**（由程式強制）：
- 分析的 Prompt 裡不能出現播放、讚、註冊、花費、成效分組、「爆款或失敗」之類的標籤。
- 爆款文檔進 Prompt 之前要先去掉所有統計數字，只保留機制描述。
- 有測試檢查 Prompt 裡沒有這些欄位。

**其他**：
- 知識庫 01–04 號檔案（原則、機制、Agent 指令、評分錨點）固定放進 Prompt，記錄版本和雜湊值。
- 評分錨點照 `04_scoring_rubric.json`。沒有固定權重，反轉不會自動加分。

### B3. 參考案例
- 載入 `05_case_library.json` 作為只讀的參考資料。能用廣告名稱或 `tiktok_item_id` 對到帖子的案例，就連結過去。
- 修改建議最多引用 2 個同市場的參考案例，並說明哪個機制可以借鏡、哪些是只適用當地的細節（GP-005、GP-007）。
- 參考案例必須是**有投放數據、而且證據足夠**的帖子；不再用播放量挑選。

### B4. 爆款文檔 v2
- 分組依據改成同市場、同形式（影片或圖文）下的註冊和註冊成本，不再用播放量。
- 證據不足的門檻：花費低於 $50 或註冊少於 30，標為「證據不足」，不算失敗。這是預設值，可以設定，正式值要和投手確認（知識庫校準流程第 3、4 點）。
- 新增兩節：「和規律不符的例外」，以及反例（高播放低註冊、低播放但註冊好、複製失敗）。
- 統計數字照舊由程式產生，模型不能寫數字。

### B5. 校準
- 分數一旦寫入就不再改動，並記錄模型版本、Prompt 版本和時間。
- 投放數據到了之後，在同市場、同形式、證據足夠的帖子之間比較排名，記錄預測誤差；和預測不符的標為「意外結果」。
- 這是後台紀錄；網站另外有一頁「校準」顯示準確度，不影響個別帖子的分數。

### B6. 相容與上線
- v1 的評估保留不刪。v2 分析上線後，網站同時顯示兩個新分數，v1 的爆款潛力標為「舊版」。
- 已分析的帖子分批重跑 v2，每天最多 30 條，沿用現有的額度控管。
- Agent 重制的任務說明改用 v2 的動機分析和修改建議，其他規則不變。

---

## 實作順序

| 階段 | 內容 | 上線條件 |
|---|---|---|
| A1 | service：同步 Agent、資料表、加總、讀取模型、飛書 Agent 工具 | 測試通過，實機同步一次成功 |
| A2 | 網站：`ads_json`、帖子列表欄位、詳情卡片、總覽區塊 | 負責人讓 Codex 發布 |
| B1 | IQ 市場 | 和 A2 一起發布 |
| B2–B3 | 盲測分析 v2 和參考案例 | 用 3 條已知案例試跑，負責人看過結果 |
| B4–B5 | 爆款文檔 v2 和校準 | 投放數據累積至少 2 週 |

部署順序照舊：先 worker，後網站。新網站之前，worker 不會送出新欄位以外的新事件類型；`ads_json` 是帖子讀取模型裡的新欄位，舊網站會忽略。

## 待運營確認（不阻塞實作）
1. 證據不足的門檻（預設：花費 $50 或註冊 30）。
2. IQ 投放用的是哪個廣告帳號（8 個帳號裡「中東」那個是 GCC 還是 IQ）。
3. 知識庫案例裡有 2 條廣告名稱還沒對上（知識庫的 `known_gaps`）。
