"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Clock3, Flame, Radio, WifiOff } from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { RelativeTime } from "@/components/content-lab/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { compactNumber, emptyDashboard, percentChange, type DashboardData } from "@/lib/content-lab";

const chartConfig = {
  views: { label: "新增 VV", color: "var(--chart-2)" },
} satisfies ChartConfig;

export default function OverviewPage() {
  const [data, setData] = useState<DashboardData>(emptyDashboard);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch("/api/dashboard", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("dashboard unavailable");
        return response.json() as Promise<DashboardData>;
      })
      .then(setData)
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => setLoading(false));
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  if (error) return <div role="alert" className="py-20 text-center text-muted-foreground">暫時無法讀取總覽，請重新整理頁面。</div>;

  const change = percentChange(data.totals.views7d, data.totals.viewsPrevious7d);
  const workerOnline = data.worker.connected;

  return (
    <>
      <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-primary">
            <span className="inline-block h-px w-7 bg-primary" />
            TikTok content signals
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">內容動能總覽</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">看本週新增播放、正在加速的帖子，以及需要你注意的信號。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={workerOnline ? "border-primary/20 bg-primary/8 text-primary" : "border-white/10 bg-white/[0.03] text-muted-foreground"} variant="outline">
            {workerOnline ? <Radio /> : <WifiOff />}
            {workerOnline ? <>本機同步 · <RelativeTime value={data.worker.lastSeenAt} /></> : "等待本機 worker"}
          </Badge>
        </div>
      </div>

      {!loading && data.movers.length === 0 ? <div className="mb-5 rounded-xl border border-white/10 p-5 text-sm text-muted-foreground">尚未追蹤真實帖子。<Link className="ml-2 text-primary hover:underline" href="/bind">匯入 Excel／CSV 或貼上 TikTok 網址</Link></div> : null}
      <section aria-label="關鍵指標" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard detail={`前 7 天 ${compactNumber(data.totals.viewsPrevious7d)}`} label="7 天新增 VV" loading={loading} signal={change == null ? "新窗口" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`} value={compactNumber(data.totals.views7d)} />
        <MetricCard detail="目前按帖齡排程" label="活躍追蹤" loading={loading} signal={`${data.totals.activePosts} 條`} value={compactNumber(data.totals.activePosts)} />
        <MetricCard detail="本週發布帖子" label="破 1M 帖子" loading={loading} signal="里程碑" value={compactNumber(data.totals.millionPostsThisWeek)} />
        <MetricCard detail={`${data.totals.runningJobs} 個執行中`} label="待處理任務" loading={loading} signal={data.totals.queuedJobs > 0 ? "待處理" : "已清空"} value={compactNumber(data.totals.queuedJobs)} warning={data.totals.queuedJobs > 0} />
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,.75fr)]">
        <Card className="overflow-hidden border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-lg">播放動能</CardTitle>
                <CardDescription className="mt-1">最近 7 天的新增 VV；缺失時段不補 0</CardDescription>
              </div>
              <Badge className="border-cyan-300/15 bg-cyan-300/8 text-cyan-200" variant="outline">週新增口徑</Badge>
            </div>
          </CardHeader>
          <CardContent className="px-3 pb-2 pt-6 sm:px-6">
            {loading ? <Skeleton className="h-[280px] w-full" /> : !data.trend.length ? <div className="grid h-[280px] place-items-center text-sm text-muted-foreground">等待採集快照；尚無歷史曲線</div> : (
              <ChartContainer className="h-[280px] w-full aspect-auto" config={chartConfig}>
                <AreaChart data={data.trend} margin={{ left: 0, right: 12, top: 12, bottom: 4 }}>
                  <defs>
                    <linearGradient id="viewsFill" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-views)" stopOpacity={0.38} />
                      <stop offset="100%" stopColor="var(--color-views)" stopOpacity={0.015} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 6" vertical={false} />
                  <XAxis axisLine={false} dataKey="at" minTickGap={38} tickFormatter={(value) => new Date(value).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" })} tickLine={false} />
                  <YAxis axisLine={false} tickFormatter={(value) => compactNumber(Number(value))} tickLine={false} width={46} />
                  <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => payload?.[0]?.payload?.at ? new Date(payload[0].payload.at).toLocaleString("zh-TW") : ""} />} />
                  <Area dataKey="views" fill="url(#viewsFill)" stroke="var(--color-views)" strokeWidth={2.25} type="monotone" />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5">
            <CardTitle className="text-lg">24h Top movers</CardTitle>
            <CardDescription>增速最快的帖子</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-white/8">
              {!data.movers.length ? <p className="p-6 text-sm text-muted-foreground">目前沒有已採集的帖子。</p> : null}
              {data.movers.slice(0, 5).map((post, index) => (
                <Link className="group flex items-center gap-4 px-6 py-[18px] transition hover:bg-white/[0.025]" href={`/posts/${post.id}`} key={post.id}>
                  <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium group-hover:text-primary">{post.creatorHandle ?? "等待創作者資料"}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">{post.market} · 累計 {compactNumber(post.views)}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm font-semibold text-cyan-200">+{compactNumber(post.delta24h)}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">24 小時</p>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5">
            <CardTitle className="text-lg">最近信號</CardTitle>
            <CardDescription>里程碑、加速與運維事件</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {data.recentAlerts.length ? data.recentAlerts.slice(0, 5).map((alert) => {
              const payload = alert.payload;
              return (
                <div className="flex flex-col gap-4 border-b border-white/8 px-6 py-5 last:border-0 sm:flex-row sm:items-center" key={alert.id}>
                  <div className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[#ff715b]/12 text-[#ff8a76]"><Flame className="size-5" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{String(payload.creatorHandle ?? "內容信號")}</p>
                      <Badge className="border-[#ff715b]/20 bg-[#ff715b]/10 text-[#ff9c8d]" variant="outline">{alert.rule.replaceAll("_", " ")}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">目前 {compactNumber(Number(payload.currentViews ?? 0))} · 最新增量 +{compactNumber(Number(payload.delta ?? 0))}</p>
                  </div>
                  <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"><Clock3 className="size-3.5" /><RelativeTime value={alert.firedAt} /></div>
                </div>
              );
            }) : <div className="px-6 py-12 text-center text-sm text-muted-foreground">目前沒有新報警。</div>}
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5">
            <CardTitle className="text-lg">市場拆分</CardTitle>
            <CardDescription>按 7 天新增 VV</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            {data.marketBreakdown.map((market) => {
              const share = data.totals.views7d ? (market.views / data.totals.views7d) * 100 : 0;
              return (
                <div key={market.market}>
                  <div className="mb-2 flex items-end justify-between gap-3">
                    <div><p className="font-mono text-sm font-semibold">{market.market}</p><p className="mt-1 text-xs text-muted-foreground">{market.posts} 條帖子</p></div>
                    <div className="text-right"><p className="font-mono text-sm">{compactNumber(market.views)}</p><p className="mt-1 text-xs text-muted-foreground">{share.toFixed(1)}%</p></div>
                  </div>
                  <Progress className="h-1.5 bg-white/[0.06] [&>div]:bg-primary" value={Math.min(100, share)} />
                </div>
              );
            })}
            <div className="rounded-lg border border-white/8 bg-white/[0.025] p-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground"><Activity className="size-4 text-primary" /><span className="font-medium">採集成功率</span></div>
              <p className="mt-2">{data.totals.captureSuccessRate24h == null ? "等待第一批快照" : `最近 24 小時 ${data.totals.captureSuccessRate24h.toFixed(1)}%`}</p>
            </div>
          </CardContent>
        </Card>
      </section>

      {!workerOnline ? (
        <section className="mt-4 flex flex-col gap-4 rounded-xl border border-primary/15 bg-primary/[0.045] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <p className="font-medium">網站已就緒，等待你的 Mac 開始同步</p>
            <p className="mt-1 text-sm text-muted-foreground">本機 worker 只做出站連線；啟動後會接走綁定任務並回傳數據。</p>
          </div>
          <Button asChild variant="outline"><Link href="/bind">先綁定測試帖子</Link></Button>
        </section>
      ) : null}
    </>
  );
}

function MetricCard({ label, value, signal, detail, loading, warning = false }: { label: string; value: string; signal: string; detail: string; loading: boolean; warning?: boolean }) {
  return (
    <Card className="gap-4 border-white/8 bg-card/80 py-5 shadow-none">
      <CardHeader className="gap-0 px-5"><CardDescription className="font-mono text-[10px] uppercase tracking-[0.13em]">{label}</CardDescription></CardHeader>
      <CardContent className="px-5">
        {loading ? <><Skeleton className="h-8 w-28" /><Skeleton className="mt-3 h-3 w-36" /></> : <>
          <div className="flex items-end justify-between gap-3">
            <p className="text-[32px] font-semibold leading-none tracking-[-0.05em]">{value}</p>
            <Badge className={warning ? "border-[#ff715b]/20 bg-[#ff715b]/8 text-[#ff9c8d]" : "border-primary/20 bg-primary/8 text-primary"} variant="outline">{signal}</Badge>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{detail}</p>
        </>}
      </CardContent>
    </Card>
  );
}
