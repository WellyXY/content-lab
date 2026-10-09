# Agent Recreate：實作說明與移植指南

Content Lab 的「Agent 重制」把一條已分析的 TikTok 帖子交給 Claude Code（Opus 5.5），由它按修改建議重新剪輯、加上動態圖形，輸出一支可以直接發布的 9:16 成片。本文說明整體架構、每個元件的職責、安全邊界、踩過的坑，以及移植到另一個專案時的做法，包括如何用 Fal API 補上「需要重拍」的部分。

- 原始碼：`service/src/recreate/`（本機 worker）、`site/app/api/posts/[id]/recreate`、`site/components/content-lab/recreate-panel.tsx`（網站）
- 設計與計劃：`docs/superpowers/specs/2026-10-09-agent-recreate-design.md`、`docs/superpowers/plans/2026-10-09-agent-recreate.md`

---

## 1. 整體流程

```text
網站（公開，無登入）                     本機 Mac worker（Claude 訂閱、ffmpeg、HyperFrames）
─────────────────────                    ─────────────────────────────────────────────
帖子頁「Agent 重制 n/2」
  POST /api/posts/:id/recreate
  ├ 檢查：影片帖子、分析完成
  ├ 一條 SQL 原子插入 recreations（每帖 ≤2，全站進行中 ≤5）
  └ 同一交易插入 jobs(kind=recreate)
                                   ──租約──▶ pullRemoteJobs：轉成本機 recreate 任務，立即完成網站任務
                                            runRecreation（同時只跑 1 個）
                                            1. prepareRecreateWorkspace：素材包
                                            2. runRecreateAgent：沙盒內的 Claude Code 設計動畫
                                            3. renderRecreation：程式渲染、驗收、封面
                                            4. 上傳 MP4 和封面到網站 R2
  sync 事件 "recreation" ◀────────────────  每個階段都同步狀態（queued → preparing → designing → rendering → complete/failed）
帖子頁每 15 秒刷新：進度、播放器、下載、中英改動說明、「需要重拍、未採用的建議」
                                            飛書私訊通知負責人（完整錯誤只發這裡）
```

**分工原則**：模型只負責「設計」，也就是寫 HyperFrames 的 HTML 動畫。準備素材、渲染、驗收、上傳、狀態同步全部由程式做，模型碰不到。

## 2. 技術選型

| 項目 | 選擇 | 原因 |
|---|---|---|
| Agent | `@anthropic-ai/claude-agent-sdk` 的 `query()`，模型 `claude-opus-5-5` | 本機訂閱登入，不額外計費；可自訂工具和權限回呼 |
| 動畫/渲染 | HyperFrames `hyperframes@0.8.143`（Apache-2.0，HTML + GSAP → MP4） | 適合 Agent 寫；Remotion 對 3 人以上公司要付費授權 |
| 媒體 | ffmpeg / ffprobe | 下載後抽幀、驗收、壓縮、封面 |
| 轉錄 | 本機 Whisper small（沿用分析流程的快取和幻覺過濾） | 字幕要跟台詞時間對齊 |
| 網站 | Cloudflare D1（紀錄）+ R2（成片） | 原本就用 |

HyperFrames 要點：
- 必須在**空資料夾**裡初始化：`hyperframes init . --non-interactive --resolution portrait --skip-transcribe`。沒有 `--yes` 這個參數。
- 版本要釘死，並且用絕對路徑呼叫 `node_modules/.bin/hyperframes`。不要讓 `npx` 去網路抓最新版。
- 環境變數 `HYPERFRAMES_TELEMETRY=0`、`HYPERFRAMES_SKIP_SKILLS=1`、`DO_NOT_TRACK=1`。
- `render --quality delivery --output out.mp4`：10 秒、1080×1920 的影片在 M 系列 Mac 上大約 15–30 秒。

## 3. 元件與介面

### 3.1 任務說明 `brief.ts`
- `buildRecreateBrief(inputs)` 產生 `brief.md`，內容包括：
  - 市場與字幕語言（VN→vi、TR→tr、ID→id、TH→th、GCC→ar）、原片長度上限。
  - 修改建議、缺失的爆款特徵、要避免的反模式。
  - 該市場爆款文檔的摘要，以及負責人的記憶規則。
  - 文案、轉錄（含時間戳）、分時段腳本。
