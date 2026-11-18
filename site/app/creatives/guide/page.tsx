"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpenText, Gauge, ShieldAlert, Target } from "lucide-react";

import { formatMoney } from "@/lib/ads";
import { useLocale } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

type Pattern = { id: string; title_zh: string; title_en: string; description_zh: string; description_en: string; why_zh: string; why_en: string; how_to_apply_zh: string; how_to_apply_en: string; example_video_ids: string[] };
type Caution = { title_zh: string; title_en: string; description_zh: string; description_en: string; example_video_ids: string[] };
type EvidenceItem = { videoId: string; fileName: string | null; spend: number; spendShare: number; registrations: number; cpr: number | null; cpi: number | null; ctr: number | null; summaryZh: string };
type Guide = {
  country: string; version: number; createdAt: string;
  document: { summary_zh: string; summary_en: string; scale_patterns: Pattern[]; efficiency_patterns: Pattern[]; cautions: Caution[]; sample_caveat_zh: string; sample_caveat_en: string };
  evidence: { country: string; countrySpend: number; creatives: EvidenceItem[] };
};

const pct = (value: number | null): string => value === null ? "—" : `${(value * 100).toFixed(1)}%`;

export default function CreativeGuidePage() {
  return <Suspense fallback={<Skeleton className="h-96 w-full" />}><GuideView /></Suspense>;
}

