"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Gauge } from "lucide-react";

import { formatMoney } from "@/lib/ads";
import type { Calibration } from "@/lib/calibration";
import { useLocale } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Data = Calibration & { evaluated: number };
const rho = (value: number | null): string => value === null ? "—" : value.toFixed(2);
const FORMAT: Record<string, [string, string]> = { video: ["视频", "Video"], photo: ["图文", "Photo"] };

export default function CalibrationPage() {
  const { t } = useLocale();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/calibration", { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "load failed"); return response.json() as Promise<Data>; })
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "load failed"));
  }, []);

  return (
    <>
      <div className="mb-6">
        <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-primary"><span className="inline-block h-px w-7 bg-primary" />Calibration</div>
        <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">{t("评分校准", "Score calibration")}</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground sm:text-base">{t("注册潜力分在评分时看不到成效，写入后不再修改。投放数据到了之后，在同市场、同形式、证据足够的帖子之间比较：分数排名和实际注册成本排名是否一致。这里只记录准确度，不会改动任何帖子的分数。", "Registration potential is scored blind and frozen when written. Once Spark Ads data arrives, posts of the same market and format with enough evidence are compared: does the score ranking match the cost-per-registration ranking? This page only records accuracy; it never changes a post's score.")}</p>
      </div>
      {error ? <p className="text-sm text-[#ff8a76]">{t("暂时无法读取校准数据", "Could not load calibration")}：{error}</p> : !data ? <Skeleton className="h-96 w-full" /> : data.graded === 0 ? (
        <Empty className="min-h-[40vh] border-white/8"><EmptyHeader><EmptyMedia variant="icon"><Gauge /></EmptyMedia><EmptyTitle>{t("还没有可以校准的帖子", "Nothing to calibrate yet")}</EmptyTitle><EmptyDescription>{t(`已评分 ${data.evaluated} 条；需要同市场、同形式至少 2 条花费 ≥ $50 且注册 ≥ 30 的帖子。`, `${data.evaluated} posts scored; calibration needs at least 2 posts of the same market and format with spend ≥ $50 and ≥ 30 registrations.`)}</EmptyDescription></EmptyHeader></Empty>
      ) : (
        <div className="space-y-4">
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label={t("已校准帖子", "Calibrated posts")} value={String(data.graded)} note={t(`另有 ${data.awaitingEvidence} 条等待足够的投放数据`, `${data.awaitingEvidence} more await enough ads evidence`)} />
            <Metric label={t("排名相关性", "Rank correlation")} value={rho(data.rho)} note={t("1 = 完全一致，0 = 无关，负数 = 相反；每组至少 5 条才计算", "1 = identical, 0 = unrelated, negative = opposite; needs 5+ posts per group")} />
            <Metric label={t("平均排名误差", "Mean rank error")} value={data.meanAbsError === null ? "—" : `${Math.round(data.meanAbsError * 100)}%`} note={t("分数排名和实际排名平均差多少个百分位", "Average gap between score and outcome percentiles")} />
            <Metric label={t("意外结果", "Surprises")} value={String(data.surprises.length)} note={t("差距超过一半排名的帖子", "Posts more than half the ranking apart")} />
          </section>

          <Card className="border-white/8 bg-card/80 shadow-none">
            <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">{t("按市场和形式", "By market and format")}</CardTitle><CardDescription>{t("创意分的相关性作为对照：好看不等于带来注册", "Creative-score correlation for contrast: watchable is not the same as registrations")}</CardDescription></CardHeader>
            <CardContent className="px-0 pb-0"><Table>
              <TableHeader><TableRow className="border-white/8 hover:bg-transparent"><TableHead className="pl-5 text-xs">{t("分组", "Group")}</TableHead><TableHead className="text-right text-xs">{t("帖子", "Posts")}</TableHead><TableHead className="text-right text-xs">{t("注册潜力相关性", "Reg. potential ρ")}</TableHead><TableHead className="text-right text-xs">{t("创意分相关性", "Creative ρ")}</TableHead><TableHead className="pr-5 text-right text-xs">{t("平均误差", "Mean error")}</TableHead></TableRow></TableHeader>
              <TableBody>{data.cohorts.map((cohort) => <TableRow className="border-white/8" key={`${cohort.market}-${cohort.postType}`}><TableCell className="pl-5 font-mono text-sm">{cohort.market} · {t(...(FORMAT[cohort.postType] ?? [cohort.postType, cohort.postType]))}</TableCell><TableCell className="text-right font-mono">{cohort.posts.length}</TableCell><TableCell className="text-right font-mono">{rho(cohort.rho)}</TableCell><TableCell className="text-right font-mono text-muted-foreground">{rho(cohort.creativeRho)}</TableCell><TableCell className="pr-5 text-right font-mono">{Math.round(cohort.meanAbsError * 100)}%</TableCell></TableRow>)}</TableBody>
            </Table></CardContent>
          </Card>

          {data.surprises.length ? <Card className="border-white/8 bg-card/80 shadow-none">
            <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">{t("意外结果", "Surprises")}</CardTitle><CardDescription>{t("值得人工复盘：分数没看出来的优点，或高估的地方", "Worth a human look: what the score missed or overrated")}</CardDescription></CardHeader>
            <CardContent className="px-0 pb-0"><Table>
              <TableHeader><TableRow className="border-white/8 hover:bg-transparent"><TableHead className="pl-5 text-xs">{t("帖子", "Post")}</TableHead><TableHead className="text-xs">{t("分组", "Group")}</TableHead><TableHead className="text-right text-xs">{t("注册潜力", "Reg. potential")}</TableHead><TableHead className="text-right text-xs">{t("注册成本", "Cost/reg")}</TableHead><TableHead className="pr-5 text-right text-xs">{t("结果", "Result")}</TableHead></TableRow></TableHeader>
              <TableBody>{data.surprises.map((post) => <TableRow className="border-white/8" key={post.id}><TableCell className="pl-5"><Link className="text-sm hover:text-primary" href={`/posts/${post.id}`}>{post.creatorHandle ? `@${post.creatorHandle}` : post.id.slice(0, 8)}</Link></TableCell><TableCell className="font-mono text-xs">{post.market} · {t(...(FORMAT[post.postType] ?? [post.postType, post.postType]))}</TableCell><TableCell className="text-right font-mono">{post.registrationPotential}/10</TableCell><TableCell className="text-right font-mono">{formatMoney(post.cpr)}</TableCell><TableCell className="pr-5 text-right"><Badge className={post.surprise === "underrated" ? "border-primary/25 bg-primary/10 text-primary" : "border-[#ff715b]/25 bg-[#ff715b]/10 text-[#ff8a76]"} variant="outline">{post.surprise === "underrated" ? t("被低估", "Underrated") : t("被高估", "Overrated")}</Badge></TableCell></TableRow>)}</TableBody>
            </Table></CardContent>
          </Card> : null}
        </div>
      )}
    </>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <Card className="gap-2 border-white/8 bg-card/80 py-4 shadow-none"><CardHeader className="px-4"><CardDescription className="font-mono text-[10px] uppercase tracking-[0.1em]">{label}</CardDescription></CardHeader><CardContent className="px-4"><p className="text-2xl font-semibold tracking-[-0.04em]">{value}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{note}</p></CardContent></Card>;
}
