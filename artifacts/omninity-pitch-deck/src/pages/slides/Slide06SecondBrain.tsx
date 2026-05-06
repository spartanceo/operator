const base = import.meta.env.BASE_URL;

export default function Slide06SecondBrain() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "var(--slide-bg)" }}>
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 50% 70% at 15% 50%, rgba(var(--slide-accent-rgb),0.07) 0%, transparent 65%)"
        }}
      />

      <div className="absolute" style={{ left: "5vw", top: "7vh", bottom: "7vh", width: "46vw" }}>
        <div style={{
          height: "100%",
          borderRadius: "1vw",
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 0 60px rgba(var(--slide-accent-rgb),0.10), 0 0 0 1px rgba(var(--slide-accent-rgb),0.08)"
        }}>
          <div style={{ padding: "1.2vh 1.5vw", background: "rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: "0.6vw" }}>
            <div style={{ width: "0.65vw", height: "0.65vw", borderRadius: "50%", background: "rgba(255,59,48,0.5)" }} />
            <div style={{ width: "0.65vw", height: "0.65vw", borderRadius: "50%", background: "rgba(255,204,0,0.5)" }} />
            <div style={{ width: "0.65vw", height: "0.65vw", borderRadius: "50%", background: "rgba(40,205,65,0.5)" }} />
            <div style={{ flex: 1, textAlign: "center", fontFamily: "DM Sans, sans-serif", fontSize: "1.2vw", color: "rgba(var(--slide-text-rgb),0.25)" }}>Omninity Operator — Knowledge Base</div>
          </div>
          <img
            src={`${base}ui-knowledge-base.png`}
            crossOrigin="anonymous"
            alt="Omninity OP knowledge base interface"
            style={{ width: "100%", height: "calc(100% - 4vh)", objectFit: "cover", objectPosition: "top", display: "block" }}
          />
        </div>
      </div>

      <div className="absolute" style={{ right: "6vw", top: "9vh", width: "40vw" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 700,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--slide-accent)",
          marginBottom: "1.5vh"
        }}>
          Your Second Brain
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
          Everything you know. On your machine.
        </div>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.6vw",
          color: "rgba(var(--slide-text-rgb),0.5)",
          lineHeight: 1.55,
          marginBottom: "4vh"
        }}>
          Ingest PDFs, URLs, and YouTube transcripts into a local vector store. Agents query by meaning — not keyword — and context persists across every session.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "2vh" }}>
          <div style={{ padding: "2vh 2vw", background: "rgba(var(--slide-accent-rgb),0.06)", borderLeft: "3px solid var(--slide-accent)", borderRadius: "0 0.5vw 0.5vw 0" }}>
            <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.7vw", fontWeight: 800, color: "var(--slide-text)", marginBottom: "0.5vh" }}>Semantic search</div>
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>Agents retrieve context relevant to each plan step</div>
          </div>
          <div style={{ padding: "2vh 2vw", background: "rgba(var(--slide-primary-rgb),0.06)", borderLeft: "3px solid var(--slide-primary)", borderRadius: "0 0.5vw 0.5vw 0" }}>
            <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.7vw", fontWeight: 800, color: "var(--slide-text)", marginBottom: "0.5vh" }}>Long-term memory</div>
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>Facts and preferences persist — no re-explaining each session</div>
          </div>
          <div style={{ padding: "2vh 2vw", background: "rgba(255,255,255,0.02)", borderLeft: "3px solid rgba(var(--slide-text-rgb),0.15)", borderRadius: "0 0.5vw 0.5vw 0" }}>
            <div style={{ fontFamily: "Syne, sans-serif", fontSize: "1.7vw", fontWeight: 800, color: "var(--slide-text)", marginBottom: "0.5vh" }}>Air-gapped option</div>
            <div style={{ fontFamily: "DM Sans, sans-serif", fontSize: "1.5vw", color: "rgba(var(--slide-text-rgb),0.5)" }}>No embeddings leave your device — full offline operation</div>
          </div>
        </div>
      </div>
    </div>
  );
}
