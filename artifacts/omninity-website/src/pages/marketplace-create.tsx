import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  Upload,
  ClipboardPaste,
  MessagesSquare,
  Sparkles,
  CheckCircle2,
  Loader2,
  Send,
  Save,
  Rocket,
} from "lucide-react";
import {
  useCreateSkillDraftFromUpload,
  useCreateSkillDraftFromPaste,
  useStartSkillDraftInterview,
  useAnswerSkillDraftInterview,
  useUpdateSkillDraft,
  useTestSkillDraft,
  usePublishSkillDraft,
  type SkillDraft,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";
import { cn } from "@/lib/utils";

const ACCEPT_FILES = ".pdf,.epub,.docx,.txt,.md,.markdown";

function fileExt(name: string): string {
  const m = /\.([^.]+)$/.exec(name.toLowerCase());
  return m?.[1] ?? "txt";
}

async function readFileAsBase64(file: File): Promise<{ base64: string; text?: string }> {
  // For text-shaped formats we send the decoded text; binary formats go as base64.
  const ext = fileExt(file.name);
  if (ext === "txt" || ext === "md" || ext === "markdown") {
    const text = await file.text();
    return { base64: "", text };
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // tier-review: bounded — chunked encode caps the per-iteration string at 0x8000 chars.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { base64: btoa(binary) };
}

interface DraftEditorProps {
  draft: SkillDraft;
  onChange: (next: SkillDraft) => void;
}

function DraftEditor({ draft, onChange }: DraftEditorProps) {
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [content, setContent] = useState(draft.content);
  const [triggers, setTriggers] = useState(draft.triggers.join(", "));
  const [examples, setExamples] = useState(draft.examplePrompts.join("\n"));
  const [category, setCategory] = useState(draft.category);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setName(draft.name);
    setDescription(draft.description);
    setContent(draft.content);
    setTriggers(draft.triggers.join(", "));
    setExamples(draft.examplePrompts.join("\n"));
    setCategory(draft.category);
  }, [draft.id, draft.version]);

  const update = useUpdateSkillDraft();

  async function save() {
    setSaving(true);
    try {
      const res = await update.mutateAsync({
        id: draft.id,
        data: {
          name,
          description,
          content,
          triggers: triggers
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
          examplePrompts: examples
            .split("\n")
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
          category,
        },
      });
      onChange(res.data);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="skill-name">Skill name</Label>
        <Input
          id="skill-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="input-draft-name"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="skill-desc">Short description</Label>
        <Textarea
          id="skill-desc"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="input-draft-description"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="skill-content">Skill prompt (what the agent will read)</Label>
        <Textarea
          id="skill-content"
          rows={10}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="font-mono text-sm"
          data-testid="input-draft-content"
        />
      </div>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="skill-triggers">Trigger phrases (comma-separated)</Label>
          <Input
            id="skill-triggers"
            value={triggers}
            onChange={(e) => setTriggers(e.target.value)}
            data-testid="input-draft-triggers"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="skill-category">Category</Label>
          <Input
            id="skill-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            data-testid="input-draft-category"
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="skill-examples">Example prompts (one per line)</Label>
        <Textarea
          id="skill-examples"
          rows={3}
          value={examples}
          onChange={(e) => setExamples(e.target.value)}
          data-testid="input-draft-examples"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving} data-testid="button-draft-save">
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save changes
        </Button>
        {savedAt ? (
          <span className="text-xs text-muted-foreground">Saved {new Date(savedAt).toLocaleTimeString()}</span>
        ) : null}
      </div>
    </div>
  );
}

interface TesterProps {
  draft: SkillDraft;
}

function Tester({ draft }: TesterProps) {
  const [message, setMessage] = useState(
    draft.examplePrompts[0] ?? `Demonstrate ${draft.name || "the skill"}.`,
  );
  const [reply, setReply] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const test = useTestSkillDraft();

  async function run() {
    setReply("");
    const result = await test.mutateAsync({
      id: draft.id,
      data: { message },
    });
    setReply(result.data.reply);
    setModel(result.data.model);
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <div className="text-sm font-medium">Live tester (local LLM)</div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Runs against Ollama on this machine. The model name comes from this draft's compatible models list.
      </p>
      <div className="mt-4 grid gap-3">
        <Textarea
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Try a question this skill should answer well…"
          data-testid="input-tester-message"
        />
        <div>
          <Button
            onClick={run}
            disabled={test.isPending || !message.trim()}
            data-testid="button-tester-run"
          >
            {test.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Run
          </Button>
        </div>
        {reply ? (
          <div className="rounded-md border border-border bg-card/40 p-4 text-sm leading-relaxed">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              Reply{model ? ` · ${model}` : ""}
            </div>
            <div className="whitespace-pre-wrap font-sans">{reply}</div>
          </div>
        ) : null}
        {test.error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            Tester failed. If Ollama isn't running locally, start it and try again.
          </div>
        ) : null}
      </div>
    </Card>
  );
}

