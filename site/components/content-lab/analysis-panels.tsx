"use client";

import { useState } from "react";
import Link from "next/link";
import { Lightbulb, ShieldAlert, Sparkles, Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { compactNumber, type Checkpoint, type ComputedFeatures, type Prediction, type ScriptSegment } from "@/lib/content-lab";
import { useLocale } from "@/lib/i18n";

const POTENTIAL = {
  high: { label: ["高", "High"], className: "border-primary/25 bg-primary/10 text-primary" },
  medium: { label: ["中", "Medium"], className: "border-amber-300/25 bg-amber-300/10 text-amber-200" },
  low: { label: ["低", "Low"], className: "border-[#ff715b]/25 bg-[#ff715b]/10 text-[#ff8a76]" },
} as const;

const ROLE_LABELS: Record<ScriptSegment["role"], [string, string]> = {
  hook: ["钩子", "Hook"], setup: ["铺垫", "Setup"], development: ["推进", "Development"], turn: ["转折", "Turn"],
  payoff: ["爆点", "Payoff"], cta: ["行动号召", "CTA"], other: ["其他", "Other"],
};

/** Bind-time assessment against the market's viral-content playbook, laid out for a full-width row. */
export function AssessmentCard({ prediction, market }: { prediction: Prediction | undefined; market: string }) {
  const { t, pick } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const assessment = prediction?.assessment;
  const potential = assessment?.potential ? POTENTIAL[assessment.potential] : null;
  const reason = assessment ? pick(assessment, "potential_reason") || prediction?.rationale || "" : prediction?.rationale ?? "";
  const long = reason.length > 160;
  const columns = assessment?.potential ? [
    { key: "matched", icon: Target, title: t("已具备的爆款共性", "Patterns it already uses"), tone: "text-primary", items: (assessment.matched_patterns ?? []).map((item) => ({ id: item.pattern_id, text: pick(item, "evidence") })) },
    { key: "missing", icon: Sparkles, title: t("缺少的共性", "Missing patterns"), tone: "text-amber-200", items: (assessment.missing_patterns ?? []).map((item) => ({ id: item.pattern_id, text: pick(item, "gap") })) },
    { key: "anti", icon: ShieldAlert, title: t("踩到的反模式", "Anti-patterns it hits"), tone: "text-[#ff8a76]", items: (assessment.anti_patterns_hit ?? []).map((item) => ({ id: item.pattern_id, text: pick(item, "evidence") })) },
  ] : [];
  return (
    <Card className="border-white/8 bg-card/80 shadow-none">
      <CardHeader className="border-b border-white/8 pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="text-lg">{t("爆款评估", "Viral assessment")}</CardTitle>
            {potential ? <Badge className={`${potential.className} text-sm`} variant="outline">{t("爆款可能性", "Viral potential")} · {t(potential.label[0], potential.label[1])}</Badge> : null}
          </div>
          <CardDescription>{assessment?.playbook
            ? <>{t("对照", "Compared with")} <Link className="text-primary hover:underline" href={`/playbook?market=${encodeURIComponent(market)}`}>{t(`${market} 爆款共性文档 v${assessment.playbook.version}`, `${market} playbook v${assessment.playbook.version}`)}</Link></>
            : t("对照该市场的爆款共性文档", "Compared with this market's viral playbook")}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 pt-5">
        {!prediction ? <p className="py-6 text-center text-sm text-muted-foreground">{t("等待 Agent 完成分析后评估。", "Waiting for the Agent to finish the analysis.")}</p>
          : !assessment?.potential ? <p className="text-sm leading-6 text-muted-foreground">{reason || t("尚未评估。", "Not assessed yet.")}</p>
          : <>
            <div>
              <p className={`max-w-4xl text-sm leading-7 text-foreground/90 ${long && !expanded ? "line-clamp-3" : ""}`}>{reason}</p>
              {long ? <button className="mt-1 text-xs text-primary hover:underline" onClick={() => setExpanded((value) => !value)} type="button">{expanded ? t("收起", "Show less") : t("展开全文", "Show more")}</button> : null}
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              {columns.map((column) => <PatternList icon={column.icon} items={column.items} key={column.key} title={column.title} tone={column.tone} empty={t("无", "None")} />)}
            </div>
            {assessment.suggestions?.length ? <div>
              <p className="flex items-center gap-1.5 text-sm font-medium"><Lightbulb className="size-4 text-cyan-200" />{t("修改建议", "Suggested changes")}</p>
              <ol className="mt-3 grid gap-3 lg:grid-cols-2">{[...assessment.suggestions].sort((a, b) => a.priority - b.priority).map((item, index) => <li className="rounded-lg border border-white/8 bg-white/[0.025] p-3" key={index}>
                <div className="flex items-start gap-2"><span className="mt-0.5 shrink-0 rounded bg-cyan-300/10 px-1.5 font-mono text-[11px] text-cyan-200">P{item.priority}</span><div className="min-w-0"><p className="text-sm leading-6">{pick(item, "change")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{pick(item, "reason")}{item.pattern_ids.length ? ` · ${t("依据", "Based on")} ${item.pattern_ids.join(", ")}` : ""}</p></div></div>
              </li>)}</ol>
            </div> : null}
            {assessment.inSample ? <p className="text-xs text-muted-foreground">{t("这条帖子本身是文档样本之一，评估只看内容，不以它自己的播放量为依据。", "This post is part of the playbook sample; the assessment judges its content, not its own view count.")}</p> : null}
          </>}
      </CardContent>
    </Card>
  );
}

function PatternList({ icon: Icon, title, tone, items, empty }: { icon: typeof Target; title: string; tone: string; items: Array<{ id: string; text: string }>; empty: string }) {
  return <div className="rounded-lg border border-white/8 bg-white/[0.02] p-4">
    <p className="flex items-center gap-1.5 text-sm font-medium"><Icon className={`size-4 ${tone}`} />{title}<span className="ml-auto font-mono text-xs text-muted-foreground">{items.length}</span></p>
    {items.length ? <ul className="mt-3 space-y-2.5">{items.map((item, index) => <li className="flex gap-2 text-sm leading-6 text-muted-foreground" key={index}><span className={`shrink-0 font-mono text-xs leading-6 ${tone}`}>{item.id}</span><span>{item.text}</span></li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">{empty}</p>}
  </div>;
}

/** The complete timed script: what is seen, written and said in each beat. */
export function ScriptTimeline({ script, frames }: { script: ScriptSegment[]; frames: string[] }) {
  const { t, pick } = useLocale();
  if (!script.length) return <p className="py-10 text-center text-sm text-muted-foreground">{t("这条帖子还没有分段脚本；重试分析后会生成。", "No timed script yet; retry the analysis to generate one.")}</p>;
  return <ol className="relative space-y-4 border-l border-white/10 pl-5">
    {script.map((segment, index) => <li className="relative" key={index}>
      <span className="absolute -left-[26px] top-1.5 size-2.5 rounded-full border border-primary/60 bg-background" />
      <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm font-semibold text-primary">{segment.position.replace(/^[圖图]\s*/, t("图 ", "Image "))}</span><Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{t(...(ROLE_LABELS[segment.role] ?? [segment.role, segment.role]))}</Badge></div>
      <div className="mt-2 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="space-y-2 text-sm leading-6">
          <p><span className="mr-2 text-xs text-muted-foreground">{t("画面", "Visual")}</span>{pick(segment, "visual")}</p>
          {segment.on_screen_text ? <div><span className="mr-2 text-xs text-muted-foreground">{t("字幕", "Text")}</span><span className="whitespace-pre-line">{pick(segment, "on_screen_text")}</span><p className="whitespace-pre-line pl-9 text-xs text-muted-foreground">{segment.on_screen_text}</p></div> : null}
          {segment.spoken ? <div className="rounded-md border border-cyan-300/12 bg-cyan-300/[0.04] p-2.5"><span className="mr-2 text-xs text-cyan-200">{t("台词", "Spoken")}</span><span className="whitespace-pre-line">{pick(segment, "spoken")}</span><p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{segment.spoken}</p></div> : null}
        </div>
        {segment.frames.length ? <div className="flex gap-1.5">{segment.frames.slice(0, 3).map((frame) => frames[frame - 1] ? <img alt={t(`第 ${frame} 帧`, `Frame ${frame}`)} className="h-24 w-[54px] rounded border border-white/8 object-cover" key={frame} loading="lazy" src={frames[frame - 1]} /> : null)}</div> : null}
      </div>
    </li>)}
  </ol>;
}

const PACING: Record<string, [string, string]> = { slow: ["慢", "slow"], medium: ["中", "medium"], fast: ["快", "fast"] };
const MUSIC: Record<string, [string, string]> = { original: ["原声", "Original sound"], library: ["曲库音乐", "Library music"], unknown: ["未知", "Unknown"] };
const WEEKDAYS: Array<[string, string]> = [["周日", "Sun"], ["周一", "Mon"], ["周二", "Tue"], ["周三", "Wed"], ["周四", "Thu"], ["周五", "Fri"], ["周六", "Sat"]];

/** Facts computed by the program from the media and metadata, not judged by the model. */
export function ComputedFeaturesCard({ computed }: { computed: ComputedFeatures }) {
  const { t } = useLocale();
  const photo = computed.format_type === "photo";
  const pacing = PACING[computed.pacing_band ?? ""];
  const rows: Array<[string, string]> = photo ? [
    [t("图集张数", "Images"), computed.image_count != null ? t(`${computed.image_count} 张`, `${computed.image_count}`) : "—"],
  ] : [
    [t("时长", "Duration"), computed.duration_s != null ? `${computed.duration_s}s（${computed.duration_band ?? "—"}）` : "—"],
    [t("剪辑", "Cuts"), computed.scene_cuts != null ? t(`${computed.scene_cuts} 次切换 · 每 10 秒 ${computed.cuts_per_10s ?? "—"} 次 · 节奏${pacing?.[0] ?? "—"}`, `${computed.scene_cuts} cuts · ${computed.cuts_per_10s ?? "—"} per 10s · ${pacing?.[1] ?? "—"} pacing`) : "—"],
    [t("口播", "Speech"), computed.has_speech
      ? t(`${computed.speech_words ?? 0} 词 · ${computed.speech_words_per_min ?? "—"} 词/分 · 第一句在 ${computed.first_speech_s ?? "—"}s`, `${computed.speech_words ?? 0} words · ${computed.speech_words_per_min ?? "—"} wpm · first line at ${computed.first_speech_s ?? "—"}s`)
      : t("没有口播", "No speech")],
  ];
  const weekday = WEEKDAYS[computed.publish_weekday_local ?? 0]!;
  rows.push(
    [t("音乐", "Music"), t(...(MUSIC[computed.music_type ?? "unknown"] ?? MUSIC.unknown!))],
    [t("画面文字", "On-screen text"), computed.on_screen_text_per_frame != null ? t(`每${photo ? "张" : "帧"}约 ${computed.on_screen_text_per_frame} 字`, `~${computed.on_screen_text_per_frame} characters per ${photo ? "image" : "frame"}`) : "—"],
    [t("文案", "Caption"), t(`${computed.caption_chars ?? 0} 字 · ${computed.hashtag_count ?? 0} 个 hashtag${computed.brand_in_caption ? " · 提到品牌" : ""}`, `${computed.caption_chars ?? 0} characters · ${computed.hashtag_count ?? 0} hashtags${computed.brand_in_caption ? " · mentions the brand" : ""}`)],
    [t("发布时间（当地）", "Published (local)"), computed.publish_hour_local != null ? `${t(...weekday)} ${computed.publish_hour_local}:00` : "—"],
  );
  return <Card className="border-white/8 bg-card/80 shadow-none">
    <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">{t("程序计算特征", "Computed features")}</CardTitle><CardDescription>{t("由程序从视频与数据算出，不经过模型", "Measured by the program from the media and metadata, not by the model")}</CardDescription></CardHeader>
    <CardContent className="pt-5">{Object.keys(computed).length ? <dl className="space-y-3">{rows.map(([label, value]) => <div className="flex justify-between gap-4 text-sm" key={label}><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="text-right">{value}</dd></div>)}</dl> : <p className="py-8 text-center text-sm text-muted-foreground">{t("重试分析后会计算。", "Computed after the next analysis.")}</p>}</CardContent>
  </Card>;
}

const pctRate = (value: number | null): string => (value == null ? "—" : `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`);

/** Early performance at fixed post ages; recorded as data first, before any prediction relies on it. */
export function CheckpointsCard({ checkpoints }: { checkpoints: Checkpoint[] }) {
  const { t } = useLocale();
  const status = (item: Checkpoint): string => item.status === "missed"
    ? t("未录到（当时尚未追踪）", "Not captured (not tracked then)")
    : t("尚未到达", "Not reached yet");
  return <Card className="border-white/8 bg-card/80 shadow-none">
    <CardHeader className="border-b border-white/8 pb-5">
      <CardTitle className="text-lg">{t("早期表现检查点", "Early performance checkpoints")}</CardTitle>
      <CardDescription>{t("发布后 1/3/6/24/72 小时的播放与互动，由程序记录；互动率在播放满 1,000 后才计算。目前只累积数据，尚未用于预测。", "Views and engagement 1/3/6/24/72 hours after publishing, recorded by the program; rates start at 1,000 views. Collected as data only; not yet used for predictions.")}</CardDescription>
    </CardHeader>
    <CardContent className="overflow-x-auto pt-4">
      {checkpoints.length ? <table className="w-full min-w-[640px] text-sm">
        <thead><tr className="text-left text-xs text-muted-foreground">
          <th className="py-2 font-normal">{t("检查点", "Checkpoint")}</th><th className="py-2 font-normal">{t("实际帖龄", "Actual age")}</th>
          <th className="py-2 text-right font-normal">{t("播放", "Views")}</th><th className="py-2 text-right font-normal">{t("平均每小时", "Views / hour")}</th>
          <th className="py-2 text-right font-normal">{t("点赞率", "Like rate")}</th><th className="py-2 text-right font-normal">{t("评论率", "Comment rate")}</th>
          <th className="py-2 text-right font-normal">{t("分享率", "Share rate")}</th><th className="py-2 text-right font-normal">{t("收藏率", "Save rate")}</th>
        </tr></thead>
        <tbody>{checkpoints.map((item) => <tr className="border-t border-white/8" key={item.hours}>
          <td className="py-2.5 font-mono text-primary">{item.hours}h</td>
          {item.status === "recorded" ? <>
            <td className="py-2.5 font-mono text-xs text-muted-foreground">{item.ageHours}h</td>
            <td className="py-2.5 text-right font-mono">{compactNumber(item.views)}</td>
            <td className="py-2.5 text-right font-mono">{compactNumber(item.viewsPerHour)}</td>
            <td className="py-2.5 text-right font-mono">{pctRate(item.likeRate)}</td>
            <td className="py-2.5 text-right font-mono">{pctRate(item.commentRate)}</td>
            <td className="py-2.5 text-right font-mono">{pctRate(item.shareRate)}</td>
            <td className="py-2.5 text-right font-mono">{pctRate(item.saveRate)}</td>
          </> : <td className="py-2.5 text-xs text-muted-foreground" colSpan={7}>{status(item)}</td>}
        </tr>)}</tbody>
      </table> : <p className="py-6 text-center text-sm text-muted-foreground">{t("下一次采集后生成。", "Generated after the next capture.")}</p>}
    </CardContent>
  </Card>;
}
