// Registrar acordo à vista pago antes de ser importado
// (RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO).
//
// A tela só existe para o ponto exato em que o pagamento travou: aluno provado
// por matrícula + nome, boleto 0001 único, acordo ausente do CRM. Por isso:
//   * tudo que o pagamento já sabe vem PREENCHIDO e não se edita;
//   * a única decisão da gestão fica destacada: quais mensalidades o acordo quita;
//   * toda mudança de escolha gera uma SIMULAÇÃO nova no banco, sem gravar;
//   * "Confirmar registro" só habilita quando a simulação da escolha ATUAL foi
//     aprovada -- e o banco refaz a prévia sob cadeado antes de gravar;
//   * não existe liberação manual de trava: o que a prévia recusa (ausência não
//     explicada, diferença acima da margem segura de 1,15) fica fora deste fluxo.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import { VALIDACOES_ACORDO_AVISTA, IMPEDIMENTOS_DE_TITULO } from "../utils/conciliacaoPagamento";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function data(d) {
  if (!d) return "-";
  const [a, m, dia] = String(d).slice(0, 10).split("-");
  return `${dia}/${m}/${a}`;
}
const chaveDa = (ids) => JSON.stringify(ids ? [...ids].sort() : null);
const margemTexto = (m) => String(m ?? "").replace(".", ",");

// Simular nunca grava: p_confirmar vai sempre false por aqui.
function pedirSimulacao(pagamentoId, ids) {
  return supabase.rpc("acordo_avista_registrar", {
    p_pagamento_id: pagamentoId,
    p_titulo_ids: ids,
    p_confirmar: false,
  });
}

