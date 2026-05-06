export default function Slide10CTA() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "var(--slide-bg)" }}>
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 80% 80% at 50% 50%, rgba(var(--slide-primary-rgb),0.08) 0%, rgba(var(--slide-accent-rgb),0.05) 40%, transparent 70%)"
        }}
      />

      <div
        className="absolute"
        style={{
          left: "-5vw",
          top: "-20vh",
          width: "50vw",
          height: "140vh",
          background: "linear-gradient(165deg, rgba(var(--slide-primary-rgb),0.05) 0%, transparent 60%)",
          transform: "rotate(15deg)",
          borderRight: "1px solid rgba(var(--slide-primary-rgb),0.08)"
        }}
      />

      <div className="absolute" style={{ bottom: 0, left: 0, right: 0, height: "1px", background: "linear-gradient(90deg, transparent 0%, rgba(var(--slide-primary-rgb),0.5) 30%, rgba(var(--slide-accent-rgb),0.5) 70%, transparent 100%)" }} />

      <div className="absolute" style={{ left: "7vw", top: "8vh" }}>
        <div style={{
          fontFamily: "Syne, sans-serif",
          fontSize: "1.1vw",
          fontWeight: 700,
          letterSpacing: "0.25em",
          color: "var(--slide-primary)",
          textTransform: "uppercase"
        }}>
          Omninity
        </div>
      </div>

      <div className="absolute" style={{ left: "7vw", top: "18vh" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 700,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "rgba(var(--slide-text-rgb),0.4)",
          marginBottom: "2vh"
        }}>
          Get Started
        </div>
        <div style={{
          fontFamily: "Syne, sans-serif",
          fontSize: "5.5vw",
          fontWeight: 800,
          lineHeight: 1.0,
          letterSpacing: "-0.02em",
          color: "var(--slide-text)",
          marginBottom: "1.5vh"
        }}>
          Ready when you are.
        </div>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.7vw",
          color: "rgba(var(--slide-text-rgb),0.45)",
          marginBottom: "5vh"
        }}>
          Two paths in. No lock-in.
        </div>
      </div>

      <div className="absolute" style={{ left: "7vw", bottom: "10vh", right: "7vw" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3vw" }}>
          <div style={{ padding: "4vh 3vw", background: "rgba(var(--slide-primary-rgb),0.07)", border: "1px solid rgba(var(--slide-primary-rgb),0.25)", borderRadius: "0.8vw" }}>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.4vw",
              fontWeight: 700,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "var(--slide-primary)",
              marginBottom: "1.5vh"
            }}>
              For Customers
            </div>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "2.2vw",
              fontWeight: 800,
              color: "var(--slide-text)",
              marginBottom: "1.5vh"
            }}>
              Download or join the waitlist
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.5vw",
              color: "rgba(var(--slide-text-rgb),0.5)",
              lineHeight: 1.5,
              marginBottom: "2.5vh"
            }}>
              Install Omninity Operator on macOS or Windows. Local models, full capability, no subscription required for the base tier.
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.6vw",
              fontWeight: 700,
              color: "var(--slide-primary)"
            }}>
              omninity.ai/download
            </div>
          </div>

          <div style={{ padding: "4vh 3vw", background: "rgba(var(--slide-accent-rgb),0.07)", border: "1px solid rgba(var(--slide-accent-rgb),0.25)", borderRadius: "0.8vw" }}>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.4vw",
              fontWeight: 700,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "var(--slide-accent)",
              marginBottom: "1.5vh"
            }}>
              For Partners
            </div>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "2.2vw",
              fontWeight: 800,
              color: "var(--slide-text)",
              marginBottom: "1.5vh"
            }}>
              SDK access + revenue share
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.5vw",
              color: "rgba(var(--slide-text-rgb),0.5)",
              lineHeight: 1.5,
              marginBottom: "2.5vh"
            }}>
              Apply for early SDK access. Ship your first skill. Start earning from day one on the marketplace.
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.6vw",
              fontWeight: 700,
              color: "var(--slide-accent)"
            }}>
              omninity.ai/creators
            </div>
          </div>
        </div>

        <div style={{ marginTop: "3vh", textAlign: "center" }}>
          <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.3)" }}>
            Questions? hello@omninity.ai
          </div>
        </div>
      </div>
    </div>
  );
}