- 帖子文字一律標成不可信的素材。沒有轉錄時明確寫「沒有口播，不要編造台詞」。
- `RECREATE_SYSTEM_PROMPT` 的固定規則：
  - 成片 1080×1920、使用原聲、長度不超過原片。
  - 只做剪輯和動效能做到的事；需要重拍、配音或拉長的建議，寫進 `notes.skipped`。
  - **不新增任何品牌植入**：不加 Logo、結尾品牌卡、水印、下載號召。原片裡已有的 PopUp 元素可以保留或美化。
  - 沒有 shell，用指定的檢查工具驗證，最多修 3 輪；不自己渲染。
  - 最後寫 `notes.json`：`{summary_zh, summary_en, changes[{zh,en,suggestion}], skipped[{zh,en,suggestion}]}`。

### 3.2 素材包 `workspace.ts`
`prepareRecreateWorkspace(db, config, {recreationId, postId}, {refresh, init})` 在 `var/recreate/<id>/` 建立：

```text
index.html, hyperframes.json, package.json   ← hyperframes init 產生（Agent 只能讀這些設定檔）
node_modules → service/node_modules          ← 符號連結，確保用的是釘死的版本
assets/source.mp4, assets/frames/kf-*.jpg
brand/                                       ← 品牌包：配色、字體，只作參考
.claude/skills/hyperframes*/                 ← 複製進來的 HyperFrames 技能（唯讀）
brief.md
```

- `recreationId` 只接受 `^[A-Za-z0-9_-]{1,100}$`，而且解析後必須正好是 recreate 資料夾的直接子目錄，才會執行 `rmSync`（見第 6 節的事故）。
- 原片下載失敗時，先刷新一次 TikTok 中繼資料再重試（簽名網址會過期）。刷新本身失敗（帖子被刪或設為私密）時拋出 `SourceUnavailableError`，這次不算進次數。
- 初始化後刪掉腳手架自帶的 `CLAUDE.md`、`AGENTS.md`：裡面教的 publish、upgrade、render 和我們的規則衝突。
- 子程序只用最小環境變數（`HOME, USER, PATH, SHELL, TMPDIR, LANG, CLAUDE_CONFIG_DIR`）。

### 3.3 Agent 執行 `agent.ts` + `tools.ts` + `permissions.ts`
```ts
query({ prompt, options: {
  model, cwd: dir, systemPrompt: RECREATE_SYSTEM_PROMPT,
  tools: ["Read", "Write", "Edit", "Glob", "Grep", "Skill"],          // 沒有 Bash
  mcpServers: { recreate: checks.server },                            // 固定參數的檢查工具
  allowedTools: checks.toolNames,                                     // 這些工具直接放行
  canUseTool: createRecreateToolGuard(dir, RECREATE_SKILLS),          // 其他工具逐一檢查
  permissionMode: "default", settingSources: ["project"],             // 只讀素材包內的技能
  maxTurns: 120, abortController /* 30 分鐘 */, env: 最小環境,
}})
```
- **檢查工具**（`tools.ts`）都用 `execFile` 加固定參數執行，不經過 shell：
  - `hyperframes_lint()`、`hyperframes_check()`
  - `hyperframes_snapshot(times: number[1..12])`：只接受 0–600 秒的數字。
  - `probe_media(file)`：只接受素材包內真實存在的檔案。
  - 輸出裡的絕對路徑會被替換掉，並截斷到 8 KB。
- **權限守門**（`permissions.ts`）：
  - 讀寫只限素材包內。拒絕 `~`、`file:`、URL、`../` 和指向外面的符號連結。
  - 不能寫的路徑：所有點檔、`.claude/**`、`CLAUDE.md`、`AGENTS.md`、`package.json`、`hyperframes.json`、`meta.json`、`node_modules`。
  - Glob/Grep 的 pattern 不能是絕對路徑或含 `..`。
  - Skill 只允許清單內的技能。
- 結果判斷：
  - 額度錯誤（usage limit、429、529）→ `AnalyzerQuotaError`，worker 暫停 30 分鐘，任務延後、不扣嘗試次數。
  - 沒有合法的 `notes.json` → 失敗。

