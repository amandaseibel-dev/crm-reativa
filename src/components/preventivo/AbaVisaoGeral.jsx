// Aba Visão geral do Preventivo — painel executivo da gestão.
//
// Três blocos, todos de LEITURA:
//   1. indicadores da última remessa de cada carteira, por período acadêmico;
//   2. mudanças de valor entre a remessa selecionada e a anterior;
//   3. histórico do aluno, por matrícula ou CPF exatos (nome nunca identifica).
//
// A PALAVRA: "pago" só existiria com baixa comprovada no Prime, e a API do
// Prime não expõe situação do título. Por isso "Pagos confirmados" vem do
// banco sempre zerado, e o que sumiu do relatório aparece como "Saiu da base —
// conferir no Prime", nunca como pagamento.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { S } from "../../ui/estilosFila";
import { moeda, dataCurta } from "../../utils/preventivoFormato";

function Cartao({ rotulo, valor, sub, destaque }) {
  return (
    <div style={{ ...S.card, padding: "14px 16px", minWidth: 170, flex: "1 1 170px",
                  borderColor: destaque ? "var(--rv-azul)" : undefined }}>
      <div style={{ ...S.muted, fontSize: 12, fontWeight: 700 }}>{rotulo}</div>
      <div style={{ fontSize: 22, fontWeight: 800, margin: "4px 0 2px" }}>{valor}</div>
      {sub ? <div style={{ ...S.muted, fontSize: 12 }}>{sub}</div> : null}
    </div>
  );
}

