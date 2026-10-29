import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) { return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function dataBR(v) { if (!v) return "-"; const p = String(v).slice(0, 10).split("-"); return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : v; }

// Motivos que acordo_saldo_residual devolve quando o residual NAO e
// confiavel (22/09/2026) -- nunca aproxima, nunca deixa o operador decidir
// o valor na tela.
const MOTIVO_RESIDUAL_TEXTO = {
  RESIDUAL_DIVERGENCIA_ESTRUTURAL: "Saldo residual não confiável (divergência estrutural) — revisão da gestão",
  RESIDUAL_PAGAMENTO_FORA_DA_ESTRUTURA: "Saldo residual não confiável (pagamento fora da estrutura) — revisão da gestão",
  RESIDUAL_MULTIPLOS_TITULOS: "Saldo residual não confiável (várias mensalidades no acordo anterior) — revisão da gestão",
  RESIDUAL_ZERO: "Sem saldo residual: nada a renegociar",
  RESIDUAL_ACORDO_NAO_ENCONTRADO: "Acordo anterior não encontrado",
};

// `residuos`: mapa acordo_id -> retorno de acordo_saldo_residual(acordo_id),
// so preenchido para acordos CANCELADO/CANCELADA que tem mensalidade NEGOCIADA
// deste aluno (re-acordo). Pra titulo comum (acordo_id null) fica sem entrada.
function valTit(t, residuos = {}) {
  const r = t.acordo_id ? residuos[t.acordo_id] : null;
  if (r && r.confiavel) return Number(r.residual);
  return Number(t.valor_em_aberto != null ? t.valor_em_aberto : (t.saldo_corrigido != null ? t.saldo_corrigido : (t.valor_original || 0)));
}

// Elegibilidade de uma mensalidade pra entrar num acordo novo. Espelha a
// funcao de backend vincular_titulos_acordo (o backend e a fonte de verdade;
// aqui e so pra habilitar/desabilitar e explicar o motivo). Retorna null
// quando elegivel, ou o motivo do bloqueio.
function motivoInelegivel(t, residuos = {}) {
  if (t.acordo_id) {
    // RE-ACORDO (22/09/2026): mensalidade NEGOCIADA cujo acordo anterior foi
    // cancelado. So aparece aqui (nao em "Já vinculada") quando `residuos` tem
    // entrada pra esse acordo -- ou seja, quando o acordo esta CANCELADO e a
    // mensalidade e NEGOCIADA (carregar() so busca residual nesse caso).
    const r = residuos[t.acordo_id];
    if (r) return r.confiavel ? null : (MOTIVO_RESIDUAL_TEXTO[r.motivo] || r.motivo || "Saldo residual não confiável");
    return "Já vinculada a acordo ativo";
  }
  const status = String(t.status || "").toLowerCase();
  const situacao = String(t.situacao || "").toUpperCase();
  // "Quitado" e decidido por status + saldo, NAO pela etiqueta situacao='PAGO'
  // (que pode vir defasada em titulo inserido manualmente: status='em_aberto'
  // e saldo > 0, mas situacao herdada 'PAGO'). Espelha vincular_titulos_acordo.
  if (status === "vinculada") return "Já negociada / vinculada";
  if (["quitada", "quitado", "paga", "pago"].includes(status)) return "Parcela quitada";
  if (["cancelada", "cancelado"].includes(status)) return "Parcela cancelada";
  if (situacao === "DUPLICADA") return "Parcela duplicada";
  if (valTit(t, residuos) <= 0) return "Saldo zero";
  return null;
}

// Vincular mensalidades (titulos em aberto) ao acordo ativo do aluno.
// Parcela vinculada sai da carteira a cobrar (a exclusao ja acontece nos RPCs
// da carteira, que ignoram titulo com acordo_id preenchido).
export default function VincularMensalidadesAcordo({ alunoId }) {
  const [acordos, setAcordos] = useState([]);
  const [titulos, setTitulos] = useState([]);
  const [residuos, setResiduos] = useState({});
  const [acordoSel, setAcordoSel] = useState("");
  const [sel, setSel] = useState({});
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState("");
  const [bloqueadosServidor, setBloqueadosServidor] = useState([]);

  async function carregar() {
    if (!alunoId) { setCarregando(false); return; }
    setCarregando(true);
    const [{ data: acs }, { data: tits }] = await Promise.all([
      supabase.from("acordos").select("id, numero_acordo, valor_total, saldo, status, qtd_parcelas, criado_em").eq("aluno_id", alunoId).order("criado_em", { ascending: false }),
      // Carrega mensalidades nao vinculadas (pra mostrar elegiveis e inelegiveis)
      // + as ja vinculadas (pra secao de desvincular) + as NEGOCIADAS de acordo
      // ja CANCELADO (candidatas a re-acordo, 22/09/2026: nao reabrem mais
      // sozinhas pra ABERTO, precisam aparecer aqui pra virarem elegiveis).
      supabase.from("acordos_titulos").select("id, competencia, vencimento, valor_em_aberto, valor_original, saldo_corrigido, situacao, status, acordo_id").eq("aluno_id", alunoId).order("vencimento", { ascending: true }),
    ]);
    const lista = acs || [];
    setAcordos(lista);
    setTitulos(tits || []);

    // Saldo residual so faz sentido pra titulo NEGOCIADO cujo acordo_id
    // aponta pra um acordo hoje CANCELADO/CANCELADA -- essa e a populacao de
    // re-acordo. `acordo_saldo_residual` e a mesma fonte de verdade que
    // vincular_titulos_acordo usa pra aceitar ou recusar.
    const acordosPorId = Object.fromEntries(lista.map((a) => [a.id, a]));
    const idsCancelados = [...new Set(
      (tits || [])
        .filter((t) => t.acordo_id && String(t.situacao || "").toUpperCase() === "NEGOCIADO")
        .map((t) => t.acordo_id)
        .filter((id) => ["CANCELADO", "CANCELADA"].includes(String(acordosPorId[id]?.status || "").toUpperCase()))
    )];
    const entradas = await Promise.all(idsCancelados.map(async (id) => {
      const { data } = await supabase.rpc("acordo_saldo_residual", { p_acordo_id: id });
      return [id, data];
    }));
    setResiduos(Object.fromEntries(entradas));

    const ativos = lista.filter((a) => a.status === "ATIVO");
    setAcordoSel((prev) => (prev && ativos.some((a) => a.id === prev)) ? prev : (ativos[0] ? ativos[0].id : ""));
    setSel({});
    setBloqueadosServidor([]);
    setCarregando(false);
  }
  useEffect(() => { carregar(); }, [alunoId]);

  const acordosAtivos = acordos.filter((a) => a.status === "ATIVO");
  // Nao vinculados = candidatos exibidos (elegiveis marcaveis, inelegiveis
  // desabilitados) -- inclui tanto titulo sem acordo quanto titulo NEGOCIADO
  // de acordo cancelado (re-acordo, tem entrada em `residuos`).
  const naoVinculados = titulos.filter((t) => !t.acordo_id || residuos[t.acordo_id] !== undefined);
  const vinculados = titulos.filter((t) => t.acordo_id && residuos[t.acordo_id] === undefined);
  const elegiveis = useMemo(() => naoVinculados.filter((t) => !motivoInelegivel(t, residuos)), [naoVinculados, residuos]);
  const inelegiveis = useMemo(() => naoVinculados.filter((t) => motivoInelegivel(t, residuos)), [naoVinculados, residuos]);
  const idsSel = Object.keys(sel).filter((k) => sel[k]);
  const selecionados = elegiveis.filter((t) => sel[t.id]);

  const todasMarcadas = elegiveis.length > 0 && selecionados.length === elegiveis.length;

  // Resumo da selecao.
  const resumo = useMemo(() => {
    const valores = selecionados.map((t) => valTit(t, residuos));
    const vencs = selecionados.map((t) => String(t.vencimento || "").slice(0, 10)).filter(Boolean).sort();
    return {
      qtd: selecionados.length,
      valor: valores.reduce((s, v) => s + v, 0),
      maisAntiga: vencs[0] || null,
      maisRecente: vencs[vencs.length - 1] || null,
      valorBloqueado: inelegiveis.reduce((s, t) => s + valTit(t, residuos), 0),
    };
  }, [selecionados, inelegiveis, residuos]);

  function marcarTodas(e) {
    if (e.target.checked) {
      const novo = {};
      elegiveis.forEach((t) => { novo[t.id] = true; });
      setSel(novo);
    } else {
      setSel({});
    }
  }

  async function vincular() {
    if (!acordoSel) { setMsg("Selecione o acordo."); return; }
    if (idsSel.length === 0) { setMsg("Selecione ao menos uma mensalidade."); return; }
    setSalvando(true); setMsg(""); setBloqueadosServidor([]);
    // `_gestao` e a MESMA funcao com um envelope: ela abre a porta da
    // Conferencia Prime na propria transacao para que a mensalidade presa em
    // EM_CONFIRMACAO tambem possa ser vinculada -- ela nao esta vinculada a
    // acordo nenhum, entao esta disponivel -- e fecha a decisao pendente junto.
    // Toda a regra de elegibilidade continua em vincular_titulos_acordo.
    const { data, error } = await supabase.rpc("vincular_titulos_acordo_gestao", { p_titulo_ids: idsSel, p_acordo_id: acordoSel });
    setSalvando(false);
    if (error || !data || !data.ok) {
      const erro = (data && data.erro) || (error && error.message) || "";
      if (erro === "PARCELAS_INELEGIVEIS" && data && Array.isArray(data.bloqueados)) {
        // Backend recusou porque parcelas mudaram de status desde a selecao.
        setBloqueadosServidor(data.bloqueados);
        setSel((s) => { const n = { ...s }; data.bloqueados.forEach((id) => { delete n[id]; }); return n; });
        setMsg("Algumas parcelas deixaram de ser elegíveis (mudaram de status). Elas foram desmarcadas — confira e vincule as restantes.");
        carregar();
        return;
      }
      if (erro === "acordo_cancelado_operacao_nao_permitida") { setMsg("Este acordo está cancelado — não é possível vincular."); return; }
      if (erro === "acordo_quitado_operacao_nao_permitida") { setMsg("Este acordo está quitado — não é possível vincular."); return; }
      // Recusa imediata, antes de gravar: dá para afirmar que nada foi salvo.
      if (erro === "ACORDO_EM_USO") { setMsg("Este acordo está sendo vinculado neste instante. Nada foi gravado — espere alguns segundos e tente de novo."); return; }
      setMsg("Erro ao vincular: " + erro);
      return;
    }
    // Em acordo ja pago a mensalidade nasce quitada; em acordo ativo fica
    // negociada. Nos dois casos ela sai da carteira a cobrar.
    const ja = Number(data.ja_estavam || 0);
    setMsg(
      Number(data.vinculados) > 0
        ? data.vinculados +
            (data.estado_titulo === "quitada"
              ? " parcela(s) vinculada(s) e marcada(s) como quitada(s) — o acordo já foi pago."
              : " parcela(s) vinculada(s) ao acordo — saíram da carteira a cobrar.") +
            (ja > 0 ? " Outra(s) " + ja + " já estavam vinculadas." : "")
        : "Nada a fazer: " + ja + " parcela(s) já estavam vinculadas a este acordo."
    );
    carregar();
  }
  async function desvincular(id) {
    setSalvando(true); setMsg("");
    const { data, error } = await supabase.rpc("desvincular_titulos_acordo", { p_titulo_ids: [id] });
    setSalvando(false);
    if (error || !data || !data.ok) { setMsg("Erro ao desvincular."); return; }
    setMsg("Parcela desvinculada — voltou pra carteira a cobrar.");
    carregar();
  }

  if (carregando) return null;
  if (acordosAtivos.length === 0 && vinculados.length === 0) return null;

  return (
    <div style={S.card}>
      <h3 style={S.titulo}>🔗 Vincular mensalidades ao acordo</h3>
      <p style={S.sub}>Ligue as parcelas negociadas ao acordo ativo. Ao vincular, a parcela sai da carteira a cobrar (evita cobrança em dobro).</p>

      {acordosAtivos.length > 0 ? (
        <>
          <div style={S.linhaTopo}>
            <label style={S.label}>Acordo:</label>
            <select style={S.select} value={acordoSel} onChange={(e) => setAcordoSel(e.target.value)}>
              {acordosAtivos.map((a) => (
                <option key={a.id} value={a.id}>
                  Acordo #{a.numero_acordo || "-"} · {moeda(a.valor_total)} · {a.qtd_parcelas || "-"}x
                </option>
              ))}
            </select>
            <button style={{ ...S.btn, opacity: resumo.qtd && !salvando ? 1 : 0.5 }} onClick={vincular} disabled={salvando || resumo.qtd === 0}>
              {salvando ? "..." : "Vincular " + resumo.qtd + " mensalidade(s) ao acordo"}
            </button>
          </div>

          {naoVinculados.length === 0 ? (
            <p style={S.vazio}>Nenhuma mensalidade em aberto para vincular.</p>
          ) : (
            <>
              {resumo.qtd > 0 && (
                <div style={S.resumo}>
                  <div style={S.resumoLinha}>
                    <span><b>Mensalidades selecionadas:</b> {resumo.qtd} de {elegiveis.length} elegível(is)</span>
                    <span><b>Saldo selecionado:</b> {moeda(resumo.valor)}</span>
                  </div>
                  <div style={S.resumoLinha}>
                    <span><b>Mais antiga:</b> {dataBR(resumo.maisAntiga)}</span>
                    <span><b>Mais recente:</b> {dataBR(resumo.maisRecente)}</span>
                  </div>
                  {inelegiveis.length > 0 && (
                    <div style={S.resumoBloq}>Bloqueadas (não elegíveis): {inelegiveis.length} · {moeda(resumo.valorBloqueado)}</div>
                  )}
                </div>
              )}

              <table style={S.tabela}>
                <thead>
                  <tr>
                    <th style={S.th}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: elegiveis.length ? "pointer" : "default", whiteSpace: "nowrap" }}>
                        <input type="checkbox" checked={todasMarcadas} onChange={marcarTodas} disabled={elegiveis.length === 0} />
                        Todas
                      </label>
                    </th>
                    <th style={S.th}>Competência</th>
                    <th style={S.th}>Vencimento</th>
                    <th style={S.thNum}>Valor</th>
                    <th style={S.th}>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {naoVinculados.map((t) => {
                    const motivo = motivoInelegivel(t, residuos);
                    const elegivel = !motivo;
                    const bloqSrv = bloqueadosServidor.includes(t.id);
                    const reAcordo = !!t.acordo_id; // so vem aqui com acordo_id quando e re-acordo
                    return (
                      <tr key={t.id} style={elegivel ? undefined : S.linhaInelegivel}>
                        <td style={S.td}>
                          <input
                            type="checkbox"
                            checked={!!sel[t.id]}
                            disabled={!elegivel}
                            onChange={(e) => setSel((s) => ({ ...s, [t.id]: e.target.checked }))}
                          />
                        </td>
                        <td style={S.td}>{t.competencia || "-"}{reAcordo ? <span style={S.tagReAcordo}>saldo residual</span> : null}</td>
                        <td style={S.td}>{dataBR(t.vencimento)}</td>
                        <td style={S.tdNum}>{moeda(valTit(t, residuos))}</td>
                        <td style={S.td}>
                          {elegivel
                            ? (bloqSrv ? <span style={S.tagBloq}>revalidar</span> : <span style={S.tagOk}>elegível</span>)
                            : <span style={S.tagBloq}>{motivo}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </>
      ) : (
        <p style={S.vazio}>Este aluno não tem acordo ativo — não há onde vincular.</p>
      )}

      {vinculados.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={S.subTit}>Parcelas já vinculadas ({vinculados.length})</div>
          <table style={S.tabela}>
            <thead><tr><th style={S.th}>Competência</th><th style={S.th}>Vencimento</th><th style={S.thNum}>Valor</th><th style={S.th}></th></tr></thead>
            <tbody>
              {vinculados.map((t) => (
                <tr key={t.id}>
                  <td style={S.td}>{t.competencia || "-"}</td>
                  <td style={S.td}>{dataBR(t.vencimento)}</td>
                  <td style={S.tdNum}>{moeda(valTit(t, residuos))}</td>
                  <td style={S.td}><button style={S.btnLink} onClick={() => desvincular(t.id)} disabled={salvando}>desvincular</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {msg ? <p style={S.msg}>{msg}</p> : null}
    </div>
  );
}

const S = {
  card: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)", borderRadius: 14, padding: "16px 18px", margin: "16px 0" },
  titulo: { margin: "0 0 4px", fontSize: 15, fontWeight: 800, color: "var(--rv-tinta)" },
  sub: { margin: "0 0 12px", fontSize: 12.5, color: "var(--rv-texto-suave)" },
  subTit: { fontSize: 12.5, fontWeight: 700, color: "var(--rv-texto)", marginBottom: 6 },
  linhaTopo: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 },
  label: { fontSize: 13, fontWeight: 700, color: "var(--rv-texto)" },
  select: { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--rv-borda-forte)", fontSize: 13, minWidth: 240 },
  btn: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  btnLink: { background: "transparent", border: "1px solid var(--rv-vermelho-borda)", color: "var(--rv-vermelho)", borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  resumo: { background: "var(--rv-fundo-cartao)", border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "10px 12px", margin: "4px 0 12px", fontSize: 12.5, color: "var(--rv-texto-forte)" },
  resumoLinha: { display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 4 },
  resumoBloq: { marginTop: 4, fontSize: 12, color: "var(--rv-ambar-texto)", fontWeight: 700 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "6px 8px", color: "var(--rv-texto-fraco)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", borderBottom: "1px solid var(--rv-borda)" },
  thNum: { textAlign: "right", padding: "6px 8px", color: "var(--rv-texto-fraco)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", borderBottom: "1px solid var(--rv-borda)" },
  td: { padding: "7px 8px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-texto-forte)" },
  tdNum: { padding: "7px 8px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right", fontWeight: 700, color: "var(--rv-tinta)" },
  linhaInelegivel: { opacity: 0.55, background: "var(--rv-superficie)" },
  tagOk: { fontSize: 11, fontWeight: 700, color: "var(--rv-verde-ok-texto)", background: "var(--rv-verde-ok-fundo)", borderRadius: 999, padding: "2px 8px" },
  tagBloq: { fontSize: 11, fontWeight: 700, color: "var(--rv-ambar-texto)", background: "var(--rv-ambar-fundo)", borderRadius: 999, padding: "2px 8px" },
  tagReAcordo: { fontSize: 10, fontWeight: 700, color: "var(--rv-texto-fraco)", marginLeft: 6, textTransform: "uppercase" },
  vazio: { fontSize: 13, color: "var(--rv-texto-fraco)", margin: "6px 0" },
  msg: { fontSize: 13, color: "var(--rv-verde-ok-texto)", fontWeight: 600, marginTop: 10 },
};
