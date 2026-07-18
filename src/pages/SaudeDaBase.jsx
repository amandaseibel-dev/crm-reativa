import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { OPERADORES_POR_EMAIL } from "../utils/operadores";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";

function moeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function StatusChip({ ok, texto }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11.5,
        fontWeight: 700,
        padding: "3px 10px",
        borderRadius: 999,
        color: ok ? "#0f7a4f" : "#b91c1c",
        background: ok ? "#eff6ff" : "#fef2f2",
        border: `1px solid ${ok ? "#c7d7fe" : "#fecaca"}`,
      }}
    >
      {ok ? "✅" : "⚠️"} {texto}
    </span>
  );
}

export default function SaudeDaBase() {
  const [carregando, setCarregando] = useState(true);
  const [dados, setDados] = useState(null);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);
    const { data, error } = await supabase.rpc("saude_da_base");
    if (!error) setDados(data);
    setCarregando(false);
  }

  if (carregando || !dados) {
    return <div style={estilos.container}>Carregando saúde da base...</div>;
  }

  const geradoEm = dados.gerado_em ? new Date(dados.gerado_em).toLocaleString("pt-BR") : "-";

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <div>
          <h1 style={estilos.titulo}>🩺 Saúde da Base</h1>
          <p style={estilos.subtitulo}>Panorama rápido pra saber se está tudo em ordem, sem precisar perguntar.</p>
        </div>
        <button style={estilos.botaoAtualizar} onClick={carregar}>
          Atualizar
        </button>
      </div>
      <p style={estilos.geradoEm}>Calculado agora: {geradoEm}</p>

      <div style={estilos.card}>
        <h3 style={estilos.tituloBloco}>Checagens automáticas</h3>
        <div style={estilos.linhaChips}>
          <StatusChip ok={dados.cpf_duplicado === 0} texto={dados.cpf_duplicado === 0 ? "Sem CPF duplicado" : `${dados.cpf_duplicado} CPF duplicado`} />
          <StatusChip ok={dados.casos_linhas_duplicadas === 0} texto={dados.casos_linhas_duplicadas === 0 ? "Sem duplicidade em casos" : `${dados.casos_linhas_duplicadas} aluno duplicado em casos`} />
          <StatusChip ok={dados.teto_estourado === 0} texto={dados.teto_estourado === 0 ? "Ninguém acima do teto" : `${dados.teto_estourado} operador(es) acima de 500`} />
          <StatusChip ok={dados.maior_desvio <= 500} texto={`Maior desvio de média: ${moeda(dados.maior_desvio)}`} />
        </div>
      </div>

      <div style={estilos.gridResumo}>
        <div style={estilos.cardValor}>
          <span style={estilos.numeroValor}>{(dados.total_alunos || 0).toLocaleString("pt-BR")}</span>
          <span style={estilos.labelValor}>Total de alunos na base</span>
        </div>
        <div style={estilos.cardValor}>
          <span style={estilos.numeroValor}>
            {(dados.alunos_sem_casos || 0).toLocaleString("pt-BR")}
            {dados.total_alunos > 0 && (
              <span style={estilos.percentual}> ({((dados.alunos_sem_casos / dados.total_alunos) * 100).toFixed(1)}%)</span>
            )}
          </span>
          <span style={estilos.labelValor}>Sem nenhum registro em casos</span>
        </div>
        <div style={{ ...estilos.cardValor, background: dados.sem_valor > 0 ? "#fef7f0" : undefined, borderColor: dados.sem_valor > 0 ? "#fde3cc" : undefined }}>
          <span style={{ ...estilos.numeroValor, color: dados.sem_valor > 0 ? "#c2410c" : undefined }}>
            {(dados.sem_valor || 0).toLocaleString("pt-BR")}
            {dados.total_alunos > 0 && (
              <span style={estilos.percentual}> ({((dados.sem_valor / dados.total_alunos) * 100).toFixed(1)}%)</span>
            )}
          </span>
          <span style={estilos.labelValor}>
            Livres sem valor calculado — <a href="/financeiro-hub" style={estilos.link}>ir pra Confirmação de Pagamento</a>
          </span>
        </div>
        <div style={{ ...estilos.cardValor, background: dados.sem_telefone > 0 ? "#fef7f0" : undefined, borderColor: dados.sem_telefone > 0 ? "#fde3cc" : undefined }}>
          <span style={{ ...estilos.numeroValor, color: dados.sem_telefone > 0 ? "#c2410c" : undefined }}>
            {(dados.sem_telefone || 0).toLocaleString("pt-BR")}
            {dados.total_alunos > 0 && (
              <span style={estilos.percentual}> ({((dados.sem_telefone / dados.total_alunos) * 100).toFixed(1)}%)</span>
            )}
          </span>
          <span style={estilos.labelValor}>
            Sem telefone cadastrado — <a href="/financeiro-hub" style={estilos.link}>ir pra Confirmação de Pagamento</a>
          </span>
        </div>
        <div style={{ ...estilos.cardValor, background: "#eff6ff", borderColor: "#c7d7fe" }}>
          <span style={{ ...estilos.numeroValor, color: "#0f7a4f" }}>
            {(dados.livre_com_valor || 0).toLocaleString("pt-BR")}
            {dados.total_alunos > 0 && (
              <span style={{ ...estilos.percentual, color: "#0f7a4f" }}> ({((dados.livre_com_valor / dados.total_alunos) * 100).toFixed(1)}%)</span>
            )}
          </span>
          <span style={estilos.labelValor}>
            Livres com valor (elegíveis) — <a href="/acoes-massivas" style={estilos.link}>ir pra Ações Massivas</a>
          </span>
        </div>
      </div>

      <div style={estilos.card}>
        <h3 style={estilos.tituloBloco}>Equilíbrio entre operadores</h3>
        <p style={estilos.subtituloBloco}>
          Média geral da equipe: <strong>{moeda(dados.media_geral)}</strong> · Maior desvio: <strong>{moeda(dados.maior_desvio)}</strong>
        </p>
        <table style={estilos.tabela}>
          <thead>
            <tr>
              <th style={estilos.th}>Operador</th>
              <th style={estilos.thNum}>Qtd. de casos</th>
              <th style={estilos.thNum}>Valor médio</th>
              <th style={estilos.thNum}>Desvio da média</th>
            </tr>
          </thead>
          <tbody>
            {(dados.operadores || []).map((op) => {
              const desvio = Number(op.media) - Number(dados.media_geral);
              return (
                <tr key={op.operador_email}>
                  <td style={estilos.td}>{OPERADORES_POR_EMAIL[op.operador_email] || op.operador_email}</td>
                  <td style={{ ...estilos.tdNum, color: op.qtd > 500 ? "#b91c1c" : op.qtd < 450 ? "#d97706" : undefined, fontWeight: 700 }}>
                    {op.qtd}
                  </td>
                  <td style={estilos.tdNum}>{moeda(op.media)}</td>
                  <td style={{ ...estilos.tdNum, color: Math.abs(desvio) > 500 ? "#b91c1c" : "#8a93a3" }}>
                    {desvio >= 0 ? "+" : ""}{moeda(desvio)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const estilos = {
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "#f4f6fa", minHeight: "100%" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 6, flexWrap: "wrap" },
  titulo: { margin: 0, color: "#0d1321", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "5px 0 0", color: "#8a93a3", fontSize: 13.5 },
  geradoEm: { margin: "0 0 18px", color: "#98a2b3", fontSize: 12 },
  botaoAtualizar: { background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  card: { background: "#fff", borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 2px rgba(16,24,40,0.04)", border: "1px solid #edf0f5", marginBottom: 18 },
  tituloBloco: { margin: "0 0 14px", fontFamily: FONTE_TITULO, fontSize: 16, fontWeight: 800, color: "#0d1321" },
  subtituloBloco: { margin: "0 0 14px", fontSize: 13, color: "#475569" },
  linhaChips: { display: "flex", gap: 10, flexWrap: "wrap" },
  gridResumo: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 18 },
  cardValor: { background: "#fff", border: "1px solid #edf0f5", borderRadius: 16, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  numeroValor: { fontFamily: FONTE_TITULO, fontSize: 24, fontWeight: 800, color: "#0d1321" },
  labelValor: { fontSize: 12.5, color: "#8a93a3", fontWeight: 600 },
  percentual: { fontSize: 14, fontWeight: 700, color: "#8a93a3" },
  link: { color: "#1e40af", fontWeight: 700 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  td: { padding: "9px 10px", borderBottom: "1px solid #f2f4f7", fontWeight: 700 },
  tdNum: { padding: "9px 10px", borderBottom: "1px solid #f2f4f7", textAlign: "right" },
};
