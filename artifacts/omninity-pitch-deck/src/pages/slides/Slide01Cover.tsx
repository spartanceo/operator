const base = import.meta.env.BASE_URL;

export default function Slide01Cover() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "var(--slide-bg)" }}>
      <img
        src={`${base}hero-cover.png`}
        crossOrigin="anonymous"
        alt=""
        className="absolute inset-0 w-full h-full object-cover"
        style={{ opacity: 0.35 }}
      />

      <div
        className="absolute inset-0"
        style={{
          background: "linear-gradient(135deg, rgba(7,8,16,0.92) 40%, rgba(var(--slide-primary-rgb),0.18) 100%)"
        }}
      />

      <div
        className="absolute"
        style={{
          right: "-8vw",
          top: "-15vh",
          width: "55vw",
          height: "130vh",
          background: "linear-gradient(150deg, rgba(var(--slide-primary-rgb),0.06) 0%, rgba(var(--slide-accent-rgb),0.04) 100%)",
          transform: "rotate(-12deg)",
          borderLeft: "1px solid rgba(var(--slide-primary-rgb),0.12)"
        }}
      />

      <div
        className="absolute"
        style={{
          left: 0,
          bottom: 0,
          width: "100%",
          height: "1px",
          background: "linear-gradient(90deg, rgba(var(--slide-primary-rgb),0.6) 0%, rgba(var(--slide-primary-rgb),0.0) 60%)"
        }}
      />

      <div className="absolute" style={{ left: "7vw", top: "7vh" }}>
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

      <div className="absolute" style={{ left: "7vw", bottom: "7vh", right: "7vw" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 700,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--slide-primary)",
          marginBottom: "2vh"
        }}>
          Omninity Operator
        </div>
        <div style={{
          fontFamily: "Syne, sans-serif",
          fontSize: "6.5vw",
          fontWeight: 800,
          lineHeight: 1.0,
          letterSpacing: "-0.02em",
          color: "var(--slide-text)",
          textWrap: "balance",
          marginBottom: "3.5vh"
        }}>
          Your Loyal<br />AI Agent
        </div>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.7vw",
          fontWeight: 400,
          color: "rgba(var(--slide-text-rgb),0.55)",
          letterSpacing: "0.01em",
          textWrap: "balance"
        }}>
          Local-first. Reversible by default. Loyal to the person at the keyboard.
        </div>
      </div>

      <div className="absolute" style={{ right: "7vw", bottom: "8.5vh" }}>
        <div style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: "1.5vw",
          fontWeight: 400,
          color: "rgba(var(--slide-text-rgb),0.3)",
          letterSpacing: "0.06em"
        }}>
          CONFIDENTIAL
        </div>
      </div>
    </div>
  );
}
