export default function Slide02Problem() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "var(--slide-bg)" }}>
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 70% 60% at 80% 50%, rgba(var(--slide-accent-rgb),0.05) 0%, transparent 70%)"
        }}
      />

      <div className="absolute" style={{ top: 0, left: "7vw", width: "3px", height: "100%", background: "linear-gradient(180deg, var(--slide-primary) 0%, rgba(var(--slide-primary-rgb),0) 100%)" }} />

      <div className="absolute" style={{ left: "10vw", top: "9vh", right: "7vw" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 700,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--slide-primary)",
          marginBottom: "2vh"
        }}>
          The Problem
        </div>
        <div style={{
          fontFamily: "Syne, sans-serif",
          fontSize: "4.2vw",
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          color: "var(--slide-text)",
          marginBottom: "6vh",
          textWrap: "balance"
        }}>
          Today's AI serves the platform,<br />not the person.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "2.5vw" }}>
          <div style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: "0.8vw",
            padding: "3vh 2vw"
          }}>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "3.5vw",
              fontWeight: 800,
              color: "var(--slide-primary)",
              marginBottom: "1.5vh",
              lineHeight: 1
            }}>
              01
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.7vw",
              fontWeight: 700,
              color: "var(--slide-text)",
              marginBottom: "1vh"
            }}>
              Data Leaves Your Machine
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.5vw",
              fontWeight: 400,
              color: "rgba(var(--slide-text-rgb),0.5)",
              lineHeight: 1.5
            }}>
              Every prompt sent to a cloud model is logged, used for training, and stored on servers you don't control.
            </div>
          </div>

          <div style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: "0.8vw",
            padding: "3vh 2vw"
          }}>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "3.5vw",
              fontWeight: 800,
              color: "var(--slide-primary)",
              marginBottom: "1.5vh",
              lineHeight: 1
            }}>
              02
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.7vw",
              fontWeight: 700,
              color: "var(--slide-text)",
              marginBottom: "1vh"
            }}>
              Vendor Lock-in
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.5vw",
              fontWeight: 400,
              color: "rgba(var(--slide-text-rgb),0.5)",
              lineHeight: 1.5
            }}>
              Your workflows, your context, your history — held hostage by proprietary APIs that change pricing overnight.
            </div>
          </div>

          <div style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: "0.8vw",
            padding: "3vh 2vw"
          }}>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "3.5vw",
              fontWeight: 800,
              color: "var(--slide-primary)",
              marginBottom: "1.5vh",
              lineHeight: 1
            }}>
              03
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.7vw",
              fontWeight: 700,
              color: "var(--slide-text)",
              marginBottom: "1vh"
            }}>
              Actions Without Consent
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.5vw",
              fontWeight: 400,
              color: "rgba(var(--slide-text-rgb),0.5)",
              lineHeight: 1.5
            }}>
              AI agents that send emails, book meetings, and delete files — all without a confirmation step.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
