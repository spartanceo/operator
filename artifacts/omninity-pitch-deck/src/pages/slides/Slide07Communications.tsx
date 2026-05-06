const base = import.meta.env.BASE_URL;

export default function Slide07Communications() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "var(--slide-bg)" }}>
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 70% 50% at 50% 110%, rgba(var(--slide-primary-rgb),0.07) 0%, transparent 60%)"
        }}
      />

      <div className="absolute" style={{ top: 0, left: 0, right: 0, height: "1px", background: "linear-gradient(90deg, transparent 0%, rgba(var(--slide-primary-rgb),0.4) 50%, transparent 100%)" }} />

      <div className="absolute" style={{ left: "7vw", top: "8vh", right: "7vw" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 700,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--slide-primary)",
          marginBottom: "1vh"
        }}>
          Communications Hub
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
          Every channel. Drafts always wait for you.
        </div>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.6vw",
          color: "rgba(var(--slide-text-rgb),0.5)",
          marginBottom: "3vh"
        }}>
          OP drafts, schedules, and sequences across email, calendar, VoIP, and outreach — nothing sends until you approve.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2vw", alignItems: "start" }}>
          <div style={{
            borderRadius: "1vw",
            overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 0 40px rgba(var(--slide-primary-rgb),0.10)"
          }}>
            <div style={{ padding: "1vh 1.2vw", background: "rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: "0.5vw" }}>
              <div style={{ width: "0.55vw", height: "0.55vw", borderRadius: "50%", background: "rgba(255,59,48,0.5)" }} />
              <div style={{ width: "0.55vw", height: "0.55vw", borderRadius: "50%", background: "rgba(255,204,0,0.5)" }} />
              <div style={{ width: "0.55vw", height: "0.55vw", borderRadius: "50%", background: "rgba(40,205,65,0.5)" }} />
              <div style={{ flex: 1, textAlign: "center", fontFamily: "DM Sans, sans-serif", fontSize: "1.1vw", color: "rgba(var(--slide-text-rgb),0.25)" }}>Communications</div>
            </div>
            <img
              src={`${base}ui-communications.png`}
              crossOrigin="anonymous"
              alt="Omninity OP communications interface"
              style={{ width: "100%", display: "block", objectFit: "cover" }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "1.5vh", paddingTop: "0.5vh" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "1.2vw", padding: "1.8vh 1.5vw", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "0.6vw" }}>
              <div style={{ flexShrink: 0, width: "2.4vw", height: "2.4vw", borderRadius: "0.4vw", background: "rgba(var(--slide-primary-rgb),0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="1.1vw" height="1.1vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              </div>
              <div>
                <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.6vw", fontWeight: 800, color: "var(--slide-text)", marginBottom: "0.3vh" }}>Email</div>
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>Gmail + Outlook. Reads, drafts, and categorises. Approval before send.</div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: "1.2vw", padding: "1.8vh 1.5vw", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "0.6vw" }}>
              <div style={{ flexShrink: 0, width: "2.4vw", height: "2.4vw", borderRadius: "0.4vw", background: "rgba(var(--slide-primary-rgb),0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="1.1vw" height="1.1vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </div>
              <div>
                <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.6vw", fontWeight: 800, color: "var(--slide-text)", marginBottom: "0.3vh" }}>Calendar</div>
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>Google + Apple. Schedules and blocks focus time. Events confirmed by you.</div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: "1.2vw", padding: "1.8vh 1.5vw", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "0.6vw" }}>
              <div style={{ flexShrink: 0, width: "2.4vw", height: "2.4vw", borderRadius: "0.4vw", background: "rgba(var(--slide-accent-rgb),0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="1.1vw" height="1.1vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.62 1.27h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              </div>
              <div>
                <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.6vw", fontWeight: 800, color: "var(--slide-text)", marginBottom: "0.3vh" }}>VoIP & Outreach</div>
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>Twilio for calls/SMS. Multi-step sequences. Transcripts stay on-device.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
