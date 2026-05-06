export default function Slide04AgentRoster() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "var(--slide-bg)" }}>
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 50% 50% at 50% 50%, rgba(var(--slide-primary-rgb),0.04) 0%, transparent 70%)"
        }}
      />

      <div className="absolute" style={{ left: "7vw", top: "7vh", right: "7vw" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 700,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--slide-primary)",
          marginBottom: "1.2vh"
        }}>
          Agent Roster
        </div>
        <div style={{
          fontFamily: "Syne, sans-serif",
          fontSize: "4vw",
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          color: "var(--slide-text)",
          marginBottom: "4.5vh"
        }}>
          Six specialists. One shared goal.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gridTemplateRows: "1fr 1fr", gap: "1.8vw" }}>
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "0.8vw", padding: "2.8vh 2.2vw" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1.2vw", marginBottom: "1.2vh" }}>
              <div style={{ width: "3vw", height: "3vw", borderRadius: "50%", background: "rgba(var(--slide-primary-rgb),0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="1.4vw" height="1.4vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </svg>
              </div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.9vw", fontWeight: 800, color: "var(--slide-text)" }}>Router</div>
            </div>
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)", lineHeight: 1.5 }}>
              Classifies each input — chat, task, or goal — and routes it to the right downstream agent.
            </div>
          </div>

          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "0.8vw", padding: "2.8vh 2.2vw" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1.2vw", marginBottom: "1.2vh" }}>
              <div style={{ width: "3vw", height: "3vw", borderRadius: "50%", background: "rgba(var(--slide-primary-rgb),0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="1.4vw" height="1.4vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                </svg>
              </div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.9vw", fontWeight: 800, color: "var(--slide-text)" }}>Planner</div>
            </div>
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)", lineHeight: 1.5 }}>
              Decomposes goals into ordered steps with risk classification before any action is taken.
            </div>
          </div>

          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "0.8vw", padding: "2.8vh 2.2vw" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1.2vw", marginBottom: "1.2vh" }}>
              <div style={{ width: "3vw", height: "3vw", borderRadius: "50%", background: "rgba(var(--slide-primary-rgb),0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="1.4vw" height="1.4vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M5.93 4.93a10 10 0 0 0 0 14.14"/>
                </svg>
              </div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.9vw", fontWeight: 800, color: "var(--slide-text)" }}>Executor</div>
            </div>
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)", lineHeight: 1.5 }}>
              Calls registered tools, gates high-risk steps for approval, and logs every action taken.
            </div>
          </div>

          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "0.8vw", padding: "2.8vh 2.2vw" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1.2vw", marginBottom: "1.2vh" }}>
              <div style={{ width: "3vw", height: "3vw", borderRadius: "50%", background: "rgba(var(--slide-accent-rgb),0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="1.4vw" height="1.4vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
              </div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.9vw", fontWeight: 800, color: "var(--slide-text)" }}>Verifier</div>
            </div>
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)", lineHeight: 1.5 }}>
              Checks step output against the plan, flags anomalies, and writes the run summary.
            </div>
          </div>

          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "0.8vw", padding: "2.8vh 2.2vw" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1.2vw", marginBottom: "1.2vh" }}>
              <div style={{ width: "3vw", height: "3vw", borderRadius: "50%", background: "rgba(var(--slide-accent-rgb),0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="1.4vw" height="1.4vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
              </div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.9vw", fontWeight: 800, color: "var(--slide-text)" }}>Research</div>
            </div>
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)", lineHeight: 1.5 }}>
              Browser and extraction sub-agent for information gathering from the web and local docs.
            </div>
          </div>

          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "0.8vw", padding: "2.8vh 2.2vw" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1.2vw", marginBottom: "1.2vh" }}>
              <div style={{ width: "3vw", height: "3vw", borderRadius: "50%", background: "rgba(var(--slide-accent-rgb),0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="1.4vw" height="1.4vw" viewBox="0 0 24 24" fill="none" stroke="var(--slide-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1 .46-4.96A2.5 2.5 0 0 1 4.5 12a2.5 2.5 0 0 1 2.04-2.46A2.5 2.5 0 0 1 9.5 2z"/>
                </svg>
              </div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.9vw", fontWeight: 800, color: "var(--slide-text)" }}>Memory</div>
            </div>
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)", lineHeight: 1.5 }}>
              Reads and writes durable memories across runs. Stores preferences, facts, and patterns locally.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
