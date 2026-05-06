const base = import.meta.env.BASE_URL;

export default function Slide05DesktopControl() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "var(--slide-bg)" }}>
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 50% 80% at 85% 50%, rgba(var(--slide-primary-rgb),0.07) 0%, transparent 65%)"
        }}
      />

      <div className="absolute" style={{ left: "7vw", top: "9vh", width: "38vw" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 700,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--slide-primary)",
          marginBottom: "1.5vh"
        }}>
          Desktop Control & Automation
        </div>
        <div style={{
          fontFamily: "Syne, sans-serif",
          fontSize: "3.5vw",
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          color: "var(--slide-text)",
          marginBottom: "2vh"
        }}>
          Semantic control.<br />No coordinates.
        </div>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.6vw",
          fontWeight: 400,
          color: "rgba(var(--slide-text-rgb),0.5)",
          lineHeight: 1.55,
          marginBottom: "4vh"
        }}>
          OP describes what to click by label and role — not pixel coordinates. Every session runs a Look-Act-Verify loop before any action executes.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "2vh" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1.5vw" }}>
            <div style={{
              flexShrink: 0,
              width: "3vw",
              height: "3vw",
              borderRadius: "50%",
              background: "rgba(var(--slide-primary-rgb),0.15)",
              border: "1.5px solid var(--slide-primary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "Syne, sans-serif",
              fontSize: "1.3vw",
              fontWeight: 800,
              color: "var(--slide-primary)"
            }}>1</div>
            <div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.7vw", fontWeight: 800, color: "var(--slide-text)" }}>Look</div>
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>Semantic snapshot — elements by label and role</div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "1.5vw" }}>
            <div style={{
              flexShrink: 0,
              width: "3vw",
              height: "3vw",
              borderRadius: "50%",
              background: "rgba(var(--slide-primary-rgb),0.15)",
              border: "1.5px solid var(--slide-primary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "Syne, sans-serif",
              fontSize: "1.3vw",
              fontWeight: 800,
              color: "var(--slide-primary)"
            }}>2</div>
            <div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.7vw", fontWeight: 800, color: "var(--slide-text)" }}>Act</div>
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>High-risk steps pause for approval, all steps logged</div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "1.5vw" }}>
            <div style={{
              flexShrink: 0,
              width: "3vw",
              height: "3vw",
              borderRadius: "50%",
              background: "rgba(var(--slide-accent-rgb),0.15)",
              border: "1.5px solid var(--slide-accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "Syne, sans-serif",
              fontSize: "1.3vw",
              fontWeight: 800,
              color: "var(--slide-accent)"
            }}>3</div>
            <div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.7vw", fontWeight: 800, color: "var(--slide-text)" }}>Verify</div>
              <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>Output checked against plan — deviations flagged</div>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute" style={{ right: "5vw", top: "7vh", bottom: "7vh", width: "46vw" }}>
        <div style={{
          height: "100%",
          borderRadius: "1vw",
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 0 60px rgba(var(--slide-primary-rgb),0.12), 0 0 0 1px rgba(var(--slide-primary-rgb),0.08)"
        }}>
          <div style={{ padding: "1.2vh 1.5vw", background: "rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: "0.6vw" }}>
            <div style={{ width: "0.65vw", height: "0.65vw", borderRadius: "50%", background: "rgba(255,59,48,0.5)" }} />
            <div style={{ width: "0.65vw", height: "0.65vw", borderRadius: "50%", background: "rgba(255,204,0,0.5)" }} />
            <div style={{ width: "0.65vw", height: "0.65vw", borderRadius: "50%", background: "rgba(40,205,65,0.5)" }} />
            <div style={{ flex: 1, textAlign: "center", fontFamily: "DM Sans, sans-serif", fontSize: "1.2vw", color: "rgba(var(--slide-text-rgb),0.25)" }}>Omninity Operator — Desktop Control</div>
          </div>
          <img
            src={`${base}ui-desktop-control.png`}
            crossOrigin="anonymous"
            alt="Omninity OP desktop control interface"
            style={{ width: "100%", height: "calc(100% - 4vh)", objectFit: "cover", objectPosition: "top", display: "block" }}
          />
        </div>
      </div>
    </div>
  );
}
