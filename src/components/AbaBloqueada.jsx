// Tela exibida em abas secundárias (não-líderes). Não monta o CRM operacional,
// não faz polling/realtime/heartbeat nem ações manuais. Só oferece o botão para
// transferir a liderança para esta aba.
export default function AbaBloqueada({ onUsarEstaAba, liderPodeTerEncerrado }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0f172a",
        padding: 20,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: "32px 28px",
          maxWidth: 460,
          textAlign: "center",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ fontSize: 44 }}>🗂️</div>
        <h1 style={{ fontSize: 22, fontWeight: 900, margin: "8px 0", color: "#0f172a" }}>
          Aba duplicada do ReATIVA
        </h1>
        <p style={{ color: "#475569", fontSize: 15 }}>
          Já existe outra aba ativa do ReATIVA. Feche esta aba para continuar.
        </p>
        {liderPodeTerEncerrado && (
          <p
            style={{
              color: "#b45309",
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 10,
              padding: "10px 12px",
              fontSize: 13,
              marginTop: 14,
              fontWeight: 600,
            }}
          >
            A outra aba pode ter sido encerrada. Clique em “Usar esta aba” para
            continuar.
          </p>
        )}
        <p style={{ color: "#64748b", fontSize: 13, marginTop: 12 }}>
          Se você quer usar o sistema aqui, clique abaixo. A outra aba será
          bloqueada e esta passará a ser a aba ativa.
        </p>
        <button
          onClick={onUsarEstaAba}
          style={{
            marginTop: 18,
            background: "#1d4ed8",
            color: "#fff",
            border: "none",
            borderRadius: 10,
            padding: "12px 22px",
            fontWeight: 800,
            cursor: "pointer",
            fontSize: 15,
          }}
        >
          Usar esta aba
        </button>
      </div>
    </div>
  );
}