### 3.4 渲染與驗收 `render.ts`
- 由程式執行 `hyperframes render`，接著用 `verifyRendition` 檢查：
  - 1080×1920
  - 有音軌
  - 長度在 5 秒到原片 +0.5 秒之間
- 超過 50 MB 時用 CRF 26 重新壓縮一次，仍超過就失敗。
- 封面取第 1 秒的畫面。

### 3.5 流程與狀態 `run.ts`
- `runRecreation(db, config, {recreationId, sitePostId, finalAttempt}, deps)` 依序推進狀態：`preparing → designing → rendering → complete`。每次變化都寫進本機 `recreations` 表，並排一個 `recreation` 同步事件。
- 各種失敗的處理：

  | 情況 | 處理 |
  |---|---|
  | 原片不可用 | `failed`、`counts=0`（不算次數），不重試 |
  | 額度暫停 | 保持 `queued`、錯誤 `paused_for_quota`，之後會再跑 |
  | 其他錯誤（非最後一次） | 留在當前階段，等重試（最多 2 次） |
  | 其他錯誤（最後一次） | `failed` |

- 公開頁面只顯示錯誤類別（`agent_failed`、`render_failed`、`verify_failed`、`upload_failed`…）。完整錯誤只透過飛書私訊給負責人，因為裡面可能有本機路徑。
- `failStaleRecreations`：最後一次嘗試在執行中 worker 掛掉時，這個任務永遠不會再被租用。租約（2 小時）過期後，把它標成 `worker_stopped`，免得頁面一直顯示「製作中」。

### 3.6 Worker 接線 `worker.ts`
- 重制有自己的執行槽，同時只跑 1 個，不佔分析的並發名額，租約 2 小時。
- 網站任務 `recreate` 一租到就轉成本機任務，同時告訴網站「已完成」：進度靠 recreation 紀錄同步，不靠網站任務本身。
- 上傳：`PUT /api/local-worker/recreations/:id/{video.mp4|cover.jpg}`，帶 Bearer token。

### 3.7 網站
- D1 表 `recreations(id, post_id, status, notes_json, video_url, cover_url, error, counts, created_at, updated_at)`。
- 建立紀錄是一條原子 SQL，同一個交易裡再插入任務，而且只有紀錄存在時才插入：
```sql
INSERT INTO recreations (id, post_id, status, counts, created_at, updated_at)
SELECT ?, ?, 'queued', 1, ?, ?
WHERE (SELECT COALESCE(SUM(counts),0) FROM recreations WHERE post_id = ?) < 2
  AND (SELECT COUNT(*) FROM recreations WHERE status IN ('queued','preparing','designing','rendering')) < 5
```
  實測同時送出 3 個請求，只有 1 個成功，次數剛好停在 2。
- 拒絕 `Sec-Fetch-Site: cross-site` 的請求。全站最多 5 個進行中，超過回 429，防止腳本掃遍所有帖子、塞滿佇列。
- 媒體路由支援 HTTP Range，影片才能拖動進度條。上傳時檢查檔案標頭（MP4 的 `ftyp`、JPEG 的 SOI），上限 50 MB。
- `post_deleted` 同步事件也會刪掉 recreations。
- 部署順序：**先 worker，後網站**。舊網站不會產生 recreate 任務，新 worker 也只在新網站建立任務之後才送 `recreation` 事件。

## 4. 安全模型（最重要的一節）

Agent 會讀帖子的文案和轉錄，這些都是**不可信輸入**，可能被寫進指令來誘導 Agent。第一版的審查找到 4 條已實際重現的逃逸路線，移植時務必避開：

| 漏洞 | 怎麼發生 | 修法 |
|---|---|---|
| `.npmrc` 執行任意代碼 | Agent 可以寫素材包內任何檔案；`npx` 會讀專案的 `.npmrc`，`node-options=--import=x.mjs` 就能執行任意代碼 | 拿掉 `npx` 和 shell；點檔、設定檔一律唯讀 |
| shell 展開繞過檢查 | 守門檢查的是原始字串，但 zsh 會展開 glob qualifier `*(e:'cmd':)`、`~`；ffprobe 也吃 URL、`file:`、`lavfi` | **不給 Bash**，改成固定參數、`execFile` 的工具 |
| `~` 路徑 | `resolve(ws, "~/.zshrc")` 看起來在素材包內，但 CLI 自己會把 `~` 展開成家目錄 | 拒絕所有 `~` 開頭和帶 scheme 的路徑 |
| 外洩密鑰 | 子程序繼承了 worker 的全部環境變數（同步 token、飛書密鑰） | 用最小環境變數白名單 |

