import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import Aluno from "./Aluno";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";
import {
  GRUPOS, STATUS_CASO, dataBr, moeda, pendenciaImpeditiva, rotuloDivergencia, rotuloPendencia, rotuloTermo,
} from "../utils/juridico";

// JURÍDICO -- seleção, conferência, aprovação e encaminhamento de alunos para
// análise de ajuizamento. Exclusivo da gestão: a porta de verdade é
// `usuario_e_gestao()` dentro de cada RPC `juridico_*`; a rota só evita mostrar
// uma tela que o banco vai negar.
//
// A tela não calcula nada: elegibilidade, soma sem duplicar mensalidade de
// acordo, pendência documental e bloqueio de cobrança são decididos no banco.
const ABAS = [
  { chave: "SELECAO", rotulo: "Seleção" },
  { chave: "EM_ANALISE", rotulo: "Em análise" },
  { chave: "APROVADO", rotulo: "Aprovados" },
  { chave: "ENVIADO_FINANCEIRO", rotulo: "Enviados ao financeiro" },
  { chave: "CONFIRMADO_JURIDICO", rotulo: "Encaminhados ao jurídico" },
];

const ORIGENS_DOC = [
  { chave: "CRM", rotulo: "Termo do CRM, conferido" },
  { chave: "DRIVE", rotulo: "Drive / repositório" },
  { chave: "PRESENCIAL_DIGITALIZADO", rotulo: "Assinado presencialmente e digitalizado" },
  { chave: "OUTRO", rotulo: "Outro" },
];

const E = {
  indicadores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, margin: "16px 0" },
  indicador: { ...A.card, padding: "14px 16px" },
  indRotulo: { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)" },
  indValor: { fontSize: 24, fontWeight: 800, color: "var(--rv-tinta)", marginTop: 4 },
  form: { ...A.card, padding: 16, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 },
  campo: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 700, color: "var(--rv-texto-fraco)" },
  detalhe: { background: "var(--rv-fundo-suave)", padding: "12px 16px", fontSize: 12.5 },
  aviso: { ...A.muted, fontSize: 12.5, margin: "0 0 12px" },
};

