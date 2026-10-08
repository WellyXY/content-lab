"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Clock3, ListFilter, Play, Search } from "lucide-react";

import { RelativeTime } from "@/components/content-lab/relative-time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { compactNumber, demoPosts, tagLabel, type PostSummary } from "@/lib/content-lab";

export default function PostsPage() {
  const [posts, setPosts] = useState<PostSummary[]>(demoPosts);
  const [mode, setMode] = useState<"live" | "demo">("demo");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState("all");
  const [state, setState] = useState("all");
  const [sort, setSort] = useState("delta24h");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/posts", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("posts unavailable");
        return response.json() as Promise<{ mode: "live" | "demo"; posts: PostSummary[] }>;
      })
      .then((result) => { setPosts(result.posts); setMode(result.mode); })
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const result = posts.filter((post) => {
      if (market !== "all" && post.market !== market) return false;
      if (state !== "all" && post.trackingState !== state) return false;
      if (!normalized) return true;
      return [post.creatorHandle, post.caption, post.projectTag].some((value) => value?.toLowerCase().includes(normalized));
    });
    return result.sort((a, b) => {
      if (sort === "views") return b.views - a.views;
      if (sort === "newest") return new Date(b.boundAt).getTime() - new Date(a.boundAt).getTime();
      if (sort === "rank") return (a.rankPosition ?? 9999) - (b.rankPosition ?? 9999);
      return b.delta24h - a.delta24h;
    });
  }, [market, posts, query, sort, state]);

  return (
    <>
      <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-primary"><span className="inline-block h-px w-7 bg-primary" />Tracked content</div>
          <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">帖子雷達</h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">依增速、累計播放與實驗性排名找到值得追的內容。</p>
        </div>
        <div className="flex items-center gap-2">
          {mode === "demo" ? <Badge className="border-amber-300/20 bg-amber-300/8 text-amber-200" variant="outline">示範資料</Badge> : null}
          <Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{filtered.length} 條</Badge>
        </div>
      </div>

      <Card className="gap-0 overflow-hidden border-white/8 bg-card/80 py-0 shadow-none">
        <div className="grid gap-3 border-b border-white/8 p-4 md:grid-cols-[minmax(220px,1fr)_150px_150px_170px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="搜尋創作者、文案或項目" className="h-10 border-white/10 bg-white/[0.025] pl-9" onChange={(event) => setQuery(event.target.value)} placeholder="搜尋創作者、文案、項目" value={query} />
          </div>
          <Select onValueChange={setMarket} value={market}>
            <SelectTrigger className="h-10 w-full border-white/10 bg-white/[0.025]"><SelectValue placeholder="全部市場" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部市場</SelectItem><SelectItem value="VN">越南</SelectItem><SelectItem value="TR">土耳其</SelectItem></SelectContent>
          </Select>
          <Select onValueChange={setState} value={state}>
            <SelectTrigger className="h-10 w-full border-white/10 bg-white/[0.025]"><SelectValue placeholder="全部狀態" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部狀態</SelectItem><SelectItem value="active">每小時</SelectItem><SelectItem value="slow">每 3 小時</SelectItem><SelectItem value="daily">每日</SelectItem><SelectItem value="stopped">已停止</SelectItem></SelectContent>
          </Select>
          <Select onValueChange={setSort} value={sort}>
            <SelectTrigger className="h-10 w-full border-white/10 bg-white/[0.025]"><ListFilter /><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="delta24h">24h 增量</SelectItem><SelectItem value="views">累計播放</SelectItem><SelectItem value="rank">實驗性排名</SelectItem><SelectItem value="newest">最新綁定</SelectItem></SelectContent>
          </Select>
        </div>

        <CardContent className="p-0">
          {loading ? <div className="space-y-2 p-5">{Array.from({ length: 6 }, (_, index) => <Skeleton className="h-16 w-full" key={index} />)}</div> : filtered.length ? (
            <Table>
              <TableHeader><TableRow className="border-white/8 hover:bg-transparent"><TableHead className="pl-5 text-xs text-muted-foreground">內容</TableHead><TableHead className="text-xs text-muted-foreground">市場 / 項目</TableHead><TableHead className="text-right text-xs text-muted-foreground">累計 VV</TableHead><TableHead className="text-right text-xs text-muted-foreground">24h 增量</TableHead><TableHead className="hidden text-xs text-muted-foreground lg:table-cell">Agent 標籤</TableHead><TableHead className="hidden pr-5 text-right text-xs text-muted-foreground sm:table-cell">狀態</TableHead></TableRow></TableHeader>
              <TableBody>{filtered.map((post) => <PostRow key={post.id} post={post} />)}</TableBody>
            </Table>
          ) : (
            <Empty className="border-0 py-24"><EmptyHeader><EmptyMedia variant="icon"><Search /></EmptyMedia><EmptyTitle>沒有符合條件的帖子</EmptyTitle><EmptyDescription>調整篩選，或綁定一條新的 TikTok 連結。</EmptyDescription></EmptyHeader></Empty>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function PostRow({ post }: { post: PostSummary }) {
  const status = statusCopy(post);
  return (
    <TableRow className="border-white/8 hover:bg-white/[0.025]">
      <TableCell className="max-w-[320px] py-3 pl-5">
        <div className="flex items-center gap-3">
          <Link aria-label={`查看 ${post.creatorHandle ?? "帖子"}`} className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/10 bg-gradient-to-br from-cyan-300/15 to-primary/10 text-cyan-200" href={`/posts/${post.id}`}>
            {post.thumbnailUrl ? <img alt="" className="h-full w-full object-cover" src={post.thumbnailUrl} /> : <Play className="size-4" />}
          </Link>
          <div className="min-w-0">
            <Link className="block truncate text-sm font-medium hover:text-primary" href={`/posts/${post.id}`}>{post.creatorHandle ?? "等待創作者資料"}</Link>
            <p className="mt-1 truncate text-xs text-muted-foreground">{post.caption ?? post.url}</p>
          </div>
        </div>
      </TableCell>
      <TableCell><p className="font-mono text-xs font-semibold">{post.market}</p><p className="mt-1 max-w-32 truncate text-xs text-muted-foreground">{post.projectTag ?? "未分類"}</p></TableCell>
      <TableCell className="text-right font-mono font-semibold">{compactNumber(post.views)}</TableCell>
      <TableCell className="text-right"><span className="font-mono font-semibold text-cyan-200">+{compactNumber(post.delta24h)}</span></TableCell>
      <TableCell className="hidden lg:table-cell"><div className="flex max-w-56 flex-wrap gap-1.5">{post.hookType ? <Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{tagLabel(post.hookType)}</Badge> : null}{post.topic ? <Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{tagLabel(post.topic)}</Badge> : null}{post.rankPosition ? <Badge className="border-primary/15 bg-primary/8 text-primary" variant="outline">#{post.rankPosition}/{post.rankTotal}</Badge> : null}</div></TableCell>
      <TableCell className="hidden pr-5 text-right sm:table-cell"><Badge className={status.className} variant="outline">{status.label}</Badge><div className="mt-1.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground"><Clock3 className="size-3" /><RelativeTime value={post.lastCapturedAt} /></div></TableCell>
    </TableRow>
  );
}

function statusCopy(post: PostSummary) {
  if (post.analysisState === "failed") return { label: "分析失敗", className: "border-[#ff715b]/20 bg-[#ff715b]/8 text-[#ff9c8d]" };
  if (post.analysisState !== "complete") return { label: "分析中", className: "border-amber-300/20 bg-amber-300/8 text-amber-200" };
  if (post.trackingState === "stopped") return { label: "已停止", className: "border-white/10 bg-white/[0.03] text-muted-foreground" };
  return { label: "追蹤中", className: "border-primary/20 bg-primary/8 text-primary" };
}