interface PublisherProps {
  draft: SkillDraft;
}

function Publisher({ draft }: PublisherProps) {
  const [token, setToken] = useState(localStorage.getItem("omninity:creator-token") ?? "");
  const [docs, setDocs] = useState("");
  const [published, setPublished] = useState<{ creatorHandle: string; slug: string } | null>(null);
  const publish = usePublishSkillDraft();

  async function go() {
    const result = await publish.mutateAsync({
      data: {
        draftId: draft.id,
        apiToken: token,
        documentation: docs,
      },
    });
    if (token) localStorage.setItem("omninity:creator-token", token);
    setPublished({
      creatorHandle: result.data.creatorHandle,
      slug: result.data.slug,
    });
  }

  if (published) {
    return (
      <Card className="border-primary/30 bg-primary/5 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          Published to the Skill Store.
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          People can now find your skill at <span className="font-mono">{published.creatorHandle}/{published.slug}</span>.
        </p>
        <div className="mt-4 flex gap-2">
          <Link href={`/creators/${published.creatorHandle}`}>
            <Button variant="outline" size="sm">View profile</Button>
          </Link>
          <Link href="/marketplace">
            <Button size="sm">Back to marketplace</Button>
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Rocket className="h-4 w-4 text-primary" />
        <div className="text-sm font-medium">Publish to the Skill Store</div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Optional. Drafts are usable on this machine without ever publishing. Need a token?{" "}
        <Link href="/creators/signup" className="text-primary underline-offset-2 hover:underline">
          Sign up as a creator
        </Link>
        .
      </p>
      <div className="mt-4 grid gap-3">
        <div className="grid gap-2">
          <Label htmlFor="creator-token">Creator API token</Label>
          <Input
            id="creator-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="cr_…"
            data-testid="input-publish-token"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="creator-docs">Documentation (optional, markdown)</Label>
          <Textarea
            id="creator-docs"
            rows={4}
            value={docs}
            onChange={(e) => setDocs(e.target.value)}
            data-testid="input-publish-docs"
          />
        </div>
        <div>
          <Button
            onClick={go}
            disabled={publish.isPending || !token.trim() || draft.status === "published"}
            data-testid="button-publish-draft"
          >
            {publish.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="mr-2 h-4 w-4" />
            )}
            Publish version {(draft.publishedStoreSkillId ? "+1" : "1")}
          </Button>
        </div>
        {publish.error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            Publish failed. Check the token and that cloud features are enabled in Settings → Privacy.
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export default function MarketplaceCreatePage() {
  const [, navigate] = useLocation();
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [tab, setTab] = useState("upload");

  // Upload path state
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const upload = useCreateSkillDraftFromUpload();

  // Paste path state
  const [pasteText, setPasteText] = useState("");
  const paste = useCreateSkillDraftFromPaste();

  // Interview path state
  const startInterview = useStartSkillDraftInterview();
  const answerInterview = useAnswerSkillDraftInterview();
  const [interviewAnswer, setInterviewAnswer] = useState("");

  const interviewActive = draft?.source === "interview" && draft.status !== "published" && draft.status !== "ready";
  const lastInterviewQuestion = useMemo(() => {
    const turns = draft?.interviewTranscript ?? [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t && t.role === "assistant") return t.content;
    }
    return "";
  }, [draft]);

  async function handleUpload() {
    if (!uploadFile) return;
    const { base64, text } = await readFileAsBase64(uploadFile);
    const result = await upload.mutateAsync({
      data: {
        fileName: uploadFile.name,
        kind: fileExt(uploadFile.name),
        ...(base64 ? { base64 } : {}),
        ...(text ? { text } : {}),
      },
    });
    setDraft(result.data);
  }

  async function handlePaste() {
    if (!pasteText.trim()) return;
    const result = await paste.mutateAsync({ data: { text: pasteText } });
    setDraft(result.data);
  }

  async function handleStartInterview() {
    const result = await startInterview.mutateAsync();
    setDraft(result.data);
  }

  async function handleAnswer() {
    if (!draft || !interviewAnswer.trim()) return;
    const result = await answerInterview.mutateAsync({
      id: draft.id,
      data: { answer: interviewAnswer },
    });
    setDraft(result.data);
    setInterviewAnswer("");
  }

  return (
    <>
      <SEO
        title="Create a skill"
        description="Build a no-code Operator skill in minutes. Upload a document, paste your notes, or have the local model interview you."
      />
      <section className="border-b border-border/40 py-12 md:py-16">
        <div className="mx-auto max-w-5xl px-5 md:px-8">
          <Link href="/marketplace" className="text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 inline h-3.5 w-3.5" /> Back to marketplace
          </Link>
          <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight md:text-5xl">
            Create a skill, three ways.
          </h1>
          <p className="mt-3 max-w-2xl text-base text-muted-foreground">
            Drop in a PDF, paste a brief, or let your local model interview you. We'll
            draft the skill, you tweak it, and it's ready to use — privately, on your
            machine. Optionally publish it to the Skill Store.
          </p>
        </div>
      </section>
      <section className="py-10">
        <div className="mx-auto grid max-w-5xl gap-8 px-5 md:px-8">
          {!draft ? (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="upload" data-testid="tab-upload">
                  <Upload className="mr-2 h-4 w-4" /> Upload
                </TabsTrigger>
                <TabsTrigger value="paste" data-testid="tab-paste">
                  <ClipboardPaste className="mr-2 h-4 w-4" /> Paste
                </TabsTrigger>
                <TabsTrigger value="interview" data-testid="tab-interview">
                  <MessagesSquare className="mr-2 h-4 w-4" /> Interview
                </TabsTrigger>
              </TabsList>
              <TabsContent value="upload" className="mt-6">
                <Card className="p-6">
                  <div className="text-sm font-medium">Upload your source material</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    PDF, EPUB, DOCX, TXT, or Markdown. Stays on your machine — extraction
                    happens locally.
                  </p>
                  <div className="mt-5 grid gap-3">
                    <Input
                      type="file"
                      accept={ACCEPT_FILES}
                      onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                      data-testid="input-upload-file"
                    />
                    <div>
                      <Button
                        onClick={handleUpload}
                        disabled={!uploadFile || upload.isPending}
                        data-testid="button-upload-submit"
                      >
                        {upload.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="mr-2 h-4 w-4" />
                        )}
                        Draft skill from file
                      </Button>
                    </div>
                    {upload.error ? (
                      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                        Upload failed. Try a smaller file or paste the contents instead.
                      </div>
                    ) : null}
                  </div>
                </Card>
              </TabsContent>
              <TabsContent value="paste" className="mt-6">
                <Card className="p-6">
                  <div className="text-sm font-medium">Paste your brief</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Anything from a paragraph to a long article. The local model will
                    structure it into a draft skill.
                  </p>
                  <div className="mt-5 grid gap-3">
                    <Textarea
                      rows={10}
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      placeholder="Paste book chapters, course notes, SOPs, brand guidelines…"
                      data-testid="input-paste-text"
                    />
                    <div>
                      <Button
                        onClick={handlePaste}
                        disabled={pasteText.trim().length < 20 || paste.isPending}
                        data-testid="button-paste-submit"
                      >
                        {paste.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="mr-2 h-4 w-4" />
                        )}
                        Draft skill from text
                      </Button>
                    </div>
                  </div>
                </Card>
              </TabsContent>
              <TabsContent value="interview" className="mt-6">
                <Card className="p-6">
                  <div className="text-sm font-medium">Have the model interview you</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Seven plain-language questions. The model rolls your answers into a
                    draft you can edit.
                  </p>
                  <div className="mt-5">
                    <Button
                      onClick={handleStartInterview}
                      disabled={startInterview.isPending}
                      data-testid="button-interview-start"
                    >
                      {startInterview.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <MessagesSquare className="mr-2 h-4 w-4" />
                      )}
                      Start the interview
                    </Button>
                  </div>
                </Card>
              </TabsContent>
            </Tabs>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="outline" className="rounded-full text-[10px] uppercase tracking-wider">
                  {draft.source}
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    "rounded-full text-[10px] uppercase tracking-wider",
                    draft.status === "published"
                      ? "border-primary/40 text-primary"
                      : "text-muted-foreground",
                  )}
                >
                  {draft.status}
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft(null);
                    setUploadFile(null);
                    setPasteText("");
                  }}
                  data-testid="button-restart-wizard"
                >
                  Start over
                </Button>
              </div>
              {interviewActive ? (
                <Card className="border-primary/30 bg-primary/5 p-5">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Question {draft.interviewStep + 1} of 7
                  </div>
                  <div className="mt-2 text-base font-medium">{lastInterviewQuestion}</div>
                  <Textarea
                    rows={4}
                    value={interviewAnswer}
                    onChange={(e) => setInterviewAnswer(e.target.value)}
                    className="mt-4"
                    data-testid="input-interview-answer"
                  />
                  <div className="mt-3">
                    <Button
                      onClick={handleAnswer}
                      disabled={!interviewAnswer.trim() || answerInterview.isPending}
                      data-testid="button-interview-answer"
                    >
                      {answerInterview.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="mr-2 h-4 w-4" />
                      )}
                      Next
                    </Button>
                  </div>
                </Card>
              ) : (
                <>
                  <Card className="p-6">
                    <div className="mb-5 text-sm font-medium">Edit your skill</div>
                    <DraftEditor draft={draft} onChange={setDraft} />
                  </Card>
                  <Tester draft={draft} />
                  <Publisher draft={draft} />
                </>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}