export default function Juridico() {
  const [aba, setAba] = useState("SELECAO");
  const [painel, setPainel] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [fichaId, setFichaId] = useState(null);
  const [aberto, setAberto] = useState(null);
  const [dialogo, setDialogo] = useState(null);
  const [marcados, setMarcados] = useState([]);
  // seleção
  const [qtd, setQtd] = useState(40);
  const [ano, setAno] = useState("");
  const [semestre, setSemestre] = useState("");
  const [grupos, setGrupos] = useState(GRUPOS.map((g) => g.chave));
  const [observacao, setObservacao] = useState("");
  const [previa, setPrevia] = useState(null);
  const emVoo = useRef(false);

  const carregar = useCallback(async () => {
    if (emVoo.current) return;
    emVoo.current = true;
    setCarregando(true);
    const { data, error } = await supabase.rpc("juridico_painel");
    emVoo.current = false;
    setCarregando(false);
    if (error) {
      setErro(error.code === "42501" ? "A aba Jurídico é restrita à gestão." : "Não foi possível carregar a aba Jurídico.");
      return;
    }
    setErro("");
    setPainel(data);
    // Registra no histórico o que mudou depois do encaminhamento. Não bloqueia a tela.
    supabase.rpc("juridico_varrer_alertas").then(({ error: e }) => {
      if (e) console.error("Alerta de encaminhamento não registrado:", e.message);
    });
  }, []);

  useEffect(() => {
    // Carga única ao abrir; o setState vem depois do await da RPC.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toda ação passa por aqui: uma por vez, mensagem do banco na tela, recarga.
  const executar = useCallback(async (rpc, args, sucesso) => {
    if (ocupado) return null;
    setOcupado(true);
    setErro("");
    setAviso("");
    const { data, error } = await supabase.rpc(rpc, args);
    setOcupado(false);
    if (error) {
      setErro(error.message || "A operação falhou.");
      return null;
    }
    if (sucesso) setAviso(typeof sucesso === "function" ? sucesso(data) : sucesso);
    await carregar();
    return data;
  }, [ocupado, carregar]);

  const filtros = useMemo(() => ({
    p_ano: ano ? Number(ano) : null,
    p_semestre: ano && semestre ? Number(semestre) : null,
    p_grupos: grupos.length === GRUPOS.length ? null : grupos,
  }), [ano, semestre, grupos]);
  const qtdValida = Number.isInteger(Number(qtd)) && Number(qtd) >= 1 && Number(qtd) <= 500;

  const verCandidatos = async () => {
    if (!qtdValida || ocupado) return;
    setOcupado(true);
    setErro("");
    const { data, error } = await supabase.rpc("juridico_candidatos", { p_limite: Number(qtd), ...filtros });
    setOcupado(false);
    if (error) { setErro(error.message); return; }
    setPrevia(data || []);
  };

  const gerarLote = async () => {
    if (!qtdValida) return;
    const r = await executar("juridico_lote_gerar",
      { p_qtd: Number(qtd), ...filtros, p_observacao: observacao || null },
      (d) => d.gerados < d.solicitados
        ? `Lote ${d.protocolo} gerado com ${d.gerados} de ${d.solicitados} solicitados: não há mais candidatos elegíveis neste critério.`
        : `Lote ${d.protocolo} gerado com ${d.gerados} aluno(s). Revise em "Em análise".`);
    if (r) { setPrevia(null); setAba("EM_ANALISE"); }
  };

  const baixarExcel = async (payload) => {
    if (!payload?.casos?.length) { setErro("Este lote não tem caso aprovado para exportar."); return; }
    const { exportarLoteJuridico } = await import("../utils/exportarJuridico");
    await exportarLoteJuridico(payload);
  };
  const enviarFinanceiro = async (lote) => {
    const d = await executar("juridico_lote_enviar_financeiro", { p_lote_id: lote.lote_id },
      (x) => `Lote ${x.protocolo}: ${x.enviados_agora} caso(s) marcados como enviados ao financeiro. Excel gerado.`);
    if (d) await baixarExcel(d);
  };
  const reexportar = async (lote) => {
    const d = await executar("juridico_lote_exportar", { p_lote_id: lote.lote_id });
    if (d) await baixarExcel(d);
  };

  const pedir = (config) => setDialogo({ valores: {}, ...config });
  const confirmarDialogo = async () => {
    const d = dialogo;
    const faltando = d.campos.find((c) => c.obrigatorio && !String(d.valores[c.chave] ?? c.inicial ?? "").trim());
    if (faltando) { setErro(`Preencha: ${faltando.rotulo}.`); return; }
    const v = Object.fromEntries(d.campos.map((c) => [c.chave, d.valores[c.chave] ?? c.inicial ?? ""]));
    setDialogo(null);
    await d.aoConfirmar(v);
  };

  const casos = useMemo(() => painel?.casos || [], [painel]);
  const daAba = casos.filter((c) => c.status === aba);
  const conta = (s) => casos.filter((c) => c.status === s).length;
  const lotesDaAba = (painel?.lotes || []).filter((l) => daAba.some((c) => c.lote_id === l.lote_id));
  const ind = painel?.indicadores || {};

  if (carregando && !painel) return <div style={A.wrap}><Carregando texto="Carregando Jurídico…" /></div>;

  const acoesAnalise = (c) => {
    const pend = c.pendencias || [];
    // conjunto e saldo vêm prontos do banco: a tela não filtra nem soma
    const idsQuebrados = c.conferencia?.quebrados?.ids || [];
    const saldoQuebrado = Number(c.conferencia?.quebrados?.saldo || 0);
    const quebradosRev = (c.conferencia?.acordos || []).filter((x) => idsQuebrados.includes(x.acordo_id));
    const termo = c.conferencia?.termo;
    const temDoc = pend.includes("TERMO_NAO_LOCALIZADO") || pend.includes("TERMO_A_VALIDAR");
    return (
      <div style={{ ...A.acoes, flexWrap: "wrap" }}>
        <button type="button" style={{ ...A.btnConf, ...(pend.length || ocupado ? A.btnBusy : {}) }}
          disabled={Boolean(pend.length) || ocupado}
          title={pend.length ? "Resolva as pendências antes de aprovar" : "Aprova e bloqueia a cobrança"}
          onClick={() => executar("juridico_caso_aprovar", { p_caso_id: c.caso_id },
            `${c.aluno}: aprovado. Cobrança bloqueada — manual, massiva e automática.`)}>
          Aprovar e bloquear cobrança
        </button>
        {pend.includes("ACORDO_QUEBRADO_SEM_REVISAO") ? (
          <button type="button" style={A.btnMini} onClick={() => pedir({
            titulo: `Acordo quebrado — ${c.aluno}`,
            texto: `Acordos quebrados: ${quebradosRev.map((x) => x.numero_acordo).join(", ")}. Saldo exigível: ${moeda(saldoQuebrado)}. Confirme a revisão financeira (títulos abrangidos e pagamentos) e informe a justificativa. Quem confirma e quando fica registrado.`,
            campos: [{ chave: "motivo", rotulo: "Justificativa da revisão", obrigatorio: true, area: true }],
            aoConfirmar: (v) => executar("juridico_caso_revisar_acordo_quebrado", { p_caso_id: c.caso_id, p_motivo: v.motivo, p_acordos: idsQuebrados, p_saldo: saldoQuebrado }, "Revisão do acordo quebrado registrada."),
          })}>Revisar acordo quebrado</button>
        ) : null}
        {["ACORDO_ATIVO_SEM_APROVACAO", "ACORDO_NOVO_APOS_GERACAO", "ACORDO_REATIVADO_APOS_GERACAO"].some((x) => pend.includes(x)) ? (
          <button type="button" style={A.btnMini} onClick={() => pedir({
            titulo: `Acordo ativo — ${c.aluno}`,
            texto: `Acordos ativos revisados agora: ${(c.conferencia?.acordos || []).map((a) => a.numero_acordo).join(", ") || "nenhum"}. Confirme que são estes e informe o motivo. Se a lista mudar, a aprovação é recusada.`,
            campos: [{ chave: "motivo", rotulo: "Motivo da aprovação", obrigatorio: true, area: true }],
            aoConfirmar: (v) => executar("juridico_caso_aprovar_acordo_ativo", { p_caso_id: c.caso_id, p_motivo: v.motivo, p_acordos: (c.conferencia?.acordos || []).map((a) => a.acordo_id) }, "Acordo ativo aprovado para este caso."),
          })}>Aprovar acordo ativo</button>
        ) : null}
        {temDoc || c.doc_manual ? (
          <button type="button" style={A.btnMini} onClick={() => pedir({
            titulo: `Vincular documento — ${c.aluno}`,
            texto: "Informe onde está o termo assinado (link do Drive, caminho do arquivo digitalizado ou o anexo do CRM que você conferiu).",
            campos: [
              { chave: "origem", rotulo: "Origem", opcoes: ORIGENS_DOC, inicial: termo?.referencia ? "CRM" : "DRIVE", obrigatorio: true },
              { chave: "nome", rotulo: "Nome do documento", inicial: termo?.nome || "" },
              { chave: "referencia", rotulo: "Link ou localização", inicial: termo?.referencia || "", obrigatorio: true },
            ],
            aoConfirmar: (v) => executar("juridico_caso_documento_vincular",
              { p_caso_id: c.caso_id, p_nome: v.nome, p_referencia: v.referencia, p_origem: v.origem }, "Documento vinculado ao caso."),
          })}>{c.doc_manual ? "Trocar documento" : "Vincular / validar documento"}</button>
        ) : null}
        {temDoc ? (
          <button type="button" style={A.btnMini} onClick={() => pedir({
            titulo: `Autorização jurídica — ${c.aluno}`,
            texto: "Use quando o jurídico autorizar o encaminhamento mesmo sem o termo. Registre quem autorizou e por quê.",
            campos: [{ chave: "motivo", rotulo: "Quem autorizou e por quê", obrigatorio: true, area: true }],
            aoConfirmar: (v) => executar("juridico_caso_autorizar_documento", { p_caso_id: c.caso_id, p_motivo: v.motivo }, "Pendência documental autorizada."),
          })}>Autorização jurídica</button>
        ) : null}
        <button type="button" style={A.btnMini} onClick={() => pedir({
          titulo: `Substituir — ${c.aluno}`,
          texto: "O caso sai do lote e entra o próximo melhor candidato do mesmo critério.",
          campos: [{ chave: "motivo", rotulo: "Motivo", obrigatorio: true }],
          aoConfirmar: (v) => executar("juridico_caso_substituir", { p_caso_id: c.caso_id, p_motivo: v.motivo },
            (d) => d.novo_caso_id ? "Candidato substituído." : "Caso removido. Não há outro candidato elegível neste critério."),
        })}>Substituir</button>
      </div>
    );
  };

  const remover = (c) => pedir({
    titulo: `Remover — ${c.aluno}`,
    texto: c.status === "APROVADO"
      ? "O caso sai do lote, o bloqueio de cobrança é levantado e o aluno volta ao status anterior."
      : "O caso sai do lote sem substituto.",
    campos: [{ chave: "motivo", rotulo: "Motivo", obrigatorio: true }],
    aoConfirmar: (v) => executar("juridico_caso_remover", { p_caso_id: c.caso_id, p_motivo: v.motivo }, "Caso removido."),
  });

  const confirmarJuridico = () => pedir({
    titulo: `Registrar encaminhamento ao jurídico — ${marcados.length} caso(s)`,
    texto: "Registra que os casos foram efetivamente entregues ao jurídico. Não indica ajuizamento.",
    campos: [
      { chave: "data", rotulo: "Data do encaminhamento", tipo: "date", inicial: new Date().toLocaleDateString("en-CA"), obrigatorio: true },
      { chave: "obs", rotulo: "Observação (para quem, como)", area: true },
    ],
    aoConfirmar: async (v) => {
      const r = await executar("juridico_casos_confirmar_juridico",
        { p_caso_ids: marcados, p_data: v.data, p_observacao: v.obs || null },
        (d) => `${d.confirmados} caso(s) registrados como encaminhados ao jurídico.`
          + ((d.recusados || []).length
            ? ` NÃO confirmados (não encaminhável; motivo registrado no histórico): ${d.recusados.map((x) => `${x.aluno}: ${(x.divergencias || []).map(rotuloDivergencia).join("; ")}`).join(" | ")}`
            : ""));
      if (r) setMarcados([]);
    },
  });

  const detalhe = (c) => {
    const cf = c.conferencia;
    if (!cf) return <div style={E.detalhe}>{c.titulos_aprovados} título(s) aprovados e bloqueados — {moeda(c.valor_aprovado)}.</div>;
    return (
      <div style={E.detalhe}>
        <strong>Mensalidades em aberto ({cf.mensalidades.length}) — {moeda(cf.total_mensalidades)}</strong>
        <div>{cf.mensalidades.map((m) => `${m.documento || "s/ doc"} · ${dataBr(m.vencimento)} · ${moeda(m.valor)}`).join("  |  ") || "nenhuma"}</div>
        {cf.incorporadas_qtd ? (
          <div style={{ marginTop: 6 }}>
            {cf.incorporadas_qtd} mensalidade(s) incorporada(s) a acordo ({moeda(cf.incorporadas_valor)}) — <strong>não somadas</strong>, para não duplicar com as parcelas.
            {cf.negociado_sem_vinculo ? ` ${cf.negociado_sem_vinculo} delas sem vínculo de acordo: conferir.` : ""}
          </div>
        ) : null}
        {cf.acordos.map((a) => (
          <div key={a.acordo_id} style={{ marginTop: 6 }}>
            <strong>Acordo {a.numero_acordo || a.numero_ulbra || ""} — {a.situacao === "QUEBRADO" ? `quebrado (${a.parcelas_vencidas} parcela(s) vencida(s))` : "ativo em dia"} — {moeda(a.saldo)}</strong>
          </div>
        ))}
        {cf.acordos_cancelados ? <div style={{ marginTop: 6 }}>{cf.acordos_cancelados} acordo(s) cancelado(s) no histórico.</div> : null}
        {cf.termo?.referencia ? <div style={{ marginTop: 6 }}>Termo no CRM: {cf.termo.nome || "arquivo"} ({cf.termo.etapa || "—"}) — {cf.termo.referencia}</div> : null}
        {c.doc_manual ? <div style={{ marginTop: 6 }}>Documento vinculado: {c.doc_manual.nome || "—"} · {c.doc_manual.referencia}</div> : null}
        {c.doc_autorizado_motivo ? <div style={{ marginTop: 6 }}>Autorização jurídica: {c.doc_autorizado_motivo}</div> : null}
        {c.acordo_ativo_motivo ? <div style={{ marginTop: 6 }}>Acordo ativo aprovado: {c.acordo_ativo_motivo}</div> : null}
      </div>
    );
  };

  const tabelaCasos = (lista) => (
    <div style={{ ...A.card, marginBottom: 16 }}>
      <table style={A.tabela}>
        <thead>
          <tr>
            {aba === "ENVIADO_FINANCEIRO" ? <th style={A.th}></th> : null}
            <th style={A.th}>Aluno</th>
            <th style={A.th}>Situação acadêmica</th>
            <th style={A.thNum}>Valor</th>
            <th style={A.th}>{aba === "EM_ANALISE" ? "Documentação e pendências" : "Andamento"}</th>
            <th style={A.th}></th>
          </tr>
        </thead>
        <tbody>
          {lista.map((c) => (
            <Fragment key={c.caso_id}>
              <tr>
                {aba === "ENVIADO_FINANCEIRO" ? (
                  <td style={A.td}>
                    <input type="checkbox" aria-label={`Selecionar ${c.aluno}`} checked={marcados.includes(c.caso_id)}
                      onChange={(e) => setMarcados((m) => e.target.checked ? [...m, c.caso_id] : m.filter((x) => x !== c.caso_id))} />
                  </td>
                ) : null}
                <td style={A.td}>
                  <strong>{c.aluno || "—"}</strong>
                  <div style={A.muted}>Matr. {c.matricula || "—"} · {c.curso || "—"}</div>
                </td>
                <td style={A.td}>{c.situacao_academica || "—"}<div style={A.muted}>dívida {c.semestre_divida || "—"}</div></td>
                <td style={A.tdNum}>{moeda(c.conferencia ? c.conferencia.total : c.valor_aprovado)}</td>
                <td style={A.td}>
                  {aba === "EM_ANALISE" ? (
                    <>
                      <div>{rotuloTermo(c.conferencia, c)}</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                        {(c.pendencias || []).map((p) => (
                          <span key={p} style={{ ...A.chip, ...(pendenciaImpeditiva(p) ? A.chipRej : A.chipPend) }}>{rotuloPendencia(p)}</span>
                        ))}
                        {!(c.pendencias || []).length ? <span style={{ ...A.chip, ...A.chipOk }}>Pronto para aprovar</span> : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <span style={{ ...A.chip, ...A.chipOk }}>Cobrança bloqueada</span>
                      {(c.divergencias || []).length ? (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                          {c.divergencias.map((d) => (
                            <span key={d} style={{ ...A.chip, ...A.chipRej }}>{rotuloDivergencia(d)}</span>
                          ))}
                        </div>
                      ) : null}
                      <div style={A.muted}>
                        {aba === "APROVADO" ? `aprovado em ${dataBr(c.aprovado_em)}` : null}
                        {aba === "ENVIADO_FINANCEIRO" ? `enviado ao financeiro em ${dataBr(c.enviado_financeiro_em)}` : null}
                        {aba === "CONFIRMADO_JURIDICO" ? `encaminhado ao jurídico em ${dataBr(c.confirmado_juridico_data)}${c.confirmado_juridico_obs ? ` — ${c.confirmado_juridico_obs}` : ""}` : null}
                      </div>
                    </>
                  )}
                </td>
                <td style={A.td}>
                  <div style={{ ...A.acoes, flexWrap: "wrap" }}>
                    <button type="button" style={A.btnFicha} onClick={() => setFichaId(c.aluno_id)}>Ficha</button>
                    <button type="button" style={A.btnMini} onClick={() => setAberto(aberto === c.caso_id ? null : c.caso_id)}>
                      {aberto === c.caso_id ? "Ocultar" : "Detalhar"}
                    </button>
                    {aba === "EM_ANALISE" || aba === "APROVADO" ? (
                      <button type="button" style={A.btnMini} onClick={() => remover(c)}>Remover</button>
                    ) : null}
                  </div>
                  {aba === "EM_ANALISE" ? <div style={{ marginTop: 8 }}>{acoesAnalise(c)}</div> : null}
                </td>
              </tr>
              {aberto === c.caso_id ? <tr><td colSpan={6} style={{ padding: 0 }}>{detalhe(c)}</td></tr> : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div style={A.wrap}>
      <div style={A.topo}>
        <div>
          <h2 style={A.titulo}>Jurídico</h2>
          <p style={A.sub}>
            Seleção, conferência e encaminhamento de alunos para análise de ajuizamento.
            Aprovar bloqueia a cobrança; nenhum título é cancelado.
          </p>
        </div>
        <button type="button" style={A.btnGhostClaro} onClick={carregar}>Atualizar</button>
      </div>

      <div style={E.indicadores}>
        {[
          ["Em análise", ind.em_analise ?? 0, moeda(ind.valor_em_analise)],
          ["Aprovados", ind.aprovados ?? 0],
          ["Enviados ao financeiro", ind.enviados_financeiro ?? 0],
          ["Encaminhados ao jurídico", ind.confirmados_juridico ?? 0],
          ["Valor com cobrança bloqueada", moeda(ind.valor_bloqueado)],
          ["Com mudança após encaminhamento", casos.filter((c) => (c.divergencias || []).length).length],
        ].map(([rotulo, valor, sub]) => (
          <div key={rotulo} style={E.indicador}>
            <div style={E.indRotulo}>{rotulo}</div>
            <div style={E.indValor}>{valor}</div>
            {sub ? <div style={A.muted}>{sub}</div> : null}
          </div>
        ))}
      </div>

      <div style={A.barra}>
        {ABAS.map((a) => (
          <button key={a.chave} type="button" style={aba === a.chave ? A.btnGhost : A.btnGhostClaro}
            onClick={() => { setAba(a.chave); setAberto(null); setMarcados([]); }}>
            {a.rotulo}{a.chave === "SELECAO" ? "" : ` (${conta(a.chave)})`}
          </button>
        ))}
      </div>

      {erro ? <div role="alert" style={A.erroBox}>{erro}</div> : null}
      {aviso ? <div role="status" style={{ ...A.card, padding: "10px 14px", marginBottom: 12 }}>{aviso}</div> : null}

      {aba === "SELECAO" ? (
        <>
          <div style={E.form}>
            <label style={E.campo}>Alunos solicitados pelo jurídico
              <input style={{ ...A.input, width: 120 }} type="number" min={1} max={500} value={qtd}
                onChange={(e) => setQtd(e.target.value)} />
            </label>
            <label style={E.campo}>Ano da dívida (prioriza formados)
              <input style={{ ...A.input, width: 110 }} type="number" min={2025} max={2100} placeholder="todos" value={ano}
                onChange={(e) => setAno(e.target.value)} />
            </label>
            <label style={E.campo}>Semestre
              <select style={A.select} value={semestre} disabled={!ano} onChange={(e) => setSemestre(e.target.value)}>
                <option value="">ano todo</option><option value="1">1º</option><option value="2">2º</option>
              </select>
            </label>
            <div style={E.campo}>Considerar
              <div style={{ display: "flex", gap: 12, fontWeight: 500, color: "var(--rv-texto-forte)" }}>
                {GRUPOS.map((g) => (
                  <label key={g.chave} style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    <input type="checkbox" checked={grupos.includes(g.chave)}
                      onChange={(e) => setGrupos((x) => e.target.checked ? [...x, g.chave] : x.filter((k) => k !== g.chave))} />
                    {g.rotulo}
                  </label>
                ))}
              </div>
            </div>
            <label style={{ ...E.campo, flex: 1, minWidth: 200 }}>Observação do lote
              <input style={A.input} value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="ex.: pedido do jurídico de 12/11" />
            </label>
            <button type="button" style={A.btnGhostClaro} disabled={!qtdValida || !grupos.length || ocupado} onClick={verCandidatos}>Ver candidatos</button>
            <button type="button" style={{ ...A.btnGhost, ...(!qtdValida || !grupos.length || ocupado ? A.btnBusy : {}) }}
              disabled={!qtdValida || !grupos.length || ocupado} onClick={gerarLote}>Gerar lista preliminar</button>
          </div>
          <p style={E.aviso}>
            Entram mensalidades vencidas de 2025/1 em diante e acordos quebrados. Ordem: formados com dívida no período
            escolhido, demais formados, trancados e evadidos — sempre do maior saldo para o menor. Ficam de fora alunos já
            em lote, fora da cobrança ou com pagamento aguardando confirmação. A base não registra a data de conclusão do
            curso: o período usa o semestre da dívida.
          </p>
          {previa ? (
            previa.length ? (
              <div style={A.card}>
                <table style={A.tabela}>
                  <thead><tr>
                    <th style={A.th}>#</th><th style={A.th}>Aluno</th><th style={A.th}>Situação acadêmica</th>
                    <th style={A.th}>Dívida</th><th style={A.thNum}>Mensalidades</th><th style={A.thNum}>Acordo quebrado</th>
                    <th style={A.thNum}>Total elegível</th><th style={A.th}></th>
                  </tr></thead>
                  <tbody>
                    {previa.map((p, i) => (
                      <tr key={p.aluno_id}>
                        <td style={A.td}>{i + 1}</td>
                        <td style={A.td}><strong>{p.nome}</strong><div style={A.muted}>Matr. {p.matricula || "—"} · {p.curso || "—"}</div></td>
                        <td style={A.td}>{p.situacao_academica}{p.tem_acordo_ativo ? <span style={{ ...A.chip, ...A.chipPend, marginLeft: 8 }}>tem acordo</span> : null}</td>
                        <td style={A.td}>{p.semestre_divida || "—"}</td>
                        <td style={A.tdNum}>{moeda(p.valor_mensalidades)}</td>
                        <td style={A.tdNum}>{moeda(p.valor_acordos)}</td>
                        <td style={A.tdNum}>{moeda(p.valor_total)}</td>
                        <td style={A.td}><button type="button" style={A.btnFicha} onClick={() => setFichaId(p.aluno_id)}>Ficha</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p style={A.muted}>Nenhum candidato elegível neste critério.</p>
          ) : null}
        </>
      ) : !daAba.length ? (
        <p style={A.muted}>Nenhum caso nesta etapa.</p>
      ) : (
        <>
          {aba === "ENVIADO_FINANCEIRO" ? (
            <div style={{ ...A.barra, marginBottom: 12 }}>
              <button type="button" style={{ ...A.btnGhost, ...(!marcados.length || ocupado ? A.btnBusy : {}) }}
                disabled={!marcados.length || ocupado} onClick={confirmarJuridico}>
                Registrar encaminhamento ao jurídico ({marcados.length})
              </button>
              <button type="button" style={A.btnGhostClaro} onClick={() => setMarcados(daAba.map((c) => c.caso_id))}>Marcar todos</button>
            </div>
          ) : null}
          {lotesDaAba.map((l) => (
            <div key={l.lote_id}>
              <div style={{ ...A.topo, margin: "14px 0 8px" }}>
                <div>
                  <strong>Lote {l.protocolo}</strong>
                  <span style={{ ...A.muted, marginLeft: 10 }}>
                    {l.qtd_solicitada} solicitado(s) · {l.casos_ativos} no lote{l.observacao ? ` · ${l.observacao}` : ""}
                  </span>
                </div>
                <div style={A.acoes}>
                  {aba === "APROVADO" ? (
                    <button type="button" style={{ ...A.btnGhost, ...(ocupado ? A.btnBusy : {}) }} disabled={ocupado} onClick={() => enviarFinanceiro(l)}>
                      Gerar Excel e registrar envio ao financeiro
                    </button>
                  ) : null}
                  {aba === "ENVIADO_FINANCEIRO" || aba === "CONFIRMADO_JURIDICO" ? (
                    <button type="button" style={A.btnGhostClaro} disabled={ocupado} onClick={() => reexportar(l)}>Baixar Excel do lote</button>
                  ) : null}
                </div>
              </div>
              {tabelaCasos(daAba.filter((c) => c.lote_id === l.lote_id))}
            </div>
          ))}
          <p style={E.aviso}>{STATUS_CASO[aba]}: encaminhamento para análise. Não indica ajuizamento efetivo.</p>
        </>
      )}

      {dialogo ? (
        <div style={A.modalOverlay} onClick={() => setDialogo(null)}>
          <div role="dialog" aria-label={dialogo.titulo} style={{ ...A.modalBox, maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <strong>{dialogo.titulo}</strong>
              <button type="button" style={A.btnGhostClaro} onClick={() => setDialogo(null)}>Cancelar</button>
            </div>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              {dialogo.texto ? <p style={{ ...A.muted, margin: 0 }}>{dialogo.texto}</p> : null}
              {dialogo.campos.map((c) => {
                const valor = dialogo.valores[c.chave] ?? c.inicial ?? "";
                const mudar = (e) => setDialogo((d) => ({ ...d, valores: { ...d.valores, [c.chave]: e.target.value } }));
                return (
                  <label key={c.chave} style={E.campo}>{c.rotulo}
                    {c.opcoes ? (
                      <select style={A.select} value={valor} onChange={mudar}>
                        {c.opcoes.map((o) => <option key={o.chave} value={o.chave}>{o.rotulo}</option>)}
                      </select>
                    ) : c.area ? (
                      <textarea style={{ ...A.input, minHeight: 70 }} value={valor} onChange={mudar} />
                    ) : (
                      <input style={A.input} type={c.tipo || "text"} value={valor} onChange={mudar} />
                    )}
                  </label>
                );
              })}
              <button type="button" style={A.btnGhost} onClick={confirmarDialogo}>Confirmar</button>
            </div>
          </div>
        </div>
      ) : null}

      {fichaId ? (
        <div style={A.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <strong>Ficha do aluno</strong>
              <button type="button" style={A.btnGhostClaro} onClick={() => setFichaId(null)}>Fechar</button>
            </div>
            <div style={{ overflow: "auto" }}><Aluno fichaEmbedId={fichaId} /></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
