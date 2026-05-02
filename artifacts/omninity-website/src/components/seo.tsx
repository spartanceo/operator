import { useEffect } from "react";

interface SEOProps {
  title: string;
  description: string;
  ogImage?: string;
  ogTags?: boolean;
}

function setMeta(name: string, content: string, attr: "name" | "property" = "name") {
  if (typeof document === "undefined") return;
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function SEO({ title, description, ogImage, ogTags = false }: SEOProps) {
  useEffect(() => {
    document.title = `${title} — Omninity Operator`;
    setMeta("description", description);
    if (ogTags) {
      setMeta("og:title", `${title} — Omninity Operator`, "property");
      setMeta("og:description", description, "property");
      setMeta("og:type", "website", "property");
      if (ogImage) setMeta("og:image", ogImage, "property");
      setMeta("twitter:card", "summary_large_image");
      setMeta("twitter:title", `${title} — Omninity Operator`);
      setMeta("twitter:description", description);
    }
  }, [title, description, ogImage, ogTags]);
  return null;
}
