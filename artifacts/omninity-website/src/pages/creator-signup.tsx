import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, CheckCircle2, Copy, Loader2, UserPlus } from "lucide-react";

import {
  useSignupStoreCreator,
  type StoreCreator,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SEO } from "@/components/seo";

export default function CreatorSignupPage() {
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [bio, setBio] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [result, setResult] = useState<{ account: StoreCreator; apiToken: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const signup = useSignupStoreCreator();

  async function go() {
    const res = await signup.mutateAsync({
      data: {
        displayName,
        ...(handle.trim() ? { handle: handle.trim() } : {}),
        ...(bio.trim() ? { bio: bio.trim() } : {}),
        ...(websiteUrl.trim() ? { websiteUrl: websiteUrl.trim() } : {}),
      },
    });
    setResult(res.data);
    localStorage.setItem("omninity:creator-token", res.data.apiToken);
  }

  function copyToken() {
    if (!result) return;
    void navigator.clipboard.writeText(result.apiToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <SEO
        title="Become a creator"
        description="Sign up as an Omninity Skill Store creator and publish your skills."
      />
      <section className="border-b border-border/40 py-12 md:py-16">
        <div className="mx-auto max-w-3xl px-5 md:px-8">
          <Link href="/creators" className="text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 inline h-3.5 w-3.5" /> Back to creators
          </Link>
          <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight md:text-5xl">
            Become a Skill Store creator.
          </h1>
          <p className="mt-3 text-base text-muted-foreground">
            Free, takes 30 seconds. You'll get a private API token used to publish skills
            from the Skill Creator wizard.
          </p>
        </div>
      </section>
      <section className="py-10">
        <div className="mx-auto max-w-3xl px-5 md:px-8">
          {!result ? (
            <Card className="p-6">
              <div className="grid gap-5">
                <div className="grid gap-2">
                  <Label htmlFor="displayName">Display name</Label>
                  <Input
                    id="displayName"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Ada Lovelace"
                    data-testid="input-creator-display-name"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="handle">Handle (optional)</Label>
                  <Input
                    id="handle"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value.toLowerCase())}
                    placeholder="ada"
                    data-testid="input-creator-handle"
                  />
                  <p className="text-xs text-muted-foreground">
                    Lowercase letters, numbers, and hyphens. Leave blank to derive from your display name.
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="bio">Bio (optional)</Label>
                  <Textarea
                    id="bio"
                    rows={3}
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    data-testid="input-creator-bio"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="websiteUrl">Website (optional)</Label>
                  <Input
                    id="websiteUrl"
                    value={websiteUrl}
                    onChange={(e) => setWebsiteUrl(e.target.value)}
                    placeholder="https://example.com"
                    data-testid="input-creator-website"
                  />
                </div>
                <div>
                  <Button
                    onClick={go}
                    disabled={signup.isPending || displayName.trim().length < 2}
                    data-testid="button-creator-signup"
                  >
                    {signup.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <UserPlus className="mr-2 h-4 w-4" />
                    )}
                    Sign up
                  </Button>
                </div>
                {signup.error ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                    Signup failed. Check that cloud/network features are enabled in Settings → Privacy.
                  </div>
                ) : null}
              </div>
            </Card>
          ) : (
            <Card className="border-primary/30 bg-primary/5 p-6">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                Your creator handle is <span className="font-mono">{result.account.handle}</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Save this API token somewhere safe — it's required to publish or update skills, and we
                only show it once.
              </p>
              <div className="mt-4 flex items-center gap-2 rounded-md border border-border bg-card/40 p-3 font-mono text-xs">
                <span className="flex-1 break-all" data-testid="text-creator-api-token">
                  {result.apiToken}
                </span>
                <Button size="sm" variant="outline" onClick={copyToken}>
                  <Copy className="mr-2 h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="mt-5 flex gap-2">
                <Link href="/creators/dashboard">
                  <Button>Go to dashboard</Button>
                </Link>
                <Link href="/marketplace/create">
                  <Button variant="outline">Create your first skill</Button>
                </Link>
              </div>
            </Card>
          )}
        </div>
      </section>
    </>
  );
}
