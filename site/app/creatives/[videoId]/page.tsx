"use client";

import { Suspense, use, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Clapperboard } from "lucide-react";

import { formatMoney } from "@/lib/ads";
import { compactNumber, type ScriptSegment } from "@/lib/content-lab";
import { creativeTotals, type Creative } from "@/lib/creatives";
import { useLocale } from "@/lib/i18n";
import { ScriptTimeline } from "@/components/content-lab/analysis-panels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const WINDOWS = [7, 14, 30] as const;
const pct = (value: number | null): string => value === null ? "—" : `${(value * 100).toFixed(2)}%`;

export default function CreativeDetailPage({ params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = use(params);
  return <Suspense fallback={<Skeleton className="h-[480px] w-full" />}><CreativeDetail videoId={videoId} /></Suspense>;
}

function CreativeDetail({ videoId }: { videoId: string }) {
  const { t, lang } = useLocale();
  const search = useSearchParams();
  const initial = Number(search.get("window"));
  const [days, setDays] = useState<number>(WINDOWS.includes(initial as 7) ? initial : 7);
  const [data, setData] = useState<{ creative: Creative; guides: Array<{ country: string }> } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/creatives/${encodeURIComponent(videoId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("load failed"); return response.json() as Promise<{ creative: Creative; guides: Array<{ country: string }> }>; })
      .then(setData)
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [videoId]);

  const back = <Link className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" href="/creatives"><ArrowLeft className="size-4" />{t("常规素材", "Creatives")}</Link>;
  if (error) return <>{back}<p className="mt-6 text-sm text-[#ff8a76]">{t("找不到这支素材，或暂时无法读取。", "Creative not found or temporarily unavailable.")}</p></>;
  if (!data) return <>{back}<Skeleton className="mt-6 h-[480px] w-full" /></>;

  const { creative } = data;
  const hasGuide = (country: string) => data.guides.some((guide) => guide.country === country);
  const totals = creativeTotals(creative, days, null);
  const byCountry = [...new Set(creative.stats.filter((item) => item.window === days).map((item) => item.country))]
    .map((country) => ({ country, totals: creativeTotals(creative, days, country) })).sort((a, b) => b.totals.spend - a.totals.spend);
  const analysis = creative.analysis;
  const field = (zh?: string, en?: string) => (lang === "en" ? en || zh : zh || en) ?? "";
  const metric = (label: string, value: string, sub?: string) => (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-mono text-lg font-semibold">{value}</p>{sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}</div>
  );

  return (
    <>
      {back}
      <div className="mt-4 grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="h-fit overflow-hidden border-white/8 bg-card/80 shadow-none">
          <div className="aspect-[9/16] w-full bg-black">
            {creative.videoUrl ? <video className="h-full w-full object-contain" controls playsInline poster={creative.coverUrl ?? undefined} preload="metadata" src={creative.videoUrl} />
              : creative.coverUrl ? <img alt="" className="h-full w-full object-contain" src={creative.coverUrl} />
              : <div className="grid h-full place-items-center text-muted-foreground"><Clapperboard className="size-8" /></div>}
          </div>
          <CardContent className="space-y-1.5 p-4 text-xs text-muted-foreground">
            {!creative.videoUrl ? <p>{t("影片还在同步，稍后刷新即可播放。", "The video is still syncing; refresh later to play it.")}</p> : null}
            <p>{t("时长", "Duration")} {creative.durationS ? `${creative.durationS.toFixed(1)}s` : "—"} · {t(`${creative.ads} 条广告`, `${creative.ads} ads`)}</p>
            <p className="break-all font-mono">video_id {creative.videoId}</p>
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-5">
          <div>
            <h1 className="break-words text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">{creative.fileName ?? creative.videoId}</h1>
            {creative.campaigns.length ? <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("广告系列：", "Campaigns: ")}{creative.campaigns.join("、")}</p> : null}
            <div className="mt-3 flex gap-1.5">{WINDOWS.map((window) => <button className={`rounded-full border px-3 py-1 text-xs ${window === days ? "border-primary/40 bg-primary/10 text-primary" : "border-white/10 text-muted-foreground hover:text-foreground"}`} key={window} onClick={() => setDays(window)} type="button">{t(`最近 ${window} 天`, `Last ${window} days`)}</button>)}</div>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {metric(t("花费", "Spend"), formatMoney(totals.spend))}
            {metric(t("曝光", "Impressions"), compactNumber(totals.impressions))}
            {metric("CTR", pct(totals.ctr))}
            {metric(t("安装", "Installs"), compactNumber(totals.installs), `CPI ${formatMoney(totals.cpi)}`)}
            {metric(t("注册", "Registrations"), compactNumber(totals.registrations))}
            {metric(t("注册成本", "Cost/reg"), formatMoney(totals.cpr))}
          </div>

          <Card className="border-white/8 bg-card/80 shadow-none">
            <CardHeader className="border-b border-white/8 pb-4"><CardTitle className="text-base">{t(`分国家（最近 ${days} 天）`, `By country (last ${days} days)`)}</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto pt-3">
              {byCountry.length ? <table className="w-full text-sm">
                <thead><tr className="text-xs text-muted-foreground"><th className="py-1.5 text-left font-normal">{t("国家", "Country")}</th><th className="text-right font-normal">{t("花费", "Spend")}</th><th className="text-right font-normal">{t("曝光", "Impr.")}</th><th className="text-right font-normal">CTR</th><th className="text-right font-normal">{t("安装", "Installs")}</th><th className="text-right font-normal">CPI</th><th className="text-right font-normal">{t("注册", "Regs")}</th><th className="text-right font-normal">{t("注册成本", "Cost/reg")}</th></tr></thead>
                <tbody>{byCountry.map(({ country, totals: row }) => (
                  <tr className="border-t border-white/6" key={country}>
                    <td className="py-2 font-mono">{hasGuide(country) ? <Link className="text-primary hover:underline" href={`/creatives/guide?country=${country}`}>{country}</Link> : country}</td>
                    <td className="text-right font-mono">{formatMoney(row.spend)}</td><td className="text-right font-mono">{compactNumber(row.impressions)}</td><td className="text-right font-mono">{pct(row.ctr)}</td>
                    <td className="text-right font-mono">{compactNumber(row.installs)}</td><td className="text-right font-mono">{formatMoney(row.cpi)}</td>
                    <td className="text-right font-mono">{compactNumber(row.registrations)}</td><td className="text-right font-mono text-cyan-200">{formatMoney(row.cpr)}</td>
                  </tr>
                ))}</tbody>
              </table> : <p className="py-6 text-center text-sm text-muted-foreground">{t("这个时间范围没有花费。", "No spend in this window.")}</p>}
            </CardContent>
          </Card>

          <Card className="border-white/8 bg-card/80 shadow-none">
            <CardHeader className="border-b border-white/8 pb-4">
              <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">{t("内容分析", "Content analysis")}</CardTitle>{creative.analyzedAt ? <Badge className="border-primary/20 bg-primary/8 text-primary" variant="outline">{creative.analyzedAt.slice(0, 10)}</Badge> : null}</div>
              <CardDescription>{t("v1 只分析每个国家最近 30 天花费前 10 的素材。", "v1 analyzes each country's top 10 creatives by 30-day spend.")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 pt-5">
              {analysis ? <>
                <p className="text-sm leading-7">{field(creative.summaryZh ?? analysis.summary_zh, analysis.summary_en)}</p>
                {analysis.hook_translation_zh || analysis.hook_text ? <div><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-primary">{t("开场钩子", "Hook")}</p><blockquote className="mt-2 border-l-2 border-primary/60 pl-4 leading-7">{field(analysis.hook_translation_zh, analysis.hook_translation_en)}</blockquote>{analysis.hook_text ? <p className="mt-1 pl-[18px] text-sm text-muted-foreground">{analysis.hook_text}</p> : null}</div> : null}
                {analysis.formula_zh ? <div><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-cyan-200">{t("一句话公式", "Formula")}</p><p className="mt-2 text-sm leading-7">{field(analysis.formula_zh, analysis.formula_en)}</p></div> : null}
                {analysis.script?.length ? <div><p className="mb-3 font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground">{t("分段脚本", "Timed script")}</p><ScriptTimeline frames={analysis.keyframes ?? []} script={analysis.script as ScriptSegment[]} /></div>
                  : analysis.keyframes?.length ? <div className="flex gap-2 overflow-x-auto pb-1">{analysis.keyframes.map((frame) => <img alt="" className="h-32 w-[72px] shrink-0 rounded border border-white/8 object-cover" key={frame} loading="lazy" src={frame} />)}</div> : null}
              </> : <p className="text-sm text-muted-foreground">{t("这支素材还没有内容分析：它不在任何国家花费前 10，或者分析还在排队。", "No content analysis yet: it is not in any country's top 10, or the analysis is still queued.")}</p>}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
