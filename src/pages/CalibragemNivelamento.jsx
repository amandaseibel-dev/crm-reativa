import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando, Erro } from "../ui/estados";
import Dobra from "../ui/blocos";

// Calibragem — NIVELAMENTO: escolhe o ano do aluno (o ano da dívida MAIS
// RECENTE dele), vê cada operador vs o alvo (só mensalidades sem negociação),
// simula e aplica.
//
// OS PARÂMETROS SÃO DA GESTÃO. Alvo, dias sem acionamento e quem participa
// ficam na tela, não no código. O motor sempre aceitou os três em `p_criterio`;
// era o front que mandava 500 e 11 fixos.
//
// O ALVO EXIBIDO RESPEITA O TETO. `alvo_sugerido` do diagnóstico é a média crua
// (casos dos operadores + pool inteiro ÷ nº de operadores) e não conhece teto
// nenhum: em 02/09 devolvia 1.325, e a tela pintava os 8 operadores de vermelho
// dizendo que faltavam ~880 casos para cada um. O motor nivela por
// `least(alvo, média)` — a tela agora mostra a mesma conta.
//
// Backend: calibragem_diagnostico_sem_negociacao(ano)
//        + calibragem_simular_nivelamento(criterio)
//        + calibragem_aprovar_simulacao / calibragem_executar_nivelamento_lote
//        + calibragem_desfazer_nivelamento_lote (desfazer, em lotes)

