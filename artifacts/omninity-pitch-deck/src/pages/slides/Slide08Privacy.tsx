const base = import.meta.env.BASE_URL;

export default function Slide08Privacy() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "var(--slide-bg)" }}>
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 60% 60% at 50% 50%, rgba(var(--slide-accent-rgb),0.06) 0%, transparent 70%)"
        }}
      />

      <div className="absolute" style={{ left: "7vw", top: "8vh", right: "7vw" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 700,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--slide-accent)",
          marginBottom: "1vh"
        }}>
          Privacy & Security
        </div>
        <div style={{
          fontFamily: "Syne, sans-serif",
          fontSize: "3.5vw",
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          color: "var(--slide-text)",
          marginBottom: "1vh"
        }}>
          Privacy is architecture, not a setting.
        </div>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.6vw",
          color: "rgba(var(--slide-text-rgb),0.5)",
          marginBottom: "3vh"
        }}>
          Four controls that ship in the base product — no enterprise tier required.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2vw", alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "1.5vh" }}>
            <div style={{ background: "rgba(var(--slide-accent-rgb),0.06)", border: "1px solid rgba(var(--slide-accent-rgb),0.18)", borderRadius: "0.7vw", padding: "2.5vh 2vw" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "1vw", marginBottom: "1vh" }}>
                <div style={{ width: "2.2vw", height: "2.2vw", borderRadius: "0.4vw", background: "rgba(var(--slide-accent-rgb),0.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width="1vw" height="1vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.7vw", fontWeight: 800, color: "var(--slide-text)" }}>Privacy Meter</div>
              </div>
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.55)", lineHeight: 1.5 }}>
                Live score of open channels, active models, and data that has left your device today.
              </div>
            </div>

            <div style={{ background: "rgba(var(--slide-primary-rgb),0.06)", border: "1px solid rgba(var(--slide-primary-rgb),0.18)", borderRadius: "0.7vw", padding: "2.5vh 2vw" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "1vw", marginBottom: "1vh" }}>
                <div style={{ width: "2.2vw", height: "2.2vw", borderRadius: "0.4vw", background: "rgba(var(--slide-primary-rgb),0.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width="1vw" height="1vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.52"/></svg>
                </div>
                <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.7vw", fontWeight: 800, color: "var(--slide-text)" }}>24-Hour Action Undo</div>
              </div>
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.55)", lineHeight: 1.5 }}>
                Roll back file moves, edits, and calendar changes from a single undo log within 24 hours.
              </div>
            </div>
          </div>

          <div style={{
            borderRadius: "1vw",
            overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 0 40px rgba(var(--slide-accent-rgb),0.10)"
          }}>
            <div style={{ padding: "1vh 1.2vw", background: "rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: "0.5vw" }}>
              <div style={{ width: "0.55vw", height: "0.55vw", borderRadius: "50%", background: "rgba(255,59,48,0.5)" }} />
              <div style={{ width: "0.55vw", height: "0.55vw", borderRadius: "50%", background: "rgba(255,204,0,0.5)" }} />
              <div style={{ width: "0.55vw", height: "0.55vw", borderRadius: "50%", background: "rgba(40,205,65,0.5)" }} />
              <div style={{ flex: 1, textAlign: "center", fontFamily: "DM Sans, sans-serif", fontSize: "1.1vw", color: "rgba(var(--slide-text-rgb),0.25)" }}>Privacy & Security Dashboard</div>
            </div>
            <img
              src={`${base}ui-privacy.png`}
              crossOrigin="anonymous"
              alt="Omninity OP privacy dashboard"
              style={{ width: "100%", display: "block", objectFit: "cover" }}
            />

            <div style={{ padding: "2vh 2vw", background: "rgba(255,255,255,0.02)", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
              <div style={{ display: "flex", gap: "2vw" }}>
                <div>
                  <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.6vw", fontWeight: 800, color: "var(--slide-text)", marginBottom: "0.3vh" }}>Per-Skill Permissions</div>
                  <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.4vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>Grant and revoke individually with a master kill switch</div>
                </div>
                <div>
                  <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.6vw", fontWeight: 800, color: "var(--slide-text)", marginBottom: "0.3vh" }}>GDPR Export & Erasure</div>
                  <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.4vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>Full data export as JSON, per-category deletion</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
