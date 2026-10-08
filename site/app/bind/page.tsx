"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleDashed, FileSpreadsheet, Link2, LoaderCircle, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";

import { RelativeTime } from "@/components/content-lab/relative-time";
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
    if (unique.length > 50) throw new Error("單次最多 50 條，請分批匯入；尚未送出任何網址");
    if (!unique.length) throw new Error("請先貼上至少一條 TikTok 網址");
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
    if (!response.ok) throw new Error(result.error ?? "綁定失敗，請稍後再試");
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
        title: "綁定 TikTok 帖子",
        description: "把最多 50 條 TikTok 公開帖子加入 Content Lab 的採集與分析佇列。",
        inputSchema: {
          type: "object",
          properties: {
            urls: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", format: "uri" } },
            market: { type: "string", enum: ["VN", "TR"] },
            projectTag: { type: "string", maxLength: 80 },
          },
          required: ["urls", "market"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute(input) {
          const value = input as { urls?: unknown; market?: unknown; projectTag?: unknown };
          if (!Array.isArray(value.urls) || !value.urls.every((item) => typeof item === "string")) throw new Error("urls 必須是網址陣列");
          const nextMarket = value.market === "TR" ? "TR" : "VN";
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
      toast.success(`已加入 ${result.accepted.length} 條帖子`);
      if (result.accepted.length) setRawUrls("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "綁定失敗");
    } finally { setSubmitting(false); }
  }

  async function importFile(file: File) {
    if (file.size > 5_000_000) { toast.error("檔案上限 5MB"); return; }
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
      if (!found.length) throw new Error("檔案裡找不到 TikTok 網址");
      setRawUrls((current) => [current, ...found].filter(Boolean).join("\n"));
      toast.success(`讀到 ${found.length} 條 TikTok 網址；確認市場與項目後加入佇列`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "無法讀取檔案");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <div className="mb-7">
        <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-primary"><span className="inline-block h-px w-7 bg-primary" />Ingest queue</div>
        <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">綁定內容</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">網址先存進 GPT Site；你的 Mac 醒著時會自動接走採集與 Agent 分析。</p>
      </div>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,.65fr)]">
        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">貼上 TikTok 網址</CardTitle><CardDescription>每行一條，單次最多 50 條；會自動去重並展開短鏈。</CardDescription></CardHeader>
          <CardContent className="space-y-5 pt-6">
            <div className="space-y-2"><div className="flex items-center justify-between gap-3"><Label htmlFor="urls">帖子網址</Label><span className="font-mono text-xs text-muted-foreground">{parsedCount} / 50</span></div><Textarea className="min-h-48 resize-y border-white/10 bg-white/[0.025] font-mono text-[13px] leading-6" id="urls" onChange={(event) => setRawUrls(event.target.value)} placeholder={"https://www.tiktok.com/@creator/video/...\nhttps://vt.tiktok.com/..."} value={rawUrls} /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label>市場</Label><Select onValueChange={setMarket} value={market}><SelectTrigger className="w-full border-white/10 bg-white/[0.025]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="VN">越南 · UTC+7</SelectItem><SelectItem value="TR">土耳其 · UTC+3</SelectItem></SelectContent></Select></div>
              <div className="space-y-2"><Label htmlFor="project">項目標籤</Label><Input className="border-white/10 bg-white/[0.025]" id="project" maxLength={80} onChange={(event) => setProjectTag(event.target.value)} placeholder="例如 Fate Radar" value={projectTag} /></div>
            </div>
            <div className="space-y-2"><Label htmlFor="passphrase">綁定口令（如已啟用）</Label><Input autoComplete="off" className="border-white/10 bg-white/[0.025]" id="passphrase" onChange={(event) => setPassphrase(event.target.value)} placeholder="未設定可留空" type="password" value={passphrase} /></div>
            <div className="flex flex-col gap-3 border-t border-white/8 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <div><Input accept=".csv,.tsv,.txt,.xlsx" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} ref={fileRef} type="file" /><Button onClick={() => fileRef.current?.click()} type="button" variant="outline"><Upload />匯入 CSV / XLSX</Button></div>
              <Button className="min-w-36 font-semibold" disabled={submitting || parsedCount === 0} onClick={submit}>{submitting ? <LoaderCircle className="animate-spin" /> : <Link2 />}加入處理佇列</Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5"><div className="flex items-center justify-between gap-3"><div><CardTitle className="text-lg">處理方式</CardTitle><CardDescription className="mt-1">公開頁面與本機算力分離</CardDescription></div><FileSpreadsheet className="size-5 text-primary" /></div></CardHeader>
          <CardContent className="space-y-5 pt-6">
            {[{ step: "01", title: "站點收件", body: "檢查 TikTok 網域、去重、限速後寫入佇列。" }, { step: "02", title: "Mac 接單", body: "本機 worker 主動租用工作，不開任何入站端口。" }, { step: "03", title: "採集與分析", body: "TikWM 快照、ffmpeg 抽幀、Codex taxonomy v3 打標。" }, { step: "04", title: "結果同步", body: "同步真實數據、分析結果與關鍵幀。" }].map((item) => <div className="flex gap-4" key={item.step}><span className="font-mono text-xs text-primary">{item.step}</span><div><p className="text-sm font-medium">{item.title}</p><p className="mt-1 text-sm leading-6 text-muted-foreground">{item.body}</p></div></div>)}
            <div className="rounded-lg border border-white/8 bg-white/[0.025] p-4 text-xs leading-5 text-muted-foreground">外部頁面碰不到 Codex、SQLite 或你的本機網路。Mac 睡眠時工作保留在佇列，醒來後續跑。</div>
          </CardContent>
        </Card>
      </section>

      {lastResult ? <section className="mt-4 grid gap-3 sm:grid-cols-3"><ResultCard icon={CheckCircle2} label="已加入" tone="success" value={lastResult.accepted.length} /><ResultCard icon={CircleDashed} label="已存在" tone="neutral" value={lastResult.duplicates.length} /><ResultCard icon={XCircle} label="不合法" tone="error" value={lastResult.invalid.length} /></section> : null}

      <Card className="mt-4 gap-0 overflow-hidden border-white/8 bg-card/80 py-0 shadow-none">
        <CardHeader className="border-b border-white/8 py-5"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><div className="flex items-center gap-2"><CardTitle className="text-lg">處理佇列</CardTitle>{queueError ? <span role="alert" className="text-xs text-amber-200">暫時無法讀取</span> : null}</div><CardDescription className="mt-1">等待 Mac worker 的綁定與分析工作</CardDescription></div><div className="w-full max-w-52"><div className="mb-2 flex justify-between font-mono text-[10px] text-muted-foreground"><span>完成度</span><span>{queueProgress}%</span></div><Progress className="h-1.5 bg-white/[0.06] [&>div]:bg-primary" value={queueProgress} /></div></div></CardHeader>
        <CardContent className="p-0">
          {!jobs.length ? <p className="p-6 text-center text-sm text-muted-foreground">{queueError ? "請稍後重新整理佇列。" : "目前沒有處理工作。"}</p> : null}
          <Table><TableHeader><TableRow className="border-white/8 hover:bg-transparent"><TableHead className="pl-5 text-xs text-muted-foreground">工作</TableHead><TableHead className="text-xs text-muted-foreground">市場</TableHead><TableHead className="text-xs text-muted-foreground">狀態</TableHead><TableHead className="hidden text-xs text-muted-foreground sm:table-cell">嘗試</TableHead><TableHead className="pr-5 text-right text-xs text-muted-foreground">建立時間</TableHead></TableRow></TableHeader><TableBody>{jobs.slice(0, 20).map((job) => <TableRow className="border-white/8" key={job.id}><TableCell className="max-w-[420px] py-4 pl-5"><p className="font-mono text-xs font-semibold uppercase text-foreground">{job.kind}</p><p className="mt-1 truncate text-xs text-muted-foreground">{String(job.payload.url ?? job.payload.postId ?? job.id)}</p></TableCell><TableCell className="font-mono text-xs">{String(job.payload.market ?? "—")}</TableCell><TableCell><JobBadge status={job.status} /></TableCell><TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">{job.attempts}</TableCell><TableCell className="pr-5 text-right text-xs text-muted-foreground"><RelativeTime value={job.createdAt} /></TableCell></TableRow>)}</TableBody></Table>
        </CardContent>
      </Card>
    </>
  );
}

function JobBadge({ status }: { status: string }) {
  const tone = status === "complete" ? "border-primary/20 bg-primary/8 text-primary" : status === "failed" ? "border-[#ff715b]/20 bg-[#ff715b]/8 text-[#ff9c8d]" : status === "processing" ? "border-cyan-300/20 bg-cyan-300/8 text-cyan-200" : "border-amber-300/20 bg-amber-300/8 text-amber-200";
  return <Badge className={tone} variant="outline">{status === "complete" ? "完成" : status === "failed" ? "失敗" : status === "processing" ? "處理中" : status === "retry" ? "重試" : "排隊中"}</Badge>;
}

function ResultCard({ icon: Icon, label, value, tone }: { icon: typeof CheckCircle2; label: string; value: number; tone: "success" | "neutral" | "error" }) {
  const color = tone === "success" ? "text-primary" : tone === "error" ? "text-[#ff8a76]" : "text-muted-foreground";
  return <Card className="gap-2 border-white/8 bg-card/80 py-4 shadow-none"><CardContent className="flex items-center gap-3 px-4"><Icon className={`size-5 ${color}`} /><div><p className="text-2xl font-semibold leading-none">{value}</p><p className="mt-1 text-xs text-muted-foreground">{label}</p></div></CardContent></Card>;
}
