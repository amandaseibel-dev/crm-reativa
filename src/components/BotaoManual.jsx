export default function BotaoManual() {
  return (
    <button
      type="button"
      onClick={() => window.open("/manual-operacao", "_blank", "noreferrer")}
      style={{
        position: "fixed",
        right: "22px",
        bottom: "22px",
        zIndex: 999999,
        background: "#19c37d",
        color: "#071526",
        border: "2px solid #ffffff",
        borderRadius: "999px",
        padding: "14px 20px",
        fontWeight: "bold",
        fontSize: "14px",
        cursor: "pointer",
        boxShadow: "0 10px 25px rgba(0,0,0,0.35)",
      }}
    >
      Manual da Operação
    </button>
  );
}
