/**
 * Help-system context.
 *
 * Owns the slice of UI state that powers tooltips, the help panel,
 * onboarding checklist progress, feature tours, "what's new" highlights
 * and the keyboard-shortcut overlay. State is persisted to localStorage
 * so a "shown once" tooltip is genuinely shown once across reloads.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STORAGE_PREFIX = "omninity.operator.help.";
const KEY_TOOLTIPS = `${STORAGE_PREFIX}tooltips.v1`;
const KEY_CHECKLIST = `${STORAGE_PREFIX}checklist.v1`;
const KEY_TOURS = `${STORAGE_PREFIX}tours.v1`;
const KEY_FEATURES = `${STORAGE_PREFIX}features.v1`;
const KEY_FEEDBACK = `${STORAGE_PREFIX}feedback.v1`;
const KEY_CHECKLIST_DISMISSED = `${STORAGE_PREFIX}checklistDismissed.v1`;

type StringSet = Record<string, true>;
type FeedbackMap = Record<string, "yes" | "no">;

interface PersistedState {
  tooltips: StringSet;
  checklist: StringSet;
  tours: StringSet;
  features: StringSet;
  feedback: FeedbackMap;
  checklistDismissed: boolean;
}

interface HelpPanelState {
  open: boolean;
  articleId: string | null;
}

interface HelpContextValue {
  panel: HelpPanelState;
  openPanel: (articleId?: string | null) => void;
  closePanel: () => void;

  shortcutsOpen: boolean;
  openShortcuts: () => void;
  closeShortcuts: () => void;

  isTooltipDismissed: (id: string) => boolean;
  dismissTooltip: (id: string) => void;
  resetTooltips: () => void;

  isChecklistComplete: (id: string) => boolean;
  completeChecklistItem: (id: string) => void;
  isChecklistDismissed: boolean;
  dismissChecklist: () => void;
  resetChecklist: () => void;

  isTourCompleted: (id: string) => boolean;
  completeTour: (id: string) => void;
  resetTour: (id: string) => void;
  activeTourId: string | null;
  startTour: (id: string) => void;
  endTour: () => void;

  isFeatureSeen: (id: string) => boolean;
  markFeatureSeen: (id: string) => void;

  feedback: FeedbackMap;
  setArticleFeedback: (articleId: string, value: "yes" | "no") => void;
}

const HelpContext = createContext<HelpContextValue | null>(null);

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readSet(key: string): StringSet {
  const ls = safeStorage();
  if (!ls) return {};
  const raw = ls.getItem(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: StringSet = {};
      for (const k of Object.keys(parsed as Record<string, unknown>)) {
        out[k] = true;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function readFeedback(key: string): FeedbackMap {
  const ls = safeStorage();
  if (!ls) return {};
  const raw = ls.getItem(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: FeedbackMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === "yes" || v === "no") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function readBool(key: string): boolean {
  const ls = safeStorage();
  if (!ls) return false;
  return ls.getItem(key) === "1";
}

function writeJSON(key: string, value: unknown): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(key, JSON.stringify(value));
  } catch {
    /* storage disabled — silently ignore */
  }
}

function writeBool(key: string, value: boolean): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(key, value ? "1" : "0");
  } catch {
    /* storage disabled */
  }
}

