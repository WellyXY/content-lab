"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpenText, History, ShieldAlert, Target, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { MARKETS, compactNumber, type PlaybookData, type PlaybookPattern, type PlaybookSummary } from "@/lib/content-lab";

type Response = { market: string; playbook: PlaybookData | null; history: PlaybookSummary[]; markets: Array<{ market: string; version: number }> };

const CHANGE_LABELS: Record<string, string> = { new: "新增", strengthened: "增強", weakened: "減弱", retired: "移除", first_version: "首版" };
const pct = (value: number): string => `${Math.round(value * 100)}%`;

export default function PlaybookPage() {
  return <Suspense fallback={<Skeleton className="h-96 w-full" />}><PlaybookView /></Suspense>;
}

function PlaybookView() {
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
      .then(async (response) => { if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "讀取失敗"); return response.json() as Promise<Response>; })
      .then(setData)
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "讀取失敗"); });
    return () => controller.abort();
  }, [market, version]);

  const playbook = data?.playbook ?? null;
  const statLine = (key: string): string | null => {
    const row = playbook?.evidence.stats.find((item) => item.key === key);
    if (row && playbook) return `${row.label} — 高播放組 ${row.topPosts}/${playbook.evidence.topSize}（${pct(row.topShare)}），低播放組 ${row.bottomPosts}/${playbook.evidence.bottomSize}（${pct(row.bottomShare)}），這 ${row.posts} 條的播放中位數 ${compactNumber(row.medianViews)}`;
    const numeric = playbook?.evidence.numeric.find((item) => item.key === key);
    return numeric ? `${numeric.label} — 高播放組中位數 ${numeric.topMedian ?? "—"}，低播放組中位數 ${numeric.bottomMedian ?? "—"}` : null;
  };

  return (
    <>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-primary"><span className="inline-block h-px w-7 bg-primary" />Viral playbook</div>
          <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">爆款共性文檔</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">從各市場已分析帖子的真實播放中，歸納高播放內容的共性；每週更新一版，新綁定的帖子都會對照它產出建議。</p>
        </div>
        <Select onValueChange={(next) => router.push(`/playbook?market=${next}`)} value={market}>
          <SelectTrigger className="h-10 w-48 border-white/10 bg-white/[0.025]"><SelectValue /></SelectTrigger>
          <SelectContent>{MARKETS.map((item) => <SelectItem key={item.code} value={item.code}>{item.code} {item.label}{data?.markets.some((entry) => entry.market === item.code) ? "" : "（尚無文檔）"}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {error ? <p className="text-sm text-[#ff8a76]">{error}</p> : !data ? <Skeleton className="h-96 w-full" /> : !playbook ? (
        <Empty className="min-h-[40vh] border-white/8"><EmptyHeader><EmptyMedia variant="icon"><BookOpenText /></EmptyMedia><EmptyTitle>{market} 還沒有爆款共性文檔</EmptyTitle><EmptyDescription>這個市場累積至少 10 條發布滿 2 天、已分析且有播放數據的帖子後，系統會自動產生第一版。</EmptyDescription></EmptyHeader></Empty>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4">
            <Card className="border-white/8 bg-card/80 shadow-none">
              <CardHeader className="border-b border-white/8 pb-5">
                <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-lg">{market} · v{playbook.version}</CardTitle><Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">週起始 {playbook.weekStart.slice(0, 10)}</Badge></div>
                <CardDescription className="mt-1">樣本 {playbook.evidence.eligiblePosts} 條：高播放組 {playbook.evidence.topSize} 條（≥ {compactNumber(playbook.evidence.topMinViews)}），低播放組 {playbook.evidence.bottomSize} 條，整體中位數 {compactNumber(playbook.evidence.medianViews)}。數字由程式計算，文字由 Agent 歸納。</CardDescription>
              </CardHeader>
              <CardContent className="pt-5"><p className="text-sm leading-7">{playbook.document.summary_zh}</p></CardContent>
            </Card>

            <Section icon={Target} title="爆款共性" tone="text-primary">{playbook.document.patterns.map((item) => <PatternCard item={item} key={item.id} playbook={playbook} statLine={statLine} />)}</Section>
            <Section icon={ShieldAlert} title="反模式" tone="text-[#ff8a76]">{playbook.document.anti_patterns.map((item) => <PatternCard item={item} key={item.id} playbook={playbook} statLine={statLine} />)}</Section>

            <Card className="border-white/8 bg-card/80 shadow-none">
              <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="flex items-center gap-2 text-lg"><TrendingUp className="size-4 text-cyan-200" />本週變化</CardTitle></CardHeader>
              <CardContent className="space-y-2 pt-5">{playbook.document.weekly_changes.map((change, index) => <p className="text-sm leading-6" key={index}><Badge className="mr-2 border-cyan-300/15 bg-cyan-300/8 text-cyan-200" variant="outline">{CHANGE_LABELS[change.type] ?? change.type}</Badge>{change.pattern_id !== "-" ? <span className="mr-2 font-mono text-xs text-muted-foreground">{change.pattern_id}</span> : null}{change.change_zh}</p>)}</CardContent>
            </Card>

            {playbook.document.open_questions_zh.length ? <Card className="border-white/8 bg-card/80 shadow-none"><CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">待驗證</CardTitle></CardHeader><CardContent className="pt-5"><ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">{playbook.document.open_questions_zh.map((question, index) => <li key={index}>{question}</li>)}</ul></CardContent></Card> : null}
            <p className="text-xs leading-5 text-muted-foreground">{playbook.document.sample_caveat_zh}</p>
          </div>

          <Card className="h-fit border-white/8 bg-card/80 shadow-none">
            <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="flex items-center gap-2 text-lg"><History className="size-4" />歷史版本</CardTitle></CardHeader>
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
  return <Card className="border-white/8 bg-card/80 shadow-none">
    <CardHeader className="pb-3"><CardTitle className="text-base"><span className="mr-2 font-mono text-sm text-primary">{item.id}</span>{item.title_zh}</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm leading-6">
      <p>{item.description_zh}</p>
      {item.why_it_works_zh ? <p className="text-muted-foreground"><span className="mr-1 text-foreground/80">為什麼有效：</span>{item.why_it_works_zh}</p> : null}
      {item.how_to_apply_zh ? <p className="text-muted-foreground"><span className="mr-1 text-foreground/80">怎麼用：</span>{item.how_to_apply_zh}</p> : null}
      <ul className="space-y-1 rounded-md border border-white/8 bg-white/[0.02] p-3 font-mono text-[11px] leading-5 text-muted-foreground">{item.stat_keys.map((key) => { const line = statLine(key); return line ? <li key={key}>{line}</li> : null; })}</ul>
      {item.example_post_ids.length ? <p className="text-xs text-muted-foreground">案例：{item.example_post_ids.map((id, index) => { const post = playbook.evidence.posts.find((entry) => entry.id === id); return <span key={id}>{index ? "、" : ""}{post ? <>{post.formulaZh || post.summaryZh.slice(0, 30)}（{compactNumber(post.views)}）</> : id.slice(0, 8)}</span>; })}</p> : null}
    </CardContent>
  </Card>;
}