export default function RegistrarAcordoAvista({ item, onFechar, onRegistrado }) {
  const [previa, setPrevia] = useState(null);
  const [selecao, setSelecao] = useState(null);
  const [chaveSimulada, setChaveSimulada] = useState(null);
  // Abre simulando: a primeira simulação sai no efeito de montagem.
  const [simulando, setSimulando] = useState(true);
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState("");
  const [feito, setFeito] = useState(null);

  // A resposta da simulação é aplicada num callback, nunca no corpo do efeito.
  const aplicarSimulacao = useCallback((ids, { data: r, error }) => {
    setSimulando(false);
    if (error) {
      setErro(/gest[aã]o financeira/i.test(error.message)
        ? "Registrar acordo à vista é decisão da gestão financeira."
        : error.message);
      return;
    }
    setErro("");
    setPrevia(r);
    // A sugestão do banco vira escolha explícita: confirmar nunca usa sugestão.
    const escolhidos = ids ?? (r?.titulos?.selecionados || []).map((t) => t.id);
    if (ids === null) setSelecao(escolhidos);
    setChaveSimulada(chaveDa(escolhidos));
  }, []);

  const simular = useCallback(
    (ids) => pedirSimulacao(item.pagamento_id, ids).then((resposta) => aplicarSimulacao(ids, resposta)),
    [item.pagamento_id, aplicarSimulacao],
  );

  useEffect(() => { simular(null); }, [simular]);

  const simulacaoEmDia = chaveSimulada !== null && chaveSimulada === chaveDa(selecao);
  const podeConfirmar = Boolean(previa?.aprovado) && simulacaoEmDia && !simulando && !gravando
    && Array.isArray(selecao) && selecao.length > 0 && !feito;

  const validacao = useMemo(() => {
    const porCodigo = {};
    for (const v of previa?.validacoes || []) porCodigo[v.codigo] = v;
    return porCodigo;
  }, [previa]);
  const ausenciaNaoExplicada = validacao.AUSENCIA_EXPLICADA && !validacao.AUSENCIA_EXPLICADA.ok;
  const foraDaMargem = validacao.DIFERENCA_DENTRO_DA_MARGEM_SEGURA && !validacao.DIFERENCA_DENTRO_DA_MARGEM_SEGURA.ok;

  function alternar(id) {
    const atual = new Set(selecao || []);
    if (atual.has(id)) atual.delete(id); else atual.add(id);
    const ids = [...atual];
    setSelecao(ids);
    setSimulando(true);
    simular(ids);
  }

  async function confirmar() {
    if (!podeConfirmar) return;
    const acordo = previa.acordo_a_criar || {};
    const ok = window.confirm(
      `Registrar o acordo ULBRA ${acordo.numero_ulbra} (1 parcela de ${moeda(acordo.valor_total)}), ` +
      `quitar ${selecao.length} mensalidade(s) e baixar o pagamento de ${moeda(previa.pagamento?.valor_pago)}?\n\n` +
      `Crédito: ${previa.credito?.operador_nome || previa.credito?.operador_email}.`,
    );
    if (!ok) return;
    setGravando(true);
    setErro("");
    const { data: r, error } = await supabase.rpc("acordo_avista_registrar", {
      p_pagamento_id: item.pagamento_id,
      p_titulo_ids: selecao,
      p_confirmar: true,
    });
    setGravando(false);
    if (error) { setErro(error.message); return; }
    if (!r?.gravou) {
      setPrevia(r);
      setErro(`Recusado na confirmação, nada foi gravado: ${(r?.bloqueios || []).join(", ") || r?.motivo || "motivo desconhecido"}.`);
      return;
    }
    setFeito(r);
    if (onRegistrado) onRegistrado(r);
  }

  const p = previa?.pagamento || {};
  const al = previa?.aluno || {};
  const ac = previa?.acordo_a_criar || {};
  const pc = previa?.parcela_a_criar || {};
  const tit = previa?.titulos || {};
  const saldo = previa?.saldo || {};
  const somaEscolhida = (tit.candidatos || [])
    .filter((t) => (selecao || []).includes(t.id))
    .reduce((s, t) => s + Number(t.valor || 0), 0);

  return (
    <div style={S.modalOverlay} onClick={onFechar}>
      <div style={S.modalBox} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Registrar acordo à vista">
        <div style={S.modalTopo}>
          <span style={S.modalTitulo}>Registrar acordo à vista</span>
          <button type="button" style={{ ...S.modalFechar, marginLeft: "auto" }} onClick={onFechar}>
            Fechar ✕
          </button>
        </div>

        <div style={corpo}>
          <p style={trava}>
            <b>Aluno identificado · acordo não encontrado.</b> O pagamento entrou, a matrícula e o nome
            apontam para o mesmo aluno, e o acordo à vista deste boleto não chegou pelo relatório.
          </p>

          {erro ? <div style={S.erroBox}>{erro}</div> : null}
          {!previa && simulando ? <p style={S.muted}>Simulando…</p> : null}

          {previa ? (
            <>
              <section>
                <h3 style={secao}>O que já sabemos (vem do pagamento)</h3>
                <div style={grade}>
                  <Campo rotulo="Aluno" valor={al.nome || "—"} />
                  <Campo rotulo="CPF" valor={al.cpf_mascarado || "—"} />
                  <Campo rotulo="Matrícula (arquivo)" valor={p.matricula || "—"} />
                  <Campo rotulo="Nome no arquivo" valor={p.nome_no_arquivo || "—"} />
                  <Campo rotulo="Acordo ULBRA" valor={ac.numero_ulbra || "—"} />
                  <Campo rotulo="Boleto" valor={p.boleto || "—"} />
                  <Campo rotulo="Parcela" valor="1 de 1" />
                  <Campo rotulo="Valor pago" valor={moeda(p.valor_pago)} />
                  <Campo rotulo="Pago em" valor={data(p.data_pagamento)} />
                  <Campo rotulo="Vencimento" valor={data(p.vencimento)} />
                  <Campo rotulo="Operador (crédito)" valor={previa.credito?.operador_nome || p.operador_email || "—"} />
                </div>
              </section>

              <section style={decisao}>
                <h3 style={{ ...secao, color: "var(--rv-ambar-texto)" }}>
                  Decisão da gestão: quais mensalidades este acordo quita
                </h3>
                <p style={dica}>
                  A soma precisa ficar entre {moeda(tit.faixa_valor_pago?.soma_minima)} e{" "}
                  {moeda(tit.faixa_valor_pago?.soma_maxima)} (valor pago ÷{" "}
                  {margemTexto(tit.faixa_valor_pago?.margem_segura)} até o valor pago).
                  {tit.selecao === "SUGERIDA" ? " Veio marcada a sugestão: todas as elegíveis do aluno. Confira." : ""}
                </p>
                {(tit.candidatos || []).length === 0 ? (
                  <p style={S.muted}>Nenhuma mensalidade em aberto encontrada para este aluno.</p>
                ) : (
                  (tit.candidatos || []).map((t) => {
                    const marcado = (selecao || []).includes(t.id);
                    return (
                      <label key={t.id} style={{ ...linhaTitulo, opacity: t.impedimento && !marcado ? 0.6 : 1 }}>
                        <input
                          type="checkbox"
                          checked={marcado}
                          disabled={(Boolean(t.impedimento) && !marcado) || gravando || Boolean(feito)}
                          onChange={() => alternar(t.id)}
                        />
                        <span style={{ fontWeight: 700 }}>{t.documento || "(sem documento)"}</span>
                        <span>venc. {data(t.vencimento)}</span>
                        <span style={{ marginLeft: "auto", fontWeight: 700 }}>{moeda(t.valor)}</span>
                        {t.impedimento ? (
                          <span style={seloRuim}>{IMPEDIMENTOS_DE_TITULO[t.impedimento] || t.impedimento}</span>
                        ) : null}
                      </label>
                    );
                  })
                )}
                <p style={{ ...dica, marginTop: 8 }}>
                  Soma escolhida: <b>{moeda(somaEscolhida)}</b> · valor pago: <b>{moeda(p.valor_pago)}</b>
                </p>
                {foraDaMargem ? (
                  <p style={{ ...dica, color: "var(--rv-vermelho-texto)", fontWeight: 700, margin: 0 }}>
                    {validacao.DIFERENCA_DENTRO_DA_MARGEM_SEGURA.detalhe}. O registro normal não é permitido.
                  </p>
                ) : null}
              </section>

              {ausenciaNaoExplicada ? (
                <section style={alerta}>
                  <h3 style={{ ...secao, color: "var(--rv-vermelho-texto)" }}>Fora do fluxo normal</h3>
                  <p style={{ ...dica, margin: 0 }}>
                    {validacao.AUSENCIA_EXPLICADA.detalhe}. Este caso não pode ser registrado por esta tela.
                  </p>
                </section>
              ) : null}

              <section>
                <h3 style={secao}>Simulação {simulando ? "(atualizando…)" : ""}</h3>
                <div style={grade}>
                  <Campo rotulo="Acordo a criar" valor={`ULBRA ${ac.numero_ulbra || "?"} · 1 parcela · ${moeda(ac.valor_total)}`} />
                  <Campo rotulo="Parcela a criar" valor={`boleto ${pc.boleto || "?"} · venc. ${data(pc.vencimento)} · ${moeda(pc.valor)}`} />
                  <Campo rotulo="Mensalidades a vincular" valor={`${tit.quantidade ?? 0} · ${moeda(tit.soma)}`} />
                  <Campo rotulo="Valor pago" valor={moeda(p.valor_pago)} />
                  <Campo rotulo="Responsável do acordo" valor={ac.operador_responsavel_nome || ac.operador_responsavel_email || "—"} />
                  <Campo rotulo="Saldo do aluno" valor={`${moeda(saldo.antes)} → ${moeda(saldo.esperado_depois)}`} />
                </div>
                {(previa.efeitos || []).length > 0 ? (
                  <ul style={lista}>
                    {previa.efeitos.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                ) : null}
              </section>

              <section>
                <h3 style={secao}>Validações</h3>
                <ul style={{ ...lista, listStyle: "none", paddingLeft: 0 }}>
                  {(previa.validacoes || []).map((v) => (
                    <li key={v.codigo} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                      <span style={v.ok ? marcaOk : marcaRuim}>{v.ok ? "✓" : "✗"}</span>
                      <span>
                        <b>{VALIDACOES_ACORDO_AVISTA[v.codigo] || v.codigo}</b>
                        <span style={{ color: "var(--rv-texto-suave)" }}> — {v.detalhe}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : null}
        </div>

        <div style={rodape}>
          {feito ? (
            <span style={{ ...seloStatus, ...S.chipOk }}>
              Registrado: acordo ULBRA {feito.acordo_a_criar?.numero_ulbra} criado e pagamento baixado.
            </span>
          ) : previa ? (
            <span style={{ ...seloStatus, ...(previa.aprovado && simulacaoEmDia ? S.chipOk : S.chipRej) }}>
              {simulando
                ? "Simulando…"
                : previa.aprovado && simulacaoEmDia
                  ? "Simulação aprovada. Nada foi gravado ainda."
                  : `Simulação recusada. Não passou em: ${(previa.bloqueios || []).map((b) => VALIDACOES_ACORDO_AVISTA[b] || b).join(" · ") || "refaça a simulação"}. Nada será gravado.`}
            </span>
          ) : null}
          <button type="button" style={S.btnGhost} onClick={onFechar}>
            {feito ? "Fechar" : "Cancelar"}
          </button>
          {!feito ? (
            <button
              type="button"
              style={{ ...S.btnGhost, background: podeConfirmar ? "#15803d" : "var(--rv-borda-forte)" }}
              onClick={confirmar}
              disabled={!podeConfirmar}
            >
              {gravando ? "Gravando…" : "Confirmar registro"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Campo({ rotulo, valor }) {
  return (
    <div style={campo}>
      <span style={campoRotulo}>{rotulo}</span>
      <span style={campoValor}>{valor}</span>
    </div>
  );
}

const corpo = { padding: "14px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 };
const trava = { margin: 0, fontSize: 13.5, color: "var(--rv-roxo-texto)", background: "var(--rv-roxo-fundo)", border: "1px solid var(--rv-borda-forte)", borderRadius: 10, padding: "10px 12px" };
const secao = { margin: "0 0 8px", fontSize: 12, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--rv-texto-suave)" };
const grade = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 };
const campo = { display: "flex", flexDirection: "column", gap: 2, border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "6px 10px", background: "var(--rv-fundo-cartao)" };
const campoRotulo = { fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--rv-texto-suave)" };
const campoValor = { fontSize: 13.5, fontWeight: 700, color: "var(--rv-tinta)", overflowWrap: "anywhere" };
const decisao = { border: "2px solid var(--rv-ambar-borda)", background: "var(--rv-ambar-fundo)", borderRadius: 12, padding: "12px 14px" };
const alerta = { border: "2px solid var(--rv-vermelho-borda)", background: "var(--rv-vermelho-fundo)", borderRadius: 12, padding: "12px 14px" };
const dica = { margin: "0 0 8px", fontSize: 12.5, color: "var(--rv-texto)" };
const linhaTitulo = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13, color: "var(--rv-tinta)", background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "8px 10px", marginBottom: 6 };
const seloRuim = { fontSize: 11.5, fontWeight: 800, color: "var(--rv-vermelho-texto)", background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", borderRadius: 999, padding: "2px 10px" };
const lista = { margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5, color: "var(--rv-texto)", display: "flex", flexDirection: "column", gap: 4 };
const marcaOk = { color: "var(--rv-verde-ok-texto)", fontWeight: 900 };
const marcaRuim = { color: "var(--rv-vermelho-texto)", fontWeight: 900 };
const rodape = { display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", padding: "12px 18px", borderTop: "1px solid var(--rv-borda)" };
const seloStatus = { marginRight: "auto", fontSize: 12.5, fontWeight: 700, borderRadius: 999, padding: "5px 12px" };