function loadInitial(): PersistedState {
  return {
    tooltips: readSet(KEY_TOOLTIPS),
    checklist: readSet(KEY_CHECKLIST),
    tours: readSet(KEY_TOURS),
    features: readSet(KEY_FEATURES),
    feedback: readFeedback(KEY_FEEDBACK),
    checklistDismissed: readBool(KEY_CHECKLIST_DISMISSED),
  };
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [persisted, setPersisted] = useState<PersistedState>(() => loadInitial());
  const [panel, setPanel] = useState<HelpPanelState>({
    open: false,
    articleId: null,
  });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [activeTourId, setActiveTourId] = useState<string | null>(null);

  // Persist whenever the slice changes — small, debouncing isn't needed
  // at this volume (the user dismisses ~handful of tooltips per session).
  useEffect(() => {
    writeJSON(KEY_TOOLTIPS, persisted.tooltips);
  }, [persisted.tooltips]);
  useEffect(() => {
    writeJSON(KEY_CHECKLIST, persisted.checklist);
  }, [persisted.checklist]);
  useEffect(() => {
    writeJSON(KEY_TOURS, persisted.tours);
  }, [persisted.tours]);
  useEffect(() => {
    writeJSON(KEY_FEATURES, persisted.features);
  }, [persisted.features]);
  useEffect(() => {
    writeJSON(KEY_FEEDBACK, persisted.feedback);
  }, [persisted.feedback]);
  useEffect(() => {
    writeBool(KEY_CHECKLIST_DISMISSED, persisted.checklistDismissed);
  }, [persisted.checklistDismissed]);

  const openPanel = useCallback((articleId: string | null = null) => {
    setPanel({ open: true, articleId });
  }, []);
  const closePanel = useCallback(() => {
    setPanel((curr) => ({ ...curr, open: false }));
  }, []);

  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);

  const dismissTooltip = useCallback((id: string) => {
    setPersisted((curr) =>
      curr.tooltips[id]
        ? curr
        : { ...curr, tooltips: { ...curr.tooltips, [id]: true } },
    );
  }, []);
  const isTooltipDismissed = useCallback(
    (id: string) => Boolean(persisted.tooltips[id]),
    [persisted.tooltips],
  );
  const resetTooltips = useCallback(() => {
    setPersisted((curr) => ({ ...curr, tooltips: {} }));
  }, []);

  const completeChecklistItem = useCallback((id: string) => {
    setPersisted((curr) =>
      curr.checklist[id]
        ? curr
        : { ...curr, checklist: { ...curr.checklist, [id]: true } },
    );
  }, []);
  const isChecklistComplete = useCallback(
    (id: string) => Boolean(persisted.checklist[id]),
    [persisted.checklist],
  );
  const dismissChecklist = useCallback(() => {
    setPersisted((curr) => ({ ...curr, checklistDismissed: true }));
  }, []);
  const resetChecklist = useCallback(() => {
    setPersisted((curr) => ({
      ...curr,
      checklist: {},
      checklistDismissed: false,
    }));
  }, []);

  const completeTour = useCallback((id: string) => {
    setPersisted((curr) =>
      curr.tours[id] ? curr : { ...curr, tours: { ...curr.tours, [id]: true } },
    );
  }, []);
  const isTourCompleted = useCallback(
    (id: string) => Boolean(persisted.tours[id]),
    [persisted.tours],
  );
  const resetTour = useCallback((id: string) => {
    setPersisted((curr) => {
      if (!curr.tours[id]) return curr;
      const next = { ...curr.tours };
      delete next[id];
      return { ...curr, tours: next };
    });
  }, []);
  const startTour = useCallback((id: string) => setActiveTourId(id), []);
  const endTour = useCallback(() => setActiveTourId(null), []);

  const markFeatureSeen = useCallback((id: string) => {
    setPersisted((curr) =>
      curr.features[id]
        ? curr
        : { ...curr, features: { ...curr.features, [id]: true } },
    );
  }, []);
  const isFeatureSeen = useCallback(
    (id: string) => Boolean(persisted.features[id]),
    [persisted.features],
  );

  const setArticleFeedback = useCallback(
    (articleId: string, value: "yes" | "no") => {
      setPersisted((curr) => ({
        ...curr,
        feedback: { ...curr.feedback, [articleId]: value },
      }));
    },
    [],
  );

  const value = useMemo<HelpContextValue>(
    () => ({
      panel,
      openPanel,
      closePanel,
      shortcutsOpen,
      openShortcuts,
      closeShortcuts,
      isTooltipDismissed,
      dismissTooltip,
      resetTooltips,
      isChecklistComplete,
      completeChecklistItem,
      isChecklistDismissed: persisted.checklistDismissed,
      dismissChecklist,
      resetChecklist,
      isTourCompleted,
      completeTour,
      resetTour,
      activeTourId,
      startTour,
      endTour,
      isFeatureSeen,
      markFeatureSeen,
      feedback: persisted.feedback,
      setArticleFeedback,
    }),
    [
      panel,
      openPanel,
      closePanel,
      shortcutsOpen,
      openShortcuts,
      closeShortcuts,
      isTooltipDismissed,
      dismissTooltip,
      resetTooltips,
      isChecklistComplete,
      completeChecklistItem,
      persisted.checklistDismissed,
      dismissChecklist,
      resetChecklist,
      isTourCompleted,
      completeTour,
      resetTour,
      activeTourId,
      startTour,
      endTour,
      isFeatureSeen,
      markFeatureSeen,
      persisted.feedback,
      setArticleFeedback,
    ],
  );

  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useHelp(): HelpContextValue {
  const ctx = useContext(HelpContext);
  if (!ctx) {
    throw new Error("useHelp must be used inside a <HelpProvider>.");
  }
  return ctx;
}
