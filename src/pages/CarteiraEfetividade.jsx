import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import Negociacoes20262 from "../components/Negociacoes20262";
import CoberturaHistorica from "../components/CoberturaHistorica";

// EFETIVIDADE DA COBRANÇA — leitura da Diretoria/Presidência.
//
// Cada safra tem régua própria, e por isso a navegação separa: 2026/1 é
// carteira consolidada (as quatro faixas somam 100%), 2026/2 está em curso e só
// mostra o negociado, e 2024/2025 não tem percentual nenhum — o CRM não guarda
// o que houve antes de julho/2026.
//
// A tela de 2026/1 é de leitura em 10 segundos: três números no topo, a
// composição da carteira numa barra, a qualidade da conversão em linhas, e TODO
// o texto metodológico recolhido em "Ver metodologia". Nenhuma conta acontece
// aqui — os valores vêm prontos das RPCs; o front só desenha.
//
// Duas dimensões que não se confundem:
//   EFETIVIDADE = quanto da carteira foi convertido em pagamento OU negociação.
//   RECUPERAÇÃO FINANCEIRA = quanto disso já virou dinheiro. Vive DENTRO da
//   efetividade e nunca é somada de novo.

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const moedaCurta = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1e6) return "R$ " + (n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " mi";
  if (Math.abs(n) >= 1e3) return "R$ " + (n / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
  return moeda(n);
};
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const data = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");

const FAIXAS = [
  { chave: "efetividade", rotulo: "Efetividade comprovada", drill: "EFETIVIDADE", cor: "#2563eb",
    def: "Valor original da carteira pago ou negociado em algum momento. Atraso, quebra ou cancelamento posteriores não devolvem o valor." },
  { chave: "inadimplencia", rotulo: "Inadimplência confirmada", drill: "INADIMPLENCIA", cor: "#b4232a",
    def: "Sem pagamento e sem nenhuma evidência de negociação, com o Prime confirmando o título aberto." },
  { chave: "em_validacao", rotulo: "Em validação", drill: "EM_VALIDACAO", cor: "#c08a1e",
    def: "Há indício de conversão sem evidência suficiente, ou o Prime não confirma a situação atual. Não aumenta a efetividade." },
  { chave: "academico", rotulo: "Ajuste acadêmico", drill: "ACADEMICO", cor: "#94a3b8",
    def: "Saiu da situação aberta por evento acadêmico — não é resultado de cobrança." },
];

const COR_SUB = {
  "Pago / Quitado": "#1f7a3d",
  "Negociado regular": "#2563eb",
  "Negociado em atraso (ate 30 dias)": "#c08a1e",
  "Acordo quebrado (acima de 30 dias)": "#b4232a",
  "Acordo cancelado": "#94a3b8",
  "Convertido com origem comprovada": "#6d28d9",
};
const ROTULO_SUB = {
  "Negociado regular": "Negociação regular",
  "Negociado em atraso (ate 30 dias)": "Negociação em atraso",
  "Acordo quebrado (acima de 30 dias)": "Acordo quebrado",
  "Convertido com origem comprovada": "Outras conversões comprovadas",
};

export default function CarteiraEfetividade() {
  const [d, setD] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [recalculando, setRecalculando] = useState(false);
  const [ano, setAno] = useState("2026");
  const [sem, setSem] = useState("1");
  const [aberta, setAberta] = useState(null);
  const [detalhe, setDetalhe] = useState(null);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);
  const [metodologia, setMetodologia] = useState(false);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data: r, error } = await supabase.rpc("carteira_2026_1_indicadores");
      if (!ativo) return;
      if (error) setErro(error.message);
      else setD(r?.vazio ? null : r);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  async function recalcular() {
    setRecalculando(true);
    setErro("");
    const { error } = await supabase.rpc("carteira_2026_1_recalcular");
    if (error) { setErro(error.message); setRecalculando(false); return; }
    const { data: r, error: e2 } = await supabase.rpc("carteira_2026_1_indicadores");
    if (e2) setErro(e2.message); else setD(r?.vazio ? null : r);
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

  const safra = ano + "/" + sem;
  const tipo = safra === "2026/1" ? "Carteira consolidada"
             : safra === "2026/2" ? "Semestre vigente" : "Cobertura histórica";
  const base = Number(d?.base?.valor || 0);
  const pct = (v) => (base > 0 ? (Number(v || 0) / base) * 100 : 0);
  const fmtPct = (v, casas = 2) =>
    pct(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas }) + "%";
  const efetividade = Number(d?.faixas?.efetividade || 0);
  const naoEfetivado = Number(d?.faixas?.inadimplencia || 0) + Number(d?.faixas?.em_validacao || 0);

  const seletor = (opcoes, valor, aoTrocar) => (
    <div style={S.grupo}>
      {opcoes.map(([k, r]) => (
        <button key={k} onClick={() => aoTrocar(k)} style={{ ...S.opcao, ...(valor === k ? S.opcaoAtiva : null) }}>
          {r}
        </button>
      ))}
    </div>
  );

  return (
    <div style={S.pagina}>
      <h1 style={S.h1}>Efetividade da Cobrança</h1>

      <div style={S.navegacao}>
        <div style={S.navBloco}>
          <span style={S.navRotulo}>Ano</span>
          {seletor([["2024", "2024"], ["2025", "2025"], ["2026", "2026"]], ano, setAno)}
        </div>
        <div style={S.navBloco}>
          <span style={S.navRotulo}>Semestre</span>
          {seletor([["1", "1º semestre"], ["2", "2º semestre"]], sem, setSem)}
        </div>
        <span style={S.selo}>{safra} · {tipo}</span>
        {safra === "2026/1" ? (
          <button onClick={recalcular} disabled={recalculando} style={{ ...S.botaoDiscreto, marginLeft: "auto" }}>
            {recalculando ? "Atualizando…" : "Atualizar"}
          </button>
        ) : null}
      </div>

      {erro ? <p style={S.erro}>{erro}</p> : null}

      {ano !== "2026" ? (
        <CoberturaHistorica safra={safra} />
      ) : sem === "2" ? (
        <Negociacoes20262 />
      ) : !d ? (
        <div style={{ marginTop: 28 }}>
          <p style={S.discreto}>Ainda não há fotografia gerada.</p>
          <button onClick={recalcular} disabled={recalculando} style={S.botaoDiscreto}>
            {recalculando ? "Calculando…" : "Gerar agora"}
          </button>
        </div>
      ) : (
        <>
          {/* TRÊS NÚMEROS */}
          <div style={S.heroLinha}>
            <div style={S.hero}>
              <span style={S.heroRotulo}>Efetividade</span>
              <strong style={{ ...S.heroValor, color: "#2563eb" }}>{fmtPct(efetividade)}</strong>
              <span style={S.heroApoio}>{moeda(efetividade)}</span>
            </div>
            <div style={S.hero}>
              <span style={S.heroRotulo}>Recuperação financeira</span>
              <strong style={{ ...S.heroValor, color: "#1f7a3d" }}>{moedaCurta(d.recuperacao?.total)}</strong>
              <span style={S.heroApoio}>{fmtPct(d.recuperacao?.total)} da carteira · dinheiro recebido</span>
            </div>
            <div style={S.hero}>
              <span style={S.heroRotulo}>Saldo ainda não efetivado</span>
              <strong style={{ ...S.heroValor, color: "#b4232a" }}>{fmtPct(naoEfetivado)}</strong>
              <span style={S.heroApoio}>{moeda(naoEfetivado)}</span>
            </div>
          </div>

          {/* COMPOSIÇÃO DA CARTEIRA */}
          <section style={S.cartao}>
            <div style={S.cartaoTopo}>
              <h2 style={S.h2}>Composição da carteira {safra}</h2>
              <span style={S.discreto}>{moeda(base)} · {num(d.base?.titulos)} títulos · {num(d.base?.cpfs)} CPFs</span>
            </div>

            <div style={S.barra}>
              {FAIXAS.map((f) => (
                <div key={f.chave} title={f.rotulo + ": " + fmtPct(d.faixas?.[f.chave])}
                     style={{ width: pct(d.faixas?.[f.chave]) + "%", background: f.cor }} />
              ))}
            </div>

            <div style={S.blocos}>
              {FAIXAS.map((f) => (
                <button key={f.chave} onClick={() => abrirDetalhe(f.drill, null)} style={S.bloco} title={f.def}>
                  <span style={S.blocoTopo}>
                    <span style={{ ...S.ponto, background: f.cor }} />
                    {f.rotulo}
                  </span>
                  <strong style={{ ...S.blocoPct, color: f.cor }}>{fmtPct(d.faixas?.[f.chave])}</strong>
                  <span style={S.blocoValor}>{moeda(d.faixas?.[f.chave])}</span>
                  <span style={S.verTitulos}>Ver títulos →</span>
                </button>
              ))}
            </div>
          </section>

          {/* RECUPERAÇÃO FINANCEIRA */}
          <section style={S.cartao}>
            <h2 style={S.h2}>Recuperação financeira</h2>
            <strong style={{ fontSize: 28, letterSpacing: "-0.5px", color: "#1f7a3d" }}>
              {moeda(d.recuperacao?.total)}
            </strong>
            <div style={{ marginTop: 12, display: "grid", gap: 6, maxWidth: 470 }}>
              <div style={S.linhaSimples}>
                <span>Parcelas e baixas conciliadas</span>
                <strong>{moeda(d.recuperacao?.parcelas_e_baixas)}</strong>
              </div>
              <div style={S.linhaSimples}>
                <span>Pagamentos conciliados fora do CRM</span>
                <strong>{moeda(d.recuperacao?.caixa_acordo_fora_do_crm)}</strong>
              </div>
            </div>
            <p style={{ ...S.discreto, marginTop: 12 }}>Já incluído dentro da efetividade. Não somar novamente.</p>
          </section>

          {/* COMO ESTÁ COMPOSTA A EFETIVIDADE */}
          <section style={S.cartao}>
            <h2 style={S.h2}>Como está composta a efetividade</h2>
            <div style={{ marginTop: 6 }}>
              {(d.composicao || []).map((c) => {
                const share = efetividade > 0 ? (Number(c.valor) / efetividade) * 100 : 0;
                const cor = COR_SUB[c.sub_faixa] || "#2563eb";
                return (
                  <button key={c.sub_faixa} onClick={() => abrirDetalhe("EFETIVIDADE", c.sub_faixa)} style={S.linhaComposicao}>
                    <div style={S.linhaComposicaoTopo}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>
                        <span style={{ ...S.ponto, background: cor, marginRight: 8 }} />
                        {ROTULO_SUB[c.sub_faixa] || c.sub_faixa}
                      </span>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
                        <strong style={{ fontSize: 15 }}>{moeda(c.valor)}</strong>
                        <span style={{ fontSize: 14, fontWeight: 700, color: cor, minWidth: 52, textAlign: "right" }}>
                          {share.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                        </span>
                      </span>
                    </div>
                    <div style={S.trilho}>
                      <div style={{ height: "100%", width: share + "%", background: cor, borderRadius: 999 }} />
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* DRILL-DOWN */}
          {aberta ? (
            <section style={S.cartao}>
              <div style={S.cartaoTopo}>
                <h2 style={S.h2}>
                  {aberta.sub || aberta.faixa.replace(/_/g, " ").toLowerCase()}
                  {detalhe ? " · " + num(detalhe.total_titulos) + " títulos · " + moeda(detalhe.total_valor) : ""}
                </h2>
                <button onClick={() => { setAberta(null); setDetalhe(null); }} style={S.botaoDiscreto}>fechar</button>
              </div>
              {carregandoDetalhe ? (
                <p style={S.discreto}>Carregando…</p>
              ) : (
                <div style={{ overflowX: "auto", marginTop: 10 }}>
                  <table style={S.tabela}>
                    <thead>
                      <tr style={{ color: "var(--rv-texto-fraco)", textAlign: "left" }}>
                        <th style={S.th}>Aluno</th><th style={S.th}>CPF</th><th style={S.th}>Título</th>
                        <th style={S.th}>Vencimento</th><th style={S.th}>Situação</th>
                        <th style={{ ...S.th, textAlign: "right" }}>Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detalhe?.linhas || []).map((l, i) => (
                        <tr key={l.documento + "-" + i} style={{ borderTop: "1px solid var(--rv-borda-suave)" }}>
                          <td style={S.td}>{l.aluno}</td>
                          <td style={{ ...S.td, whiteSpace: "nowrap" }}>{l.cpf}</td>
                          <td style={S.td}>{l.documento}</td>
                          <td style={{ ...S.td, whiteSpace: "nowrap" }}>{data(l.vencimento)}</td>
                          <td style={S.td}>
                            {l.sub_faixa}
                            <span style={{ color: "var(--rv-texto-fraco)" }}> · {l.estado_prime}</span>
                          </td>
                          <td style={{ ...S.td, textAlign: "right", fontWeight: 600 }}>{moeda(l.valor_na_faixa)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {detalhe && detalhe.total_titulos > (detalhe.linhas || []).length ? (
                    <p style={S.discreto}>
                      Mostrando os {num((detalhe.linhas || []).length)} maiores de {num(detalhe.total_titulos)}.
                    </p>
                  ) : null}
                </div>
              )}
            </section>
          ) : null}

          {/* METODOLOGIA — todo o texto mora aqui */}
          <div style={{ marginTop: 18 }}>
            <button onClick={() => setMetodologia((v) => !v)} style={S.linkMetodologia}>
              {metodologia ? "▾" : "▸"} Ver metodologia
            </button>
            <span style={{ ...S.discreto, marginLeft: 12 }}>
              Carteira congelada em {data(d.base?.congelada_em)} · fotografia de {data(d.gerado_em)}
            </span>
            {metodologia ? (
              <div style={{ ...S.cartao, marginTop: 10, gap: 10 }}>
                <p style={S.texto}>
                  <strong>Efetividade comprovada.</strong> Considera somente valores da carteira 2026/1 com evidência
                  rastreável de pagamento ou negociação. A efetividade de um título nunca passa do valor original —
                  juros, multa e honorários não aumentam a carteira recuperada. Um título negociado e depois pago não
                  soma duas vezes: o valor apenas muda de linha.
                </p>
                <p style={S.texto}>
                  <strong>Em validação.</strong> Casos com indício de conversão, mas sem evidência suficiente para
                  classificação definitiva. Aparecem separados e não aumentam a efetividade.
                </p>
                <p style={S.texto}>
                  <strong>Precedência das fontes.</strong> A situação atual é do Prime — série e semestre do título,
                  título aberto ou liquidado, portador, matrícula e situação acadêmica. O estado do CRM não sobrepõe
                  informação disponível no Prime. O histórico de conversão (acordos, parcelas, pagamentos recebidos e
                  eventos de cobrança) vem do CRM e das importações operacionais, porque a API do Prime não entrega
                  esses dados. Quando o Prime não tem linha para o título, ninguém confirma que ele segue aberto: o
                  valor fica em validação, nunca em inadimplência confirmada.
                </p>
                <p style={S.texto}>
                  <strong>Situação atual não decide histórico.</strong> Está medido que um título negociado pode voltar
                  a aparecer aberto no Prime quando o acordo quebra — em 28,7% dos casos. Por isso “aberto hoje” nunca
                  é lido como “nunca foi negociado”.
                </p>
                <p style={S.texto}>
                  <strong>Histórico.</strong> O histórico estruturado de pagamentos disponível no CRM inicia em julho
                  de 2026. Vínculos anteriores ou não preservados integralmente podem permanecer em validação até sua
                  reconstrução.
                </p>
                <p style={S.texto}>
                  <strong>Base congelada.</strong> {num(d.base?.titulos)} títulos e {num(d.base?.cpfs)} CPFs,
                  {" "}{moeda(base)}, com entradas de {data(d.base?.entrada_de)} a {data(d.base?.entrada_ate)}.
                  Semestre pela série do Prime; {num(d.base?.por_vencimento_sem_serie)} títulos entraram pelo
                  vencimento por não terem série, e ficam identificados no detalhe. As quatro faixas somam exatamente
                  a carteira base.
                </p>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

const S = {
  pagina: { padding: "28px 24px 56px", color: "var(--rv-tinta)", maxWidth: 1120, margin: "0 auto" },
  h1: { margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em", fontFamily: "'Sora', Inter, sans-serif" },
  h2: { margin: 0, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)" },

  navegacao: { display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", marginTop: 18 },
  navBloco: { display: "flex", alignItems: "center", gap: 8 },
  navRotulo: { fontSize: 11, color: "var(--rv-texto-fraco)", fontWeight: 700, textTransform: "uppercase",
               letterSpacing: "0.06em" },
  grupo: { display: "inline-flex", background: "var(--rv-fundo-suave)", borderRadius: 10, padding: 3, gap: 3 },
  opcao: { background: "none", border: "none", cursor: "pointer", padding: "7px 18px", borderRadius: 8,
           fontSize: 14, fontWeight: 500, color: "var(--rv-texto-suave)", fontFamily: "inherit" },
  opcaoAtiva: { background: "var(--rv-superficie)", color: "var(--rv-tinta)", fontWeight: 700,
                boxShadow: "0 1px 3px rgba(15,23,42,0.10)" },
  selo: { fontSize: 12.5, color: "var(--rv-texto-suave)" },

  heroLinha: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 18, marginTop: 30 },
  hero: { display: "flex", flexDirection: "column", gap: 6 },
  heroRotulo: { fontSize: 12.5, fontWeight: 600, color: "var(--rv-texto-suave)" },
  heroValor: { fontSize: 38, fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.03em",
               fontFamily: "'Sora', Inter, sans-serif" },
  heroApoio: { fontSize: 13, color: "var(--rv-texto-suave)" },

  cartao: { background: "var(--rv-superficie)", borderRadius: 16, padding: "20px 22px", marginTop: 22,
            boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 4px 16px rgba(15,23,42,0.05)",
            display: "flex", flexDirection: "column", gap: 6 },
  cartaoTopo: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },

  barra: { display: "flex", height: 16, borderRadius: 999, overflow: "hidden", marginTop: 16 },
  blocos: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))", gap: 16, marginTop: 18 },
  bloco: { background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer",
           display: "flex", flexDirection: "column", gap: 3, color: "var(--rv-tinta)", fontFamily: "inherit" },
  blocoTopo: { fontSize: 12.5, color: "var(--rv-texto-suave)", fontWeight: 600 },
  ponto: { display: "inline-block", width: 9, height: 9, borderRadius: 3, marginRight: 7 },
  blocoPct: { fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", fontFamily: "'Sora', Inter, sans-serif" },
  blocoValor: { fontSize: 13, color: "var(--rv-texto-suave)" },
  verTitulos: { fontSize: 11.5, color: "var(--rv-azul-texto)", fontWeight: 600, marginTop: 2 },

  linhaSimples: { display: "flex", justifyContent: "space-between", gap: 16, fontSize: 13.5,
                  color: "var(--rv-texto-suave)" },
  linhaComposicao: { display: "block", width: "100%", background: "none", border: "none", cursor: "pointer",
                     padding: "10px 0", color: "var(--rv-tinta)", fontFamily: "inherit", textAlign: "left" },
  linhaComposicaoTopo: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 },
  trilho: { background: "var(--rv-fundo-suave)", borderRadius: 999, height: 6, overflow: "hidden", marginTop: 8 },

  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: { padding: "6px 8px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" },
  td: { padding: "8px", verticalAlign: "top" },

  botaoDiscreto: { background: "none", border: "1px solid var(--rv-borda-suave)", color: "var(--rv-texto-suave)",
                   borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
                   fontFamily: "inherit" },
  linkMetodologia: { background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                     color: "var(--rv-azul-texto)", fontSize: 13, fontWeight: 600 },
  texto: { margin: 0, fontSize: 13, color: "var(--rv-texto-suave)", lineHeight: 1.6 },
  discreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)" },
  erro: { color: "#b4232a", fontSize: 13, marginTop: 14 },
};