export default function AbaVisaoGeral({ carteira }) {
  const [periodo, setPeriodo] = useState("");
  const [geral, setGeral] = useState(null);
  const [mudancas, setMudancas] = useState(null);
  const [busca, setBusca] = useState("");
  const [historico, setHistorico] = useState(null);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let vivo = true;
    supabase.rpc("preventivo_visao_geral", { p_periodo: periodo || null }).then(({ data, error }) => {
      if (!vivo) return;
      if (error) { setErro(error.message); return; }
      setErro(""); setGeral(data);
    });
    return () => { vivo = false; };
  }, [periodo]);

  // Mudanças de valor: a remessa mais recente da carteira escolhida no topo.
  useEffect(() => {
    let vivo = true;
    (async () => {
      const r = await supabase.rpc("preventivo_remessas", { p_carteira_id: carteira.id });
      const ultima = (r.data || [])[0];
      if (!ultima) { if (vivo) setMudancas({ vazio: true }); return; }
      const m = await supabase.rpc("preventivo_remessa_mudancas", { p_lote_id: ultima.id });
      if (!vivo) return;
      if (m.error) { setErro(m.error.message); return; }
      setMudancas({ ...m.data, remessa_nome: ultima.nome });
    })();
    return () => { vivo = false; };
  }, [carteira.id]);

  const consultar = useCallback(async (e) => {
    e.preventDefault();
    if (!busca.trim()) return;
    const { data, error } = await supabase.rpc("preventivo_aluno_historico", { p_busca: busca.trim() });
    if (error) { setErro(error.message); return; }
    setErro(""); setHistorico(data);
  }, [busca]);

  if (!geral && !erro) return <p style={S.muted}>Carregando…</p>;

  return (
    <div>
      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {geral ? (
        <>
          <div style={{ ...S.barra, alignItems: "center" }}>
            <label style={{ ...S.muted, fontWeight: 700 }}>Período acadêmico</label>
            <select style={S.select} value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
              <option value="">Todos</option>
              {(geral.periodos_disponiveis || []).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <span style={S.muted}>Soma a remessa mais recente de TODAS as carteiras (não segue o período escolhido no topo); mudanças e histórico abaixo seguem a carteira do topo.</span>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <Cartao rotulo="Alunos no relatório" valor={geral.matriculados} sub="matrículas na última remessa" />
            <Cartao rotulo="Sem título vencido" valor={geral.adimplentes} sub="no relatório, não é prova de adimplência" />
            <Cartao rotulo="Inadimplentes" valor={geral.inadimplentes} sub="com título vencido" destaque />
            <Cartao rotulo="A vencer" valor={moeda(geral.a_vencer?.valor)} sub={`${geral.a_vencer?.titulos || 0} títulos`} />
            <Cartao rotulo="Vencidos" valor={moeda(geral.vencidos?.valor)} sub={`${geral.vencidos?.titulos || 0} títulos`} destaque />
            <Cartao rotulo="Pagos confirmados" valor={moeda(geral.pagos_confirmados?.valor)}
                    sub="só com baixa comprovada no Prime" />
            <Cartao rotulo="Saiu da base — conferir no Prime" valor={moeda(geral.saiu_da_base_a_conferir?.valor)}
                    sub={`${geral.saiu_da_base_a_conferir?.titulos || 0} títulos`} />
          </div>
          <p style={{ ...S.muted, fontSize: 12, marginTop: 0 }}>
            {geral.pagos_confirmados?.motivo} {geral.saiu_da_base_a_conferir?.definicao}
          </p>
        </>
      ) : null}

      <h2 style={{ ...S.cardNome, fontSize: 16, margin: "22px 0 8px" }}>
        Mudanças de valor{mudancas?.remessa_nome ? ` — ${mudancas.remessa_nome}` : ""}
      </h2>
      {mudancas?.vazio || mudancas?.primeira_remessa ? (
        <p style={S.muted}>Primeira remessa da carteira: não há anterior para comparar.</p>
      ) : mudancas?.sequencia_nao_comprovada ? (
        <p style={S.muted}>{mudancas.observacao}</p>
      ) : (mudancas?.mudaram || []).length === 0 ? (
        <p style={S.muted}>Nenhum título mudou de valor desde a remessa anterior.</p>
      ) : (
        <table style={S.tabela}>
          <thead><tr>
            <th style={S.th}>Matrícula</th><th style={S.th}>Aluno</th><th style={S.th}>Título</th>
            <th style={S.th}>Antes</th><th style={S.th}>Agora</th><th style={S.th}>Diferença</th>
          </tr></thead>
          <tbody>
            {mudancas.mudaram.map((m) => (
              <tr key={m.titulo_id}>
                <td style={S.td}>{m.matricula}</td><td style={S.td}>{m.aluno_nome}</td>
                <td style={S.td}>{m.documento || "—"}</td>
                <td style={S.td}>{moeda(m.valor_anterior)}</td><td style={S.td}>{moeda(m.valor_atual)}</td>
                <td style={S.td}>{moeda(m.delta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ ...S.cardNome, fontSize: 16, margin: "26px 0 8px" }}>Histórico do aluno</h2>
      <form onSubmit={consultar} style={{ ...S.barra }}>
        <input style={S.input} value={busca} placeholder="Matrícula ou CPF (11 dígitos)"
               onChange={(e) => setBusca(e.target.value)} />
        <button type="submit" style={S.btnGhost}>Consultar</button>
      </form>
      {historico ? (
        (historico.titulos || []).length === 0 ? (
          <p style={S.muted}>Nenhum título encontrado para essa matrícula ou CPF.</p>
        ) : (
          <table style={S.tabela}>
            <thead><tr>
              <th style={S.th}>Período</th><th style={S.th}>Vencimento</th><th style={S.th}>Título</th>
              <th style={S.th}>Valor original</th><th style={S.th}>Atraso</th>
              <th style={S.th}>Situação</th><th style={S.th}>Remessas (valor)</th>
            </tr></thead>
            <tbody>
              {historico.titulos.map((t) => (
                <tr key={t.titulo_id}>
                  <td style={S.td}>{t.periodo_academico}</td>
                  <td style={S.td}>{dataCurta(t.vencimento)}</td>
                  <td style={S.td}>{t.documento || "—"}</td>
                  <td style={S.td}>{moeda(t.valor_original)}</td>
                  <td style={S.td}>{t.dias_atraso > 0 ? `${t.dias_atraso} dias` : "—"}</td>
                  <td style={S.td}>
                    {t.na_ultima_remessa ? "Em aberto na última remessa" : "Saiu da base — conferir no Prime"}
                    {t.status === "FORA_DA_JANELA" ? " · passou de 31 dias" : ""}
                  </td>
                  <td style={S.td}>
                    {(t.remessas || []).map((r) => `${r.remessa}: ${moeda(r.saldo)}`).join(" → ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </div>
  );
}
