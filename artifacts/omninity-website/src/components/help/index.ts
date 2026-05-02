/** Public re-exports for the help/documentation system. */
export { HelpProvider, useHelp } from "./help-context";
export { HelpPanel } from "./help-panel";
export { HelpIcon } from "./help-icon";
export { FirstTimeTooltip } from "./first-time-tooltip";
export { FeatureHighlight } from "./feature-highlight";
export { ShortcutsOverlay } from "./shortcuts-overlay";
export { OnboardingChecklist } from "./onboarding-checklist";
export { FeatureTour } from "./feature-tour";
export { InlineHints } from "./inline-hints";
export { GlobalKeyboardShortcuts } from "./keyboard-shortcuts";
export {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  CHECKLIST_ITEMS,
  FEATURE_TOURS,
  SHORTCUT_SECTIONS,
  CONTEXT_HINTS,
  FEATURE_HIGHLIGHTS,
  searchArticles,
} from "./help-content";
export type {
  HelpArticle,
  HelpCategory,
  HelpCategoryId,
  ChecklistItem,
  FeatureTour as FeatureTourSpec,
  FeatureTourStep,
  ShortcutSection,
  ContextHint,
  FeatureHighlight as FeatureHighlightSpec,
} from "./help-content";
