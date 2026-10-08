# FrameLab Vietnam source URLs

`framelab-vn.csv` is an import manifest of 13 unique TikTok post URLs from the FrameLab research set referenced by [the Content Lab design spec, Appendix A](../superpowers/specs/2026-10-08-content-monitor-design.md#附錄-a詞表迭代紀錄2026-10-08). It contains 9 videos and 4 photo posts from 11 creators.

Each row links to its exact source line in `mercurydudu/popup-KOL-content-analysis-dashboard`, pinned to commit `5e5dd33b91ef3b0db1f382c2660c2c30a1d747a2`. Access to those GitHub provenance links requires permission to that repository. `VN` records the Vietnam research-set grouping described in the Content Lab spec, not a verified creator location or audience country. `FrameLab VN` is the import batch/project label.

No Excel workbook or CSV source dataset was found in the Content Lab repository, the FrameLab repository, or this local project's `sources/` directory during the 2026-10-08 audit. The design spec requires Excel/CSV import as a feature; this CSV was derived from the referenced FrameLab source URLs.

This manifest deliberately contains no playback counts, engagement metrics, historical curves, rankings, transcripts, or analysis summaries. After import, the local collector must request current data from TikWM (or its configured fallback), record the actual capture time and source, and expose failures as unavailable. Old values hard-coded in the FrameLab source must not be presented as fresh measurements. Importing these URLs does not create historical observations.

Read-only upstream spot checks on 2026-10-08 confirmed that the video ending `7651202612980813077` returned live metrics and a video URL, and the photo post ending `7668635242554608897` returned live metrics and 3 image URLs. All 13 URLs are source-verified; individual current availability is determined when the collector fetches each post.
