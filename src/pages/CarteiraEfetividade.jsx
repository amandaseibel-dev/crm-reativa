import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";

// Efetividade da carteira 2026/1 — leitura da Diretoria/Presidência.
//
// Duas dimensões que NÃO se confundem (regra da Amanda, 11/09/2026):
//   EFETIVIDADE DE COBRANÇA  = quanto da carteira foi convertido em pagamento
//                              OU negociação. Quebra e cancelamento posteriores
//                              não devolvem valor para a inadimplência.
//   RECUPERAÇÃO FINANCEIRA   = quanto disso já virou dinheiro. Vive DENTRO da
//                              efetividade e nunca é somada de novo.
//
// As quatro faixas fecham 100% da carteira base congelada. Clicar em qualquer
// uma abre os títulos que a compõem (CPF mascarado — a Diretoria identifica o
// caso, não coleciona documento).

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const moedaCurta = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const data = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");

const FAIXAS = [
  { chave: "efetividade", rotulo: "Efetividade comprovada", drill: "EFETIVIDADE", cor: "var(--rv-azul)",
    ajuda: "Valor original da carteira pago ou negociado em algum momento." },
  { chave: "inadimplencia", rotulo: "Inadimplência confirmada", drill: "INADIMPLENCIA", cor: "#b4232a",
    ajuda: "Sem pagamento e sem nenhuma evidência de negociação, com o Prime confirmando o título aberto." },
  { chave: "em_validacao", rotulo: "Em validação", drill: "EM_VALIDACAO", cor: "#b07d16",
    ajuda: "Há indício de conversão sem evidência suficiente, ou o Prime não confirma a situação atual do título. Não aumenta a efetividade." },
  { chave: "academico", rotulo: "Baixa/Ajuste acadêmico", drill: "ACADEMICO", cor: "var(--rv-texto-fraco)",
    ajuda: "Saiu da situação aberta por evento acadêmico — não é resultado de cobrança." },
];

