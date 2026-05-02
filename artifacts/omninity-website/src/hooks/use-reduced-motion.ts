/**
 * `usePrefersReducedMotion` — reactive hook around the
 * `prefers-reduced-motion` media query.
 *
 * Components driving Framer Motion or CSS keyframe animations should call
 * this and either skip the animation entirely (`if (reduced) return null`)
 * or pass `transition={{ duration: 0 }}` so the WCAG 2.3.3 contract holds.
 *
 * The CSS layer in `index.css` already neutralises declarative animations
 * site-wide; this hook is for imperative motion drivers that the CSS rule
 * cannot reach.
 */

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function read(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(read);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(QUERY);
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return reduced;
}
