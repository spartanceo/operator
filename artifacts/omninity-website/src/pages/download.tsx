import { useState } from "react";
import { Apple, ArrowDownToLine, Check, ChevronDown, Copy, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";
import { CURRENT_RELEASE, PAST_RELEASES } from "@/lib/site-data";

const CHECKSUMS = {
  mac: "d8c6c3a92ef5ba6e8d8174b3f0bb2d5d1d0c7b1ff3b3eaa01ed2c4d2c4d8c6c3",
  win: "b1f0c4af3d5a91c70c9f3e8a2b8d2c1ef02d9a5c1b6f7d3e8d4f1c0b2a9e7f3a",
};

const DOWNLOAD_BASE_URL = "https://downloads.omninity.app";

interface DownloadCardProps {
  os: "Mac" | "Windows";
  fileLabel: string;
  href: string;
  size: string;
  arch: string;
  checksum: string;
  icon: React.ReactNode;
}

function DownloadCard(props: DownloadCardProps) {
  const [copied, setCopied] = useState(false);
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border/60 p-7">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-background text-foreground">
            {props.icon}
          </div>
          <div>
            <div className="text-lg font-medium tracking-tight">{props.os}</div>
            <div className="text-sm text-muted-foreground">{props.arch}</div>
          </div>
        </div>
        <Badge variant="outline" className="rounded-full border-border text-[10px] uppercase tracking-wider text-muted-foreground">
          v{CURRENT_RELEASE.version}
        </Badge>
      </div>
      <div className="space-y-5 p-7">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Filename</span>
          <span className="font-mono text-foreground">{props.fileLabel}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Size</span>
          <span className="text-foreground">{props.size}</span>
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">SHA-256</span>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(props.checksum);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              }}
              className="hover-elevate inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted-foreground"
            >
              {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="overflow-hidden rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {props.checksum}
          </div>
        </div>
        <Button asChild className="w-full gap-2" size="lg">
          <a href={props.href} download={props.fileLabel}>
            <ArrowDownToLine className="h-4 w-4" />
            Download for {props.os}
          </a>
        </Button>
      </div>
    </Card>
  );
}

export default function DownloadPage() {
  const [showOlder, setShowOlder] = useState(false);
  return (
    <>
      <SEO
        title="Download"
        description="Download Omninity Operator for Mac and Windows. Verified release builds with SHA-256 checksums and full release notes."
      />
      <section className="border-b border-border/40 py-20 md:py-24">
        <div className="mx-auto max-w-7xl px-5 md:px-8">
          <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Release {CURRENT_RELEASE.version} · {CURRENT_RELEASE.date}
          </Badge>
          <h1 className="mt-6 text-balance text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
            Download Omninity Operator.
          </h1>
          <p className="mt-5 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground">
            One installer per platform. Verified, signed, and shipped quietly. The first
            launch will pull a 4 GB local model via Ollama; everything after is offline.
          </p>
        </div>
      </section>
      <section className="border-b border-border/40 py-16 md:py-20">
        <div className="mx-auto grid max-w-5xl gap-6 px-5 md:grid-cols-2 md:px-8">
          <DownloadCard
            os="Mac"
            fileLabel={`Omninity-Operator-${CURRENT_RELEASE.version}.dmg`}
            href={`${DOWNLOAD_BASE_URL}/v${CURRENT_RELEASE.version}/Omninity-Operator-${CURRENT_RELEASE.version}.dmg`}
            size="96.4 MB · macOS 12+"
            arch="Universal · Apple Silicon and Intel"
            checksum={CHECKSUMS.mac}
            icon={<Apple className="h-5 w-5" />}
          />
          <DownloadCard
            os="Windows"
            fileLabel={`Omninity-Operator-Setup-${CURRENT_RELEASE.version}.exe`}
            href={`${DOWNLOAD_BASE_URL}/v${CURRENT_RELEASE.version}/Omninity-Operator-Setup-${CURRENT_RELEASE.version}.exe`}
            size="103.7 MB · Windows 10/11"
            arch="x64 and ARM64"
            checksum={CHECKSUMS.win}
            icon={<MonitorSmartphone className="h-5 w-5" />}
          />
        </div>
      </section>
      <section className="border-b border-border/40 py-20 md:py-24">
        <div className="mx-auto max-w-5xl px-5 md:px-8">
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Release notes
            </Badge>
            <span className="text-sm text-muted-foreground">v{CURRENT_RELEASE.version} · {CURRENT_RELEASE.date}</span>
          </div>
          <h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            What changed in this release.
          </h2>
          <Card className="mt-8 p-8">
            <ul className="space-y-4">
              {CURRENT_RELEASE.highlights.map((h) => (
                <li key={h} className="flex items-start gap-3 text-base leading-relaxed text-foreground">
                  <span className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  {h}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </section>
      <section className="py-20 md:py-24">
        <div className="mx-auto max-w-5xl px-5 md:px-8">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">Older releases</h2>
            <Button variant="ghost" size="sm" onClick={() => setShowOlder((v) => !v)} className="gap-1.5">
              {showOlder ? "Hide" : "Show all"}
              <ChevronDown className={`h-4 w-4 transition-transform ${showOlder ? "rotate-180" : ""}`} />
            </Button>
          </div>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            For enterprise customers pinning a specific version, every public release stays
            available indefinitely. Signed builds; same checksums on the docs.
          </p>
          {showOlder ? (
            <Card className="mt-6 divide-y divide-border/60 p-0">
              {PAST_RELEASES.map((r) => (
                <div key={r.version} className="grid grid-cols-1 gap-4 p-6 md:grid-cols-12">
                  <div className="md:col-span-3">
                    <div className="font-mono text-sm text-foreground">v{r.version}</div>
                    <div className="text-xs text-muted-foreground">{r.date}</div>
                  </div>
                  <ul className="space-y-1.5 md:col-span-7">
                    {r.highlights.map((h) => (
                      <li key={h} className="text-sm text-muted-foreground">
                        — {h}
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-col gap-1.5 md:col-span-2 md:items-end">
                    <a
                      href={`${DOWNLOAD_BASE_URL}/v${r.version}/Omninity-Operator-${r.version}.dmg`}
                      className="text-xs text-primary underline-offset-4 hover:underline"
                    >
                      Mac (.dmg)
                    </a>
                    <a
                      href={`${DOWNLOAD_BASE_URL}/v${r.version}/Omninity-Operator-Setup-${r.version}.exe`}
                      className="text-xs text-primary underline-offset-4 hover:underline"
                    >
                      Windows (.exe)
                    </a>
                  </div>
                </div>
              ))}
            </Card>
          ) : null}
        </div>
      </section>
    </>
  );
}
