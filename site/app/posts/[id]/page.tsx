"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Clock3, Film, Flame, MessageCircle, Play, RefreshCw, Share2, Sparkles, ThumbsUp } from "lucide-react";
import { Line, LineChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { AssessmentCard, ComputedFeaturesCard, ScriptTimeline } from "@/components/content-lab/analysis-panels";
import { RelativeTime } from "@/components/content-lab/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { compactNumber, tagLabel, tagDimensionLabel, tagConfidenceLabel, type PostDetailData } from "@/lib/content-lab";

const chartConfig = { views: { label: "累計 VV", color: "var(--chart-2)" } } satisfies ChartConfig;

export default function PostDetailPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<PostDetailData | null>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch(`/api/posts/${encodeURIComponent(params.id)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "這條帖子不存在，示範資料已移除。" : "暫時無法讀取帖子，請稍後重試。");
        return response.json() as Promise<PostDetailData>;
      })
      .then(setData)
      .catch((error) => { if (!controller.signal.aborted) setLoadError(error.message); })
      .finally(() => setLoading(false));
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [params.id]);

  const engagement = useMemo(() => {
    if (!data?.post.views) return 0;
    return ((data.post.likes + data.post.comments + data.post.shares) / data.post.views) * 100;
  }, [data]);

  async function retryAnalysis() {
    if (!data) return;
    setRetrying(true);
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(data.post.id)}`, { method: "POST" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error ?? "重新排隊失敗");
      }
      toast.success("已重新加入分析佇列");
      setData((current) => current ? { ...current, post: { ...current.post, analysisState: "queued" } } : current);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重新排隊失敗");
    } finally { setRetrying(false); }
  }

  if (loading) return <DetailSkeleton />;
  if (!data) return <Empty className="min-h-[60vh] border-white/8"><EmptyHeader><EmptyMedia variant="icon"><Film /></EmptyMedia><EmptyTitle>找不到這條帖子</EmptyTitle><EmptyDescription>{loadError ?? "它可能尚未同步，或連結已失效。"}</EmptyDescription></EmptyHeader><Button asChild variant="outline"><Link href="/posts">返回帖子列表</Link></Button></Empty>;

  const post = data.post;
  const frames = data.keyframes ?? data.features?.keyframes ?? [];
  const videoId = post.url.match(/\/(?:video|photo)\/(\d+)/)?.[1];
  const prediction = data.predictions[0];
  const tagEntries = Object.entries(data.features?.tags ?? {});

  return (
    <>
      <div className="mb-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div className="min-w-0">
          <Link className="font-mono text-[11px] uppercase tracking-[0.15em] text-primary hover:underline" href="/posts">Posts / {post.market}</Link>
          <h1 className="mt-3 truncate text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">{post.creatorHandle ?? "等待創作者資料"}</h1>
          <p className="mt-2 max-w-3xl truncate text-sm text-muted-foreground sm:text-base">{post.caption ?? post.url}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{post.market}</Badge>
            {post.projectTag ? <Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{post.projectTag}</Badge> : null}
            <Badge className={post.analysisState === "complete" ? "border-primary/20 bg-primary/8 text-primary" : "border-amber-300/20 bg-amber-300/8 text-amber-200"} variant="outline">{post.analysisState === "complete" ? "分析完成" : post.analysisState === "failed" ? "分析失敗，可重試" : "等待分析結果"}</Badge>
            <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="size-3.5" /><RelativeTime value={post.lastCapturedAt} /></span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button asChild variant="outline"><a href={post.url} rel="noreferrer" target="_blank"><Play />在 TikTok 查看</a></Button>
          <Button disabled={retrying} onClick={retryAnalysis} variant="outline"><RefreshCw className={retrying ? "animate-spin" : ""} />重試分析</Button>
        </div>
      </div>

      <Card className="mb-4 border-white/8 bg-card/80 shadow-none">
        <CardHeader><CardTitle className="text-lg">原始內容</CardTitle><CardDescription>來自 TikTok 的真實貼文；平台限制播放時可開啟原始連結。</CardDescription></CardHeader>
        <CardContent>{post.postType === "video" && post.mediaUrl && !playbackFailed ? <video className="mx-auto max-h-[650px] w-full max-w-[430px] rounded-lg bg-black" controls playsInline preload="metadata" poster={post.thumbnailUrl ?? undefined} src={post.mediaUrl} onError={() => setPlaybackFailed(true)} aria-label="原始影片" /> : videoId ? <iframe className="mx-auto h-[650px] w-full max-w-[370px] rounded-lg border-0 bg-black" src={`https://www.tiktok.com/player/v1/${videoId}`} title="TikTok 原始內容" allow="fullscreen; autoplay; encrypted-media" allowFullScreen loading="lazy" /> : <a className="text-primary underline" href={post.url} target="_blank" rel="noreferrer">在 TikTok 開啟原始內容</a>}</CardContent>
      </Card>
      <section aria-label="帖子指標" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MiniMetric icon={Play} label="累計 VV" value={compactNumber(post.lastCapturedAt ? post.views : null)} />
        <MiniMetric icon={ThumbsUp} label="讚" value={compactNumber(post.lastCapturedAt ? post.likes : null)} />
        <MiniMetric icon={MessageCircle} label="留言" value={compactNumber(post.lastCapturedAt ? post.comments : null)} />
        <MiniMetric icon={Share2} label="分享" value={compactNumber(post.lastCapturedAt ? post.shares : null)} />
        <MiniMetric icon={Sparkles} label="互動率" value={post.lastCapturedAt ? `${engagement.toFixed(2)}%` : "—"} />
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(330px,.65fr)]">
        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="text-lg">小時播放曲線</CardTitle><CardDescription className="mt-1">斷點代表缺失，跨缺口的增量標為 interpolated</CardDescription></div><Badge className="border-cyan-300/15 bg-cyan-300/8 text-cyan-200" variant="outline">24h +{compactNumber(post.delta24h)}</Badge></div>
          </CardHeader>
          <CardContent className="px-3 pb-2 pt-6 sm:px-6">
            {data.snapshots.length ? (
              <ChartContainer className="h-[340px] w-full aspect-auto" config={chartConfig}>
                <LineChart data={data.snapshots} margin={{ left: 0, right: 12, top: 12, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="4 6" vertical={false} />
                  <XAxis axisLine={false} dataKey="capturedAt" minTickGap={46} tickFormatter={(value) => new Date(value).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric", hour: "numeric" })} tickLine={false} />
                  <YAxis axisLine={false} tickFormatter={(value) => compactNumber(Number(value))} tickLine={false} width={50} />
                  <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => payload?.[0]?.payload?.capturedAt ? new Date(payload[0].payload.capturedAt).toLocaleString("zh-TW") : ""} />} />
                  <Line connectNulls={false} dataKey="views" dot={false} stroke="var(--color-views)" strokeWidth={2.25} type="monotone" />
                </LineChart>
              </ChartContainer>
            ) : <Empty className="h-[340px] border-0"><EmptyHeader><EmptyMedia variant="icon"><Film /></EmptyMedia><EmptyTitle>等待第一筆快照</EmptyTitle><EmptyDescription>本機 worker 接走任務後，曲線會從這裡開始。</EmptyDescription></EmptyHeader></Empty>}
          </CardContent>
        </Card>

        <AssessmentCard market={post.market} prediction={prediction} />
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)]">
        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">Agent 標籤</CardTitle><CardDescription>分類詞表 {data.features?.taxonomyVersion ?? "v3"} · 固定分類</CardDescription></CardHeader>
          <CardContent className="pt-6">
            {tagEntries.length ? <div className="grid gap-3 sm:grid-cols-2">{tagEntries.map(([key, raw]) => { const value = tagValue(raw); return <div className="rounded-lg border border-white/8 bg-white/[0.025] p-3" key={key}><p className="text-sm text-muted-foreground">{tagDimensionLabel(key)}</p><div className="mt-2 flex items-start justify-between gap-3"><p className="min-w-0 text-sm font-medium">{tagLabel(value.value, key)}</p>{value.confidence ? <span className="shrink-0 text-xs text-muted-foreground">{tagConfidenceLabel(value.confidence)}</span> : null}</div></div>; })}</div> : <div className="py-12 text-center text-sm text-muted-foreground">Agent 還在分析內容。</div>}
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">腳本拆解</CardTitle><CardDescription>數字由程式計算，Agent 只負責解讀</CardDescription></CardHeader>
          <CardContent className="space-y-6 pt-6">
            <div><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-primary">開場鉤子</p><blockquote className="mt-2 border-l-2 border-primary/60 pl-4 text-base leading-7">{data.features?.hookTranslationZh ?? "等待分析"}</blockquote>{data.features?.hookText ? <p className="mt-2 pl-[18px] text-sm text-muted-foreground">{data.features.hookText}</p> : null}</div>
            <div><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-cyan-200">一句話公式</p><p className="mt-2 text-sm leading-7 text-foreground/90">{data.features?.formulaZh ?? "等待 Agent 產出公式"}</p></div>
            <div><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground">中文摘要</p><p className="mt-2 text-sm leading-7 text-muted-foreground">{data.features?.summaryZh ?? "等待 Agent 產出摘要"}</p></div>
          </CardContent>
        </Card>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,.55fr)]">
        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">分段腳本</CardTitle><CardDescription>{post.postType === "photo" ? "按圖集順序逐張拆解" : "按時間拆解畫面、字幕與台詞；台詞由本機 Whisper 轉寫"}</CardDescription></CardHeader>
          <CardContent className="pt-6"><ScriptTimeline frames={frames} script={data.features?.script ?? []} /></CardContent>
        </Card>
        <ComputedFeaturesCard computed={data.features?.computed ?? {}} />
      </section>

      <Card className="mt-4 border-white/8 bg-card/80 shadow-none">
        <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">關鍵幀</CardTitle><CardDescription>{post.postType === "photo" ? "圖集的全部圖片" : "本機 ffmpeg 按畫面切換抽幀"}，交給 Claude 分析</CardDescription></CardHeader>
        <CardContent className="pt-6">
          {frames.length ? <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">{frames.map((frame, index) => <figure className="overflow-hidden rounded-lg border border-white/8 bg-black" key={frame}><img alt={`關鍵幀 ${index + 1}`} className="aspect-[9/16] h-full w-full object-cover" loading="lazy" src={frame} /><figcaption className="sr-only">關鍵幀 {index + 1}</figcaption></figure>)}</div> : <Empty className="border-dashed border-white/8 py-12"><EmptyHeader><EmptyMedia variant="icon"><Film /></EmptyMedia><EmptyTitle>{data.mediaError ?? "尚無關鍵幀"}</EmptyTitle><EmptyDescription>{post.analysisState === "failed" ? "媒體取得或分析失敗，請查看處理佇列並重試。" : "本機取得媒體並抽幀後，圖片會同步顯示在這裡。"}</EmptyDescription></EmptyHeader></Empty>}
        </CardContent>
      </Card>

      {data.alerts.length ? <section className="mt-4 rounded-xl border border-[#ff715b]/18 bg-[#ff715b]/[0.055] p-5 sm:p-6"><div className="flex items-start gap-4"><div className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[#ff715b]/12 text-[#ff8a76]"><Flame className="size-5" /></div><div><p className="font-medium">這條帖子已觸發 {data.alerts.length} 次信號</p><p className="mt-1 text-sm text-muted-foreground">最近：{data.alerts[0].rule.replaceAll("_", " ")} · <RelativeTime value={data.alerts[0].firedAt} /></p></div></div></section> : null}
    </>
  );
}

function MiniMetric({ icon: Icon, label, value }: { icon: typeof Play; label: string; value: string }) {
  return <Card className="gap-3 border-white/8 bg-card/80 py-4 shadow-none"><CardHeader className="flex-row items-center gap-2 px-4"><Icon className="size-4 text-muted-foreground" /><CardDescription className="font-mono text-[10px] uppercase tracking-[0.1em]">{label}</CardDescription></CardHeader><CardContent className="px-4"><p className="text-2xl font-semibold tracking-[-0.04em]">{value}</p></CardContent></Card>;
}

function DetailSkeleton() {
  return <div className="space-y-4"><Skeleton className="h-24 w-full max-w-2xl" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <Skeleton className="h-24" key={index} />)}</div><Skeleton className="h-[430px] w-full" /></div>;
}

function tagValue(raw: unknown): { value: string | string[]; confidence: string | null } {
  if (typeof raw === "string") return { value: raw, confidence: null };
  if (raw && typeof raw === "object") {
    const value = (raw as Record<string, unknown>).value;
    const confidence = (raw as Record<string, unknown>).confidence;
    if (Array.isArray(value)) return { value: value.filter((item): item is string => typeof item === "string"), confidence: typeof confidence === "string" ? confidence : null };
    return { value: typeof value === "string" ? value : "—", confidence: typeof confidence === "string" ? confidence : null };
  }
  return { value: "—", confidence: null };
}
