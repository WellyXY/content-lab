# Implementation brief for Codex — no code changes without user approval

Goal: preserve Content Lab existing TikTok acquisition/parser and online dashboard; Admin-only local AI analysis on M1 16GB with no paid AI API; teammates read human-approved results on hosted site. Local-model capability and performance require benchmark; do not promise 24/7 AI access or zero hosting/storage costs.

Phase 1: ingest structured references (MD/JSON) as read-only retrieval; maintain version/hash; attach raw evidence pointers and provenance per finding. Build blind analysis pipeline and independent Creative Score/Predicted Registration Potential fields. Log missing modalities and scoring nulls.
Phase 2: admin review/edit/approve, store analysis revision history, upload approved case records to durable online storage. Ensure teammates can view when admin Mac offline. Add access control for admins and readers; do not expose local machine directly.
Phase 3: weekly ads import, safe creative-name mapping with review on ambiguous aliases, compute aggregated spend/registrations/CPA by time and format, distinguish ad metrics from organic ones. Do not join just by creator name.
Phase 4: creative suggestions with linked supporting cases and per-market boundaries. Validate speed/memory of a local multimodal model on three known clips before embedding in online workflow.

Acceptance: 1) no live spend data in blind scoring prompt; 2) no invented BGM/words; 3) no universal reverse penalty; 4) Creative high/Registration low allowed; 5) reviewers can correct insights; 6) missing/ambiguous asset mapping blocks metric joins; 7) team reads published insight with Mac offline.
