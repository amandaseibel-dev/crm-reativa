import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// NEGOCIAÇÕES 2026/2 — semestre vigente.
//
// 2026/2 está em andamento e a carteira ainda está em formação: as remessas
// continuam entrando. Por isso esta visão NÃO calcula inadimplência, não trata
// o semestre inteiro como não convertido e não compara percentual com a
// efetividade consolidada de 2026/1. Ela responde uma pergunta só:
//
//   quanto do semestre vigente já precisou ser negociado, e quanto disso já
//   foi recebido?
//
// Valor sempre pelo ORIGINAL do título (juros e honorários não inflam), safra
// pela série do Prime (fallback por vencimento fica marcado no detalhe), e
// título que é parcela de acordo renegociada fica de fora — senão entraria
// como carteira de 2026/2 e duplicaria com 2026/1.

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const data = (v) => (v ? new Date(v + "T12:00:00").toLocaleDateString("pt-BR") : "—");
const dataHora = (v) => (v ? new Date(v).toLocaleString("pt-BR") : "—");

const CORES = {
  "Quitado": "var(--rv-azul)",
  "Regular": "#1f7a3d",
  "Em atraso": "#b07d16",
  "Acordo quebrado": "#b4232a",
  "Acordo cancelado": "var(--rv-texto-fraco)",
};

