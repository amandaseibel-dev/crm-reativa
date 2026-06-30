export default function BotaoManual() {
  return (
    <button
      onClick={() => window.open("/manual-operacao", "_blank")}
      style={{
        position: "fixed",
        right: "18px",
        bottom: "18px",
        zIndex: 9999,
        background: "#19c37d",
        color: "#071526",
        border: "none",
        borderRadius: "999px",
        padding: "13px 18px",
        fontWeight: "bold",
        cursor: "pointer",
        boxShadow: "0 8px 20px rgba(0,0,0,0.25)",
      }}
    >
      Manual da Operação
    </button>
  );
}
