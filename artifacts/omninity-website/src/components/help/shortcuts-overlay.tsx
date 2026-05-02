import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useHelp } from "./help-context";
import { SHORTCUT_SECTIONS } from "./help-content";

/**
 * Global keyboard-shortcut reference. Triggered by ⌘/ (Ctrl+/ on
 * Windows / Linux) or by the help icon in the operator header.
 */
export function ShortcutsOverlay() {
  const { shortcutsOpen, closeShortcuts } = useHelp();

  return (
    <Dialog
      open={shortcutsOpen}
      onOpenChange={(open) => (!open ? closeShortcuts() : null)}
    >
      <DialogContent
        className="max-w-2xl"
        data-testid="shortcuts-overlay"
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Every command Operator responds to from the keyboard. Press{" "}
            <Kbd>⌘</Kbd>
            <Kbd>/</Kbd> any time to reopen this panel.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {SHORTCUT_SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </h3>
              <ul className="space-y-2">
                {section.shortcuts.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-card/40 px-2 py-1.5"
                    data-testid={`shortcut-${s.id}`}
                  >
                    <span className="text-xs text-foreground">
                      {s.description}
                    </span>
                    <KbdGroup>
                      {s.keys.map((k, i) => (
                        <Kbd key={`${s.id}-${i}`}>{k}</Kbd>
                      ))}
                    </KbdGroup>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