function GuideView() {
  const { t, pick } = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const [data, setData] = useState<{ countries: Array<{ country: string; version: number }>; guide: Guide | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requested = (params.get("country") ?? "").toUpperCase();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/creatives/guide?country=${encodeURIComponent(requested)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("load failed"); return response.json() as Promise<{ countries: Array<{ country: string; version: number }>; guide: Guide | null }>; })
      .then((result) => {
        // Without a country, open the first one that has a guide.
        if (!requested && result.countries[0]) { router.replace(`/creatives/guide?country=${result.countries[0].country}`); return; }
        setData(result);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "load failed"); });
    return () => controller.abort();
  }, [requested, router]);

  const guide = data?.guide ?? null;
  const byId = new Map((guide?.evidence.creatives ?? []).map((item) => [item.videoId, item]));
  const examples = (ids: string[]) => ids.length ? (
    <p className="text-xs text-muted-foreground">{t("例子：", "Examples: ")}{ids.map((id, index) => { const item = byId.get(id); return <span key={id}>{index ? t("、", ", ") : ""}{item?.fileName ?? id}{item ? `（${formatMoney(item.spend)} · ${formatMoney(item.cpr)}/${t("注册", "reg")}）` : ""}</span>; })}</p>
  ) : null;
  const patternCard = (item: Pattern) => (
    <Card className="border-white/8 bg-card/80 shadow-none" key={item.id}>
      <CardHeader className="pb-2"><CardTitle className="text-base"><span className="mr-2 font-mono text-sm text-primary">{item.id}</span>{pick(item, "title")}</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm leading-6">
        <p>{pick(item, "description")}</p>
        <p className="text-muted-foreground"><span className="text-foreground/80">{t("为什么有效：", "Why it works: ")}</span>{pick(item, "why")}</p>
        <p className="text-muted-foreground"><span className="text-foreground/80">{t("怎么用：", "How to apply: ")}</span>{pick(item, "how_to_apply")}</p>
        {examples(item.example_video_ids)}
      </CardContent>
    </Card>
  );

  return (
    <>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <Link className="font-mono text-[11px] uppercase tracking-[0.15em] text-primary hover:underline" href="/creatives">Creatives / Guide</Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">{t("分国家素材指南", "Creative guide by country")}</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground sm:text-base">{t("只用每个国家最近 30 天花费前 10 的常规素材写成，看的是投放规模和注册成本，不是自然播放。数字由程序计算，文字由 Agent 归纳。", "Written only from each country's top 10 regular creatives by 30-day spend: it is about delivery scale and registration cost, not organic views. Numbers are computed by the program; the text is written by the Agent.")}</p>
        </div>
        {data?.countries.length ? (
          <Select onValueChange={(next) => router.push(`/creatives/guide?country=${next}`)} value={requested || undefined}>
            <SelectTrigger className="h-10 w-44 border-white/10 bg-white/[0.025]"><SelectValue placeholder={t("选择国家", "Country")} /></SelectTrigger>
            <SelectContent>{data.countries.map((item) => <SelectItem key={item.country} value={item.country}>{item.country} · v{item.version}</SelectItem>)}</SelectContent>
          </Select>
        ) : null}
      </div>

      {error ? <p className="text-sm text-[#ff8a76]">{t("暂时无法读取素材指南", "Could not load the guide")}：{error}</p> : !data ? <Skeleton className="h-96 w-full" /> : !guide ? (
        <Empty className="min-h-[40vh] border-white/8"><EmptyHeader><EmptyMedia variant="icon"><BookOpenText /></EmptyMedia><EmptyTitle>{t("这个国家还没有素材指南", "No guide for this country yet")}</EmptyTitle><EmptyDescription>{t("每天同步素材后，系统会分析各国花费前 10 的素材，全部分析完就生成指南。", "After each daily sync the top 10 creatives per country are analyzed; the guide is written once they are all done.")}</EmptyDescription></EmptyHeader></Empty>
      ) : (
        <div className="space-y-5">
          <Card className="border-white/8 bg-card/80 shadow-none">
            <CardHeader className="border-b border-white/8 pb-5">
              <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-lg">{guide.country} · v{guide.version}</CardTitle><Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{guide.createdAt.slice(0, 10)}</Badge></div>
              <CardDescription className="mt-1">{t(`样本：${guide.evidence.creatives.length} 支素材，占该国 30 天花费 ${formatMoney(guide.evidence.countrySpend)} 中的 ${pct(guide.evidence.creatives.reduce((sum, item) => sum + item.spendShare, 0))}`, `Sample: ${guide.evidence.creatives.length} creatives, ${pct(guide.evidence.creatives.reduce((sum, item) => sum + item.spendShare, 0))} of the country's ${formatMoney(guide.evidence.countrySpend)} 30-day spend`)}</CardDescription>
            </CardHeader>
            <CardContent className="pt-5"><p className="text-sm leading-7">{pick(guide.document, "summary")}</p></CardContent>
          </Card>
          <section className="space-y-3"><h2 className="flex items-center gap-2 text-lg font-semibold"><Target className="size-4 text-primary" />{t("能跑量的共性", "What scales")}</h2>{guide.document.scale_patterns.map(patternCard)}</section>
          {guide.document.efficiency_patterns.length ? <section className="space-y-3"><h2 className="flex items-center gap-2 text-lg font-semibold"><Gauge className="size-4 text-cyan-200" />{t("注册成本更低的差异", "What brings cheaper registrations")}</h2>{guide.document.efficiency_patterns.map(patternCard)}</section> : null}
          {guide.document.cautions.length ? <section className="space-y-3"><h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldAlert className="size-4 text-[#ff8a76]" />{t("跑量但成本高：别照抄", "High spend, costly registrations: don't copy")}</h2>{guide.document.cautions.map((item, index) => (
            <Card className="border-white/8 bg-card/80 shadow-none" key={index}><CardContent className="space-y-2 pt-5 text-sm leading-6"><p className="font-medium">{pick(item, "title")}</p><p className="text-muted-foreground">{pick(item, "description")}</p>{examples(item.example_video_ids)}</CardContent></Card>
          ))}</section> : null}
          <Card className="border-white/8 bg-card/80 shadow-none">
            <CardHeader className="border-b border-white/8 pb-4"><CardTitle className="text-base">{t("样本素材（最近 30 天）", "Sample creatives (last 30 days)")}</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto pt-4">
              <table className="w-full text-sm">
                <thead><tr className="text-xs text-muted-foreground"><th className="py-1 text-left font-normal">{t("素材", "Creative")}</th><th className="text-right font-normal">{t("花费占比", "Spend share")}</th><th className="text-right font-normal">{t("花费", "Spend")}</th><th className="text-right font-normal">{t("注册", "Regs")}</th><th className="text-right font-normal">{t("注册成本", "Cost/reg")}</th><th className="text-right font-normal">CPI</th><th className="text-right font-normal">CTR</th></tr></thead>
                <tbody>{guide.evidence.creatives.map((item) => (
                  <tr className="border-t border-white/6" key={item.videoId}>
                    <td className="max-w-[320px] truncate py-1.5" title={item.summaryZh}>{item.fileName ?? item.videoId}</td>
                    <td className="text-right font-mono">{pct(item.spendShare)}</td><td className="text-right font-mono">{formatMoney(item.spend)}</td><td className="text-right font-mono">{item.registrations.toLocaleString("en-US")}</td>
                    <td className="text-right font-mono">{formatMoney(item.cpr)}</td><td className="text-right font-mono">{formatMoney(item.cpi)}</td><td className="text-right font-mono">{pct(item.ctr)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </CardContent>
          </Card>
          <p className="text-xs leading-5 text-muted-foreground">{pick(guide.document, "sample_caveat")}</p>
        </div>
      )}
    </>
  );
}