其他原則：
- 會聯網的子指令（例如 `hyperframes catalog`）不要開放。
- 素材包裡由工具讀取的設定檔（`hyperframes.json`、`.claude/`），Agent 不能寫。
- 模型的工作只到「寫好 HTML」。渲染、上傳、刪除這類有副作用的動作全部由程式做。
- 還沒做的第二層防護：HyperFrames 在 snapshot 和 render 時用的 Chrome 仍然可以聯網；也可以考慮開 SDK 的 OS 級沙盒（macOS Seatbelt）。

## 5. 實測結果

越南帖子 @vlamp_05：原片 11.4 秒、單一鏡頭、沒有口播。兩次試跑：
- 時間：Agent 5–5.5 分鐘（44–54 輪），渲染 23–30 秒。
- 成片：10.2–10.4 秒，6–8 個鏡頭，原聲，15 MB。
- 改動內容：
  - 第 1 秒用後段的反應鏡頭閃前，配懸念字幕當鉤子，再「倒帶」回開頭。
  - 加入逐詞跳動的越南語字幕。
  - 原片裡的 PopUp 通知改成只閃過暱稱。
  - 中段情緒加碼，結尾放大字金句和一個可以 @ 朋友的標籤。
- 未採用、列為需要重拍的建議：拉長到 20–30 秒、加口播、加「在 PopUp 配對到隊友」的劇情。

## 6. 踩過的坑

1. **修改建議常常需要重拍**（拉長、加口播、加劇情）。只剪輯做不到，要明確讓 Agent 跳過並列出來；否則它會亂做，或者硬拉長片長。
2. **品牌植入會改變內容性質**。這些是創作者自己的帖子，加結尾品牌卡就變成硬廣。現在規則是不新增任何品牌元素，並用測試鎖住。
3. **在測試裡驗證「刪除路徑」這類 bug 時，舊代碼真的會執行刪除**。我們曾因此誤刪了 macOS 使用者暫存目錄的一部分。教訓：凡是會刪檔或寫檔的代碼，測試裡的根目錄一定要先指向臨時目錄或注入，不能用真實路徑去「證明它會失敗」。
4. **租約時間要涵蓋所有階段最長耗時的總和**。否則清理程式會把還在跑的任務標成失敗。
5. **額度用完不是失敗**。如果最後一次嘗試剛好遇到額度暫停卻標成失敗，按鈕會重新可按，訪客就會用掉第 2 次機會。
6. **公開錯誤訊息會洩露本機路徑**。只同步錯誤類別。
7. **計時型測試在全套測試的負載下會不穩定**。例如 SIGTERM 在子程序裝好 handler 之前就送到；要找根因並修代碼，不要調大 timeout 了事。

---

## 7. 移植到另一個專案：加上 Fal 生成能力

另一個專案有 Fal API，所以「需要重拍」的建議可以改成**生成**：生成新鏡頭、生成配音，片長也可以超過原片。建議做法如下。

### 7.1 架構變化

```text
brief.md ──▶ Agent（設計）──▶ 需要新素材時呼叫 MCP 工具 ──▶ 程式呼叫 Fal（FAL_KEY 只在程式裡）
                                 generate_shot / generate_voiceover / generate_image
                              ◀── 素材寫進 assets/generated/，回傳相對路徑和實際長度
            ──▶ HyperFrames 組合原片＋生成素材 ──▶ 程式渲染、驗收、上傳
```

- **Agent 永遠拿不到 `FAL_KEY`**，跟目前不給 shell、不給密鑰的原則一樣。Fal 呼叫包成固定參數的 MCP 工具，由程式執行，輸出存成素材包內的檔案。
- 生成素材和原片一樣，只能放在 `assets/generated/`，由程式命名，例如 `shot-01.mp4`、`vo-01.mp3`。

### 7.2 建議的工具介面

