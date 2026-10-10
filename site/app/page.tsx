"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Clock3, Flame, Radio, WifiOff } from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { MarketAdsPanel } from "@/components/content-lab/ads-panels";
import { RelativeTime } from "@/components/content-lab/relative-time";
import { useLocale } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { compactNumber, emptyDashboard, percentChange, type DashboardData } from "@/lib/content-lab";

export default function OverviewPage() {
  const { t } = useLocale();
  const chartConfig = { views: { label: t("新增 VV", "New views"), color: "var(--chart-2)" } } satisfies ChartConfig;
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

  if (error) return <div role="alert" className="py-20 text-center text-muted-foreground">{t("暂时无法读取总览，请刷新页面。", "Could not load the overview; refresh the page.")}</div>;

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
          <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">{t("内容动能总览", "Content momentum")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">{t("看本周新增播放、正在加速的帖子，以及需要你注意的信号。", "This week's new views, the posts that are accelerating, and the signals that need you.")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={workerOnline ? "border-primary/20 bg-primary/8 text-primary" : "border-white/10 bg-white/[0.03] text-muted-foreground"} variant="outline">
            {workerOnline ? <Radio /> : <WifiOff />}
            {workerOnline ? <>{t("本机同步", "Local sync")} · <RelativeTime value={data.worker.lastSeenAt} /></> : t("等待本机 worker", "Waiting for the local worker")}
          </Badge>
        </div>
      </div>

      {!loading && data.movers.length === 0 ? <div className="mb-5 rounded-xl border border-white/10 p-5 text-sm text-muted-foreground">{t("尚未追踪真实帖子。", "No posts are tracked yet.")}<Link className="ml-2 text-primary hover:underline" href="/bind">{t("导入 Excel／CSV 或粘贴 TikTok 链接", "Import Excel/CSV or paste TikTok links")}</Link></div> : null}
      <section aria-label={t("关键指标", "Key metrics")} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard detail={t(`前 7 天 ${compactNumber(data.totals.viewsPrevious7d)}`, `Previous 7d ${compactNumber(data.totals.viewsPrevious7d)}`)} label={t("7 天新增 VV", "New views (7d)")} loading={loading} signal={change == null ? t("新窗口", "New window") : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`} value={compactNumber(data.totals.views7d)} />
        <MetricCard detail={t("按帖龄排程", "Scheduled by post age")} label={t("活跃追踪", "Tracked")} loading={loading} signal={t(`${data.totals.activePosts} 条`, `${data.totals.activePosts} posts`)} value={compactNumber(data.totals.activePosts)} />
        <MetricCard detail={t("本周发布的帖子", "Published this week")} label={t("破 1M 帖子", "1M+ posts")} loading={loading} signal={t("里程碑", "Milestone")} value={compactNumber(data.totals.millionPostsThisWeek)} />
        <MetricCard detail={t(`${data.totals.runningJobs} 个执行中`, `${data.totals.runningJobs} running`)} label={t("待处理任务", "Queued jobs")} loading={loading} signal={data.totals.queuedJobs > 0 ? t("待处理", "Pending") : t("已清空", "Clear")} value={compactNumber(data.totals.queuedJobs)} warning={data.totals.queuedJobs > 0} />
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,.75fr)]">
        <Card className="overflow-hidden border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-lg">{t("播放动能", "View momentum")}</CardTitle>
                <CardDescription className="mt-1">{t("最近 7 天的新增 VV；缺失时段不补 0", "New views over the last 7 days; missing hours are not filled with 0")}</CardDescription>
              </div>
              <Badge className="border-cyan-300/15 bg-cyan-300/8 text-cyan-200" variant="outline">{t("周新增口径", "Weekly new views")}</Badge>
            </div>
          </CardHeader>
          <CardContent className="px-3 pb-2 pt-6 sm:px-6">
            {loading ? <Skeleton className="h-[280px] w-full" /> : !data.trend.length ? <div className="grid h-[280px] place-items-center text-sm text-muted-foreground">{t("等待采集快照；尚无历史曲线", "Waiting for snapshots; no history yet")}</div> : (
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
            <CardDescription>{t("增速最快的帖子", "Fastest-growing posts")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-white/8">
              {!data.movers.length ? <p className="p-6 text-sm text-muted-foreground">{t("目前没有已采集的帖子。", "No captured posts yet.")}</p> : null}
              {data.movers.slice(0, 5).map((post, index) => (
                <Link className="group flex items-center gap-4 px-6 py-[18px] transition hover:bg-white/[0.025]" href={`/posts/${post.id}`} key={post.id}>
                  <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium group-hover:text-primary">{post.creatorHandle ?? t("等待创作者资料", "Waiting for creator data")}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">{post.market} · {t("累计", "total")} {compactNumber(post.views)}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm font-semibold text-cyan-200">+{compactNumber(post.delta24h)}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">{t("24 小时", "24h")}</p>
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
            <CardTitle className="text-lg">{t("最近信号", "Recent signals")}</CardTitle>
            <CardDescription>{t("里程碑、加速与运维事件", "Milestones, acceleration and operations")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {data.recentAlerts.length ? data.recentAlerts.slice(0, 5).map((alert) => {
              const payload = alert.payload;
              return (
                <div className="flex flex-col gap-4 border-b border-white/8 px-6 py-5 last:border-0 sm:flex-row sm:items-center" key={alert.id}>
                  <div className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[#ff715b]/12 text-[#ff8a76]"><Flame className="size-5" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{String(payload.creatorHandle ?? t("内容信号", "Content signal"))}</p>
                      <Badge className="border-[#ff715b]/20 bg-[#ff715b]/10 text-[#ff9c8d]" variant="outline">{alert.rule.replaceAll("_", " ")}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{t("目前", "Now")} {compactNumber(Number(payload.currentViews ?? 0))} · {t("最新增量", "latest delta")} +{compactNumber(Number(payload.delta ?? 0))}</p>
                  </div>
                  <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"><Clock3 className="size-3.5" /><RelativeTime value={alert.firedAt} /></div>
                </div>
              );
            }) : <div className="px-6 py-12 text-center text-sm text-muted-foreground">{t("目前没有新报警。", "No new alerts.")}</div>}
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5">
            <CardTitle className="text-lg">{t("市场拆分", "By market")}</CardTitle>
            <CardDescription>{t("按 7 天新增 VV", "By new views (7d)")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            {data.marketBreakdown.map((market) => {
              const share = data.totals.views7d ? (market.views / data.totals.views7d) * 100 : 0;
              return (
                <div key={market.market}>
                  <div className="mb-2 flex items-end justify-between gap-3">
                    <div><p className="font-mono text-sm font-semibold">{market.market}</p><p className="mt-1 text-xs text-muted-foreground">{t(`${market.posts} 条帖子`, `${market.posts} posts`)}</p></div>
                    <div className="text-right"><p className="font-mono text-sm">{compactNumber(market.views)}</p><p className="mt-1 text-xs text-muted-foreground">{share.toFixed(1)}%</p></div>
                  </div>
                  <Progress className="h-1.5 bg-white/[0.06] [&>div]:bg-primary" value={Math.min(100, share)} />
                </div>
              );
            })}
            <div className="rounded-lg border border-white/8 bg-white/[0.025] p-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground"><Activity className="size-4 text-primary" /><span className="font-medium">{t("采集成功率", "Capture success")}</span></div>
              <p className="mt-2">{data.totals.captureSuccessRate24h == null ? t("等待第一批快照", "Waiting for the first snapshots") : t(`最近 24 小时 ${data.totals.captureSuccessRate24h.toFixed(1)}%`, `Last 24h ${data.totals.captureSuccessRate24h.toFixed(1)}%`)}</p>
            </div>
          </CardContent>
        </Card>
      </section>

      <MarketAdsPanel markets={data.adsByMarket} topPosts={data.topRegistrationPosts} />

      {!workerOnline ? (
        <section className="mt-4 flex flex-col gap-4 rounded-xl border border-primary/15 bg-primary/[0.045] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <p className="font-medium">{t("网站已就绪，等待你的 Mac 开始同步", "The site is ready; waiting for your Mac to sync")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("本机 worker 只做出站连接；启动后会接走绑定任务并回传数据。", "The local worker only makes outbound connections; once running it picks up bind jobs and reports data.")}</p>
          </div>
          <Button asChild variant="outline"><Link href="/bind">{t("先绑定测试帖子", "Bind a test post")}</Link></Button>
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
