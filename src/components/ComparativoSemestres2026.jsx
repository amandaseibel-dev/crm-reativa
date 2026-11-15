import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { S, moeda } from "./situacoesDaSafraFormato";

// COMPARATIVO 2026/1 × 2026/2 NA MESMA TELA.
//
// Uma linha por semestre, colunas que dizem o que medem. Nenhuma coluna soma
// semestres: os CPFs se sobrepõem entre safras, então cada linha é fechada em si.
//
//   • Carteira original  — valor que entrou na carteira do semestre.
//   • Saldo em aberto    — 2026/1: saldo total da carteira (fotografia).
//                          2026/2: NÃO há saldo total confiável; mostra o saldo
//                          só dos acordos vigentes, com o nome dito.
//   • Negociado          — valor coberto por acordo. NÃO é dinheiro recebido.
//   • Caixa confirmado   — pagamento provado e baixado (fonte: efetividade_caixa_origem,
//                          lido pela RPC efetividade_caixa_resumo_semestre).
//   • % recuperado       — caixa confirmado ÷ carteira original. Só o caixa.
//
// RATEIO fica numa coluna à parte, identificada como rateio: é o status da parcela
// rateado, não dinheiro. Nunca entra no percentual.
//
// Dado indisponível aparece como "—", nunca como R$ 0,00.

const SEMESTRES = ["2026/1", "2026/2"];