const ALVO = 500;
const DIAS_MIN = 10; // piso da fidelização: o banco também recusa menos que isto
const TAM_LOTE = 150;

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const mi = (v) => (Number(v || 0) / 1e6).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " mi";
const dataHora = (v) => (v ? new Date(v).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

function corBarra(qtd, alvo) {
  const pct = (qtd / (alvo || ALVO)) * 100;
  if (pct >= 99) return "#34d399";
  if (pct >= 70) return "#fbbf24";
  return "#f87171";
}

const ROTULO_STATUS = {
  EXECUTADA: "aplicado",
  EXECUTANDO: "aplicação interrompida",
  DESFAZENDO: "desfazendo",
  REVERTIDA: "desfeito",
};

function baixarCsv(nome, linhas) {
  const escapar = (v) => {
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // Ponto e vírgula + BOM: é o que o Excel em pt-BR abre sem pedir importação.
  const texto = "﻿" + linhas.map((l) => l.map(escapar).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export default function CalibragemNivelamento() {
  const [ano, setAno] = useState(null); // null = todos
  const [anos, setAnos] = useState([]);
  const [diag, setDiag] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  // Parâmetros na mão da gestão.
  const [alvoPedido, setAlvoPedido] = useState(ALVO);
  const [dias, setDias] = useState(11);
  const [foraDoNivelamento, setForaDoNivelamento] = useState([]); // e-mails desmarcados

  const [sim, setSim] = useState(null);
  const [simulando, setSimulando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [aviso, setAviso] = useState("");
  const [busca, setBusca] = useState("");

  const [historico, setHistorico] = useState([]);
  const [desfazendoId, setDesfazendoId] = useState(null);

  const carregarHistorico = useCallback(async () => {
    const { data, error } = await supabase
      .from("calibragem_simulacoes")
      .select("id,status,criterios,resultado,criado_em,executado_em,criado_por_email,aprovado_por_email")
      .in("status", ["EXECUTADA", "EXECUTANDO", "DESFAZENDO", "REVERTIDA"])
      .order("executado_em", { ascending: false, nullsFirst: false })
      .order("criado_em", { ascending: false })
      .limit(10);
    if (!error && Array.isArray(data)) setHistorico(data);
  }, []);

  const carregarDiag = useCallback(async (anoSel) => {
    setCarregando(true);
    setErro("");
    setSim(null);
    setAviso("");
    setBusca("");
    const { data, error } = await supabase.rpc("calibragem_diagnostico_sem_negociacao", { p_ano: anoSel });
    setCarregando(false);
    if (error) { setErro("Não foi possível carregar o diagnóstico."); return; }
    setDiag(data);
    setAnos((atuais) => (atuais.length || !Array.isArray(data?.anos) ? atuais : data.anos.map((a) => a.ano)));
  }, []);

  // Carga inicial e troca de ano: as duas funções acendem o "carregando" antes
  // de ir ao banco, que é justamente o que a regra proíbe — aqui é intencional.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { carregarDiag(ano); }, [ano, carregarDiag]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { carregarHistorico(); }, [carregarHistorico]);

  const operadores = useMemo(() => diag?.operadores || [], [diag]);
  const participantes = useMemo(
    () => operadores.filter((o) => !foraDoNivelamento.includes(o.op_email)),
    [operadores, foraDoNivelamento],
  );
  const todosParticipam = foraDoNivelamento.length === 0;

  // Alvo efetivo ANTES de simular: o pedido, limitado pelo material que existe.
  // Com todos participando vale a média que o banco calculou; tirando alguém da
  // lista a conta muda, e refazemos aqui com os mesmos números do diagnóstico.
  const mediaDisponivel = useMemo(() => {
    if (!diag) return null;
    if (todosParticipam) return Number(diag.alvo_sugerido) || null;
    if (!participantes.length) return null;
    const emCarteira = participantes.reduce((s, o) => s + Number(o.qtd || 0), 0);
    return Math.floor((emCarteira + Number(diag.pool_total || 0)) / participantes.length);
  }, [diag, participantes, todosParticipam]);

  const alvoEfetivo = sim
    ? Number(sim.alvo_efetivo) || alvoPedido
    : Math.max(1, Math.min(alvoPedido, mediaDisponivel || alvoPedido));

  const foraDoAlcance = useMemo(() => {
    if (sim || !diag || !participantes.length) return null;
    return Math.max(0, Number(diag.base_total || 0) - participantes.length * alvoEfetivo);
  }, [sim, diag, participantes.length, alvoEfetivo]);

  function alternarOperador(email) {
    setForaDoNivelamento((fora) => (fora.includes(email) ? fora.filter((e) => e !== email) : [...fora, email]));
    setSim(null);
    setAviso("");
  }

  async function simular() {
    if (!participantes.length) { setAviso("⚠️ Escolha ao menos um operador para nivelar."); return; }
    setSimulando(true);
    setAviso("");
    setBusca("");
    const criterio = { alvo: alvoPedido, dias_sem_acionamento: dias };
    if (ano) criterio.ano = ano;
    if (!todosParticipam) criterio.operadores = participantes.map((o) => o.op_email);
    const { data, error } = await supabase.rpc("calibragem_simular_nivelamento", { p_criterio: criterio });
    setSimulando(false);
    if (error) { setAviso("Erro ao simular: " + (error.message || "")); return; }
    setSim(data);

    const alvoEf = Number(data?.alvo_efetivo || alvoPedido);
    const abaixo = (data?.depois || []).filter((o) => Number(o.qtd) < alvoEf);
    const trocas = (data?.movimentacoes || []).filter((m) => m.de_email && m.para_email).length;
    const partes = [];
    if (alvoEf < alvoPedido) {
      partes.push(
        `ℹ️ Não há casos "sem negociação" para ${num(alvoPedido)} por operador${ano ? " em " + ano : ""}: ` +
        `${num(data?.total_disponivel)} disponíveis (${num(data?.pool_total)} sem responsável). ` +
        `O nivelamento usa o alvo efetivo de ${num(alvoEf)} — a média por operador.` +
        (abaixo.length ? ` ${abaixo.length} operador(es) ficaram abaixo dela por falta de casos parados para soltar.` : "")
      );
    } else if (abaixo.length) {
      partes.push(`⚠️ Pool insuficiente: ${abaixo.length} operador(es) ficaram abaixo de ${num(alvoPedido)} (não há casos "sem negociação" suficientes${ano ? " para " + ano : ""}).`);
    }
    // O equilíbrio de valor só acontece na fase de trocas. Sem trocas, o índice
    // que a tela mostra é o que sobrou por acaso — e a gestão precisa saber.
    if (!trocas) {
      partes.push(
        `⚠️ Nenhuma troca de valor foi possível: todos os casos elegíveis foram usados para completar o alvo, ` +
        `ou estão dentro dos ${dias} dias de fidelização. O equilíbrio de valor (${data?.indice_depois}) é o que resultou das entradas e saídas, não de um ajuste.`
      );
    }
    setAviso(partes.join(" "));
  }

  async function emLotes(rpc, id, aoAndar) {
    let feitos = 0;
    let guarda = 0;
    for (;;) {
      const { data, error } = await supabase.rpc(rpc, { p_id: id, p_tamanho: TAM_LOTE });
      if (error) throw error;
      feitos += Number(data?.movidos_lote ?? data?.voltaram_lote ?? 0);
      aoAndar(data, feitos);
      if (data?.concluido) return feitos;
      // Sem progresso e sem "concluído" significa que o lote não tem mais o que
      // fazer — parar aqui em vez de girar 500 vezes até o guarda estourar.
      if (Number(data?.movidos_lote ?? data?.voltaram_lote ?? 0) === 0 && Number(data?.pulados_lote || 0) === 0) return feitos;
      if (++guarda > 500) throw new Error("Muitos lotes — interrompido por segurança. Rode novamente para continuar.");
    }
  }

  async function aplicar() {
    if (!sim?.simulacao_id) return;
    const ok = window.confirm(
      `APLICAR o nivelamento?\n\nIsto MOVE ${num(sim.total_movimentacoes)} casos de verdade` +
      `${ano ? " (alunos de " + ano + ")" : ""} para nivelar ${participantes.length} operador(es) em ${num(sim.alvo_efetivo || alvoPedido)}: ` +
      `retira os parados (+${dias}d) de quem está acima → pool, e completa quem está abaixo com os sem responsável ` +
      `e os casos mais recentes. Os alunos passam para a carteira do novo operador.\n\n` +
      `Ação registrada e auditada, e pode ser desfeita depois. Confirmar?`
    );
    if (!ok) return;
    setAplicando(true);
    setAviso("");
    const { error: e1 } = await supabase.rpc("calibragem_aprovar_simulacao", { p_id: sim.simulacao_id });
    if (e1) { setAplicando(false); setAviso("Erro ao aprovar: " + (e1.message || "")); return; }
    try {
      const movidos = await emLotes("calibragem_executar_nivelamento_lote", sim.simulacao_id, (d, feitos) =>
        setAviso(`Aplicando em lotes… ${num(d?.feitos || 0)}/${num(d?.total || 0)} casos (movidos: ${num(feitos)}).`));
      setAviso(`✅ Nivelamento aplicado e auditado (${num(movidos)} casos movidos). Os operadores precisam dar F5 para ver a carteira nova.`);
    } catch (err) {
      setAplicando(false);
      setAviso("Erro ao aplicar: " + (err?.message || err?.details || "erro desconhecido"));
      return;
    }
    setAplicando(false);
    setSim(null);
    carregarDiag(ano);
    carregarHistorico();
  }

  async function desfazer(item) {
    const total = Number(item?.resultado?.total_movimentacoes || 0);
    const ok = window.confirm(
      `DESFAZER este nivelamento?\n\nCada um dos ${num(total)} casos volta para o responsável que tinha antes.\n\n` +
      `Casos que já saíram das mãos de quem os recebeu, ou que entraram em negociação, acordo, link, termo ou ` +
      `confirmação de pagamento desde então, NÃO são mexidos — ficam registrados como pulados.\n\n` +
      `A reversão também é auditada. Confirmar?`
    );
    if (!ok) return;
    setDesfazendoId(item.id);
    setAviso("");
    try {
      const voltaram = await emLotes("calibragem_desfazer_nivelamento_lote", item.id, (d, feitos) =>
        setAviso(`Desfazendo em lotes… faltam ${num(d?.restantes || 0)} de ${num(d?.total || 0)} (devolvidos: ${num(feitos)}).`));
      setAviso(`✅ Nivelamento desfeito (${num(voltaram)} casos devolvidos ao responsável anterior). Os operadores precisam dar F5.`);
    } catch (err) {
      setAviso("Erro ao desfazer: " + (err?.message || err?.details || "erro desconhecido"));
    }
    setDesfazendoId(null);
    carregarDiag(ano);
    carregarHistorico();
  }

  const movimentacoes = useMemo(() => sim?.movimentacoes || [], [sim]);
  const movsFiltradas = useMemo(() => {
    const t = busca.trim().toLowerCase();
    if (!t) return movimentacoes;
    return movimentacoes.filter((m) =>
      String(m.nome || "").toLowerCase().includes(t) ||
      String(m.cpf || "").includes(t) ||
      String(m.de_nome || "").toLowerCase().includes(t) ||
      String(m.para_nome || "").toLowerCase().includes(t));
  }, [movimentacoes, busca]);

  function exportarMovimentacoes() {
    baixarCsv(
      `nivelamento_${ano || "todos-os-anos"}_${new Date().toISOString().slice(0, 10)}.csv`,
      [["CPF", "Aluno", "Valor", "Sai de", "Vai para", "Motivo"],
        ...movimentacoes.map((m) => [m.cpf, m.nome, Number(m.valor || 0).toFixed(2).replace(".", ","),
          m.de_nome || "(sem responsável)", m.para_nome || "(sem responsável)", m.motivo])],
    );
  }

  const S = estilos;
  if (carregando && !diag) return <div style={S.container}><Carregando texto="Carregando calibragem…" tema="escuro" /></div>;
  if (erro) return <div style={S.container}><Erro texto={erro} onTentar={() => carregarDiag(ano)} /></div>;

  const lista = sim?.depois || participantes;
  const antesPorEmail = {};
  (sim?.antes || participantes).forEach((o) => { antesPorEmail[o.op_email] = o; });

  return (
    <div style={S.container}>
      <div style={S.inner}>
        <div style={S.header}>
          <div>
            <h1 style={S.titulo}>⚖️ Calibragem</h1>
            <p style={S.sub}>
              Nivelar cada operador em <strong>{num(alvoEfetivo)} CPFs</strong>
              {alvoEfetivo < alvoPedido && <> (média disponível — não há material para {num(alvoPedido)})</>} e valor na média — só
              mensalidades sem negociação.
            </p>
          </div>
        </div>

        {/* Filtro por ano */}
        <div style={S.toolbar}>
          <div style={S.grp}>
            <span style={S.lbl}>Ano do aluno (dívida mais recente)</span>
            <div style={S.chips}>
              {anos.map((a) => (
                <button key={a} type="button" onClick={() => setAno(a)} style={{ ...S.chip, ...(ano === a ? S.chipOn : {}) }}>{a}</button>
              ))}
              <button type="button" onClick={() => setAno(null)} style={{ ...S.chip, ...(ano === null ? S.chipOn : {}) }}>Todos</button>
            </div>
          </div>
        </div>

        {/* Parâmetros — na mão da gestão, não no código */}
        <Dobra
          tema="escuro"
          style={S.dobra}
          titulo="Parâmetros do nivelamento"
          resumo={`alvo ${num(alvoPedido)} · parado após ${dias} dias · ${participantes.length} de ${operadores.length} operadores`}
        >
          <div style={S.params}>
            <label style={S.campo}>
              <span style={S.lbl}>Alvo por operador</span>
              <input
                type="number" min="1" max="5000" value={alvoPedido}
                onChange={(e) => { setAlvoPedido(Math.max(1, Number(e.target.value) || 1)); setSim(null); }}
                style={S.input}
              />
              <span style={S.ajuda}>
                {mediaDisponivel != null && mediaDisponivel < alvoPedido
                  ? `Não cabe: só há material para ${num(mediaDisponivel)} por operador.`
                  : "O teto de casos por carteira."}
              </span>
            </label>

            <label style={S.campo}>
              <span style={S.lbl}>Parado após</span>
              <input
                type="number" min={DIAS_MIN} max="365" value={dias}
                onChange={(e) => { setDias(Math.max(DIAS_MIN, Number(e.target.value) || DIAS_MIN)); setSim(null); }}
                style={S.input}
              />
              <span style={S.ajuda}>Dias sem acionamento. Mínimo {DIAS_MIN} — é o prazo de fidelização do operador.</span>
            </label>
          </div>

          <div style={S.grpOps}>
            <div style={S.linhaLbl}>
              <span style={S.lbl}>Quem entra no nivelamento</span>
              <button type="button" onClick={() => { setForaDoNivelamento([]); setSim(null); }} style={S.link}>marcar todos</button>
            </div>
            <div style={S.chips}>
              {operadores.map((o) => {
                const dentro = !foraDoNivelamento.includes(o.op_email);
                return (
                  <button
                    key={o.op_email} type="button" onClick={() => alternarOperador(o.op_email)}
                    style={{ ...S.chip, ...(dentro ? S.chipOn : S.chipOff) }}
                    aria-pressed={dentro}
                  >
                    {dentro ? "✓ " : ""}{o.op_nome} <span style={S.chipQtd}>{num(o.qtd)}</span>
                  </button>
                );
              })}
            </div>
            <span style={S.ajuda}>Quem ficar de fora não perde nem recebe caso nenhum — a carteira dele fica intacta.</span>
          </div>
        </Dobra>

        {/* Resumo */}
        {!sim && (
          <div style={S.resumo}>
            <div style={S.rcell}><div style={S.rk}>Base sem negociação</div><div style={S.rv}>{num(diag?.base_total)}</div></div>
            <div style={S.rcell}>
              <div style={S.rk}>Sem responsável</div>
              <div style={S.rv}>{num(diag?.pool_total)}</div>
              {diag?.pool_saldo > 0 && <div style={S.rsub}>{moeda(diag.pool_saldo)}</div>}
            </div>
            <div style={S.rcell}>
              <div style={S.rk}>Alvo por operador</div>
              <div style={S.rv}>{num(alvoEfetivo)}</div>
              {alvoEfetivo < alvoPedido && <div style={S.rsub}>média — pedido: {num(alvoPedido)}</div>}
            </div>
            <div style={S.rcell}>
              <div style={S.rk}>Fora do alcance</div>
              <div style={{ ...S.rv, color: foraDoAlcance > 0 ? "#f87171" : "#e2e8f0" }}>{num(foraDoAlcance)}</div>
              <div style={S.rsub}>{participantes.length} × {num(alvoEfetivo)} não cobrem a base</div>
            </div>
          </div>
        )}

        {/* Modo */}
        <div style={{ ...S.modo, color: sim ? "#34d399" : "#60a5fa" }}>
          {sim
            ? `● Após simular — ${num(sim.total_movimentacoes)} movimentações · equilíbrio CPFs ${sim.indice_qtd_depois} · valor ${sim.indice_depois}`
            : "◔ Situação atual — clique em “Simular nivelamento”"}
        </div>

        {/* Lista de operadores */}
        <div>
          {lista.map((o) => {
            const q = Number(o.qtd);
            const pct = Math.min(100, (q / alvoEfetivo) * 100);
            const antes = antesPorEmail[o.op_email];
            const delta = sim && antes ? q - Number(antes.qtd) : null;
            const st = sim
              ? (q >= alvoEfetivo ? "✓ nivelado" : `${num(alvoEfetivo - q)} abaixo (sem casos parados para soltar)`)
              : (q >= alvoEfetivo ? "✓ nivelado" : `${num(alvoEfetivo - q)} abaixo do alvo`);
            return (
              <div key={o.op_email} style={S.op}>
                <div><div style={S.nome}>{o.op_nome}</div><div style={S.st}>{st}</div></div>
                <div style={S.bar}>
                  <div style={{ ...S.fill, width: pct + "%", background: corBarra(q, alvoEfetivo) }} />
                  <div style={S.alvo500} />
                  <div style={S.barnum}>{num(q)}{delta ? ` (${delta > 0 ? "+" : ""}${delta})` : ""}</div>
                </div>
                <div style={S.saldo}>R$ {mi(o.saldo)}<small style={S.saldoS}>saldo</small></div>
              </div>
            );
          })}
          {!lista.length && <p style={S.vazio}>Nenhum operador selecionado.</p>}
        </div>

        {aviso && <div style={S.aviso}>{aviso}</div>}

        {/* Ações */}
        <div style={S.cta}>
          <button type="button" onClick={simular} disabled={simulando || aplicando} style={S.btn}>
            {simulando ? "Simulando…" : sim ? "↻ Simular de novo" : "Simular nivelamento"}
          </button>
          {sim && (
            <button type="button" onClick={aplicar} disabled={aplicando} style={S.btnAplicar}>
              {aplicando ? "Aplicando…" : `Aplicar ✓ (${num(sim.total_movimentacoes)} casos)`}
            </button>
          )}
          {sim && <button type="button" onClick={() => { setSim(null); setAviso(""); }} style={S.btnGhost}>Voltar</button>}
        </div>

        {/* Quem vai mover — a simulação já traz a lista; antes ela não aparecia */}
        {sim && movimentacoes.length > 0 && (
          <Dobra
            tema="escuro"
            style={S.dobra}
            titulo="Quem vai mover"
            contador={num(movimentacoes.length)}
            resumo="confira antes de aplicar"
          >
            <div style={S.linhaBusca}>
              <input
                type="search" value={busca} onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por aluno, CPF ou operador…" style={S.inputBusca}
              />
              <button type="button" onClick={exportarMovimentacoes} style={S.btnGhostP}>Baixar planilha</button>
            </div>
            <div style={S.tabelaWrap}>
              <table style={S.tabela}>
                <thead>
                  <tr>
                    <th style={S.th}>Aluno</th><th style={S.th}>CPF</th>
                    <th style={{ ...S.th, textAlign: "right" }}>Valor</th>
                    <th style={S.th}>Sai de</th><th style={S.th}>Vai para</th>
                  </tr>
                </thead>
                <tbody>
                  {movsFiltradas.slice(0, 200).map((m) => (
                    <tr key={m.caso_id}>
                      <td style={S.td}>{m.nome}</td>
                      <td style={{ ...S.td, ...S.mono }}>{m.cpf}</td>
                      <td style={{ ...S.td, ...S.mono, textAlign: "right" }}>{moeda(m.valor)}</td>
                      <td style={S.td}>{m.de_nome || <span style={S.pool}>sem responsável</span>}</td>
                      <td style={S.td}>{m.para_nome || <span style={S.pool}>sem responsável</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={S.ajuda}>
              {movsFiltradas.length > 200
                ? `Mostrando 200 de ${num(movsFiltradas.length)}. Baixe a planilha para ver todos.`
                : `${num(movsFiltradas.length)} movimentação(ões).`}
            </p>
          </Dobra>
        )}

        {/* Histórico + desfazer */}
        {historico.length > 0 && (
          <Dobra
            tema="escuro"
            style={S.dobra}
            titulo="Nivelamentos anteriores"
            contador={historico.length}
            resumo="dá para desfazer"
          >
            <div style={S.tabelaWrap}>
              <table style={S.tabela}>
                <thead>
                  <tr>
                    <th style={S.th}>Quando</th><th style={S.th}>Recorte</th>
                    <th style={{ ...S.th, textAlign: "right" }}>Casos</th>
                    <th style={S.th}>Situação</th><th style={S.th} />
                  </tr>
                </thead>
                <tbody>
                  {historico.map((h) => {
                    const c = h.criterios || {};
                    const podeDesfazer = h.status === "EXECUTADA" || h.status === "DESFAZENDO" || h.status === "EXECUTANDO";
                    return (
                      <tr key={h.id}>
                        <td style={S.td}>{dataHora(h.executado_em || h.criado_em)}</td>
                        <td style={S.td}>{c.ano ? `alunos de ${c.ano}` : "todos os anos"} · alvo {num(c.alvo || ALVO)}</td>
                        <td style={{ ...S.td, ...S.mono, textAlign: "right" }}>{num(h.resultado?.total_movimentacoes)}</td>
                        <td style={S.td}>{ROTULO_STATUS[h.status] || h.status.toLowerCase()}</td>
                        <td style={{ ...S.td, textAlign: "right" }}>
                          {podeDesfazer && (
                            <button
                              type="button" onClick={() => desfazer(h)}
                              disabled={desfazendoId != null || aplicando}
                              style={S.btnDesfazer}
                            >
                              {desfazendoId === h.id ? "Desfazendo…" : "Desfazer"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p style={S.ajuda}>
              Desfazer devolve cada caso ao responsável anterior. Quem já saiu das mãos de quem recebeu, ou entrou em
              negociação, acordo, link, termo ou confirmação de pagamento desde então, não é mexido.
            </p>
          </Dobra>
        )}

        <p style={S.nota}>
          A linha azul marca o alvo de {num(alvoEfetivo)}
          {alvoEfetivo < alvoPedido && ` (média por operador — o pedido de ${num(alvoPedido)} não cabe no material disponível)`}.
          Vermelho = abaixo · Verde = nivelado. O aluno entra no ano da dívida mais recente dele. Aplicar move os casos
          de verdade (tira parados +{dias} dias → pool; completa com os sem responsável e os mais recentes) e é auditado.
          Quem está em negociação, com acordo ativo, link, termo, retorno agendado ou confirmação de pagamento nunca é movido.
        </p>
      </div>
    </div>
  );
}

const estilos = {
  container: { minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", padding: "24px 28px", fontFamily: "'Sora','Inter',system-ui,sans-serif", boxSizing: "border-box" },
  inner: { maxWidth: 880, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 },
  titulo: { fontSize: 24, fontWeight: 800, margin: "0 0 2px", letterSpacing: "-0.02em" },
  sub: { color: "#94a3b8", fontSize: 13.5, margin: 0 },
  toolbar: { display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", marginBottom: 12 },
  grp: { display: "flex", flexDirection: "column", gap: 6 },
  lbl: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "#64748b", fontWeight: 700 },
  chips: { display: "flex", gap: 6, flexWrap: "wrap" },
  chip: { background: "#0b1424", border: "1px solid #22304a", color: "#94a3b8", borderRadius: 999, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  // `border` inteiro, não só `borderColor`: misturar atalho e propriedade solta
  // faz o React reclamar e deixa a borda antiga presa ao alternar o chip.
  chipOn: { background: "#3b82f6", border: "1px solid #3b82f6", color: "#fff" },
  chipOff: { opacity: 0.5, textDecoration: "line-through" },
  chipQtd: { opacity: 0.7, fontWeight: 700, fontSize: 11, marginLeft: 2 },

  dobra: { marginBottom: 14 },
  params: { display: "flex", gap: 22, flexWrap: "wrap", marginBottom: 14 },
  campo: { display: "flex", flexDirection: "column", gap: 5, minWidth: 200, flex: "1 1 200px" },
  input: { background: "#0b1424", border: "1px solid #22304a", color: "#e2e8f0", borderRadius: 8, padding: "8px 11px", fontSize: 15, fontWeight: 700, fontFamily: "inherit", width: "100%", boxSizing: "border-box" },
  ajuda: { fontSize: 11.5, color: "#64748b", lineHeight: 1.45 },
  grpOps: { display: "flex", flexDirection: "column", gap: 7 },
  linhaLbl: { display: "flex", alignItems: "baseline", gap: 10 },
  link: { background: "none", border: "none", color: "#60a5fa", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: "inherit" },

  resumo: { display: "flex", background: "#0b1424", border: "1px solid #22304a", borderRadius: 12, padding: "2px 0", marginBottom: 18, flexWrap: "wrap" },
  rcell: { flex: "1 1 150px", padding: "11px 16px", borderLeft: "1px solid #22304a" },
  rk: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "#64748b", fontWeight: 700 },
  rv: { fontSize: 19, fontWeight: 800, marginTop: 2 },
  rsub: { fontSize: 10.5, color: "#64748b", fontWeight: 600, marginTop: 1 },
  modo: { fontSize: 12, fontWeight: 700, marginBottom: 10 },
  op: { display: "grid", gridTemplateColumns: "120px 1fr 120px", alignItems: "center", gap: 14, padding: "9px 0", borderBottom: "1px solid #0b1424" },
  nome: { fontWeight: 700, fontSize: 14 },
  st: { fontSize: 11, color: "#64748b", marginTop: 1 },
  bar: { position: "relative", height: 24, background: "#0b1424", borderRadius: 6, overflow: "hidden", border: "1px solid #22304a" },
  fill: { position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: 5 },
  alvo500: { position: "absolute", top: -2, bottom: -2, left: "100%", width: 2, background: "#60a5fa" },
  barnum: { position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 11, fontWeight: 800, color: "#fff", fontVariantNumeric: "tabular-nums", textShadow: "0 1px 2px rgba(0,0,0,0.6)" },
  saldo: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 13, fontWeight: 700 },
  saldoS: { display: "block", color: "#64748b", fontSize: 10, fontWeight: 600 },
  vazio: { color: "#64748b", fontSize: 13, fontStyle: "italic", padding: "14px 0" },

  cta: { display: "flex", gap: 12, alignItems: "center", marginTop: 18, marginBottom: 18, flexWrap: "wrap" },
  btn: { background: "#3b82f6", color: "#fff", border: "none", borderRadius: 10, padding: "12px 22px", fontSize: 14, fontWeight: 800, cursor: "pointer" },
  btnAplicar: { background: "#16a34a", color: "#fff", border: "none", borderRadius: 10, padding: "12px 22px", fontSize: 14, fontWeight: 800, cursor: "pointer" },
  btnGhost: { background: "transparent", border: "1px solid #22304a", color: "#94a3b8", borderRadius: 10, padding: "12px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer" },
  btnGhostP: { background: "transparent", border: "1px solid #22304a", color: "#94a3b8", borderRadius: 8, padding: "7px 13px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  btnDesfazer: { background: "transparent", border: "1px solid #7f1d1d", color: "#f87171", borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },

  linhaBusca: { display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" },
  inputBusca: { flex: "1 1 220px", background: "#0b1424", border: "1px solid #22304a", color: "#e2e8f0", borderRadius: 8, padding: "7px 11px", fontSize: 13, fontFamily: "inherit" },
  tabelaWrap: { overflowX: "auto", maxHeight: 420, overflowY: "auto", border: "1px solid #22304a", borderRadius: 8 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: { textAlign: "left", padding: "7px 10px", color: "#64748b", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, borderBottom: "1px solid #22304a", position: "sticky", top: 0, background: "#0b1424", whiteSpace: "nowrap" },
  td: { padding: "6px 10px", borderBottom: "1px solid #131f36", whiteSpace: "nowrap" },
  mono: { fontVariantNumeric: "tabular-nums" },
  pool: { color: "#64748b", fontStyle: "italic" },

  aviso: { marginTop: 14, background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.35)", color: "#fcd34d", padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600, lineHeight: 1.5 },
  nota: { fontSize: 11, color: "#64748b", marginTop: 12, fontStyle: "italic", lineHeight: 1.5 },
};
