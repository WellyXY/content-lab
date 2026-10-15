"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpenText, History, ShieldAlert, Target, TrendingUp } from "lucide-react";

import { formatMoney } from "@/lib/ads";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { MARKETS, compactNumber, type PlaybookData, type PlaybookPattern, type PlaybookSummary } from "@/lib/content-lab";
import { useLocale } from "@/lib/i18n";

type Response = { market: string; playbook: PlaybookData | null; history: PlaybookSummary[]; markets: Array<{ market: string; version: number }> };

const CHANGE_LABELS: Record<string, [string, string]> = {
  new: ["新增", "New"], strengthened: ["增强", "Stronger"], weakened: ["减弱", "Weaker"], retired: ["移除", "Retired"], first_version: ["首版", "First version"],
};
const pct = (value: number): string => `${Math.round(value * 100)}%`;

export default function PlaybookPage() {
  return <Suspense fallback={<Skeleton className="h-96 w-full" />}><PlaybookView /></Suspense>;
}

function PlaybookView() {
  const { t, pick, lang } = useLocale();
  const params = useSearchParams();
  const router = useRouter();
  const market = (params.get("market") ?? "TR").toUpperCase();
  const version = params.get("version");
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    fetch(`/api/playbooks?market=${encodeURIComponent(market)}${version ? `&version=${encodeURIComponent(version)}` : ""}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "load failed"); return response.json() as Promise<Response>; })
      .then(setData)
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "load failed"); });
    return () => controller.abort();
  }, [market, version]);

  const playbook = data?.playbook ?? null;
  const registrations = playbook?.evidence.outcome === "registrations";
  const statLine = (key: string): string | null => {
    if (!playbook) return null;
    const { evidence } = playbook;
    const row = evidence.stats.find((item) => item.key === key);
    if (row && registrations) {
      const label = lang === "en" && row.labelEn ? row.labelEn : row.label;
      return t(
        `${label} — 低注册成本组 ${row.topPosts}/${evidence.topSize}（${pct(row.topShare)}），高注册成本组 ${row.bottomPosts}/${evidence.bottomSize}（${pct(row.bottomShare)}），这 ${row.posts} 条的注册成本中位数 ${money(row.medianCpr)}`,
        `${label} — cheapest-registration tier ${row.topPosts}/${evidence.topSize} (${pct(row.topShare)}), costliest tier ${row.bottomPosts}/${evidence.bottomSize} (${pct(row.bottomShare)}); median cost per registration of these ${row.posts} posts: ${money(row.medianCpr)}`,
      );
    }
    if (row) {
      const label = lang === "en" && row.labelEn ? row.labelEn : row.label;
      return t(
        `${label} — 高播放组 ${row.topPosts}/${evidence.topSize}（${pct(row.topShare)}），低播放组 ${row.bottomPosts}/${evidence.bottomSize}（${pct(row.bottomShare)}），这 ${row.posts} 条的播放中位数 ${compactNumber(row.medianViews)}`,
        `${label} — top tier ${row.topPosts}/${evidence.topSize} (${pct(row.topShare)}), bottom tier ${row.bottomPosts}/${evidence.bottomSize} (${pct(row.bottomShare)}); median views of these ${row.posts} posts: ${compactNumber(row.medianViews)}`,
      );
    }
    const numeric = evidence.numeric.find((item) => item.key === key);
    if (!numeric) return null;
    const label = lang === "en" && numeric.labelEn ? numeric.labelEn : numeric.label;
    if (registrations) return t(`${label} — 低注册成本组中位数 ${numeric.topMedian ?? "—"}，高注册成本组中位数 ${numeric.bottomMedian ?? "—"}`, `${label} — cheapest-tier median ${numeric.topMedian ?? "—"}, costliest-tier median ${numeric.bottomMedian ?? "—"}`);
    return t(`${label} — 高播放组中位数 ${numeric.topMedian ?? "—"}，低播放组中位数 ${numeric.bottomMedian ?? "—"}`, `${label} — top-tier median ${numeric.topMedian ?? "—"}, bottom-tier median ${numeric.bottomMedian ?? "—"}`);
  };
  const questions = playbook ? (playbook.document.open_questions ?? (playbook.document.open_questions_zh ?? []).map((question) => ({ zh: question, en: question }))) : [];

  return (
    <>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-primary"><span className="inline-block h-px w-7 bg-primary" />Viral playbook</div>
          <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">{t("爆款共性文档", "Viral playbook")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">{t("投放证据足够的市场以注册成本为准，归纳带来便宜注册的内容共性；其余市场暂用播放量。每周更新一版。", "Where there is enough Spark Ads evidence, patterns behind the posts that bring the cheapest registrations; other markets use views for now. A new version every week.")}</p>
        </div>
        <Select onValueChange={(next) => router.push(`/playbook?market=${next}`)} value={market}>
          <SelectTrigger className="h-10 w-48 border-white/10 bg-white/[0.025]"><SelectValue /></SelectTrigger>
          <SelectContent>{MARKETS.map((item) => <SelectItem key={item.code} value={item.code}>{item.code} {t(item.label, item.labelEn)}{data?.markets.some((entry) => entry.market === item.code) ? "" : t("（尚无文档）", " (none yet)")}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {error ? <p className="text-sm text-[#ff8a76]">{t("暂时无法读取爆款共性文档", "Could not load the playbook")}：{error}</p> : !data ? <Skeleton className="h-96 w-full" /> : !playbook ? (
        <Empty className="min-h-[40vh] border-white/8"><EmptyHeader><EmptyMedia variant="icon"><BookOpenText /></EmptyMedia><EmptyTitle>{t(`${market} 还没有爆款共性文档`, `${market} has no playbook yet`)}</EmptyTitle><EmptyDescription>{t("这个市场累计至少 10 条发布满 2 天、已分析且有播放数据的帖子后，系统会自动生成第一版。", "The first version is generated automatically once the market has 10 analyzed posts with views that are at least 2 days old.")}</EmptyDescription></EmptyHeader></Empty>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4">
            <Card className="border-white/8 bg-card/80 shadow-none">
              <CardHeader className="border-b border-white/8 pb-5">
                <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-lg">{market} · v{playbook.version}</CardTitle><Badge className={registrations ? "border-primary/25 bg-primary/10 text-primary" : "border-white/10 bg-white/[0.03] text-muted-foreground"} variant="outline">{registrations ? t("以注册成本为准", "By cost per registration") : t("以播放量为准（投放证据不足）", "By views (not enough ads evidence yet)")}</Badge><Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{t("周起始", "Week of")} {playbook.weekStart.slice(0, 10)}</Badge></div>
                <CardDescription className="mt-1">{registrations ? t(
                  `样本 ${playbook.evidence.eligiblePosts} 条有足够投放数据的帖子（花费 ≥ $50 且注册 ≥ 30），按同形式比较：低注册成本组 ${playbook.evidence.topSize} 条（≤ ${money(playbook.evidence.topMaxCpr)}），高注册成本组 ${playbook.evidence.bottomSize} 条，中位数 ${money(playbook.evidence.medianCpr)}。另有 ${playbook.evidence.insufficientPosts ?? 0} 条证据不足，未计入，不算失败。数字由程序计算，文字由 Agent 归纳。`,
                  `${playbook.evidence.eligiblePosts} posts with enough Spark Ads evidence (spend ≥ $50 and ≥ 30 registrations), compared within format: cheapest tier ${playbook.evidence.topSize} (≤ ${money(playbook.evidence.topMaxCpr)}), costliest tier ${playbook.evidence.bottomSize}, median ${money(playbook.evidence.medianCpr)}. ${playbook.evidence.insufficientPosts ?? 0} more have too little evidence and are left out, not counted as failures. Numbers are computed by the program; the text is written by the Agent.`,
                ) : t(
                  `样本 ${playbook.evidence.eligiblePosts} 条：高播放组 ${playbook.evidence.topSize} 条（≥ ${compactNumber(playbook.evidence.topMinViews)}），低播放组 ${playbook.evidence.bottomSize} 条，整体中位数 ${compactNumber(playbook.evidence.medianViews)}。数字由程序计算，文字由 Agent 归纳。`,
                  `Sample of ${playbook.evidence.eligiblePosts} posts: top tier ${playbook.evidence.topSize} (≥ ${compactNumber(playbook.evidence.topMinViews)} views), bottom tier ${playbook.evidence.bottomSize}, overall median ${compactNumber(playbook.evidence.medianViews)}. Numbers are computed by the program; the text is written by the Agent.`,
                )}</CardDescription>
              </CardHeader>
              <CardContent className="pt-5"><p className="text-sm leading-7">{pick(playbook.document, "summary")}</p></CardContent>
            </Card>

            <Section icon={Target} title={t("爆款共性", "Patterns")} tone="text-primary">{playbook.document.patterns.map((item) => <PatternCard item={item} key={item.id} playbook={playbook} statLine={statLine} />)}</Section>
            <Section icon={ShieldAlert} title={t("反模式", "Anti-patterns")} tone="text-[#ff8a76]">{playbook.document.anti_patterns.map((item) => <PatternCard item={item} key={item.id} playbook={playbook} statLine={statLine} />)}</Section>

            {playbook.document.exceptions?.length ? <Card className="border-white/8 bg-card/80 shadow-none">
              <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">{t("和规律不符的例外", "Exceptions to the patterns")}</CardTitle><CardDescription>{t("高播放不等于高注册：这些帖子说明了规律的边界", "High views are not registrations: these posts mark where the patterns stop")}</CardDescription></CardHeader>
              <CardContent className="space-y-3 pt-5">{playbook.document.exceptions.map((item, index) => <div className="text-sm leading-6" key={index}><Badge className="mr-2 border-amber-300/20 bg-amber-300/8 text-amber-200" variant="outline">{t(...(EXCEPTION_LABELS[item.kind] ?? [item.kind, item.kind]))}</Badge>{lang === "en" ? item.en || item.zh : item.zh}{item.post_ids.length ? <span className="ml-1 text-xs text-muted-foreground">（{item.post_ids.map((id, position) => { const post = playbook.evidence.posts.find((entry) => entry.id === id); return <span key={id}>{position ? t("、", ", ") : ""}<Link className="text-primary hover:underline" href={`/posts/${id}`}>{post ? (registrations ? `${money(post.cpr)} · ${compactNumber(post.views)}` : compactNumber(post.views)) : id.slice(0, 8)}</Link></span>; })}）</span> : null}</div>)}</CardContent>
            </Card> : null}

            <Card className="border-white/8 bg-card/80 shadow-none">
              <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="flex items-center gap-2 text-lg"><TrendingUp className="size-4 text-cyan-200" />{t("本周变化", "This week's changes")}</CardTitle></CardHeader>
              <CardContent className="space-y-2 pt-5">{playbook.document.weekly_changes.map((change, index) => <p className="text-sm leading-6" key={index}><Badge className="mr-2 border-cyan-300/15 bg-cyan-300/8 text-cyan-200" variant="outline">{t(...(CHANGE_LABELS[change.type] ?? [change.type, change.type]))}</Badge>{change.pattern_id !== "-" ? <span className="mr-2 font-mono text-xs text-muted-foreground">{change.pattern_id}</span> : null}{pick(change, "change")}</p>)}</CardContent>
            </Card>

            {questions.length ? <Card className="border-white/8 bg-card/80 shadow-none"><CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">{t("待验证", "Open questions")}</CardTitle></CardHeader><CardContent className="pt-5"><ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">{questions.map((question, index) => <li key={index}>{question[lang] || question.zh}</li>)}</ul></CardContent></Card> : null}
            <p className="text-xs leading-5 text-muted-foreground">{pick(playbook.document, "sample_caveat")}</p>
          </div>

          <Card className="h-fit border-white/8 bg-card/80 shadow-none">
            <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="flex items-center gap-2 text-lg"><History className="size-4" />{t("历史版本", "Versions")}</CardTitle></CardHeader>
            <CardContent className="space-y-1 pt-4">{data.history.map((item) => <Link className={`flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-white/[0.04] ${item.version === playbook.version ? "bg-primary/8 text-primary" : "text-muted-foreground"}`} href={`/playbook?market=${market}&version=${item.version}`} key={item.id}><span>v{item.version}</span><span className="font-mono text-xs">{item.weekStart.slice(0, 10)}</span></Link>)}</CardContent>
          </Card>
        </div>
      )}
    </>
  );
}

function Section({ icon: Icon, title, tone, children }: { icon: typeof Target; title: string; tone: string; children: React.ReactNode }) {
  return <section className="space-y-3"><h2 className="flex items-center gap-2 text-lg font-semibold"><Icon className={`size-4 ${tone}`} />{title}</h2>{children}</section>;
}

function PatternCard({ item, playbook, statLine }: { item: PlaybookPattern; playbook: PlaybookData; statLine: (key: string) => string | null }) {
  const { t, pick, lang } = useLocale();
  const why = pick(item, "why_it_works");
  const how = pick(item, "how_to_apply");
  return <Card className="border-white/8 bg-card/80 shadow-none">
    <CardHeader className="pb-3"><CardTitle className="text-base"><span className="mr-2 font-mono text-sm text-primary">{item.id}</span>{pick(item, "title")}</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm leading-6">
      <p>{pick(item, "description")}</p>
      {why ? <p className="text-muted-foreground"><span className="mr-1 text-foreground/80">{t("为什么有效：", "Why it works: ")}</span>{why}</p> : null}
      {how ? <p className="text-muted-foreground"><span className="mr-1 text-foreground/80">{t("怎么用：", "How to apply: ")}</span>{how}</p> : null}
      <ul className="space-y-1 rounded-md border border-white/8 bg-white/[0.02] p-3 font-mono text-[11px] leading-5 text-muted-foreground">{item.stat_keys.map((key) => { const line = statLine(key); return line ? <li key={key}>{line}</li> : null; })}</ul>
      {item.example_post_ids.length ? <p className="text-xs text-muted-foreground">{t("案例：", "Examples: ")}{item.example_post_ids.map((id, index) => { const post = playbook.evidence.posts.find((entry) => entry.id === id); return <span key={id}>{index ? t("、", ", ") : ""}{post ? <>{(lang === "en" ? post.formulaEn : post.formulaZh) || post.formulaZh || post.summaryZh.slice(0, 30)}（{post.cpr !== undefined ? `${money(post.cpr)}/${t("注册", "reg")}` : compactNumber(post.views)}）</> : id.slice(0, 8)}</span>; })}</p> : null}
    </CardContent>
  </Card>;
}

const EXCEPTION_LABELS: Record<string, [string, string]> = {
  high_views_low_registrations: ["高播放、注册差", "High views, weak registrations"], low_views_good_registrations: ["低播放、注册好", "Low views, strong registrations"],
  copy_failed: ["照抄失败", "Copy that failed"], other: ["其他例外", "Other exception"],
};
const money = (value: number | null | undefined): string => formatMoney(value ?? null);
