export default function Slide09Partners() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "var(--slide-bg)" }}>
      <div
        className="absolute inset-0"
        style={{
          background: "linear-gradient(135deg, rgba(var(--slide-primary-rgb),0.07) 0%, rgba(7,8,16,0) 50%, rgba(var(--slide-accent-rgb),0.07) 100%)"
        }}
      />

      <div className="absolute" style={{ top: 0, left: 0, right: 0, height: "1px", background: "linear-gradient(90deg, rgba(var(--slide-primary-rgb),0.5) 0%, rgba(var(--slide-accent-rgb),0.5) 100%)" }} />

      <div className="absolute" style={{ left: "7vw", top: "9vh", right: "7vw" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 700,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--slide-primary)",
          marginBottom: "1.2vh"
        }}>
          For Partners
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
          The Skill Ecosystem
        </div>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.6vw",
          color: "rgba(var(--slide-text-rgb),0.5)",
          marginBottom: "4.5vh"
        }}>
          Build on OP. Distribute to a growing base of privacy-conscious users. Keep a meaningful share of revenue.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "2vw" }}>
          <div style={{ padding: "4vh 2.5vw", background: "rgba(var(--slide-primary-rgb),0.05)", border: "1px solid rgba(var(--slide-primary-rgb),0.15)", borderRadius: "0.8vw" }}>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "1.6vw",
              fontWeight: 800,
              color: "var(--slide-primary)",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              marginBottom: "2vh"
            }}>
              Skill SDK
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.5vw",
              color: "rgba(var(--slide-text-rgb),0.55)",
              lineHeight: 1.6,
              marginBottom: "2.5vh"
            }}>
              Package any capability as a .skill file. The SDK handles permissions, sandboxing, UI integration, and tool registration automatically.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1vh" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.8vw" }}>
                <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "var(--slide-primary)", flexShrink: 0 }} />
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.6)" }}>Drag-and-drop install for end users</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.8vw" }}>
                <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "var(--slide-primary)", flexShrink: 0 }} />
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.6)" }}>Typed tool interface + API reference</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.8vw" }}>
                <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "var(--slide-primary)", flexShrink: 0 }} />
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.6)" }}>Isolated permission sandbox</div>
              </div>
            </div>
          </div>

          <div style={{ padding: "4vh 2.5vw", background: "rgba(var(--slide-accent-rgb),0.05)", border: "1px solid rgba(var(--slide-accent-rgb),0.15)", borderRadius: "0.8vw" }}>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "1.6vw",
              fontWeight: 800,
              color: "var(--slide-accent)",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              marginBottom: "2vh"
            }}>
              Revenue Share
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.5vw",
              color: "rgba(var(--slide-text-rgb),0.55)",
              lineHeight: 1.6,
              marginBottom: "2.5vh"
            }}>
              Paid skills listed on the marketplace earn a developer-first split. Popularity score is capped so new entrants compete on quality, not install count.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1vh" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.8vw" }}>
                <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "var(--slide-accent)", flexShrink: 0 }} />
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.6)" }}>Transparent payout dashboard</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.8vw" }}>
                <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "var(--slide-accent)", flexShrink: 0 }} />
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.6)" }}>Monthly settlement cycle</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.8vw" }}>
                <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "var(--slide-accent)", flexShrink: 0 }} />
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.6)" }}>Freemium and subscription models</div>
              </div>
            </div>
          </div>

          <div style={{ padding: "4vh 2.5vw", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "0.8vw" }}>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: "1.6vw",
              fontWeight: 800,
              color: "var(--slide-text)",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              marginBottom: "2vh"
            }}>
              White-label & Enterprise
            </div>
            <div style={{
              fontFamily: "DM Sans, sans-serif",
              fontSize: "1.5vw",
              color: "rgba(var(--slide-text-rgb),0.55)",
              lineHeight: 1.6,
              marginBottom: "2.5vh"
            }}>
              Deploy OP under your own brand. Custom skill bundles, managed tenant isolation, and SLA-backed on-premises support available.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1vh" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.8vw" }}>
                <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "rgba(var(--slide-text-rgb),0.4)", flexShrink: 0 }} />
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.6)" }}>Custom branding and domain</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.8vw" }}>
                <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "rgba(var(--slide-text-rgb),0.4)", flexShrink: 0 }} />
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.6)" }}>Air-gapped on-premises option</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.8vw" }}>
                <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "rgba(var(--slide-text-rgb),0.4)", flexShrink: 0 }} />
                <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.6)" }}>Dedicated integration engineering</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
