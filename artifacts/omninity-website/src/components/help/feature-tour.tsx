import { useEffect, useLayoutEffect, useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, Compass, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useHelp } from "./help-context";
import { FEATURE_TOURS, type FeatureTour } from "./help-content";

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOTLIGHT_PADDING = 8;

/**
 * Feature-tour engine.
 *
 * The tour reads `FEATURE_TOURS` from the content registry, finds the
 * tour that matches the current operator path, and runs through its
 * steps. Each step optionally points at a CSS selector — when the node
 * is present we draw a soft ring around it; otherwise the step renders
 * as a centered card.
 *
 * The tour autostarts the first time a user visits a page (skip is
 * remembered the same as completion). Replay from the help panel resets
 * the completion flag and re-arms the tour.
 */
export function FeatureTour() {
  const [location] = useLocation();
  const {
    isTourCompleted,
    completeTour,
    activeTourId,
    startTour,
    endTour,
  } = useHelp();
  const [stepIndex, setStepIndex] = useState(0);
  const [spotlight, setSpotlight] = useState<SpotlightRect | null>(null);

  const tour: FeatureTour | null =
    FEATURE_TOURS.find((t) => t.page === location) ??
    FEATURE_TOURS.find((t) => t.id === activeTourId) ??
    null;

  // Auto-start once per user per page.
  useEffect(() => {
    if (!tour) return;
    if (activeTourId) return;
    if (isTourCompleted(tour.id)) return;
    // Slight delay so the page has time to render its anchors.
    const t = setTimeout(() => {
      startTour(tour.id);
      setStepIndex(0);
    }, 600);
    return () => clearTimeout(t);
  }, [tour, activeTourId, isTourCompleted, startTour]);

  // Reset step index when the active tour changes.
  useEffect(() => {
    if (activeTourId && tour && tour.id === activeTourId) {
      setStepIndex(0);
    }
  }, [activeTourId, tour]);

  const isOpen = Boolean(activeTourId && tour && tour.id === activeTourId);
  const step = isOpen ? tour!.steps[stepIndex] : null;

  // Recompute the spotlight rectangle whenever the visible step changes
  // or the window resizes — keeps the ring glued to the anchor element.
  useLayoutEffect(() => {
    if (!isOpen || !step) {
      setSpotlight(null);
      return;
    }
    const compute = () => {
      if (!step.selector) {
        setSpotlight(null);
        return;
      }
      const node = document.querySelector(step.selector);
      if (!(node instanceof HTMLElement)) {
        setSpotlight(null);
        return;
      }
      const rect = node.getBoundingClientRect();
      setSpotlight({
        top: rect.top - SPOTLIGHT_PADDING,
        left: rect.left - SPOTLIGHT_PADDING,
        width: rect.width + SPOTLIGHT_PADDING * 2,
        height: rect.height + SPOTLIGHT_PADDING * 2,
      });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [isOpen, step]);

  if (!isOpen || !tour || !step) return null;

  const total = tour.steps.length;
  const isLast = stepIndex === total - 1;
  const isFirst = stepIndex === 0;

  const finish = (markComplete: boolean) => {
    if (markComplete) completeTour(tour.id);
    endTour();
  };

  const next = () => {
    if (isLast) {
      finish(true);
      return;
    }
    setStepIndex((curr) => Math.min(curr + 1, total - 1));
  };

  const prev = () => {
    setStepIndex((curr) => Math.max(curr - 1, 0));
  };

  const skip = () => finish(true);

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[60]"
      data-testid={`feature-tour-${tour.id}`}
    >
      <div className="pointer-events-auto absolute inset-0 bg-background/70 backdrop-blur-sm" />

      {spotlight ? (
        <div
          className="pointer-events-none absolute rounded-xl ring-4 ring-primary/60 transition-all"
          style={{
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
            boxShadow: "0 0 0 9999px hsla(var(--background) / 0.55)",
          }}
        />
      ) : null}

      <div
        className={cn(
          "pointer-events-auto absolute w-[min(420px,calc(100%-2rem))] rounded-xl border border-border bg-popover p-5 shadow-2xl",
          spotlight
            ? "top-auto"
            : "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
        )}
        style={
          spotlight
            ? cardStyleFromSpotlight(spotlight)
            : undefined
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Compass className="h-3.5 w-3.5 text-primary" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {tour.title} · {stepIndex + 1} of {total}
            </span>
          </div>
          <button
            type="button"
            onClick={skip}
            aria-label="Skip tour"
            data-testid="feature-tour-skip"
            className="hover-elevate -m-1 rounded-md p-1 text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <h2 className="mt-3 text-base font-semibold text-foreground">
          {step.title}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {step.body}
        </p>

        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={skip}
            data-testid="feature-tour-skip-link"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={prev}
              disabled={isFirst}
              data-testid="feature-tour-prev"
            >
              <ChevronLeft className="mr-1 h-3 w-3" />
              Back
            </Button>
            <Button
              size="sm"
              onClick={next}
              data-testid="feature-tour-next"
            >
              {isLast ? "Finish" : "Next"}
              {isLast ? null : <ChevronRight className="ml-1 h-3 w-3" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Positions the tour card just below or above the spotlight rect,
 *  whichever side has more room. Falls back to a centered position if
 *  neither side fits — the card is bounded by a max-width so this
 *  doesn't run into the viewport edges. */
function cardStyleFromSpotlight(rect: SpotlightRect): React.CSSProperties {
  const viewportH = typeof window === "undefined" ? 800 : window.innerHeight;
  const viewportW = typeof window === "undefined" ? 1200 : window.innerWidth;
  const cardWidth = Math.min(420, viewportW - 32);
  const cardEstimatedHeight = 220;
  const spaceBelow = viewportH - (rect.top + rect.height);
  const showBelow = spaceBelow > cardEstimatedHeight + 24;

  // Horizontal: clamp the card so it stays inside the viewport.
  let left = rect.left + rect.width / 2 - cardWidth / 2;
  left = Math.max(16, Math.min(left, viewportW - cardWidth - 16));

  return {
    top: showBelow ? rect.top + rect.height + 16 : rect.top - cardEstimatedHeight - 16,
    left,
  };
}
