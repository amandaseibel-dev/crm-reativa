// Dublê da ficha completa do aluno, só para o preview visual.
//
// A ficha real (`src/pages/Aluno.jsx`) fala com o banco em dezenas de consultas
// — acordos, parcelas, termos, links, movimentações. O mock de Supabase daqui é
// inerte de propósito, então montar a ficha de verdade no preview mostraria uma
// tela de erro e faria parecer defeito o que é ausência de banco.
//
// O que o preview precisa provar sobre a ficha é o ENQUADRAMENTO: que ela abre
// por cima da conversa, que o topo com o Fechar não rola junto e que a Central
// continua atrás. Por isso este dublê é ALTO — para a rolagem do popup existir.
export default function FichaAlunoDublê({ fichaEmbedId }) {
  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", color: "#334155" }}>
      <h1 style={{ fontSize: 20, margin: 0, color: "#0f172a" }}>Atendimento do aluno</h1>
      <p style={{ fontSize: 13, color: "#64748b" }}>
        aluno_id: <strong>{fichaEmbedId}</strong>
      </p>
      <p style={{
        fontSize: 13, lineHeight: 1.6, background: "#fffbeb",
        border: "1px solid #fde68a", borderRadius: 10, padding: "10px 12px",
      }}>
        <strong>Dublê do preview.</strong> No CRM, aqui dentro está a ficha
        completa de verdade — acionar, tabular, acordos, links, termos e
        movimentações — a mesma da tela <code>/aluno</code>, sem sair da Central.
      </p>
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} style={{
          marginTop: 12, height: 90, borderRadius: 10,
          border: "1px dashed #cbd5e1", background: "#f8fafc",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12.5, color: "#94a3b8",
        }}>
          bloco {i + 1} da ficha
        </div>
      ))}
    </div>
  );
}
