import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";

// Historico da fila de confirmacao por dia, com quem fez cada acao (ultimos 30
// dias, horario de Brasilia). So leitura.
//
// A RPC devolve uma linha por (dia, pessoa, acao). "Confirmar" nao e a unica
// coisa que se faz nessa fila -- concluir como saldo zero e rejeitar tambem
// sao trabalho, e antes nao apareciam em lugar nenhum. E o que a faxina
// automatica fecha sozinha vem marcado como automatico, separado das pessoas:
// antes virava um "-" na tela, que parecia gente.

const ACAO_LABEL = {
  CONFIRMADO: "confirmou",
  SALDO_ZERO: "saldo zero",
  REJEITADO: "rejeitou",
};

const ACAO_COR = {
  CONFIRMADO: { background: "#dcfce7", border: "1px solid #bbf7d0", color: "#166534" },
  SALDO_ZERO: { background: "#eef2ff", border: "1px solid #e0e7ff", color: "#3730a3" },
  REJEITADO: { background: "#fee2e2", border: "1px solid #fecaca", color: "#991b1b" },
};

function dataBR(iso) {
  if (!iso) return "-";
  const p = String(iso).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
}

export default function HistoricoConfirmacoes() {
  const [rows, setRows] = useState([]);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("historico_confirmacoes_por_dia");
      setRows(data || []);
      setCarregando(false);
    })();
  }, []);

  // Agrupa por dia e, dentro do dia, por pessoa -- cada pessoa carrega o que
  // fez de cada tipo. O automatico fica num balde proprio, fora do total das
  // pessoas, pra nao inflar o trabalho de ninguem.
  const porDia = useMemo(() => {
    const m = {};
    rows.forEach((r) => {
      const qtd = Number(r.qtd) || 0;
      if (!m[r.dia]) m[r.dia] = { dia: r.dia, pessoas: {}, automatico: 0, total: 0 };
      const d = m[r.dia];
      if (r.automatico) {
        d.automatico += qtd;
        return;
      }
      d.total += qtd;
      if (!d.pessoas[r.usuario]) d.pessoas[r.usuario] = { usuario: r.usuario, total: 0, acoes: [] };
      d.pessoas[r.usuario].total += qtd;
      d.pessoas[r.usuario].acoes.push({ acao: r.acao, qtd });
    });
    return Object.values(m)
      .map((d) => ({
        ...d,
        pessoas: Object.values(d.pessoas).sort((a, b) => b.total - a.total),
      }))
      .sort((a, b) => String(b.dia).localeCompare(String(a.dia)));
  }, [rows]);

  // Os cards contam o que PESSOAS fizeram; o automatico entra separado.
  const soPessoas = rows.filter((r) => !r.automatico);
  const totalGeral = soPessoas.reduce((s, r) => s + (Number(r.qtd) || 0), 0);
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const totalHoje = soPessoas.filter((r) => r.dia === hoje).reduce((s, r) => s + (Number(r.qtd) || 0), 0);
  const totalAuto = rows.filter((r) => r.automatico).reduce((s, r) => s + (Number(r.qtd) || 0), 0);

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h2 style={S.titulo}>Histórico de confirmações</h2>
          <p style={S.sub}>
            O que cada pessoa fez na fila de confirmação por dia — confirmou, concluiu como saldo zero
            ou rejeitou. Últimos 30 dias. O que o sistema fecha sozinho aparece separado.
          </p>
        </div>
        <div style={S.cards}>
          <div style={S.card}><div style={S.cardNum}>{totalHoje}</div><div style={S.cardRot}>Hoje</div></div>
          <div style={S.card}><div style={S.cardNum}>{totalGeral}</div><div style={S.cardRot}>Total (30 dias)</div></div>
          <div style={S.card}><div style={{ ...S.cardNum, color: "#8a93a3" }}>{totalAuto}</div><div style={S.cardRot}>Automático</div></div>
        </div>
      </div>

      {carregando ? (
        <Carregando texto="Carregando…" />
      ) : porDia.length === 0 ? (
        <p style={S.muted}>Nenhuma ação registrada nos últimos 30 dias.</p>
      ) : (
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Dia</th>
              <th style={S.thNum}>Pessoas</th>
              <th style={S.th}>Quem fez o quê</th>
              <th style={S.thNum}>Automático</th>
            </tr>
          </thead>
          <tbody>
            {porDia.map((d) => (
              <tr key={d.dia}>
                <td style={S.td}><strong>{dataBR(d.dia)}</strong></td>
                <td style={S.tdNum}>{d.total}</td>
                <td style={S.td}>
                  {d.pessoas.length === 0 ? (
                    <span style={S.muted}>—</span>
                  ) : (
                    <div style={S.linhasPessoa}>
                      {d.pessoas.map((p) => (
                        <div key={p.usuario} style={S.pessoa}>
                          <span style={S.pessoaNome}>{p.usuario}</span>
                          <div style={S.chips}>
                            {p.acoes.map((a, i) => (
                              <span key={i} style={{ ...S.chip, ...(ACAO_COR[a.acao] || {}) }}>
                                {ACAO_LABEL[a.acao] || a.acao} <strong>{a.qtd}</strong>
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td style={S.tdAuto} title="Fechado pela rotina automática (aluno já quitado/baixado) — não é trabalho de ninguém">
                  {d.automatico || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const S = {
  wrap: { padding: "20px 22px 28px", fontFamily: "'Inter', system-ui, sans-serif", color: "#0f172a" },
  topo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 16 },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 18, fontWeight: 800, color: "#0d1321" },
  sub: { margin: "4px 0 0", color: "#8a93a3", fontSize: 13 },
  cards: { display: "flex", gap: 12 },
  card: { background: "#f8fafc", border: "1px solid #e6eaf0", borderRadius: 12, padding: "10px 18px", textAlign: "center", minWidth: 100 },
  cardNum: { fontSize: 24, fontWeight: 800, color: "#0d1321", fontFamily: "'Sora', Inter, sans-serif" },
  cardRot: { fontSize: 12, color: "#8a93a3", fontWeight: 600, marginTop: 2 },
  muted: { color: "#8a93a3", fontSize: 14 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "9px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  thNum: { textAlign: "right", padding: "9px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  td: { padding: "9px 12px", borderBottom: "1px solid #f2f4f7", color: "#344054", verticalAlign: "top" },
  tdNum: { padding: "9px 12px", borderBottom: "1px solid #f2f4f7", textAlign: "right", fontWeight: 800, color: "#101828" },
  linhasPessoa: { display: "flex", flexDirection: "column", gap: 6 },
  pessoa: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  pessoaNome: { fontWeight: 700, color: "#101828", minWidth: 120 },
  tdAuto: { padding: "9px 12px", borderBottom: "1px solid #f2f4f7", textAlign: "right", color: "#8a93a3", fontWeight: 700 },
  chips: { display: "flex", gap: 6, flexWrap: "wrap" },
  chip: { fontSize: 12, background: "#eef2ff", border: "1px solid #e0e7ff", borderRadius: 999, padding: "2px 10px", color: "#3730a3" },
};
