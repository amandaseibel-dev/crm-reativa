import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { S, moeda } from "./situacoesDaSafraFormato";

// COMPARATIVO 2026/1 × 2026/2 NA MESMA TELA.
//
// A TELA SÓ EXIBE. Carteira, saldo, caixa, percentual e contagem de títulos vêm
// prontos da RPC `efetividade_caixa_resumo_semestre`. Nenhuma métrica de negócio
// é calculada aqui.
//
//   • Carteira original  — valor que entrou na carteira do semestre (`carteira_original`).
//   • Saldo em aberto    — 2026/2: saldo total do classificador, com conferência visível.
//                          2026/1: saldo da fotografia `seis_linhas`.
//   • Negociado          — valor coberto por acordo. NÃO é dinheiro recebido.
//   • Caixa confirmado   — pagamento provado e baixado (`caixa_confirmado`).
//   • % recuperado       — `percentual_recuperado_caixa`: caixa confirmado identificado
//                          ÷ carteira original. Não é recuperação total conhecida.
//   • Rateio             — coluna à parte, identificada como não-caixa.
//
// Dado indisponível aparece como "—", nunca como R$ 0,00.

const SEMESTRES = ["2026/1", "2026/2"];

const numOuNulo = (v) => (v == null ? null : Number(v));

// Monta as linhas a partir das leituras. Função pura: é o que os testes cobrem.
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
    carteira: numOuNulo(c1?.carteira_original),
    titulos: numOuNulo(c1?.titulos_carteira),
    saldoAberto: numOuNulo(sit?.em_aberto?.valor),
    negociado: numOuNulo(sit?.negociado?.valor),
    caixa: numOuNulo(c1?.caixa_confirmado),
    pagamentosCaixa: numOuNulo(c1?.pagamentos_confirmados),
    pendente: numOuNulo(c1?.pendente_classificacao),
    pendentes: numOuNulo(c1?.pagamentos_pendentes),
    percentual: c1?.percentual_recuperado_caixa ?? null,
    rateio: numOuNulo(sit?.pago?.valor),
    atualizacaoPendente: Boolean(fotografia2026_1?.snapshot?.atualizacao_pendente),
  };

  const linha2 = {
    chave: "2026/2",
    rotulo: "2026/2",
    nota: "semestre vigente · classificador",
    carteira: numOuNulo(c2?.carteira_original),
    titulos: numOuNulo(c2?.titulos_carteira),
    saldoAberto: numOuNulo(s2?.saldo_em_aberto_total),
    saldoConferencia: numOuNulo(s2?.saldo_em_conferencia),
    negociado: numOuNulo(neg?.negociado),
    caixa: numOuNulo(c2?.caixa_confirmado),
    pagamentosCaixa: numOuNulo(c2?.pagamentos_confirmados),
    pendente: numOuNulo(c2?.pendente_classificacao),
    pendentes: numOuNulo(c2?.pagamentos_pendentes),
    percentual: c2?.percentual_recuperado_caixa ?? null,
    rateio: numOuNulo(neg?.recebido),
    atualizacaoPendente: false,
  };

  return [linha1, linha2];
}

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
  const exibe = (v) => (v == null ? "—" : moeda(v));

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
              <th style={E.th}>% recuperado por caixa</th>
              <th style={E.th}>Rateio (não é caixa)</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.chave}>
                <td style={E.tdSafra}>
                  {l.rotulo}
                  <div style={E.nota}>{l.nota}</div>
                </td>
                <td style={E.tdValor}>
                  {exibe(l.carteira)}
                  {l.titulos != null ? <div style={E.nota}>{l.titulos.toLocaleString("pt-BR")} títulos</div> : null}
                </td>
                <td style={E.tdValor}>
                  {exibe(l.saldoAberto)}
                  {l.saldoConferencia != null ? (
                    <div style={E.nota}>inclui {moeda(l.saldoConferencia)} em conferência</div>
                  ) : null}
                </td>
                <td style={E.tdValor}>
                  {exibe(l.negociado)}
                  <div style={E.nota}>não é recebido</div>
                </td>
                <td style={{ ...E.tdValor, color: "var(--rv-verde-ok)" }}>
                  {exibe(l.caixa)}
                  {l.pagamentosCaixa != null ? (
                    <div style={E.nota}>{l.pagamentosCaixa} pagamentos provados e baixados</div>
                  ) : null}
                </td>
                <td style={E.tdPct}>
                  {l.percentual != null ? `${String(l.percentual).replace(".", ",")}%` : "—"}
                  <div style={E.nota}>caixa identificado ÷ carteira</div>
                </td>
                <td style={{ ...E.tdValor, color: "var(--rv-texto-suave)" }}>
                  {exibe(l.rateio)}
                  <div style={E.nota}>rateio do status, não caixa</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={S.rodape}>
        <strong>Pendente de classificação, fora do caixa:</strong>{" "}
        {linhas.map((l) => `${l.rotulo} ${exibe(l.pendente)}` +
          (l.pendentes != null ? ` (${l.pendentes} pagamentos)` : "")).join(" · ")}.
        Pagamento com chave exata ainda sem baixa, em revisão ou já pago na parcela não conta como recebido.
      </p>
      <p style={S.rodape}>
        <strong>O percentual é recuperação por caixa confirmado identificado.</strong> Não é recuperação total
        conhecida: o valor pendente de classificação não entra nele.
      </p>
      <p style={S.rodape}>
        <strong>2026/2:</strong> carteira, saldo e caixa vêm do mesmo recorte do classificador oficial. O saldo
        em aberto inclui valor em conferência ainda não confirmado. Os acordos ativos são só uma parte dele.
      </p>
      {linhas.some((l) => l.atualizacaoPendente) ? (
        <p style={{ ...S.rodape, color: "var(--rv-ambar-texto)" }}>
          A fotografia de 2026/1 tem atualização pendente. Carteira, saldo e negociado de 2026/1 podem estar
          defasados; o caixa confirmado é lido na hora.
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
