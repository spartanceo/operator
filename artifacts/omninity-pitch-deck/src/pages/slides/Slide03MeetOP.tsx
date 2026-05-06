export default function Slide03MeetOP() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "var(--slide-bg)" }}>
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 60% 70% at 20% 80%, rgba(var(--slide-primary-rgb),0.06) 0%, transparent 65%)"
        }}
      />

      <div className="absolute" style={{ bottom: 0, left: 0, right: 0, height: "1px", background: "linear-gradient(90deg, transparent 0%, rgba(var(--slide-accent-rgb),0.4) 50%, transparent 100%)" }} />

      <div className="absolute" style={{ left: "7vw", top: "9vh", right: "7vw" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 700,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--slide-accent)",
          marginBottom: "1.5vh"
        }}>
          Meet Omninity OP
        </div>
        <div style={{
          fontFamily: "Syne, sans-serif",
          fontSize: "4vw",
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          color: "var(--slide-text)",
          marginBottom: "1.5vh"
        }}>
          One operator. Three unbreakable principles.
        </div>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.7vw",
          fontWeight: 400,
          color: "rgba(var(--slide-text-rgb),0.5)",
          marginBottom: "5vh"
        }}>
          An AI agent that runs on your hardware, acts only with your approval, and can reverse anything it does.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "2vw" }}>
          <div style={{ padding: "4vh 2.5vw", background: "rgba(var(--slide-primary-rgb),0.06)", borderTop: "3px solid var(--slide-primary)", borderRadius: "0 0 0.6vw 0.6vw" }}>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "2.8vw",
              fontWeight: 800,
              color: "var(--slide-primary)",
              marginBottom: "2vh",
              letterSpacing: "-0.01em"
            }}>
              Local-First
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.6vw",
              fontWeight: 400,
              color: "rgba(var(--slide-text-rgb),0.6)",
              lineHeight: 1.55
            }}>
              Runs on Ollama, your GPU, your disk. Nothing leaves your machine unless you decide it does.
            </div>
          </div>

          <div style={{ padding: "4vh 2.5vw", background: "rgba(var(--slide-accent-rgb),0.06)", borderTop: "3px solid var(--slide-accent)", borderRadius: "0 0 0.6vw 0.6vw" }}>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "2.8vw",
              fontWeight: 800,
              color: "var(--slide-accent)",
              marginBottom: "2vh",
              letterSpacing: "-0.01em"
            }}>
              Loyal
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.6vw",
              fontWeight: 400,
              color: "rgba(var(--slide-text-rgb),0.6)",
              lineHeight: 1.55
            }}>
              No third-party objectives. The operator is built for one stakeholder: the person at the keyboard.
            </div>
          </div>

          <div style={{ padding: "4vh 2.5vw", background: "rgba(var(--slide-primary-rgb),0.04)", borderTop: "3px solid rgba(var(--slide-text-rgb),0.3)", borderRadius: "0 0 0.6vw 0.6vw" }}>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "2.8vw",
              fontWeight: 800,
              color: "var(--slide-text)",
              marginBottom: "2vh",
              letterSpacing: "-0.01em"
            }}>
              Reversible
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.6vw",
              fontWeight: 400,
              color: "rgba(var(--slide-text-rgb),0.6)",
              lineHeight: 1.55
            }}>
              Every high-risk action requires explicit approval. A 24-hour undo window covers what slips through.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
