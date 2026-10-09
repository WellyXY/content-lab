"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleDashed, FileSpreadsheet, Link2, LoaderCircle, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";

import { RelativeTime } from "@/components/content-lab/relative-time";
import { useLocale } from "@/lib/i18n";
import { cleanUrl, extractTikTokUrls, linksFromSheets } from "@/lib/import-links";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { MARKETS, MARKET_CODES } from "@/lib/content-lab";

type QueueJob = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  payload: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type BindResponse = {
  accepted: Array<{ id: string; url: string }>;
  duplicates: string[];
  invalid: Array<{ input: string; error: string }>;
};

export default function BindPage() {
  const { t } = useLocale();
  const [rawUrls, setRawUrls] = useState("");
  const [market, setMarket] = useState("VN");
  const [projectTag, setProjectTag] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [queueError, setQueueError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<BindResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshQueue = useCallback(() => {
    return fetch("/api/jobs", { cache: "no-store" })
      .then(async (response): Promise<{ mode: "live"; jobs: QueueJob[] }> => {
        if (!response.ok) throw new Error("queue unavailable");
        return await response.json() as { mode: "live"; jobs: QueueJob[] };
      })
      .then((result: { mode: "live"; jobs: QueueJob[] }) => { setJobs(result.jobs); setQueueError(false); })
      .catch(() => setQueueError(true));
  }, []);

  useEffect(() => {
    void refreshQueue();
    const timer = window.setInterval(refreshQueue, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshQueue]);

  const performBind = useCallback(async (urls: string[], overrides?: { market?: string; projectTag?: string; passphrase?: string }) => {
    const unique = [...new Set(urls.map(cleanUrl).filter(Boolean))];
    if (unique.length > 50) throw new Error(t("单次最多 50 条，请分批导入；尚未提交任何链接", "At most 50 links per batch; nothing was submitted"));
    if (!unique.length) throw new Error(t("请先粘贴至少一条 TikTok 链接", "Paste at least one TikTok link first"));
    const response = await fetch("/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        urls: unique,
        market: overrides?.market ?? market,
        projectTag: (overrides?.projectTag ?? projectTag) || null,
        passphrase: (overrides?.passphrase ?? passphrase) || undefined,
      }),
    });
    const result = await response.json().catch(() => ({})) as BindResponse & { error?: string };
    if (!response.ok) throw new Error(result.error ?? t("绑定失败，请稍后再试", "Binding failed; try again later"));
    setLastResult(result);
    await refreshQueue();
    return result;
  }, [market, passphrase, projectTag, refreshQueue]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name: "bind_tiktok_posts",
        title: "绑定 TikTok 帖子 / Bind TikTok posts",
        description: "把最多 50 条 TikTok 公开帖子加入 Content Lab 的采集与分析队列。Adds up to 50 public TikTok posts to Content Lab's collection and analysis queue.",
        inputSchema: {
          type: "object",
          properties: {
            urls: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", format: "uri" } },
            market: { type: "string", enum: MARKET_CODES },
            projectTag: { type: "string", maxLength: 80 },
          },
          required: ["urls", "market"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute(input) {
          const value = input as { urls?: unknown; market?: unknown; projectTag?: unknown };
          if (!Array.isArray(value.urls) || !value.urls.every((item) => typeof item === "string")) throw new Error("urls must be an array of links");
          const nextMarket = MARKET_CODES.find((code) => code === value.market) ?? "VN";
          const result = await performBind(value.urls, { market: nextMarket, projectTag: typeof value.projectTag === "string" ? value.projectTag : "" });
          setRawUrls(value.urls.join("\n"));
          setMarket(nextMarket);
          if (typeof value.projectTag === "string") setProjectTag(value.projectTag);
          return { accepted: result.accepted.length, duplicates: result.duplicates.length, invalid: result.invalid.length };
        },
      }, { signal: lifecycle.signal })).catch(() => undefined);
    } catch { /* Unsupported WebMCP implementations fail closed. */ }
    return () => lifecycle.abort();
  }, [performBind]);

  const parsedCount = useMemo(() => extractTikTokUrls(rawUrls).length, [rawUrls]);
  const queueProgress = jobs.length ? Math.round((jobs.filter((job) => job.status === "complete").length / jobs.length) * 100) : 0;

  async function submit() {
    setSubmitting(true);
    try {
      const result = await performBind(extractTikTokUrls(rawUrls));
      toast.success(t(`已加入 ${result.accepted.length} 条帖子`, `Added ${result.accepted.length} posts`));
      if (result.accepted.length) setRawUrls("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("绑定失败", "Binding failed"));
    } finally { setSubmitting(false); }
  }

  async function importFile(file: File) {
    if (file.size > 5_000_000) { toast.error(t("文件上限 5MB", "Files are limited to 5MB")); return; }
    try {
      let values: string[] = [];
      if (/\.xlsx$/i.test(file.name)) {
        const { default: readXlsxFile } = await import("read-excel-file/browser");
        const sheets = await readXlsxFile(file);
        values = linksFromSheets(sheets);
      } else {
        values = [(await file.text())];
      }
      const found = extractTikTokUrls(values.join("\n"));
      if (!found.length) throw new Error(t("文件里找不到 TikTok 链接", "No TikTok links found in the file"));
      setRawUrls((current) => [current, ...found].filter(Boolean).join("\n"));
      toast.success(t(`读到 ${found.length} 条 TikTok 链接；确认市场与项目后加入队列`, `Found ${found.length} TikTok links; confirm the market and project, then queue them`));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("无法读取文件", "Could not read the file"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <div className="mb-7">
        <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-primary"><span className="inline-block h-px w-7 bg-primary" />Ingest queue</div>
        <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">{t("绑定内容", "Bind posts")}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">{t("链接先存进 GPT Site；你的 Mac 醒着时会自动接走采集与 Agent 分析。", "Links are stored on the GPT Site; your Mac picks up collection and Agent analysis whenever it is awake.")}</p>
      </div>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,.65fr)]">
        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">{t("粘贴 TikTok 链接", "Paste TikTok links")}</CardTitle><CardDescription>{t("每行一条，单次最多 50 条；会自动去重并展开短链。", "One per line, up to 50 per batch; duplicates are removed and short links expanded.")}</CardDescription></CardHeader>
          <CardContent className="space-y-5 pt-6">
            <div className="space-y-2"><div className="flex items-center justify-between gap-3"><Label htmlFor="urls">{t("帖子链接", "Post links")}</Label><span className="font-mono text-xs text-muted-foreground">{parsedCount} / 50</span></div><Textarea className="min-h-48 resize-y border-white/10 bg-white/[0.025] font-mono text-[13px] leading-6" id="urls" onChange={(event) => setRawUrls(event.target.value)} placeholder={"https://www.tiktok.com/@creator/video/...\nhttps://vt.tiktok.com/..."} value={rawUrls} /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label>{t("市场", "Market")}</Label><Select onValueChange={setMarket} value={market}><SelectTrigger className="w-full border-white/10 bg-white/[0.025]"><SelectValue /></SelectTrigger><SelectContent>{MARKETS.map((item) => <SelectItem key={item.code} value={item.code}>{item.code} {t(item.label, item.labelEn)} · {item.timezone}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label htmlFor="project">{t("项目标签", "Project tag")}</Label><Input className="border-white/10 bg-white/[0.025]" id="project" maxLength={80} onChange={(event) => setProjectTag(event.target.value)} placeholder={t("例如 Fate Radar", "e.g. Fate Radar")} value={projectTag} /></div>
            </div>
            <div className="space-y-2"><Label htmlFor="passphrase">{t("绑定口令（如已启用）", "Bind passphrase (if enabled)")}</Label><Input autoComplete="off" className="border-white/10 bg-white/[0.025]" id="passphrase" onChange={(event) => setPassphrase(event.target.value)} placeholder={t("未设置可留空", "Leave empty if not set")} type="password" value={passphrase} /></div>
            <div className="flex flex-col gap-3 border-t border-white/8 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <div><Input accept=".csv,.tsv,.txt,.xlsx" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} ref={fileRef} type="file" /><Button onClick={() => fileRef.current?.click()} type="button" variant="outline"><Upload />{t("导入 CSV / XLSX", "Import CSV / XLSX")}</Button></div>
              <Button className="min-w-36 font-semibold" disabled={submitting || parsedCount === 0} onClick={submit}>{submitting ? <LoaderCircle className="animate-spin" /> : <Link2 />}{t("加入处理队列", "Add to queue")}</Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5"><div className="flex items-center justify-between gap-3"><div><CardTitle className="text-lg">{t("处理方式", "How it works")}</CardTitle><CardDescription className="mt-1">{t("公开页面与本机算力分离", "The public site and the Mac's compute stay separate")}</CardDescription></div><FileSpreadsheet className="size-5 text-primary" /></div></CardHeader>
          <CardContent className="space-y-5 pt-6">
            {[
              { step: "01", title: t("站点收件", "The site receives"), body: t("检查 TikTok 域名、去重、限速后写入队列。", "Checks the TikTok domain, removes duplicates and rate-limits, then queues the job.") },
              { step: "02", title: t("Mac 接单", "The Mac picks up"), body: t("本机 worker 主动领取任务，不开放任何入站端口。", "The local worker leases jobs itself; no inbound ports are opened.") },
              { step: "03", title: t("采集与分析", "Collect and analyze"), body: t("TikWM 快照、ffmpeg 抽帧、Whisper 转写、Claude 按词表 v3 打标并拆解脚本。", "TikWM snapshots, ffmpeg keyframes, Whisper transcripts, then Claude tags with taxonomy v3 and writes the timed script.") },
              { step: "04", title: t("结果同步", "Results sync back"), body: t("同步真实数据、分析结果与关键帧。", "Real metrics, analyses and keyframes are synced to the site.") },
            ].map((item) => <div className="flex gap-4" key={item.step}><span className="font-mono text-xs text-primary">{item.step}</span><div><p className="text-sm font-medium">{item.title}</p><p className="mt-1 text-sm leading-6 text-muted-foreground">{item.body}</p></div></div>)}
            <div className="rounded-lg border border-white/8 bg-white/[0.025] p-4 text-xs leading-5 text-muted-foreground">{t("外部页面碰不到模型、数据库或你的本机网络。Mac 睡眠时任务保留在队列，醒来后继续。", "The public site cannot reach the model, the database or your local network. While the Mac sleeps, jobs wait in the queue and resume on wake.")}</div>
          </CardContent>
        </Card>
      </section>

      {lastResult ? <section className="mt-4 grid gap-3 sm:grid-cols-3"><ResultCard icon={CheckCircle2} label={t("已加入", "Added")} tone="success" value={lastResult.accepted.length} /><ResultCard icon={CircleDashed} label={t("已存在", "Already bound")} tone="neutral" value={lastResult.duplicates.length} /><ResultCard icon={XCircle} label={t("不合法", "Invalid")} tone="error" value={lastResult.invalid.length} /></section> : null}

      <Card className="mt-4 gap-0 overflow-hidden border-white/8 bg-card/80 py-0 shadow-none">
        <CardHeader className="border-b border-white/8 py-5"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><div className="flex items-center gap-2"><CardTitle className="text-lg">{t("处理队列", "Queue")}</CardTitle>{queueError ? <span role="alert" className="text-xs text-amber-200">{t("暂时无法读取", "Unavailable")}</span> : null}</div><CardDescription className="mt-1">{t("等待 Mac worker 处理的绑定与分析任务", "Bind and analysis jobs waiting for the Mac worker")}</CardDescription></div><div className="w-full max-w-52"><div className="mb-2 flex justify-between font-mono text-[10px] text-muted-foreground"><span>{t("完成度", "Progress")}</span><span>{queueProgress}%</span></div><Progress className="h-1.5 bg-white/[0.06] [&>div]:bg-primary" value={queueProgress} /></div></div></CardHeader>
        <CardContent className="p-0">
          {!jobs.length ? <p className="p-6 text-center text-sm text-muted-foreground">{queueError ? t("请稍后刷新队列。", "Refresh the queue shortly.") : t("目前没有处理任务。", "No jobs right now.")}</p> : null}
          <Table><TableHeader><TableRow className="border-white/8 hover:bg-transparent"><TableHead className="pl-5 text-xs text-muted-foreground">{t("任务", "Job")}</TableHead><TableHead className="text-xs text-muted-foreground">{t("市场", "Market")}</TableHead><TableHead className="text-xs text-muted-foreground">{t("状态", "Status")}</TableHead><TableHead className="hidden text-xs text-muted-foreground sm:table-cell">{t("尝试", "Attempts")}</TableHead><TableHead className="pr-5 text-right text-xs text-muted-foreground">{t("创建时间", "Created")}</TableHead></TableRow></TableHeader><TableBody>{jobs.slice(0, 20).map((job) => <TableRow className="border-white/8" key={job.id}><TableCell className="max-w-[420px] py-4 pl-5"><p className="font-mono text-xs font-semibold uppercase text-foreground">{job.kind}</p><p className="mt-1 truncate text-xs text-muted-foreground">{String(job.payload.url ?? job.payload.postId ?? job.id)}</p></TableCell><TableCell className="font-mono text-xs">{String(job.payload.market ?? "—")}</TableCell><TableCell><JobBadge status={job.status} /></TableCell><TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">{job.attempts}</TableCell><TableCell className="pr-5 text-right text-xs text-muted-foreground"><RelativeTime value={job.createdAt} /></TableCell></TableRow>)}</TableBody></Table>
        </CardContent>
      </Card>
    </>
  );
}

function JobBadge({ status }: { status: string }) {
  const { t } = useLocale();
  const tone = status === "complete" ? "border-primary/20 bg-primary/8 text-primary" : status === "failed" ? "border-[#ff715b]/20 bg-[#ff715b]/8 text-[#ff9c8d]" : status === "processing" ? "border-cyan-300/20 bg-cyan-300/8 text-cyan-200" : "border-amber-300/20 bg-amber-300/8 text-amber-200";
  return <Badge className={tone} variant="outline">{status === "complete" ? t("完成", "Done") : status === "failed" ? t("失败", "Failed") : status === "processing" ? t("处理中", "Running") : status === "retry" ? t("重试", "Retrying") : t("排队中", "Queued")}</Badge>;
}

function ResultCard({ icon: Icon, label, value, tone }: { icon: typeof CheckCircle2; label: string; value: number; tone: "success" | "neutral" | "error" }) {
  const color = tone === "success" ? "text-primary" : tone === "error" ? "text-[#ff8a76]" : "text-muted-foreground";
  return <Card className="gap-2 border-white/8 bg-card/80 py-4 shadow-none"><CardContent className="flex items-center gap-3 px-4"><Icon className={`size-5 ${color}`} /><div><p className="text-2xl font-semibold leading-none">{value}</p><p className="mt-1 text-xs text-muted-foreground">{label}</p></div></CardContent></Card>;
}
