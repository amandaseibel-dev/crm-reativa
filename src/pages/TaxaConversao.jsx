import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Painel de Taxa de Conversao / Efetividade.
// Funil (acao -> resultado) para todos; ranking por operador so aparece
// para gestao (a RPC ja devolve por_operador vazio se nao for gestao).
// A base do ranking e a CARTEIRA de cada operador (os ~500 fidelizados).

const PERIODOS = [
  { dias: 7, rotulo: "7 dias" },
  { dias: 30, rotulo: "30 dias" },
  { dias: 90, rotulo: "90 dias" },
];

function pct(n) {
  if (n === null || n === undefined) return "-";
  return Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";

function corTaxa(t) {
  const v = Number(t) || 0;
  if (v >= 40) return "#16a34a";
  if (v >= 20) return "#2563eb";
  if (v >= 10) return "#d97706";
  return "#dc2626";
}
function corConversao(t) {
  const v = Number(t) || 0;
  if (v >= 3) return "#16a34a";
  if (v >= 2) return "#2563eb";
  if (v >= 1) return "#d97706";
  return "#dc2626";
}

export default function TaxaConversao() {
  const [dias, setDias] = useState(30);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      setCarregando(true);
      setErro(null);
      try {
        const { data, error } = await supabase.rpc("taxa_conversao", { p_dias: dias });
        if (error) throw error;
        if (vivo) setDados(data);
      } catch (e) {
        if (vivo) setErro(e.message || "Falha ao carregar.");
      } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [dias]);

  const funil = dados?.funil || [];
  const operadores = dados?.por_operador || [];
  const maxAlunos = Math.max(1, ...funil.map((f) => f.alunos || 0));

  return (
    <div style={s.container}>
      <div style={s.cabecalho}>
        <div>
          <h1 style={s.titulo}>Taxa de Conversão</h1>
          <p style={s.subtitulo}>Ação → resultado (acordo, quitação ou baixa). Quanto mais fundo no funil, maior a conversão.</p>
        </div>
        <div style={s.periodos}>
          {PERIODOS.map((p) => (
            <button key={p.dias} onClick={() => setDias(p.dias)} style={dias === p.dias ? s.periodoAtivo : s.periodo}>
              {p.rotulo}
            </button>
          ))}
        </div>
      </div>

      {carregando && <div style={s.aviso}>Carregando…</div>}
      {erro && <div style={s.erro}>{erro}</div>}

      {!carregando && !erro && (
        <>
          <div style={s.card}>
            <h2 style={s.h2}>Funil geral</h2>
            <div style={s.funilLista}>
              {funil.map((f) => (
                <div key={f.acao} style={s.funilLinha}>
                  <div style={s.funilNome}>{f.acao.replace(/^\d+\.\s*/, "")}</div>
                  <div style={s.funilBarraFundo}>
                    <div style={{ ...s.funilBarra, width: `${Math.max(3, (100 * (f.alunos || 0)) / maxAlunos)}%` }}>
                      <span style={s.funilBarraTxt}>{f.alunos} alunos</span>
                    </div>
                  </div>
                  <div style={{ ...s.funilTaxa, color: corTaxa(f.taxa) }}>{pct(f.taxa)}</div>
                </div>
              ))}
            </div>
            <p style={s.legenda}>A barra é o volume de alunos que receberam a ação; o % é quantos converteram depois dela.</p>
          </div>

          {operadores.length > 0 && (
            <div style={s.card}>
              <h2 style={s.h2}>Efetividade por operador — sobre a carteira (os ~500)</h2>
              <p style={s.legenda}>
                <b>Cobertura</b> = quanto da carteira o operador realmente trabalha. <b>% Conversão</b> = convertidos ÷ carteira.
                Não adianta ter 500 casos e trabalhar 30.
              </p>
              <div style={s.tabelaWrap}>
                <table style={s.tabela}>
                  <thead>
                    <tr>
                      <th style={s.th}>Operador</th>
                      <th style={s.thNum}>Carteira</th>
                      <th style={s.thNum}>Trabalhou</th>
                      <th style={s.thNum}>Cobertura</th>
                      <th style={s.thNum}>Escalou p/ fundo</th>
                      <th style={s.thNum}>Converteu</th>
                      <th style={s.thNum}>% Conversão</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operadores.map((o, i) => (
                      <tr key={o.nome} style={i % 2 ? s.trAlt : undefined}>
                        <td style={s.td}>{o.nome}</td>
                        <td style={s.tdNum}>{o.carteira}</td>
                        <td style={s.tdNum}>{o.trabalhados}</td>
                        <td style={{ ...s.tdNum, fontWeight: 700, color: corTaxa(o.cobertura) }}>{pct(o.cobertura)}</td>
                        <td style={s.tdNum}>{o.escalados}</td>
                        <td style={s.tdNum}>{o.convertidos}</td>
                        <td style={{ ...s.tdNum, fontWeight: 800, color: corConversao(o.taxa_conversao) }}>{pct(o.taxa_conversao)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={s.legenda}>Carteira = casos fidelizados atuais do operador. Leitura apenas — não altera nem redistribui nada.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const s = {
  container: { minHeight: "100%", background: "#f4f6fa", padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif" },
  cabecalho: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", flexWrap: "wrap", marginBottom: "18px" },
  titulo: { margin: 0, color: "#0d1321", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "6px 0 0 0", color: "#8a93a3", maxWidth: 620, fontSize: 13.5 },
  periodos: { display: "flex", gap: "8px" },
  periodo: { background: "#fff", color: "#334155", border: "1px solid #e2e8f0", padding: "9px 14px", borderRadius: "10px", cursor: "pointer", fontWeight: 700, fontSize: 13 },
  periodoAtivo: { background: "#2563eb", color: "#fff", border: "1px solid #2563eb", padding: "9px 14px", borderRadius: "10px", cursor: "pointer", fontWeight: 700, fontSize: 13 },
  aviso: { background: "#fff", padding: "18px", borderRadius: "14px", color: "#8a93a3" },
  erro: { background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", padding: "14px", borderRadius: "10px" },
  card: { background: "#fff", borderRadius: "16px", padding: "20px 22px", marginBottom: "16px", border: "1px solid #edf0f5", boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  h2: { margin: "0 0 14px 0", fontSize: "16px", color: "#0d1321", fontFamily: FONTE_TITULO, fontWeight: 800 },
  funilLista: { display: "flex", flexDirection: "column", gap: "10px" },
  funilLinha: { display: "grid", gridTemplateColumns: "150px 1fr 70px", alignItems: "center", gap: "12px" },
  funilNome: { fontSize: "14px", fontWeight: 700, color: "#334155" },
  funilBarraFundo: { background: "#f1f5f9", borderRadius: "8px", height: "30px", overflow: "hidden" },
  funilBarra: { background: "linear-gradient(90deg, #2563eb, #60a5fa)", height: "100%", display: "flex", alignItems: "center", paddingLeft: "10px", borderRadius: "8px", minWidth: "70px" },
  funilBarraTxt: { color: "#fff", fontSize: "12px", fontWeight: 700, whiteSpace: "nowrap" },
  funilTaxa: { fontSize: "16px", fontWeight: 800, textAlign: "right" },
  legenda: { fontSize: "12px", color: "#8a93a3", margin: "12px 0 0 0" },
  tabelaWrap: { overflowX: "auto", marginTop: "8px" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: "13.5px" },
  th: { textAlign: "left", padding: "10px 12px", borderBottom: "1px solid #e3e7ee", color: "#8a93a3", fontSize: "10.5px", fontWeight: 700, textTransform: "uppercase", background: "#f8fafc" },
  thNum: { textAlign: "right", padding: "10px 12px", borderBottom: "1px solid #e3e7ee", color: "#8a93a3", fontSize: "10.5px", fontWeight: 700, textTransform: "uppercase", background: "#f8fafc" },
  td: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", color: "#0d1321", fontWeight: 700 },
  tdNum: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", color: "#334155", textAlign: "right" },
  trAlt: { background: "#f8fafc" },
};