export default function CarteiraEfetividade() {
  const [d, setD] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [recalculando, setRecalculando] = useState(false);
  const [aberta, setAberta] = useState(null);      // { faixa, sub }
  const [detalhe, setDetalhe] = useState(null);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);
  const [notaAberta, setNotaAberta] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    const { data: r, error } = await supabase.rpc("carteira_2026_1_indicadores");
    if (error) setErro(error.message);
    else setD(r?.vazio ? null : r);
    setCarregando(false);
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  async function recalcular() {
    setRecalculando(true);
    setErro("");
    const { error } = await supabase.rpc("carteira_2026_1_recalcular");
    if (error) setErro(error.message);
    else await carregar();
    setRecalculando(false);
  }

  async function abrirDetalhe(faixaDrill, subFaixa) {
    setAberta({ faixa: faixaDrill, sub: subFaixa || null });
    setCarregandoDetalhe(true);
    setDetalhe(null);
    const { data: r, error } = await supabase.rpc("carteira_2026_1_detalhe", {
      p_faixa: faixaDrill, p_sub_faixa: subFaixa || null, p_limite: 200, p_offset: 0,
    });
    if (error) setErro(error.message);
    else setDetalhe(r);
    setCarregandoDetalhe(false);
  }

  if (carregando) return <Carregando />;

  if (!d) {
    return (
      <div style={{ padding: 24, color: "var(--rv-tinta)" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Efetividade da carteira 2026/1</h1>
        <p style={{ color: "var(--rv-texto-suave)" }}>
          Ainda não há fotografia gerada. {erro ? `Erro: ${erro}` : ""}
        </p>
        <button onClick={recalcular} disabled={recalculando} style={estiloBotao}>
          {recalculando ? "Calculando…" : "Gerar agora"}
        </button>
      </div>
    );
  }

  const base = Number(d.base?.valor || 0);
  const pct = (v) => (base > 0 ? (Number(v || 0) / base) * 100 : 0);
  const fmtPct = (v) => pct(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
  const soma = FAIXAS.reduce((s, f) => s + Number(d.faixas?.[f.chave] || 0), 0);
  const fecha = Math.abs(soma - base) < 0.01;

  return (
    <div style={{ padding: 24, color: "var(--rv-tinta)", maxWidth: 1180, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>Efetividade da carteira 2026/1</h1>
          <p style={{ margin: "4px 0 0", color: "var(--rv-texto-suave)", fontSize: 13 }}>
            Carteira congelada em {data(d.base?.congelada_em)} · entradas de {data(d.base?.entrada_de)} a{" "}
            {data(d.base?.entrada_ate)} · fotografia de {data(d.gerado_em)}
          </p>
        </div>
        <button onClick={recalcular} disabled={recalculando} style={estiloBotao}>
          {recalculando ? "Recalculando…" : "Atualizar"}
        </button>
      </div>

      {erro ? (
        <p style={{ color: "#b4232a", fontSize: 13, marginTop: 12 }}>{erro}</p>
      ) : null}

      {/* CARTEIRA BASE */}
      <section style={{ ...cartao, marginTop: 20 }}>
        <span style={rotuloPequeno}>Carteira base 2026/1</span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 30, letterSpacing: "-0.5px" }}>{moeda(base)}</strong>
          <span style={{ color: "var(--rv-texto-suave)", fontSize: 13 }}>
            100% · {num(d.base?.titulos)} títulos · {num(d.base?.cpfs)} CPFs
          </span>
        </div>
      </section>

      {/* BARRA DAS QUATRO FAIXAS */}
      <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", marginTop: 16,
                    border: "1px solid var(--rv-borda-suave)" }}>
        {FAIXAS.map((f) => (
          <div key={f.chave}
               title={`${f.rotulo}: ${fmtPct(d.faixas?.[f.chave])}`}
               style={{ width: `${pct(d.faixas?.[f.chave])}%`, background: f.cor }} />
        ))}
      </div>

      {/* AS QUATRO FAIXAS */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 12 }}>
        {FAIXAS.map((f) => (
          <button key={f.chave} onClick={() => abrirDetalhe(f.drill, null)}
                  style={{ ...cartao, textAlign: "left", cursor: "pointer", borderLeft: `4px solid ${f.cor}` }}>
            <span style={rotuloPequeno}>{f.rotulo}</span>
            <strong style={{ fontSize: 22 }}>{moeda(d.faixas?.[f.chave])}</strong>
            <div style={{ fontSize: 20, fontWeight: 600, color: f.cor, marginTop: 2 }}>{fmtPct(d.faixas?.[f.chave])}</div>
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--rv-texto-suave)", lineHeight: 1.45 }}>{f.ajuda}</p>
            <span style={{ fontSize: 11, color: "var(--rv-azul-texto)", marginTop: 6, display: "inline-block" }}>
              ver títulos →
            </span>
          </button>
        ))}
      </div>

      {/* RECONCILIAÇÃO */}
      <p style={{ marginTop: 10, fontSize: 12, color: fecha ? "var(--rv-texto-suave)" : "#b4232a" }}>
        {fecha
          ? `As quatro faixas somam ${moeda(soma)} — 100% da carteira base.`
          : `ATENÇÃO: as faixas somam ${moeda(soma)} contra ${moeda(base)} da base.`}
      </p>

      {/* RECUPERAÇÃO FINANCEIRA */}
      <section style={{ ...cartao, marginTop: 18, borderLeft: "4px solid var(--rv-azul)" }}>
        <span style={rotuloPequeno}>Recuperação financeira (dentro da efetividade)</span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 26 }}>{moeda(d.recuperacao?.total)}</strong>
          <span style={{ fontSize: 18, fontWeight: 600, color: "var(--rv-azul)" }}>{fmtPct(d.recuperacao?.total)}</span>
          <span style={{ color: "var(--rv-texto-suave)", fontSize: 13 }}>da carteira base</span>
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--rv-texto-suave)", lineHeight: 1.5 }}>
          Dinheiro que efetivamente entrou: {moedaCurta(d.recuperacao?.parcelas_e_baixas)} em parcelas de acordo e
          baixas com lastro, mais {moedaCurta(d.recuperacao?.caixa_acordo_fora_do_crm)} de acordo pago fora do CRM e
          conciliado. <strong>Não somar à reconciliação</strong> — já está dentro da efetividade.
        </p>
      </section>

      {/* COMPOSIÇÃO DA EFETIVIDADE */}
      <section style={{ ...cartao, marginTop: 18 }}>
        <span style={rotuloPequeno}>Qualidade da conversão — composição da efetividade</span>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 6 }}>
          <thead>
            <tr style={{ color: "var(--rv-texto-fraco)", textAlign: "left" }}>
              <th style={th}>Situação</th>
              <th style={{ ...th, textAlign: "right" }}>Valor da carteira</th>
              <th style={{ ...th, textAlign: "right" }}>% da carteira</th>
              <th style={{ ...th, textAlign: "right" }}>% da efetividade</th>
              <th style={{ ...th, textAlign: "right" }}>Títulos</th>
            </tr>
          </thead>
          <tbody>
            {(d.composicao || []).map((c) => {
              const efet = Number(d.faixas?.efetividade || 0);
              return (
                <tr key={c.sub_faixa} onClick={() => abrirDetalhe("EFETIVIDADE", null)}
                    style={{ borderTop: "1px solid var(--rv-borda-suave)", cursor: "pointer" }}>
                  <td style={td}>{c.sub_faixa}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{moeda(c.valor)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{fmtPct(c.valor)}</td>
                  <td style={{ ...td, textAlign: "right", color: "var(--rv-texto-suave)" }}>
                    {efet > 0 ? ((Number(c.valor) / efet) * 100).toFixed(1) + "%" : "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right", color: "var(--rv-texto-suave)" }}>{num(c.titulos)}</td>
                </tr>
              );
            })}
            <tr style={{ borderTop: "2px solid var(--rv-borda-forte)" }}>
              <td style={{ ...td, fontWeight: 700 }}>Efetividade comprovada</td>
              <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{moeda(d.faixas?.efetividade)}</td>
              <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{fmtPct(d.faixas?.efetividade)}</td>
              <td style={{ ...td, textAlign: "right" }}>100%</td>
              <td style={td} />
            </tr>
          </tbody>
        </table>
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--rv-texto-suave)", lineHeight: 1.5 }}>
          Um título negociado e depois pago não soma duas vezes: o valor apenas muda de linha, de “negociado” para
          “pago”. Nenhum real aparece em duas situações, e a efetividade de um título nunca passa do valor original —
          juros, multa e honorários não aumentam a carteira recuperada.
        </p>
      </section>

      {/* CPFs */}
      <section style={{ ...cartao, marginTop: 18 }}>
        <span style={rotuloPequeno}>Por CPF</span>
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap", fontSize: 13 }}>
          <span><strong style={{ fontSize: 18 }}>{num(d.cpfs?.convertido_total)}</strong><br />
            <span style={{ color: "var(--rv-texto-suave)" }}>100% convertido</span></span>
          <span><strong style={{ fontSize: 18 }}>{num(d.cpfs?.parcial)}</strong><br />
            <span style={{ color: "var(--rv-texto-suave)" }}>parcialmente convertido</span></span>
          <span><strong style={{ fontSize: 18 }}>{num(d.cpfs?.zero_conversao)}</strong><br />
            <span style={{ color: "var(--rv-texto-suave)" }}>sem conversão</span></span>
          <span><strong style={{ fontSize: 18 }}>{num(d.titulos_inadimplentes)}</strong><br />
            <span style={{ color: "var(--rv-texto-suave)" }}>títulos inadimplentes</span></span>
        </div>
      </section>

      {/* NOTA METODOLÓGICA */}
      <section style={{ ...cartao, marginTop: 18, background: "var(--rv-fundo-suave)" }}>
        <button onClick={() => setNotaAberta((v) => !v)}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
                         color: "var(--rv-azul-texto)", fontSize: 13, fontWeight: 600 }}>
          {notaAberta ? "▾" : "▸"} Nota metodológica e qualidade dos dados
        </button>
        {notaAberta ? (
          <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--rv-texto-suave)", lineHeight: 1.6, display: "grid", gap: 8 }}>
            <p style={{ margin: 0 }}>
              <strong style={{ color: "var(--rv-tinta)" }}>Efetividade comprovada.</strong> O indicador considera
              somente valores da carteira 2026/1 com evidência rastreável de pagamento ou negociação.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: "var(--rv-tinta)" }}>Em validação.</strong> Casos com indício de conversão, mas
              sem evidência suficiente para classificação definitiva, são apresentados separadamente e não aumentam a
              efetividade.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: "var(--rv-tinta)" }}>Histórico.</strong> O histórico estruturado de pagamentos
              disponível no CRM inicia em julho de 2026. Por isso, vínculos históricos anteriores ou não preservados
              integralmente podem permanecer em validação até sua reconstrução.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: "var(--rv-tinta)" }}>Precedência das fontes.</strong> A{" "}
              <strong style={{ color: "var(--rv-tinta)" }}>situação atual</strong> é do Prime — série e semestre do
              título, título aberto ou liquidado, portador, matrícula e situação acadêmica. O estado do CRM não
              sobrepõe informação disponível no Prime. Já o{" "}
              <strong style={{ color: "var(--rv-tinta)" }}>histórico de conversão</strong> — existência de acordos,
              parcelas, pagamentos recebidos e eventos de cobrança — vem do CRM e das importações operacionais, porque
              a API do Prime não entrega esses dados. Quando o Prime não tem linha para o título, ninguém confirma que
              ele segue aberto: o valor fica em validação, nunca em inadimplência confirmada.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: "var(--rv-tinta)" }}>Por que situação atual não decide histórico.</strong> Está
              medido que um título negociado pode voltar a aparecer aberto no Prime quando o acordo quebra — em 28,7%
              dos casos. Por isso “aberto hoje” nunca é lido como “nunca foi negociado”.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: "var(--rv-tinta)" }}>Fonte atual.</strong> A situação atual dos títulos é
              confrontada com informações do Prime, enquanto pagamentos, acordos e parcelas utilizam também as
              importações operacionais do CRM.
            </p>
          </div>
        ) : null}
      </section>

      {/* DRILL-DOWN */}
      {aberta ? (
        <section style={{ ...cartao, marginTop: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <span style={rotuloPequeno}>
              Detalhe — {aberta.faixa.replace("_", " ").toLowerCase()}
              {detalhe ? ` · ${num(detalhe.total_titulos)} títulos · ${moeda(detalhe.total_valor)}` : ""}
            </span>
            <button onClick={() => { setAberta(null); setDetalhe(null); }} style={{ ...estiloBotao, padding: "4px 10px" }}>
              fechar
            </button>
          </div>
          {carregandoDetalhe ? (
            <p style={{ fontSize: 13, color: "var(--rv-texto-suave)" }}>Carregando…</p>
          ) : (
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr style={{ color: "var(--rv-texto-fraco)", textAlign: "left" }}>
                    <th style={th}>Aluno</th><th style={th}>CPF</th><th style={th}>Título</th>
                    <th style={th}>Vencimento</th><th style={th}>Situação</th>
                    <th style={{ ...th, textAlign: "right" }}>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {(detalhe?.linhas || []).map((l, i) => (
                    <tr key={`${l.documento}-${i}`} style={{ borderTop: "1px solid var(--rv-borda-suave)" }}>
                      <td style={td}>{l.aluno}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{l.cpf}</td>
                      <td style={td}>{l.documento}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{data(l.vencimento)}</td>
                      <td style={td}>
                        {l.sub_faixa}
                        <span style={{ color: "var(--rv-texto-fraco)" }}> · {l.estado_prime}</span>
                      </td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{moeda(l.valor_na_faixa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detalhe && detalhe.total_titulos > (detalhe.linhas || []).length ? (
                <p style={{ fontSize: 12, color: "var(--rv-texto-suave)", marginTop: 8 }}>
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

const cartao = {
  background: "var(--rv-fundo-cartao)",
  border: "1px solid var(--rv-borda-suave)",
  borderRadius: 12,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  color: "var(--rv-tinta)",
};
const rotuloPequeno = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--rv-texto-fraco)",
  fontWeight: 700,
};
const th = { padding: "6px 8px", fontWeight: 600, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em" };
const td = { padding: "7px 8px", verticalAlign: "top" };
const estiloBotao = {
  background: "var(--rv-azul-fundo)",
  border: "1px solid var(--rv-azul-borda)",
  color: "var(--rv-azul-texto)",
  borderRadius: 8,
  padding: "7px 14px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
