import { useNavigate } from "react-router-dom";

// Hub de Ferramentas: agrupa utilitarios de dados/gestao que antes ficavam
// soltos no menu. Cada card leva para a ferramenta correspondente.

const FERRAMENTAS = [
  { rota: "/importar-acordos", emoji: "🤝", titulo: "Importar Acordos", desc: "Sobe o Relatorio de Titulos em Aberto e importa a carteira de acordos." },
  { rota: "/importar-recuperacao", emoji: "📥", titulo: "Importar Recuperação", desc: "Importa a planilha de recuperacao retroativa." },
  { rota: "/importacoes", emoji: "📦", titulo: "Importações", desc: "Historico e controle geral de importacoes." },
  { rota: "/exportar-contatos", emoji: "📤", titulo: "Exportar Contatos", desc: "Exporta contatos dos alunos para acoes externas." },
  { rota: "/vincular-operadores", emoji: "🔗", titulo: "Vincular Operadores", desc: "Vincula alunos da base a operadores responsaveis." },
  { rota: "/log-nivelamento", emoji: "🌙", titulo: "Log do Job Noturno", desc: "Acompanha a execucao do job de nivelamento noturno." },
  { rota: "/sugestoes-recebidas", emoji: "💡", titulo: "Sugestões Recebidas", desc: "Sugestoes enviadas pela equipe." },
];

export default function Ferramentas() {
  const navigate = useNavigate();
  return (
    <div style={S.wrap}>
      <h1 style={S.titulo}>🧰 Ferramentas</h1>
      <p style={S.sub}>Utilitários de dados e gestão reunidos num só lugar. Clique para abrir.</p>
      <div style={S.grid}>
        {FERRAMENTAS.map((f) => (
          <button key={f.rota} style={S.card} onClick={() => navigate(f.rota)}
            onMouseOver={(e) => (e.currentTarget.style.borderColor = "#93c5fd")}
            onMouseOut={(e) => (e.currentTarget.style.borderColor = "#e6eaf0")}>
            <span style={S.emoji}>{f.emoji}</span>
            <span style={S.cardTitulo}>{f.titulo}</span>
            <span style={S.cardDesc}>{f.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const S = {
  wrap: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", color: "#0f172a", background: "#f4f6fa", minHeight: "100%" },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 26, fontWeight: 800, color: "#0d1321", letterSpacing: "-0.03em" },
  sub: { margin: "6px 0 22px", color: "#64748b", fontSize: 13.5 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 16 },
  card: { textAlign: "left", background: "#fff", border: "1px solid #e6eaf0", borderRadius: 16, padding: "18px 18px 20px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 6, transition: "border-color 0.15s", boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  emoji: { fontSize: 30, lineHeight: 1 },
  cardTitulo: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 16, fontWeight: 800, color: "#0d1321", marginTop: 6 },
  cardDesc: { fontSize: 12.5, color: "#64748b", lineHeight: 1.45 },
};
