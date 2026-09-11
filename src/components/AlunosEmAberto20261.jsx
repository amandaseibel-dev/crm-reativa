import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Complemento da Visão Executiva: quem ainda deve 2026/1 e em que situação
// acadêmica está — para a Diretoria saber quem ainda pode voltar a estudar.
//
// "Em aberto" = o que a cobrança ainda não converteu (inadimplência confirmada
// + em validação). Quem negociou está regularizado e fica de fora: é o que
// permite matricular. Conta por CPF ÚNICO, somando os títulos dele.
//
// MATRICULADO NÃO É CATEGORIA NORMAL: aluno com ficha pendente não deveria
// conseguir efetivar matrícula. Quando o Prime mostra matrícula 2026/2
// confirmada com dívida 2026/1 aberta, isso vira "Exceção | Matrícula com
// pendência" — mostrada à parte, com detalhe para conferir caso a caso. O
// painel NÃO afirma que é liminar judicial.
//
// Não toca em nada da efetividade: só lê a classificação já publicada.

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const moedaExata = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");

const EXCECAO = "Exceção | Matrícula com pendência";

export default function AlunosEmAberto20261() {
  const [d, setD] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [aberto, setAberto] = useState(false);
  const [categoria, setCategoria] = useState(null);
  const [detalhe, setDetalhe] = useState(null);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      const { data, error } = await supabase.rpc("carteira_2026_1_academico");
      if (!ativo) return;
      if (error) setErro(error.message);
      else setD(data);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  async function abrirCategoria(nome) {
    setCategoria(nome);
    setDetalhe(null);
    setCarregandoDetalhe(true);
    const { data, error } = await supabase.rpc("carteira_2026_1_academico_detalhe", {
      p_categoria: nome, p_limite: 200, p_offset: 0,
    });
    if (error) setErro(error.message);
    else setDetalhe(data);
    setCarregandoDetalhe(false);
  }

  if (carregando && !d) return null;
  if (erro && !d) return null;   // complemento: nunca derruba a Visão Executiva
  if (!d) return null;

  const totalCpfs = Number(d.total?.cpfs || 0);

  return (
    <div style={S.card}>
      <button onClick={() => setAberto((v) => !v)} style={S.cabecalho}>
        <div style={{ textAlign: "left" }}>
          <span style={S.rotulo}>Alunos 2026/1 em aberto</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 26 }}>{num(totalCpfs)} CPFs</strong>
            <span style={{ fontSize: 18, color: "var(--rv-texto-suave)" }}>
              {moeda(d.total?.valor)} em aberto
            </span>
          </div>
        </div>
        <span style={{ color: "var(--rv-azul-texto)", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
          {aberto ? "▾ fechar" : "▸ ver situação acadêmica"}
        </span>
      </button>

      {aberto ? (
        <div style={{ marginTop: 14 }}>
          <p style={S.legenda}>
            Situação acadêmica dos alunos que ainda têm pendência de 2026/1. A matrícula 2026/2 vem do Prime; os
            status que o Prime não expressa vêm do cadastro acadêmico do CRM e estão marcados como tal.
          </p>

          <div style={{ overflowX: "auto" }}>
            <table style={S.tabela}>
              <thead>
                <tr style={{ color: "var(--rv-texto-fraco)", textAlign: "left" }}>
                  <th style={S.th}>Situação</th>
                  <th style={{ ...S.th, textAlign: "right" }}>CPFs</th>
                  <th style={{ ...S.th, textAlign: "right" }}>% dos alunos</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Em aberto</th>
                  <th style={S.th}>Fonte</th>
                </tr>
              </thead>
              <tbody>
                {(d.categorias || []).map((c) => {
                  const ehExcecao = c.categoria === EXCECAO;
                  return (
                    <tr key={c.categoria} onClick={() => abrirCategoria(c.categoria)}
                        style={{
                          borderTop: "1px solid var(--rv-borda-suave)",
                          cursor: "pointer",
                          background: ehExcecao ? "var(--rv-fundo-suave)" : "transparent",
                        }}>
                      <td style={{ ...S.td, fontWeight: ehExcecao ? 700 : 500 }}>
                        {ehExcecao ? "⚠ " : ""}{c.categoria}
                      </td>
                      <td style={{ ...S.td, textAlign: "right", fontWeight: 600 }}>{num(c.cpfs)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>{c.pct_cpfs}%</td>
                      <td style={{ ...S.td, textAlign: "right" }}>{moeda(c.valor)}</td>
                      <td style={{ ...S.td, fontSize: 11, color: "var(--rv-texto-fraco)" }}>{c.fonte}</td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: "2px solid var(--rv-borda-forte)" }}>
                  <td style={{ ...S.td, fontWeight: 700 }}>Total</td>
                  <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{num(totalCpfs)}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>100%</td>
                  <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{moeda(d.total?.valor)}</td>
                  <td style={S.td} />
                </tr>
              </tbody>
            </table>
          </div>

          <p style={{ ...S.legenda, marginTop: 10 }}>
            <strong style={{ color: "var(--rv-tinta)" }}>Matriculado não é categoria normal.</strong> O aluno só
            efetiva matrícula com a ficha financeira regularizada — por isso matrícula confirmada com dívida aberta
            aparece como exceção, para conferência individual, e não como situação corriqueira.
          </p>

          {categoria ? (
            <div style={{ marginTop: 14, borderTop: "1px solid var(--rv-borda-suave)", paddingTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <span style={S.rotulo}>
                  {categoria}
                  {detalhe ? ` · ${num(detalhe.total_cpfs)} CPFs · ${moedaExata(detalhe.total_valor)}` : ""}
                </span>
                <button onClick={() => { setCategoria(null); setDetalhe(null); }} style={S.botaoLeve}>fechar</button>
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
                        <th style={{ ...S.th, textAlign: "right" }}>Em aberto</th>
                        <th style={S.th}>Contrato 2026/2 (Prime)</th>
                        <th style={S.th}>Situação acadêmica (CRM)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detalhe?.linhas || []).map((l, i) => (
                        <tr key={`${l.cpf}-${i}`} style={{ borderTop: "1px solid var(--rv-borda-suave)" }}>
                          <td style={S.td}>{l.aluno}</td>
                          <td style={{ ...S.td, whiteSpace: "nowrap" }}>{l.cpf}</td>
                          <td style={{ ...S.td, textAlign: "right", fontWeight: 600 }}>{moedaExata(l.em_aberto)}</td>
                          <td style={S.td}>{l.contrato_2026_2}</td>
                          <td style={S.td}>{l.situacao_academica_crm}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {detalhe && detalhe.total_cpfs > (detalhe.linhas || []).length ? (
                    <p style={S.legenda}>
                      Mostrando os {num((detalhe.linhas || []).length)} maiores de {num(detalhe.total_cpfs)}.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
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
    marginTop: 16,
    color: "var(--rv-tinta)",
  },
  cabecalho: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
    width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer",
    color: "var(--rv-tinta)", flexWrap: "wrap",
  },
  rotulo: {
    fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em",
    color: "var(--rv-texto-fraco)", fontWeight: 700, display: "block", marginBottom: 2,
  },
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
