import { useEffect } from "react";
import { useLocation } from "wouter";
import { useHelp } from "./help-context";

/**
 * Global keyboard handler. Wired once near the top of the operator
 * shell — listens for the shortcuts that are advertised in the
 * `SHORTCUT_SECTIONS` registry and dispatches them.
 *
 * Bindings:
 *   ⌘/  → open shortcut overlay
 *   ⌘?  → open help centre
 *   ⌘N  → new conversation (delegated via `data-testid` on the chat page)
 *   ⌘K  → focus the chat input
 *   g+c → /chat   (vim-style sequence)
 *   g+a → /agents
 *   g+p → /privacy
 *   g+s → /settings
 *
 * The component intentionally returns `null` — it owns no DOM, only
 * keyboard side-effects.
 */
export function GlobalKeyboardShortcuts() {
  const [, navigate] = useLocation();
  const { openShortcuts, openPanel } = useHelp();

  useEffect(() => {
    let waitingForG = false;
    let resetTimer: number | null = null;

    const isTextField = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (target.isContentEditable) return true;
      return false;
    };

    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;

      // ⌘/  — shortcut overlay
      if (cmd && e.key === "/") {
        e.preventDefault();
        openShortcuts();
        return;
      }
      // ⌘?  — help centre
      if (cmd && (e.key === "?" || (e.shiftKey && e.key === "/"))) {
        e.preventDefault();
        openPanel();
        return;
      }
      // ⌘K  — focus chat input
      if (cmd && (e.key === "k" || e.key === "K")) {
        const input = document.querySelector(
          "[data-testid='input-chat']",
        ) as HTMLTextAreaElement | null;
        if (input) {
          e.preventDefault();
          input.focus();
        }
        return;
      }
      // ⌘N  — new conversation (only if the trigger exists on the page)
      if (cmd && (e.key === "n" || e.key === "N")) {
        const button = document.querySelector(
          "[data-testid='button-new-conversation']",
        ) as HTMLButtonElement | null;
        if (button) {
          e.preventDefault();
          button.click();
        }
        return;
      }

      // Vim-style "g x" navigation. Skip when typing in a field.
      if (isTextField(e.target)) return;
      if (cmd || e.altKey || e.shiftKey) return;

      if (waitingForG) {
        if (e.key === "c") navigate("/chat");
        else if (e.key === "a") navigate("/agents");
        else if (e.key === "p") navigate("/privacy");
        else if (e.key === "s") navigate("/settings");
        else if (e.key === "h") openPanel();
        waitingForG = false;
        if (resetTimer) {
          window.clearTimeout(resetTimer);
          resetTimer = null;
        }
        return;
      }

      if (e.key === "g") {
        waitingForG = true;
        if (resetTimer) window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
          waitingForG = false;
          resetTimer = null;
        }, 800);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (resetTimer) window.clearTimeout(resetTimer);
    };
  }, [navigate, openShortcuts, openPanel]);

  return null;
}
