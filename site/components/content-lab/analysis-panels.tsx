import Link from "next/link";
import { Lightbulb, ShieldAlert, Sparkles, Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ComputedFeatures, Prediction, ScriptSegment } from "@/lib/content-lab";

const POTENTIAL = {
  high: { label: "高", className: "border-primary/25 bg-primary/10 text-primary" },
  medium: { label: "中", className: "border-amber-300/25 bg-amber-300/10 text-amber-200" },
  low: { label: "低", className: "border-[#ff715b]/25 bg-[#ff715b]/10 text-[#ff8a76]" },
} as const;

const ROLE_LABELS: Record<ScriptSegment["role"], string> = {
  hook: "鉤子", setup: "鋪墊", development: "推進", turn: "轉折", payoff: "爆點", cta: "行動呼籲", other: "其他",
};

/** Bind-time assessment against the market's viral-content playbook. */
export function AssessmentCard({ prediction, market }: { prediction: Prediction | undefined; market: string }) {
  const assessment = prediction?.assessment;
  const potential = assessment?.potential ? POTENTIAL[assessment.potential] : null;
  return (
    <Card className="border-white/8 bg-card/80 shadow-none">
      <CardHeader className="border-b border-white/8 pb-5">
        <div className="flex items-start justify-between gap-3">
          <div><CardTitle className="text-lg">爆款評估</CardTitle><CardDescription className="mt-1">{assessment?.playbook ? <>對照 <Link className="text-primary hover:underline" href={`/playbook?market=${encodeURIComponent(market)}`}>{market} 爆款共性文檔 v{assessment.playbook.version}</Link></> : "對照該市場的爆款共性文檔"}</CardDescription></div>
          {potential ? <Badge className={potential.className} variant="outline">爆款可能性 · {potential.label}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-6">
        {!prediction ? <p className="py-8 text-center text-sm text-muted-foreground">等待 Agent 完成分析後評估。</p>
          : !assessment?.potential ? <p className="text-sm leading-6 text-muted-foreground">{prediction.rationale ?? "尚未評估。"}</p>
          : <>
            <p className="text-sm leading-7 text-foreground/90">{assessment.potential_reason_zh}</p>
            {assessment.matched_patterns?.length ? <PatternList icon={Target} title="已具備的爆款共性" tone="text-primary" items={assessment.matched_patterns.map((item) => ({ id: item.pattern_id, text: item.evidence_zh }))} /> : null}
            {assessment.missing_patterns?.length ? <PatternList icon={Sparkles} title="缺少的共性" tone="text-amber-200" items={assessment.missing_patterns.map((item) => ({ id: item.pattern_id, text: item.gap_zh }))} /> : null}
            {assessment.anti_patterns_hit?.length ? <PatternList icon={ShieldAlert} title="踩到的反模式" tone="text-[#ff8a76]" items={assessment.anti_patterns_hit.map((item) => ({ id: item.pattern_id, text: item.evidence_zh }))} /> : null}
            {assessment.suggestions?.length ? <div>
              <p className="flex items-center gap-1.5 text-sm font-medium"><Lightbulb className="size-4 text-cyan-200" />修改建議</p>
              <ol className="mt-3 space-y-3">{[...assessment.suggestions].sort((a, b) => a.priority - b.priority).map((item, index) => <li className="rounded-lg border border-white/8 bg-white/[0.025] p-3" key={index}>
                <div className="flex items-start gap-2"><span className="mt-0.5 shrink-0 font-mono text-[11px] text-cyan-200">P{item.priority}</span><div className="min-w-0"><p className="text-sm leading-6">{item.change_zh}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{item.reason_zh}{item.pattern_ids.length ? ` · 依據 ${item.pattern_ids.join("、")}` : ""}</p></div></div>
              </li>)}</ol>
            </div> : null}
            {assessment.inSample ? <p className="text-xs text-muted-foreground">這條帖子本身是文檔樣本之一，評估只看內容，不以它自己的播放量為依據。</p> : null}
          </>}
      </CardContent>
    </Card>
  );
}

function PatternList({ icon: Icon, title, tone, items }: { icon: typeof Target; title: string; tone: string; items: Array<{ id: string; text: string }> }) {
  return <div>
    <p className="flex items-center gap-1.5 text-sm font-medium"><Icon className={`size-4 ${tone}`} />{title}</p>
    <ul className="mt-2 space-y-2">{items.map((item, index) => <li className="flex gap-2 text-sm leading-6 text-muted-foreground" key={index}><span className={`shrink-0 font-mono text-xs leading-6 ${tone}`}>{item.id}</span><span>{item.text}</span></li>)}</ul>
  </div>;
}

/** The complete timed script: what is seen, written and said in each beat. */
export function ScriptTimeline({ script, frames }: { script: ScriptSegment[]; frames: string[] }) {
  if (!script.length) return <p className="py-10 text-center text-sm text-muted-foreground">這條帖子還沒有分段腳本；重試分析後會產生。</p>;
  return <ol className="relative space-y-4 border-l border-white/10 pl-5">
    {script.map((segment, index) => <li className="relative" key={index}>
      <span className="absolute -left-[26px] top-1.5 size-2.5 rounded-full border border-primary/60 bg-background" />
      <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm font-semibold text-primary">{segment.position}</span><Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{ROLE_LABELS[segment.role] ?? segment.role}</Badge></div>
      <div className="mt-2 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="space-y-2 text-sm leading-6">
          <p><span className="mr-2 text-xs text-muted-foreground">畫面</span>{segment.visual_zh}</p>
          {segment.on_screen_text ? <div><span className="mr-2 text-xs text-muted-foreground">字幕</span><span className="whitespace-pre-line">{segment.on_screen_text_zh}</span><p className="whitespace-pre-line pl-9 text-xs text-muted-foreground">{segment.on_screen_text}</p></div> : null}
          {segment.spoken ? <div className="rounded-md border border-cyan-300/12 bg-cyan-300/[0.04] p-2.5"><span className="mr-2 text-xs text-cyan-200">台詞</span><span className="whitespace-pre-line">{segment.spoken_zh}</span><p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{segment.spoken}</p></div> : null}
        </div>
        {segment.frames.length ? <div className="flex gap-1.5">{segment.frames.slice(0, 3).map((frame) => frames[frame - 1] ? <img alt={`第 ${frame} 幀`} className="h-24 w-[54px] rounded border border-white/8 object-cover" key={frame} loading="lazy" src={frames[frame - 1]} /> : null)}</div> : null}
      </div>
    </li>)}
  </ol>;
}

const PACING: Record<string, string> = { slow: "慢", medium: "中", fast: "快" };
const MUSIC: Record<string, string> = { original: "原聲", library: "曲庫音樂", unknown: "未知" };
const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

/** Facts computed by the program from the media and metadata, not judged by the model. */
export function ComputedFeaturesCard({ computed }: { computed: ComputedFeatures }) {
  const photo = computed.format_type === "photo";
  const rows: Array<[string, string]> = photo ? [
    ["圖集張數", computed.image_count != null ? `${computed.image_count} 張` : "—"],
  ] : [
    ["時長", computed.duration_s != null ? `${computed.duration_s}s（${computed.duration_band ?? "—"}）` : "—"],
    ["剪輯", computed.scene_cuts != null ? `${computed.scene_cuts} 次切換 · 每 10 秒 ${computed.cuts_per_10s ?? "—"} 次 · 節奏${PACING[computed.pacing_band ?? ""] ?? "—"}` : "—"],
    ["口播", computed.has_speech ? `${computed.speech_words ?? 0} 字 · ${computed.speech_words_per_min ?? "—"} 字/分 · 第一句在 ${computed.first_speech_s ?? "—"}s` : "沒有口播"],
  ];
  rows.push(
    ["音樂", MUSIC[computed.music_type ?? "unknown"] ?? "—"],
    ["畫面文字", computed.on_screen_text_per_frame != null ? `每${photo ? "張" : "幀"}約 ${computed.on_screen_text_per_frame} 字` : "—"],
    ["文案", `${computed.caption_chars ?? 0} 字 · ${computed.hashtag_count ?? 0} 個 hashtag${computed.brand_in_caption ? " · 提到品牌" : ""}`],
    ["發布時間（當地）", computed.publish_hour_local != null ? `${WEEKDAYS[computed.publish_weekday_local ?? 0]} ${computed.publish_hour_local}:00` : "—"],
  );
  return <Card className="border-white/8 bg-card/80 shadow-none">
    <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">程式計算特徵</CardTitle><CardDescription>由程式從影片與資料算出，不經過模型</CardDescription></CardHeader>
    <CardContent className="pt-5">{Object.keys(computed).length ? <dl className="space-y-3">{rows.map(([label, value]) => <div className="flex justify-between gap-4 text-sm" key={label}><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="text-right">{value}</dd></div>)}</dl> : <p className="py-8 text-center text-sm text-muted-foreground">重試分析後會計算。</p>}</CardContent>
  </Card>;
}
