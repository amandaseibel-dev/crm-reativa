import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";

// EFETIVIDADE DA COBRANÇA — visão executiva, um layout só para toda safra.
//
// O que muda entre 2024, 2025, 2026/1 e 2026/2 é o DADO e o CONCEITO do
// período, nunca o desenho da página. Em qualquer safra a Diretoria encontra,
// sempre no mesmo lugar: quanto há em carteira, quantos alunos são, quanto foi
// convertido, quanto entrou em dinheiro, a situação atual e o perfil dos alunos.
//
// Três naturezas de período, cada uma com a régua que os dados permitem:
//   CARTEIRA CONSOLIDADA (2026/1) — safra fechada; as quatro faixas somam 100%.
//   SEMESTRE VIGENTE (2026/2)     — em curso; só o que já foi negociado. Sem
//                                   inadimplência: há título a vencer.
//   COBERTURA HISTÓRICA (2024/25) — o CRM não guarda nada anterior a julho/2026,
//                                   então não há percentual de efetividade: o
//                                   que existe é o saldo residual e o que foi
//                                   convertido desde a entrada em cobrança.
//
// Nenhuma conta acontece aqui. Os valores vêm prontos das RPCs; o front só
// desenha. Detalhe por CPF/título existe no banco, mas fora da visão executiva.

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const moedaCurta = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1e6) return "R$ " + (n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " mi";
  if (Math.abs(n) >= 1e3) return "R$ " + (n / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
  return moeda(n);
};
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const data = (v) => (v ? new Date(v.length === 10 ? v + "T12:00:00" : v).toLocaleDateString("pt-BR") : "—");
const pctTexto = (parte, todo, casas = 2) =>
  Number(todo) > 0
    ? (Number(parte) / Number(todo) * 100).toLocaleString("pt-BR",
        { minimumFractionDigits: casas, maximumFractionDigits: casas }) + "%"
    : "—";

const AZUL = "#2563eb", VERDE = "#1f7a3d", VERMELHO = "#b4232a", AMBAR = "#c08a1e", CINZA = "#94a3b8";

export default function CarteiraEfetividade() {
  const [ano, setAno] = useState("2026");
  const [sem, setSem] = useState("1");
  const [consolidada, setConsolidada] = useState(null);
  const [academico, setAcademico] = useState(null);
  const [vigente, setVigente] = useState(null);
  const [contexto, setContexto] = useState(null);
  const [historico, setHistorico] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [metodologia, setMetodologia] = useState(false);
  const [obraAberta, setObraAberta] = useState(false);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const [a, b, c, e, f] = await Promise.all([
        supabase.rpc("carteira_2026_1_indicadores"),
        supabase.rpc("carteira_2026_1_academico"),
        supabase.rpc("carteira_2026_2_negociacoes"),
        supabase.rpc("carteira_2026_2_contexto"),
        supabase.rpc("carteira_cobertura_historica"),
      ]);
      if (!ativo) return;
      const primeiro = [a, b, c, e, f].find((r) => r.error);
      if (primeiro) setErro(primeiro.error.message);
      setConsolidada(a.data?.vazio ? null : a.data);
      setAcademico(b.data || null);
      setVigente(c.data || null);
      setContexto(e.data || null);
      setHistorico(f.data?.safras || null);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <Carregando />;

  const safra = ano + "/" + sem;
  const natureza = safra === "2026/1" ? "Carteira consolidada"
                 : safra === "2026/2" ? "Semestre vigente" : "Cobertura histórica";

  // ---- os quatro indicadores, a situação e o rodapé de cada natureza de período
  let indicadores = [], situacao = [], referencia = 0, rodape = null, tituloSituacao = "Situação da carteira";

  if (safra === "2026/1" && consolidada) {
    const base = Number(consolidada.base?.valor || 0);
    const f = consolidada.faixas || {};
    referencia = base;
    indicadores = [
      { rotulo: "Carteira convertida", valor: moedaCurta(f.efetividade), apoio: pctTexto(f.efetividade, base), cor: AZUL },
      { rotulo: "Valor recebido", valor: moedaCurta(consolidada.recuperacao?.total), apoio: pctTexto(consolidada.recuperacao?.total, base), cor: VERDE },
      { rotulo: "Alunos da carteira", valor: num(consolidada.base?.cpfs) + " alunos", apoio: num(consolidada.base?.titulos) + " títulos", cor: "var(--rv-tinta)" },
      { rotulo: "Em aberto sem negociação", valor: moedaCurta(f.inadimplencia), apoio: pctTexto(f.inadimplencia, base), cor: VERMELHO },
    ];
    situacao = [
      { rotulo: "Convertido", valor: f.efetividade, cor: AZUL },
      { rotulo: "Em aberto sem negociação", valor: f.inadimplencia, cor: VERMELHO },
      { rotulo: "Em conferência", valor: f.em_validacao, cor: AMBAR },
      { rotulo: "Ajuste acadêmico", valor: f.academico, cor: CINZA },
    ];
    rodape = "Carteira de " + moeda(base) + " · congelada em " + data(consolidada.base?.congelada_em)
           + " · fotografia de " + data(consolidada.gerado_em);
  }

  if (safra === "2026/2" && vigente) {
    const t = vigente.total || {};
    referencia = Number(t.negociado || 0);
    indicadores = [
      { rotulo: "Valor negociado", valor: moedaCurta(t.negociado), apoio: num(t.titulos) + " títulos negociados", cor: AZUL },
      { rotulo: "Valor recebido", valor: moedaCurta(t.recebido), apoio: pctTexto(t.recebido, t.negociado, 1) + " do negociado", cor: VERDE },
      { rotulo: "Alunos negociados", valor: num(t.cpfs) + " alunos", apoio: num(t.acordos) + " acordos", cor: "var(--rv-tinta)" },
      { rotulo: "Saldo negociado", valor: moedaCurta(t.saldo), apoio: "ainda a receber", cor: AMBAR },
    ];
    const CORES = { "Quitado": VERDE, "Regular": AZUL, "Em atraso": AMBAR, "Acordo quebrado": VERMELHO, "Acordo cancelado": CINZA };
    const NOMES = { "Acordo quebrado": "Quebrado", "Acordo cancelado": "Cancelado" };
    situacao = (vigente.estados || []).map((e) => ({
      rotulo: NOMES[e.estado] || e.estado, valor: e.negociado, cor: CORES[e.estado] || AZUL,
    }));
    rodape = "Carteira recebida: " + moedaCurta(contexto?.carteira_valor) + " · "
           + num(contexto?.carteira_titulos) + " títulos · " + num(contexto?.carteira_cpfs) + " alunos · "
           + num(contexto?.remessas) + " remessas (" + data(contexto?.primeira_remessa) + " a "
           + data(contexto?.ultima_remessa) + ")";
  }

  const hist = (historico || []).find((x) => x.safra === safra);
  if (ano !== "2026" && hist) {
    referencia = Number(hist.valor_original || 0);
    indicadores = [
      { rotulo: "Carteira residual", valor: moedaCurta(hist.valor_original), apoio: num(hist.titulos) + " títulos", cor: "var(--rv-tinta)" },
      { rotulo: "Alunos na carteira residual", valor: num(hist.cpfs) + " alunos", apoio: "entrada em jul/2026", cor: "var(--rv-tinta)" },
      { rotulo: "Negociado desde jul/2026", valor: moedaCurta(hist.negociado), apoio: "conversão comprovada", cor: AZUL },
      { rotulo: "Recebido desde jul/2026", valor: moedaCurta(hist.recebido), apoio: "dinheiro recebido", cor: VERDE },
    ];
    situacao = [
      { rotulo: "Negociado desde julho", valor: hist.negociado, cor: AZUL },
      { rotulo: "Recebido desde julho", valor: hist.recebido, cor: VERDE },
      { rotulo: "Ainda aberto no Prime", valor: hist.abertos_valor, cor: VERMELHO },
    ];
    rodape = "Ainda aberto no Prime: " + moeda(hist.abertos_valor) + " · " + num(hist.abertos_titulos) + " títulos";
  }

  // perfil dos alunos: só existe para 2026/1 (a coleta acadêmica cobre a carteira em aberto dessa safra)
  const perfil = safra === "2026/1" ? (academico?.categorias || []) : null;
  const perfilTotal = Number(academico?.total?.cpfs || 0);

  return (
    <div style={S.pagina}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h1 style={S.h1}>Efetividade da Cobrança</h1>
        {/* Selo discreto: sinaliza que a AREA ainda esta sendo finalizada -- de
            proposito nao fala de dados nem de calculo, para nao passar a
            impressao de que os numeros sao provisorios. */}
        <button onClick={() => setObraAberta((v) => !v)}
                title="Esta área ainda está em construção e pode receber ajustes de layout, nomenclatura e visualização."
                style={S.selo}>
          Em construção
        </button>
      </div>
      {obraAberta ? (
        <p style={S.seloTexto}>
          Esta área ainda está em construção e pode receber ajustes de layout, nomenclatura e visualização.
        </p>
      ) : null}

      <div style={S.navegacao}>
        <div style={S.navBloco}>
          <span style={S.navRotulo}>Ano</span>
          <div style={S.grupo}>
            {["2024", "2025", "2026"].map((a) => (
              <button key={a} onClick={() => setAno(a)} style={{ ...S.opcao, ...(ano === a ? S.opcaoAtiva : null) }}>{a}</button>
            ))}
          </div>
        </div>
        <div style={S.navBloco}>
          <span style={S.navRotulo}>Semestre</span>
          <div style={S.grupo}>
            {[["1", "1º semestre"], ["2", "2º semestre"]].map(([k, r]) => (
              <button key={k} onClick={() => setSem(k)} style={{ ...S.opcao, ...(sem === k ? S.opcaoAtiva : null) }}>{r}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={S.periodo}>
        <strong style={{ fontSize: 17, fontWeight: 700 }}>{safra}</strong>
        <span style={S.periodoNatureza}>· {natureza}</span>
      </div>

      {erro ? <p style={S.erro}>{erro}</p> : null}

      {indicadores.length === 0 ? (
        <p style={{ ...S.discreto, marginTop: 24 }}>Sem dados para {safra}.</p>
      ) : (
        <>
          {/* 1. QUATRO INDICADORES — mesmo tamanho e mesma posição em toda safra */}
          <div style={S.linhaIndicadores}>
            {indicadores.map((i) => (
              <div key={i.rotulo} style={S.indicador}>
                <span style={S.indRotulo}>{i.rotulo}</span>
                <strong style={{ ...S.indValor, color: i.cor }}>{i.valor}</strong>
                <span style={S.indApoio}>{i.apoio}</span>
              </div>
            ))}
          </div>
          {rodape ? <p style={S.rodapeDiscreto}>{rodape}</p> : null}

          {/* 2. SITUAÇÃO DA CARTEIRA — sempre barras simples, nunca tabela */}
          <section style={S.cartao}>
            <h2 style={S.h2}>{tituloSituacao}</h2>
            <div style={{ marginTop: 8 }}>
              {situacao.map((l) => {
                const share = referencia > 0 ? (Number(l.valor || 0) / referencia) * 100 : 0;
                return (
                  <div key={l.rotulo} style={S.linha}>
                    <div style={S.linhaTopo}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>
                        <span style={{ ...S.ponto, background: l.cor }} />{l.rotulo}
                      </span>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
                        <strong style={{ fontSize: 15 }}>{moeda(l.valor)}</strong>
                        <span style={{ fontSize: 14, fontWeight: 700, color: l.cor, minWidth: 56, textAlign: "right" }}>
                          {share.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                        </span>
                      </span>
                    </div>
                    <div style={S.trilho}>
                      <div style={{ height: "100%", width: Math.min(share, 100) + "%", background: l.cor, borderRadius: 999 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 3. PERFIL DOS ALUNOS — quantas pessoas em cada situação, sem nome e sem CPF */}
          <section style={S.cartao}>
            <h2 style={S.h2}>Perfil dos alunos</h2>
            {perfil && perfil.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                {perfil.map((c) => (
                  <div key={c.categoria} style={S.linha}>
                    <div style={S.linhaTopo}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{c.categoria}</span>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
                        <strong style={{ fontSize: 15 }}>{num(c.cpfs)} alunos</strong>
                        <span style={{ fontSize: 14, fontWeight: 700, color: AZUL, minWidth: 56, textAlign: "right" }}>
                          {Number(c.pct_cpfs).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                        </span>
                      </span>
                    </div>
                    <div style={S.trilho}>
                      <div style={{ height: "100%", width: Math.min(Number(c.pct_cpfs), 100) + "%", background: AZUL, borderRadius: 999 }} />
                    </div>
                  </div>
                ))}
                <p style={{ ...S.discreto, marginTop: 10 }}>
                  {num(perfilTotal)} alunos com pendência nesta carteira. Situação acadêmica do Prime.
                </p>
              </div>
            ) : (
              <p style={{ ...S.discreto, marginTop: 8 }}>Informação acadêmica não disponível para este período</p>
            )}
          </section>

          {/* 4. METODOLOGIA — tudo o que é técnico mora aqui */}
          <div style={{ marginTop: 18 }}>
            <button onClick={() => setMetodologia((v) => !v)} style={S.linkMetodologia}>
              {metodologia ? "▾" : "▸"} Ver metodologia
            </button>
            {metodologia ? (
              <div style={{ ...S.cartao, marginTop: 10, gap: 10 }}>
                <p style={S.texto}>
                  <strong>As três naturezas de período.</strong> <em>Carteira consolidada</em> (2026/1): safra fechada,
                  em que as quatro faixas somam 100% da carteira congelada. <em>Semestre vigente</em> (2026/2): o
                  semestre está em curso e há título a vencer, então não se calcula inadimplência — mostra-se só o que
                  já foi negociado e recebido. <em>Cobertura histórica</em> (2024 e 2025): o CRM não guarda nada
                  anterior a julho de 2026, então não há percentual de efetividade — o que existe é o saldo residual
                  que ainda estava aberto quando a carteira entrou em cobrança e as conversões comprovadas desde então.
                </p>
                <p style={S.texto}>
                  <strong>Como estes nomes se chamam na metodologia.</strong> Carteira convertida ={" "}
                  <em>efetividade comprovada</em>. Valor recebido = <em>recuperação financeira</em>. Em aberto sem
                  negociação = <em>inadimplência confirmada</em>. Em conferência = <em>em validação</em>. Na situação
                  do valor convertido, “negociado, hoje quebrado” e “negociado, hoje cancelado” continuam dentro do
                  convertido de propósito: a conversão é histórica — o valor foi alcançado pela cobrança, e o que mudou
                  depois foi a situação do acordo.
                </p>
                <p style={S.texto}>
                  <strong>Efetividade comprovada.</strong> Considera somente valores com evidência rastreável de
                  pagamento ou negociação. A efetividade de um título nunca passa do valor original — juros, multa e
                  honorários não aumentam a carteira recuperada. Um título negociado e depois pago não soma duas vezes:
                  o valor apenas muda de linha.
                </p>
                <p style={S.texto}>
                  <strong>Em conferência.</strong> Casos com indício de conversão, mas sem evidência suficiente para
                  classificação definitiva. Aparecem separados e não aumentam a carteira convertida.
                </p>
                <p style={S.texto}>
                  <strong>Precedência das fontes.</strong> A situação atual é do Prime — série e semestre do título,
                  título aberto ou liquidado, portador, matrícula e situação acadêmica. O estado do CRM não sobrepõe
                  informação disponível no Prime. O histórico de conversão (acordos, parcelas, pagamentos recebidos e
                  eventos de cobrança) vem do CRM e das importações operacionais, porque a API do Prime não entrega
                  esses dados. Quando o Prime não tem linha para o título, ninguém confirma que ele segue aberto: o
                  valor fica em conferência, nunca em aberto sem negociação.
                </p>
                <p style={S.texto}>
                  <strong>Situação atual não decide histórico.</strong> Está medido que um título negociado pode voltar
                  a aparecer aberto no Prime quando o acordo quebra — em 28,7% dos casos. Por isso “aberto hoje” nunca
                  é lido como “nunca foi negociado”.
                </p>
                <p style={S.texto}>
                  <strong>Histórico.</strong> O histórico estruturado de pagamentos disponível no CRM inicia em julho
                  de 2026. Vínculos anteriores ou não preservados integralmente podem permanecer em conferência até sua
                  reconstrução.
                </p>
                <p style={S.texto}>
                  <strong>Perfil dos alunos.</strong> Situação acadêmica vinda do Prime, por CPF único, para os alunos
                  que ainda têm pendência na carteira. Matrícula confirmada com dívida aberta aparece como exceção — o
                  aluno só efetiva matrícula com a ficha regularizada — e o painel não afirma a razão da exceção.
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

  periodo: { marginTop: 18, display: "flex", alignItems: "baseline", gap: 8 },
  periodoNatureza: { fontSize: 14, color: "var(--rv-texto-suave)" },

  linhaIndicadores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 18,
                      marginTop: 22 },
  indicador: { display: "flex", flexDirection: "column", gap: 5, minHeight: 96 },
  indRotulo: { fontSize: 12.5, fontWeight: 600, color: "var(--rv-texto-suave)" },
  indValor: { fontSize: 30, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em",
              fontFamily: "'Sora', Inter, sans-serif" },
  indApoio: { fontSize: 12.5, color: "var(--rv-texto-suave)" },
  rodapeDiscreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)", marginTop: 14 },

  cartao: { background: "var(--rv-superficie)", borderRadius: 16, padding: "20px 22px", marginTop: 22,
            boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 4px 16px rgba(15,23,42,0.05)",
            display: "flex", flexDirection: "column", gap: 6 },

  linha: { padding: "10px 0" },
  linhaTopo: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" },
  ponto: { display: "inline-block", width: 9, height: 9, borderRadius: 3, marginRight: 8 },
  trilho: { background: "var(--rv-fundo-suave)", borderRadius: 999, height: 6, overflow: "hidden", marginTop: 8 },

  linkMetodologia: { background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                     color: "var(--rv-azul-texto)", fontSize: 13, fontWeight: 600 },
  texto: { margin: 0, fontSize: 13, color: "var(--rv-texto-suave)", lineHeight: 1.6 },
  discreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)" },
  selo: { background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda-suave)",
          color: "var(--rv-texto-suave)", borderRadius: 999, padding: "3px 10px", fontSize: 11.5,
          fontWeight: 600, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.02em" },
  seloTexto: { margin: "8px 0 0", fontSize: 12.5, color: "var(--rv-texto-fraco)", maxWidth: 620, lineHeight: 1.5 },
  erro: { color: "#b4232a", fontSize: 13, marginTop: 14 },
};