const pct = (parte, todo) =>
  Number(todo) > 0
    ? ((100 * Number(parte)) / Number(todo)).toLocaleString("pt-BR",
        { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%"
    : "—";

const valorOuTraco = (v, disponivel) => (disponivel ? moeda(v) : "—");

// Monta as linhas a partir das leituras já feitas. Função pura: é o que os testes cobrem.
// Carteira e saldo de 2026/2 vêm do MESMO classificador oficial (`carteira_2026_2_classificar`),
// dentro da RPC de resumo. Assim carteira, saldo, caixa e negociado saem de um único recorte.
export function montarLinhasSemestres({ fotografia2026_1, negociacoes2026_2, caixa }) {
  const sit = fotografia2026_1?.situacoes || null;
  const c1 = caixa?.["2026/1"] || null;
  const c2 = caixa?.["2026/2"] || null;
  const s2 = c2?.saldo_2026_2 || null;
  const neg = negociacoes2026_2?.total || null;

  const linha1 = {
    chave: "2026/1",
    rotulo: "2026/1",
    nota: "carteira consolidada · fotografia",
    carteira: sit?.entrou?.valor ?? null,
    saldoAberto: sit?.em_aberto?.valor ?? null,
    negociado: sit?.negociado?.valor ?? null,
    caixa: c1 ? Number(c1.caixa_confirmado) : null,
    pagamentosCaixa: c1 ? Number(c1.pagamentos_confirmados) : null,
    pendente: c1 ? Number(c1.pendente_classificacao) : null,
    pendentes: c1 ? Number(c1.pagamentos_pendentes) : null,
    rateio: sit?.pago?.valor ?? null,
    dataReferencia: c1?.data_referencia ?? null,
    geradoEm: fotografia2026_1?.gerado_em ?? null,
    atualizacaoPendente: Boolean(fotografia2026_1?.snapshot?.atualizacao_pendente),
  };

  const linha2 = {
    chave: "2026/2",
    rotulo: "2026/2",
    nota: "semestre vigente · classificador",
    carteira: s2?.carteira_original != null ? Number(s2.carteira_original) : null,
    saldoAberto: s2?.saldo_em_aberto_total != null ? Number(s2.saldo_em_aberto_total) : null,
    saldoConferencia: s2?.saldo_em_conferencia != null ? Number(s2.saldo_em_conferencia) : null,
    saldoAcademico: s2?.saldo_academico != null ? Number(s2.saldo_academico) : null,
    saldoAcordosAtivos: s2?.saldo_acordos_ativos != null ? Number(s2.saldo_acordos_ativos) : null,
    negociado: neg?.negociado != null ? Number(neg.negociado) : null,
    caixa: c2 ? Number(c2.caixa_confirmado) : null,
    pagamentosCaixa: c2 ? Number(c2.pagamentos_confirmados) : null,
    pendente: c2 ? Number(c2.pendente_classificacao) : null,
    pendentes: c2 ? Number(c2.pagamentos_pendentes) : null,
    rateio: neg?.recebido != null ? Number(neg.recebido) : null,
    dataReferencia: c2?.data_referencia ?? null,
    geradoEm: null,
    atualizacaoPendente: false,
  };

  return [linha1, linha2];
}

// `fotografia2026_1`: a payload `seis_linhas` de 2026/1 que a página já leu quando
// o semestre selecionado é 2026/1. Passada aqui para não repetir a consulta. Sem
// ela (outro semestre selecionado), o componente lê a fotografia por conta própria.
export default function ComparativoSemestres2026({ fotografia2026_1: fotoDaPagina = null,
                                                   negociacoes2026_2 = null, recarga = 0 }) {
  const [fotografiaLida, setFotografiaLida] = useState(null);
  const [caixa, setCaixa] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);
  const fotografia2026_1 = fotoDaPagina || fotografiaLida;

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      const precisaFoto = !fotoDaPagina;
      const [foto, ...caixas] = await Promise.all([
        precisaFoto
          ? supabase.rpc("carteira_efetividade_ler", { p_bloco: "seis_linhas", p_ano: "2026", p_semestre: "1" })
          : Promise.resolve({ data: null, error: null }),
        ...SEMESTRES.map((s) => supabase.rpc("efetividade_caixa_resumo_semestre", { p_semestre: s })),
      ]);
      if (!ativo) return;
      const falhou = [foto, ...caixas].find((r) => r.error);
      if (falhou) { setErro(falhou.error.message || "falha ao consultar"); setCarregando(false); return; }
      if (precisaFoto) setFotografiaLida(foto.data || null);
      setCaixa({ "2026/1": caixas[0].data || null, "2026/2": caixas[1].data || null });
      setCarregando(false);
    })();
    return () => { ativo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recarga, Boolean(fotoDaPagina)]);

  if (carregando) return <p style={S.discreto}>Comparando 2026/1 e 2026/2…</p>;
  if (erro) {
    return (
      <p style={S.erro}>
        Não foi possível montar o comparativo 2026/1 × 2026/2: {erro}.
      </p>
    );
  }

  const linhas = montarLinhasSemestres({ fotografia2026_1, negociacoes2026_2, caixa });

  return (
    <section style={{ marginTop: 22 }}>
      <div style={S.cabecalho}>
        <h2 style={S.h2}>2026/1 e 2026/2 lado a lado</h2>
        <span style={S.apoio}>mesmo período e filtros · caixa confirmado, separado do rateio</span>
      </div>

      <div style={{ ...S.cartao, overflowX: "auto" }}>
        <table style={E.tabela}>
          <thead>
            <tr>
              <th style={{ ...E.th, textAlign: "left" }}>Semestre</th>
              <th style={E.th}>Carteira original</th>
              <th style={E.th}>Saldo em aberto</th>
              <th style={E.th}>Negociado</th>
              <th style={E.th}>Caixa confirmado</th>
              <th style={E.th}>% recuperado</th>
              <th style={E.th}>Rateio (não é caixa)</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => {
              const temCarteira = l.carteira != null;
              const temCaixa = l.caixa != null;
              return (
                <tr key={l.chave}>
                  <td style={E.tdSafra}>
                    {l.rotulo}
                    <div style={E.nota}>{l.nota}</div>
                  </td>
                  <td style={E.tdValor}>{valorOuTraco(l.carteira, temCarteira)}</td>
                  <td style={E.tdValor}>
                    {valorOuTraco(l.saldoAberto, l.saldoAberto != null)}
                    {l.saldoConferencia != null ? (
                      <div style={E.nota}>
                        inclui {moeda(l.saldoConferencia)} em conferência (sem confirmação)
                      </div>
                    ) : null}
                  </td>
                  <td style={E.tdValor}>
                    {valorOuTraco(l.negociado, l.negociado != null)}
                    <div style={E.nota}>não é recebido</div>
                  </td>
                  <td style={{ ...E.tdValor, color: "var(--rv-verde-ok)" }}>
                    {valorOuTraco(l.caixa, temCaixa)}
                    {temCaixa ? (
                      <div style={E.nota}>{l.pagamentosCaixa} pagamentos provados e baixados</div>
                    ) : null}
                  </td>
                  <td style={E.tdPct}>
                    {temCaixa && temCarteira ? pct(l.caixa, l.carteira) : "—"}
                    <div style={E.nota}>caixa ÷ carteira original</div>
                  </td>
                  <td style={{ ...E.tdValor, color: "var(--rv-texto-suave)" }}>
                    {valorOuTraco(l.rateio, l.rateio != null)}
                    <div style={E.nota}>rateio do status, não caixa</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={S.rodape}>
        <strong>Pendente de classificação, fora do caixa:</strong>{" "}
        {linhas.map((l) => `${l.rotulo} ${l.pendente != null ? moeda(l.pendente) : "—"}` +
          (l.pendentes != null ? ` (${l.pendentes} pagamentos)` : "")).join(" · ")}.
        Pagamento com chave exata ainda sem baixa, em revisão ou já pago na parcela não conta como recebido.
      </p>
      <p style={S.rodape}>
        <strong>2026/2:</strong> carteira, saldo e caixa vêm do mesmo recorte do classificador oficial
        (10.822 títulos). O saldo em aberto inclui valor em conferência e ajuste acadêmico ainda não
        confirmados. Os acordos ativos são só uma parte dele e não substituem o total.
      </p>
      {linhas.some((l) => l.atualizacaoPendente) ? (
        <p style={{ ...S.rodape, color: "var(--rv-ambar-texto)" }}>
          A fotografia de 2026/1 tem atualização pendente. Os valores de carteira, saldo e negociado de 2026/1
          podem estar defasados; o caixa confirmado é lido na hora.
        </p>
      ) : null}
    </section>
  );
}

const E = {
  tabela: { width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" },
  th: { fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)", padding: "0 10px 7px", textAlign: "right",
        borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  tdSafra: { fontSize: 13.5, fontWeight: 700, padding: "9px 10px 9px 0", color: "var(--rv-tinta)",
             borderBottom: "1px solid var(--rv-borda-suave)", verticalAlign: "top" },
  tdValor: { fontSize: 13, padding: "9px 10px", textAlign: "right", whiteSpace: "nowrap",
             fontWeight: 600, borderBottom: "1px solid var(--rv-borda-suave)", verticalAlign: "top" },
  tdPct: { fontSize: 13, fontWeight: 800, padding: "9px 10px", textAlign: "right",
           whiteSpace: "nowrap", color: "var(--rv-azul-texto)",
           borderBottom: "1px solid var(--rv-borda-suave)", verticalAlign: "top" },
  nota: { fontSize: 10.5, fontWeight: 400, color: "var(--rv-texto-fraco)", marginTop: 2 },
};
