import { useMemo, useState } from "react";
import {
  Library,
  Plus,
  Trash2,
  Search,
  FolderPlus,
  Globe,
  FileText,
  Youtube,
  Folder,
  Download,
} from "lucide-react";
import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  useListKnowledgeCollections,
  useCreateKnowledgeCollection,
  useDeleteKnowledgeCollection,
  useListKnowledgeDocuments,
  useIngestKnowledgeDocument,
  useDeleteKnowledgeDocument,
  useSearchKnowledge,
  useGetKnowledgeStats,
  exportKnowledge,
  type KnowledgeSearchHit,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";

type SourceType = "text" | "url" | "youtube";

const SOURCE_LABEL: Record<SourceType, string> = {
  text: "Pasted text",
  url: "URL",
  youtube: "YouTube",
};

function sourceIcon(type: string) {
  if (type === "url") return <Globe className="h-3 w-3" />;
  if (type === "youtube") return <Youtube className="h-3 w-3" />;
  return <FileText className="h-3 w-3" />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function KnowledgePage() {
  const qc = useQueryClient();

  // Ingest dialog
  const [ingestOpen, setIngestOpen] = useState(false);
  const [sourceType, setSourceType] = useState<SourceType>("text");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [collectionId, setCollectionId] = useState<string>("");

  // Collection dialog
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [collectionName, setCollectionName] = useState("");

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");

  // Filter
  const [activeCollection, setActiveCollection] = useState<string | null>(null);

  const collectionsQuery = useListKnowledgeCollections({ limit: 50 });
  const collections = collectionsQuery.data?.data.items ?? [];

  const docsQuery = useListKnowledgeDocuments({
    limit: 50,
    ...(activeCollection ? { collectionId: activeCollection } : {}),
  });
  const documents = docsQuery.data?.data.items ?? [];

  const statsQuery = useGetKnowledgeStats();
  const stats = statsQuery.data?.data;

  const searchMutation = useSearchKnowledge();
  const searchHits: KnowledgeSearchHit[] =
    searchMutation.data?.data.hits ?? [];

  const ingest = useIngestKnowledgeDocument({
    mutation: {
      onSuccess: () => {
        setIngestOpen(false);
        setTitle("");
        setBody("");
        setUrl("");
        setTagsInput("");
        void qc.invalidateQueries();
      },
    },
  });

  const createCollection = useCreateKnowledgeCollection({
    mutation: {
      onSuccess: () => {
        setCollectionOpen(false);
        setCollectionName("");
        void qc.invalidateQueries();
      },
    },
  });

  const removeCollection = useDeleteKnowledgeCollection({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const removeDoc = useDeleteKnowledgeDocument({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const [isExporting, setIsExporting] = useState(false);

  const submitIngest = () => {
    if (!title.trim()) return;
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    ingest.mutate({
      data: {
        sourceType,
        title: title.trim(),
        ...(sourceType === "text" ? { body: body.trim() } : {}),
        ...(sourceType === "url" || sourceType === "youtube"
          ? { url: url.trim() }
          : {}),
        ...(collectionId ? { collectionId } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      },
    });
  };

  const submitSearch = () => {
    const q = searchQuery.trim();
    if (q.length === 0) return;
    setSubmittedQuery(q);
    searchMutation.mutate({
      data: {
        query: q,
        limit: 10,
        ...(activeCollection ? { collectionId: activeCollection } : {}),
      },
    });
  };

  const triggerExport = async () => {
    setIsExporting(true);
    try {
      const result = await exportKnowledge();
      const snapshot = result.data;
      if (!snapshot) return;
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `omninity-knowledge-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } finally {
      setIsExporting(false);
    }
  };

  const submitDisabled = useMemo(() => {
    if (!title.trim()) return true;
    if (sourceType === "text") return body.trim().length === 0;
    return url.trim().length === 0;
  }, [title, body, url, sourceType]);

  return (
    <OperatorLayout
      title="Knowledge"
      description="Local second brain — ingest documents, search semantically, feed agents."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={triggerExport}
            disabled={isExporting}
            data-testid="button-export-knowledge"
          >
            <Download className="mr-1 h-3 w-3" />
            {isExporting ? "Exporting…" : "Export"}
          </Button>
          <Dialog open={collectionOpen} onOpenChange={setCollectionOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" data-testid="button-add-collection">
                <FolderPlus className="mr-1 h-3 w-3" />
                Collection
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New collection</DialogTitle>
                <DialogDescription>
                  Group related documents so search can be scoped to one topic.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <Input
                  data-testid="input-collection-name"
                  placeholder="e.g. Customer interviews"
                  value={collectionName}
                  onChange={(e) => setCollectionName(e.target.value)}
                />
                <ErrorBanner error={createCollection.error} />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCollectionOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    createCollection.mutate({
                      data: { name: collectionName.trim() },
                    })
                  }
                  disabled={createCollection.isPending || !collectionName.trim()}
                  data-testid="button-save-collection"
                >
                  {createCollection.isPending ? "Saving…" : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={ingestOpen} onOpenChange={setIngestOpen}>
            <DialogTrigger asChild>
              <Button size="sm" data-testid="button-ingest-document">
                <Plus className="mr-1 h-3 w-3" />
                Ingest
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Ingest document</DialogTitle>
                <DialogDescription>
                  Paste text or fetch a URL — content is chunked and embedded locally.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  {(Object.keys(SOURCE_LABEL) as SourceType[]).map((s) => (
                    <Button
                      key={s}
                      type="button"
                      variant={sourceType === s ? "default" : "outline"}
                      size="sm"
                      onClick={() => setSourceType(s)}
                      data-testid={`button-source-${s}`}
                    >
                      {SOURCE_LABEL[s]}
                    </Button>
                  ))}
                </div>
                <Input
                  data-testid="input-document-title"
                  placeholder="Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                {sourceType === "text" ? (
                  <Textarea
                    data-testid="input-document-body"
                    placeholder="Paste the document content here…"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    className="min-h-[160px]"
                  />
                ) : (
                  <Input
                    data-testid="input-document-url"
                    placeholder={
                      sourceType === "youtube"
                        ? "https://www.youtube.com/watch?v=…"
                        : "https://…"
                    }
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                )}
                <Input
                  data-testid="input-document-tags"
                  placeholder="Tags (comma separated)"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                />
                <select
                  data-testid="select-document-collection"
                  value={collectionId}
                  onChange={(e) => setCollectionId(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">No collection</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <ErrorBanner error={ingest.error} />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIngestOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={submitIngest}
                  disabled={ingest.isPending || submitDisabled}
                  data-testid="button-save-ingest"
                >
                  {ingest.isPending ? "Ingesting…" : "Ingest"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 p-6 lg:grid-cols-[220px_1fr]">
        {/* Sidebar: collections + stats */}
        <aside className="space-y-3" data-testid="kb-sidebar">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                Stats
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Documents</span>
                <span data-testid="stat-documents">{stats?.documentCount ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Chunks</span>
                <span data-testid="stat-chunks">{stats?.chunkCount ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Collections</span>
                <span data-testid="stat-collections">{stats?.collectionCount ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Size</span>
                <span data-testid="stat-size">
                  {formatBytes(stats?.totalSizeBytes ?? 0)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                Collections
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <button
                type="button"
                onClick={() => setActiveCollection(null)}
                data-testid="filter-collection-all"
                className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-xs hover-elevate ${
                  activeCollection === null ? "bg-accent" : ""
                }`}
              >
                <span>All documents</span>
                <Badge variant="outline" className="text-[10px]">
                  {stats?.documentCount ?? 0}
                </Badge>
              </button>
              {collections.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-1"
                  data-testid={`collection-row-${c.id}`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveCollection(c.id)}
                    className={`flex flex-1 items-center justify-between rounded-md px-2 py-1 text-xs hover-elevate ${
                      activeCollection === c.id ? "bg-accent" : ""
                    }`}
                  >
                    <span className="flex items-center gap-1 truncate">
                      <Folder className="h-3 w-3" />
                      {c.name}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {c.documentCount}
                    </Badge>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => removeCollection.mutate({ id: c.id })}
                    aria-label="Delete collection"
                    data-testid={`button-delete-collection-${c.id}`}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </aside>

        {/* Main: search + documents */}
        <section className="space-y-4">
          <div className="flex gap-2">
            <Input
              data-testid="input-search-knowledge"
              placeholder="Search the knowledge base semantically…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitSearch();
              }}
            />
            <Button
              onClick={submitSearch}
              disabled={searchMutation.isPending || !searchQuery.trim()}
              data-testid="button-search-knowledge"
            >
              <Search className="mr-1 h-3 w-3" />
              Search
            </Button>
          </div>

          <ErrorBanner error={searchMutation.error} title="Search failed" />
          <ErrorBanner error={ingest.error} title="Ingest failed" />
          <ErrorBanner error={docsQuery.error} title="Couldn’t load documents" />

          {submittedQuery && (
            <Card data-testid="card-search-results">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Results for “{submittedQuery}”
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {searchHits.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No matches yet.</p>
                ) : (
                  searchHits.map((h) => (
                    <div
                      key={h.chunkId}
                      className="rounded-md border border-border bg-card/50 p-2"
                      data-testid={`search-hit-${h.chunkId}`}
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium">{h.documentTitle}</span>
                        <span className="text-muted-foreground">
                          score {h.score.toFixed(3)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-foreground/80">
                        {h.snippet}
                      </p>
                      {h.sourceUri && (
                        <a
                          href={h.sourceUri}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 block truncate text-[10px] text-muted-foreground underline"
                        >
                          {h.sourceUri}
                        </a>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          )}

          {documents.length === 0 && !docsQuery.isLoading ? (
            <EmptyState
              icon={<Library className="h-6 w-6" />}
              title="Your knowledge base is empty"
              description="Ingest a URL or paste text to start building a personal second brain."
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {documents.map((d) => (
                <Card key={d.id} data-testid={`document-card-${d.id}`}>
                  <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-sm">{d.title}</CardTitle>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">
                          <span className="mr-1">{sourceIcon(d.sourceType)}</span>
                          {d.sourceType}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {d.chunkCount} chunks
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {formatBytes(d.sizeBytes)}
                        </Badge>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeDoc.mutate({ id: d.id })}
                      disabled={removeDoc.isPending}
                      aria-label="Delete document"
                      data-testid={`button-delete-document-${d.id}`}
                    >
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </CardHeader>
                  <CardContent>
                    {d.summary && (
                      <p className="line-clamp-3 text-xs text-foreground/80">
                        {d.summary}
                      </p>
                    )}
                    {d.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {d.tags.slice(0, 4).map((t) => (
                          <Badge
                            key={t}
                            variant="secondary"
                            className="text-[10px]"
                          >
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      Ingested {new Date(d.createdAt).toLocaleString()}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </OperatorLayout>
  );
}
