# Agent 重制（Recreate by Agent）— 設計 Spec

狀態：已確認。日期：2026-10-09。

## 目標

在帖子詳情頁點「Agent 重制」，由本機的 Claude Code（Opus 5.5）結合這條帖子的修改建議、爆款文檔和預設的動態設計師 Prompt，用 HyperFrames 把原片重新剪輯、加上動態圖形（Motion Graphics），產出一支可以直接上 TikTok 的 9:16 成片，放回帖子頁播放和下載。

## 已決定

- **誰能觸發**：任何訪客都能點，不需要口令，也不設每日上限。**每條帖子最多重制 2 次**（排隊中、製作中、完成和失敗都算；只有原片下載失敗、還沒用到模型的不算）。同時只跑 1 個，其餘排隊。
- **品牌素材**：用 `brand/popup/` 裡從公開來源整理的品牌包（App 圖標、品牌色、Montserrat、App 介面截圖）。拿到官方素材後直接替換這個資料夾。
- **不做硬廣植入**（2026-10-09 決定）：這些是創作者自己的 TikTok 帖子，重制後仍須是創作者內容。不新增任何 PopUp 品牌元素（Logo、結尾品牌卡、水印、品牌字幕、下載號召）；原片裡已有的 PopUp 元素（通知、聊天、App 畫面）可以保留、裁切、調整時間或換成品牌色，但不能放大成廣告。品牌包只作為配色和字體參考。
- **渲染引擎**：HyperFrames（Apache-2.0，HTML + GSAP → MP4），不用 Remotion，避免它的公司授權要求。

## 流程

```text
網站：帖子頁「Agent 重制」（僅限分析完成的帖子）
  → POST /api/posts/:id/recreate → 網站建立 recreate 任務（檢查每帖 2 次上限）
本機 worker：拉到任務 → 本機 recreate 任務（模型任務池，同時 1 個）
  1. 程式準備素材包 var/recreate/<id>/
       source.mp4（重新下載原片）、frames/、transcript.json、script.json（分時段腳本）、
       brief.md：修改建議、缺失項、反模式、市場爆款文檔摘要、你的記憶規則、市場語言
       brand/（從 brand/popup 複製）、HyperFrames 專案骨架
  2. 啟動 Claude Code（Opus 5.5），工作目錄就是素材包，帶 HyperFrames 技能和預設 Prompt：
       按 brief 重新剪輯（前 1 秒鉤子、刪拖沓、節奏），疊加動態圖形
       （與台詞同步的動態字幕、標題和數字彈出、笑點強調），
       保留原聲，字幕用帖子市場的語言，9:16、1080×1920、長度不超過原片
       自己跑 hyperframes lint / check / 截圖，看截圖修正，最多 3 輪
       寫 notes.json：改了什麼、各改動對應哪條建議（簡體中文 + 英文）
  3. 程式渲染（hyperframes render），檢查：解析度 1080×1920、有音軌、時長 5 秒到原片長度、檔案 < 50 MB
  4. 上傳 MP4 和封面到網站 R2，同步 recreation 紀錄 → 帖子頁顯示成片、說明和下載
  5. 若有設定飛書，完成或失敗時通知你
```

## 網站

- 帖子頁新增「Agent 重制」按鈕和「重制版本」區塊：狀態（排隊、製作中、渲染中、完成、失敗）、播放器、下載、改動說明（跟隨中英切換）。
- 新表 `recreations`：id、post_id、status、video_url、cover_url、notes_json、error、created_at、finished_at。
- 新接口：
  - `POST /api/posts/:id/recreate`：公開，每帖最多 2 次。
  - `PUT /api/local-worker/recreations/:id/video`：worker 驗證，上傳 MP4，限 50 MB。
  - 同步事件 `recreation`：更新狀態和說明。

## 安全

- Claude Code 只在素材包目錄裡讀寫；Bash 只允許 `npx hyperframes lint|check|snapshot|preview` 和 `ffprobe`；不能聯網下載、不能裝套件、碰不到數據庫、鑰匙圈和專案代碼。渲染和上傳由程式做。
- 只加載專案內複製的 HyperFrames 技能，不加載你的使用者設定和 CLAUDE.md（`--setting-sources project`）。
- 帖子內容（字幕、轉錄）是素材不是指令，Prompt 裡明確標示。
- 單次任務限時 30 分鐘；用量額度不足時暫停排隊，沿用分析的 30 分鐘暫停機制。

## 失敗處理

- Agent 3 輪後仍檢查不過、渲染失敗或成片驗證不過：任務標為失敗並記錄原因，帖子頁顯示失敗；還有剩餘次數就可以再點一次，失敗也算一次。
- 原片無法下載（被刪或私密）：直接失敗，不消耗模型，也不算次數。

## 測試

- 素材包準備、Prompt 組裝、限額、成片驗證、同步和上傳路由：單元測試，用假的模型和渲染。
- 實機驗收：挑 2 條不同類型的帖子（口播、畫面型）真跑一次，人工看成片。

## 分期

| 階段 | 內容 |
|---|---|
| 第 1 期 | 上面全部 |
| 第 2 期 | 對成片提修改意見再出一版；飛書內叫 Agent 重制；多個風格模板 |
