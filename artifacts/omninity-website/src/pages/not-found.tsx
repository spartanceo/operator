import { Link } from "wouter";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SEO } from "@/components/seo";

export default function NotFound() {
  return (
    <>
      <SEO
        title="Not found"
        description="The page you're looking for doesn't exist."
      />
      <section className="flex min-h-[70vh] items-center justify-center px-5 py-24 md:px-8">
        <div className="max-w-xl text-center">
          <div className="font-mono text-xs uppercase tracking-widest text-primary">404</div>
          <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight md:text-5xl">
            That page is somewhere else.
          </h1>
          <p className="mt-4 text-balance text-base leading-relaxed text-muted-foreground">
            The page you're looking for doesn't exist, or it moved without telling us.
            The marketplace and docs are the most popular places to land.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button variant="outline" asChild className="gap-2">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                Back home
              </Link>
            </Button>
            <Button asChild className="gap-2">
              <Link href="/marketplace">
                Browse skills
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