export default function Negociacoes20262() {
  const [d, setD] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [estado, setEstado] = useState(null);
  const [detalhe, setDetalhe] = useState(null);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const [r1, r2] = await Promise.all([
        supabase.rpc("carteira_2026_2_negociacoes"),
        supabase.rpc("carteira_2026_2_contexto"),
      ]);
      if (!ativo) return;
      if (r1.error) setErro(r1.error.message);
      else setD(r1.data);
      if (!r2.error) setCtx(r2.data);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  async function abrir(nome) {
    setEstado(nome);
    setDetalhe(null);
    setCarregandoDetalhe(true);
    const { data: r, error } = await supabase.rpc("carteira_2026_2_detalhe", {
      p_estado: nome, p_limite: 200, p_offset: 0,
    });
    if (error) setErro(error.message);
    else setDetalhe(r);
    setCarregandoDetalhe(false);
  }

  if (carregando) return <p style={S.legenda}>Carregando…</p>;
  if (erro && !d) return <p style={{ ...S.legenda, color: "#b4232a" }}>{erro}</p>;
  if (!d) return null;

  const t = d.total || {};
  const pctRecebido = Number(t.negociado) > 0 ? (Number(t.recebido) / Number(t.negociado)) * 100 : 0;

  return (
    <div>
      <div style={{ marginTop: 4 }}>
        <h2 style={{ fontSize: 20, margin: 0 }}>Negociações 2026/2 · Semestre vigente</h2>
        <p style={{ margin: "4px 0 0", color: "var(--rv-texto-suave)", fontSize: 13 }}>
          Acompanhamento das negociações realizadas sobre títulos do semestre atual
        </p>
      </div>

      {/* CONTEXTO DAS REMESSAS — para ninguém ler o valor como desempenho final */}
      <div style={{ ...S.aviso, marginTop: 14 }}>
        <strong style={{ color: "var(--rv-tinta)" }}>
          Semestre vigente · carteira em formação conforme entrada das remessas.
        </strong>
        <div style={{ marginTop: 6, display: "flex", gap: 22, flexWrap: "wrap", fontSize: 12 }}>
          <span>Primeira remessa 2026/2: <strong>{data(ctx?.primeira_remessa)}</strong></span>
          <span>Última remessa: <strong>{data(ctx?.ultima_remessa)}</strong></span>
          <span>Remessas recebidas: <strong>{num(ctx?.remessas)}</strong></span>
          <span>Dados atualizados em: <strong>{dataHora(ctx?.atualizado_em || d.gerado_em)}</strong></span>
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.5 }}>
          O valor negociado abaixo se refere às <strong>remessas de 2026/2 recebidas até agora</strong> — não é a
          efetividade final do semestre, que ainda está em curso.
        </p>
      </div>

      {/* QUATRO CARDS */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 16 }}>
        <div style={{ ...S.card, borderLeft: "4px solid var(--rv-azul)" }}>
          <span style={S.rotulo}>Valor negociado</span>
          <strong style={{ fontSize: 26 }}>{moeda(t.negociado)}</strong>
          <span style={S.sub}>{num(t.titulos)} títulos negociados · {num(t.acordos)} acordos</span>
        </div>
        <div style={S.card}>
          <span style={S.rotulo}>Alunos negociados</span>
          <strong style={{ fontSize: 26 }}>{num(t.cpfs)} CPFs</strong>
          <span style={S.sub}>do semestre vigente</span>
        </div>
        <div style={{ ...S.card, borderLeft: "4px solid #1f7a3d" }}>
          <span style={S.rotulo}>Já recebido</span>
          <strong style={{ fontSize: 26 }}>{moeda(t.recebido)}</strong>
          <span style={{ ...S.sub, color: "#1f7a3d", fontWeight: 600 }}>
            {pctRecebido.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% do valor negociado
          </span>
        </div>
        <div style={S.card}>
          <span style={S.rotulo}>Saldo negociado</span>
          <strong style={{ fontSize: 26 }}>{moeda(t.saldo)}</strong>
          <span style={S.sub}>ainda a receber</span>
        </div>
      </div>

      {/* SITUAÇÃO DAS NEGOCIAÇÕES */}
      <section style={{ ...S.card, marginTop: 18 }}>
        <span style={S.rotulo}>Situação das negociações</span>
        <div style={{ overflowX: "auto", marginTop: 6 }}>
          <table style={S.tabela}>
            <thead>
              <tr style={{ color: "var(--rv-texto-fraco)", textAlign: "left" }}>
                <th style={S.th}>Situação</th>
                <th style={{ ...S.th, textAlign: "right" }}>Negociado</th>
                <th style={{ ...S.th, textAlign: "right" }}>Recebido</th>
                <th style={{ ...S.th, textAlign: "right" }}>Saldo</th>
                <th style={{ ...S.th, textAlign: "right" }}>Títulos</th>
                <th style={{ ...S.th, textAlign: "right" }}>CPFs</th>
              </tr>
            </thead>
            <tbody>
              {(d.estados || []).map((e) => (
                <tr key={e.estado} onClick={() => abrir(e.estado)}
                    style={{ borderTop: "1px solid var(--rv-borda-suave)", cursor: "pointer" }}>
                  <td style={S.td}>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 8,
                                   background: CORES[e.estado] || "var(--rv-texto-fraco)" }} />
                    {e.estado}
                  </td>
                  <td style={{ ...S.td, textAlign: "right", fontWeight: 600 }}>{moeda(e.negociado)}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>{moeda(e.recebido)}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>{moeda(e.saldo)}</td>
                  <td style={{ ...S.td, textAlign: "right", color: "var(--rv-texto-suave)" }}>{num(e.titulos)}</td>
                  <td style={{ ...S.td, textAlign: "right", color: "var(--rv-texto-suave)" }}>{num(e.cpfs)}</td>
                </tr>
              ))}
              <tr style={{ borderTop: "2px solid var(--rv-borda-forte)" }}>
                <td style={{ ...S.td, fontWeight: 700 }}>Total</td>
                <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{moeda(t.negociado)}</td>
                <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{moeda(t.recebido)}</td>
                <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{moeda(t.saldo)}</td>
                <td style={{ ...S.td, textAlign: "right" }}>{num(t.titulos)}</td>
                <td style={{ ...S.td, textAlign: "right" }}>{num(t.cpfs)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p style={{ ...S.legenda, marginTop: 10 }}>
          Valor sempre pelo original do título: juros, multa e honorários não aumentam a carteira negociada. Acordo que
          mistura safras entra aqui só com a parte de 2026/2. Clique numa situação para ver os alunos.
          {Number(t.titulos_por_fallback) > 0 ? (
            <> {num(t.titulos_por_fallback)} título(s) ({moeda(t.valor_por_fallback)}) entraram pelo vencimento por não
            terem série no Prime — ficam identificados no detalhe.</>
          ) : null}
        </p>
      </section>

      {/* DETALHE */}
      {estado ? (
        <section style={{ ...S.card, marginTop: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <span style={S.rotulo}>
              {estado}
              {detalhe ? ` · ${num(detalhe.total_titulos)} títulos · ${moeda(detalhe.total_valor)}` : ""}
            </span>
            <button onClick={() => { setEstado(null); setDetalhe(null); }} style={S.botaoLeve}>fechar</button>
          </div>
          {carregandoDetalhe ? (
            <p style={S.legenda}>Carregando…</p>
          ) : (
            <div style={{ overflowX: "auto", marginTop: 6 }}>
              <table style={S.tabela}>
                <thead>
                  <tr style={{ color: "var(--rv-texto-fraco)", textAlign: "left" }}>
                    <th style={S.th}>Aluno</th>
                    <th style={S.th}>CPF</th>
                    <th style={S.th}>Título</th>
                    <th style={S.th}>Vencimento</th>
                    <th style={S.th}>Acordo</th>
                    <th style={{ ...S.th, textAlign: "right" }}>Valor original</th>
                    <th style={{ ...S.th, textAlign: "right" }}>Recebido</th>
                    <th style={S.th}>Safra por</th>
                  </tr>
                </thead>
                <tbody>
                  {(detalhe?.linhas || []).map((l, i) => (
                    <tr key={`${l.documento}-${i}`} style={{ borderTop: "1px solid var(--rv-borda-suave)" }}>
                      <td style={S.td}>{l.aluno}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>{l.cpf}</td>
                      <td style={S.td}>{l.documento}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>{data(l.vencimento)}</td>
                      <td style={S.td}>{l.acordo}</td>
                      <td style={{ ...S.td, textAlign: "right", fontWeight: 600 }}>{moeda(l.valor_original)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>{moeda(l.recebido)}</td>
                      <td style={{ ...S.td, fontSize: 11, color: "var(--rv-texto-fraco)" }}>{l.fonte_semestre}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detalhe && detalhe.total_titulos > (detalhe.linhas || []).length ? (
                <p style={S.legenda}>
                  Mostrando os {num((detalhe.linhas || []).length)} maiores de {num(detalhe.total_titulos)}.
                </p>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

const S = {
  card: {
    background: "var(--rv-fundo-cartao)",
    border: "1px solid var(--rv-borda-suave)",
    borderRadius: 12,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    color: "var(--rv-tinta)",
  },
  aviso: {
    background: "var(--rv-fundo-suave)",
    border: "1px solid var(--rv-borda-suave)",
    borderRadius: 10,
    padding: "12px 14px",
    color: "var(--rv-texto-suave)",
    fontSize: 12.5,
    lineHeight: 1.5,
  },
  rotulo: {
    fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em",
    color: "var(--rv-texto-fraco)", fontWeight: 700,
  },
  sub: { fontSize: 12, color: "var(--rv-texto-suave)" },
  legenda: { fontSize: 12, color: "var(--rv-texto-suave)", lineHeight: 1.5, margin: "8px 0 0" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: { padding: "6px 8px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" },
  td: { padding: "7px 8px", verticalAlign: "top" },
  botaoLeve: {
    background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-azul-borda)",
    color: "var(--rv-azul-texto)", borderRadius: 8, padding: "4px 10px", fontSize: 12,
    fontWeight: 600, cursor: "pointer",
  },
};
