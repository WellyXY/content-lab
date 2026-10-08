"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Link2, ListVideo, Plus, Radio } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "總覽", icon: LayoutDashboard },
  { href: "/posts", label: "帖子", icon: ListVideo },
  { href: "/bind", label: "綁定", icon: Link2 },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-white/8 bg-background/88 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1560px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link className="flex items-center gap-3" href="/">
            <div className="grid size-9 place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-[0_0_24px_rgb(216_255_76/18%)]">
              <Radio className="size-[18px]" aria-hidden="true" />
            </div>
            <div>
              <p className="text-[15px] font-semibold tracking-[-0.02em]">Content Lab</p>
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">live signal desk</p>
            </div>
          </Link>
          <div className="flex items-center gap-2">
            <Badge className="hidden border-cyan-300/15 bg-cyan-300/8 text-cyan-200 md:inline-flex" variant="outline">
              <span className="size-1.5 rounded-full bg-cyan-300" />
              本機 worker 同步
            </Badge>
            <Button asChild className="rounded-[9px] font-semibold" size="sm">
              <Link href="/bind"><Plus />綁定帖子</Link>
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1560px] lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden min-h-[calc(100vh-64px)] border-r border-white/8 p-4 lg:block">
          <nav aria-label="主要導覽" className="space-y-1">
            {links.map((link) => {
              const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
              const Icon = link.icon;
              return (
                <Link className={cn("nav-item", active && "nav-item-active")} href={link.href} key={link.href}>
                  <Icon />{link.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-8 rounded-xl border border-white/8 bg-white/[0.025] p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">同步架構</p>
            <p className="mt-3 text-sm leading-6 text-foreground/90">GPT Site 保持可訪問；Mac 醒著時主動採集與分析。</p>
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-primary" />
              不開本機端口
            </div>
          </div>
        </aside>

        <main className="min-w-0 px-4 pb-24 pt-7 sm:px-6 lg:px-8 lg:pb-10 lg:pt-9">{children}</main>
      </div>

      <nav aria-label="行動版導覽" className="fixed inset-x-3 bottom-3 z-50 grid grid-cols-3 rounded-2xl border border-white/10 bg-[#10151e]/95 p-1.5 shadow-2xl backdrop-blur-xl lg:hidden">
        {links.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          const Icon = link.icon;
          return (
            <Link className={cn("flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-[11px] text-muted-foreground", active && "bg-primary/10 text-primary")} href={link.href} key={link.href}>
              <Icon className="size-4" />{link.label}
            </Link>
          );
        })}
      </nav>
      <Toaster richColors position="bottom-right" />
    </div>
  );
}