| 工具 | 參數（程式驗證） | 程式做的事 |
|---|---|---|
| `generate_shot` | `prompt`（≤1,000 字）、`reference_frame`（素材包內的關鍵幀，選填）、`seconds`（例如 3–8）、`aspect: "9:16"` | 用 Fal 的圖生影片或文生影片模型生成，下載到 `assets/generated/shot-NN.mp4`，用 ffprobe 回傳實際長度和尺寸 |
| `generate_voiceover` | `text`、`language`（必須等於帖子市場的語言）、`voice`（從固定清單選） | 用 Fal 的 TTS 模型生成，存成 `vo-NN.mp3` 並回傳長度。Agent 拿這個長度去對齊字幕時間 |
| `generate_image` | `prompt`、`reference_frame`（選填） | 生成單張畫面，給轉場或圖文畫面用 |

實作上用 Fal 官方的 JS client（`@fal-ai/client`）：設定 credentials 後，用 `subscribe` 等佇列跑完再取結果。endpoint ID 放在設定檔裡，按 Fal 目前的模型清單選，不要寫死在 Prompt 裡。每次呼叫都要逾時，並記錄成本。

### 7.3 Prompt 和規則要跟著改

- 把「不能拍攝、不能配音、不能超過原片長度」改成：「需要新鏡頭或配音時用生成工具；成片最長 N 秒，例如 40 秒，對應爆款文檔說的 20–40 秒」。驗收的長度規則也要一起改。
- `notes.json` 加上 `generated[]`：哪些鏡頭或聲音是生成的、用了什麼 prompt、對應哪條建議。頁面上要讓人看得出哪些是 AI 生成。
- 仍然保留 `skipped[]`，用來放生成也做不好的部分（例如需要特定真人演技的鏡頭）。

### 7.4 預算與限額（必做）

- 每次重制設生成上限，例如最多 4 個鏡頭、合計 ≤20 秒影片、配音 ≤60 秒。工具在程式端計數，超過就回錯誤，讓 Agent 改用剪輯方案。
- 每個工具呼叫都記錄 Fal 的費用和耗時，寫進 recreation 紀錄。可以考慮全站每日的 Fal 預算上限。
- 生成要排隊、設逾時（影片生成可能要好幾分鐘）。整體租約也要加上「生成最長耗時 × 上限次數」。

### 7.5 授權與合規（請先確認）

- **肖像與 AI 生成**：用參考幀生成「創作者本人」的新鏡頭，等於用 AI 製作這個人的影像。授權範圍必須明確涵蓋「二次剪輯 + AI 生成肖像和聲音」，一般的轉發或剪輯授權不夠。建議預設只生成不含真人臉的鏡頭（場景、手部、螢幕畫面、道具），或者是新的虛擬角色。
- **配音**：預設用通用聲音，不要克隆創作者的聲音，除非另外取得授權。
- **平台標示**：TikTok 要求真實感的 AI 生成內容加上 AI 生成標示；發布流程要提醒操作者勾選。
- **品牌**：同樣不新增硬廣植入。如果 PopUp 要出現在新生成的鏡頭裡，應該讓它推動劇情（例如一條通知或一次配對），而不是加結尾品牌卡。

### 7.6 移植清單

1. 複製 `service/src/recreate/` 的六個模組：brief、workspace、permissions、tools、agent、render，以及 run 的狀態機。依目標專案的資料表調整 `collectInputs`。
2. 新增 `fal-tools.ts`：上面三個生成工具，參數驗證、計數、費用紀錄都在這裡，並把工具名加進 `allowedTools`。
3. 修改 `RECREATE_SYSTEM_PROMPT`：工具說明、長度上限、`generated[]` 欄位、授權相關的限制（不生成真人臉、不克隆聲音）。
4. `verifyRendition` 的長度上限改成設定值。
5. 網站端：沿用每帖 2 次和全站進行中上限的原子插入；頁面顯示「AI 生成」標示，以及生成費用（只給內部人員看）。
6. 照搬測試：守門（`~`、URL、點檔、沒有 shell）、檢查工具（固定參數、最小環境）、原子上限、額度暫停、錯誤類別、過期任務清理。再為生成工具補上參數、上限、費用的測試。
7. 實測：挑一條「需要重拍」建議很多的帖子，比較只剪輯和加上生成兩種版本的成片。
