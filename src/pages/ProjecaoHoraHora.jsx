import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import { supabase } from "../services/supabase";
import { podeGerirFinanceiro, emailPorNomeOperador, nomeOperadorPorEmail, OPERADORES_POR_EMAIL, EQUIPE_9, podeVerRelatorios } from "../utils/operadores";
import { analiticasSuspensas } from "../config/modoContencao";
import SuspeitasPagamentosDuplicados from "../components/SuspeitasPagamentosDuplicados";
import ErrorBoundaryProjecao from "../components/ErrorBoundaryProjecao";
import GraficoEvolucaoProjecao from "../components/projecao/GraficoEvolucaoProjecao";
import CentralRelatorios from "../components/projecao/CentralRelatorios";
import BoundaryLocal from "../components/projecao/BoundaryLocal";
import ComparativoAnoAno from "../components/projecao/ComparativoAnoAno";
import PainelAnaliseEvolucao from "../components/projecao/PainelAnaliseEvolucao";

function moeda(valor) {
  const n = Number(valor);
  if (Number.isNaN(n)) return "R$ 0,00";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function mesAtualISO() {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
}

function formatarDataCurta(dataISO) {
  if (!dataISO) return "-";
  const [ano, mes, dia] = String(dataISO).slice(0, 10).split("-");
  return `${dia}/${mes}`;
}

// A planilha vem no formato de extrato Santander: sem cabeçalho de
// verdade (a linha 1 é só um título "Data de Pagamento: ..."), colunas
// fixas por posição:
// A instituição | B "matrícula - nome do aluno" | C título | D operador
// (NOME.SOBRENOME) | E código convênio+título | F convênio | G vencimento
// da parcela | H valor original | I honorário | J data de pagamento |
// K valor pago
function normalizarLinhaSantander(linhaArray) {
  const [
    ,
    alunoBruto,
    tituloNumero,
    operadorBruto,
    numeroParcelaCompleto,
    ,
    vencimento,
    valorOriginal,
    honorario,
    dataPagamento,
    valorPago,
  ] = linhaArray;

  function paraDataISO(valor) {
    if (!valor) return null;
    if (valor instanceof Date) return valor.toISOString().slice(0, 10);
    if (typeof valor === "number") {
      const d = XLSX.SSF.parse_date_code(valor);
      if (!d) return null;
      return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
    if (typeof valor === "string" && valor.includes("/")) {
      const [dia, mes, ano] = valor.split("/");
      return `${ano}-${mes.padStart(2, "0")}-${dia.padStart(2, "0")}`;
    }
    return null;
  }

  // Operador vem como "NOME.SOBRENOME" -- o mapeamento tenta o login
  // completo (resolve aliases como AMANDA.BORGES -> Amanda ADM) e só
  // então cai para o primeiro nome.
  const emailOperador = emailPorNomeOperador(operadorBruto);

  let aluno = String(alunoBruto || "");
  const partesAluno = aluno.split(" - ");
  if (partesAluno.length > 1) aluno = partesAluno.slice(1).join(" - ");

  return {
    data_pagamento: paraDataISO(dataPagamento),
    valor_pago: Number(valorPago) || 0,
    valor_honorario: Number(honorario) || 0,
    tipo_pagamento: "SANTANDER",
    titulo_numero: tituloNumero ? String(tituloNumero) : null,
    // Identificador ÚNICO de cada parcela (ex: 50640510001). Um mesmo
    // titulo_numero pode ter várias parcelas de um parcelamento, então
    // NUNCA usar titulo_numero como chave de dedup -- só esta coluna é
    // de fato única por parcela/boleto.
    numero_parcela_completo: numeroParcelaCompleto ? String(numeroParcelaCompleto) : null,
    // Vencimento da parcela (coluna G) e valor original (H): ficam guardados
    // dentro de `dados` no backend e alimentam o relatório por vencimento.
    vencimento: paraDataISO(vencimento),
    valor_original: Number(valorOriginal) || null,
    operador_email: emailOperador,
    operador_nome: emailOperador ? nomeOperadorPorEmail(emailOperador) : (operadorBruto || null),
    aluno_nome: aluno || null,
    cpf: null,
  };
}

function ProjecaoHoraHoraInner() {
  const [usuario, setUsuario] = useState(null);
  const [aba, setAba] = useState("DASHBOARD");
  const [subAbaDashboard, setSubAbaDashboard] = useState("VISAO_GERAL");
  const [operadorSelecionado, setOperadorSelecionado] = useState("");
  const [projecaoTodos, setProjecaoTodos] = useState(null);
  const [carregandoTodos, setCarregandoTodos] = useState(false);
  const [mesReferencia, setMesReferencia] = useState(mesAtualISO());
  // Filtro de unidade/estabelecimento OPCIONAL. "" = "Todos" (padrão): não
  // filtra. Só restringe quando uma unidade é escolhida.
  const [unidadeFiltro, setUnidadeFiltro] = useState("");
  const [unidades, setUnidades] = useState([]);

  // Busca "o aluno pagou este mês?" — cada operador pesquisa SOMENTE os
  // próprios pagamentos (gestão vê todos). Backend: projecao_pesquisar_pagamento_mes.
  const [buscaTermo, setBuscaTermo] = useState("");
  const [buscaResultado, setBuscaResultado] = useState(null);
  const [buscando, setBuscando] = useState(false);

  const [dashboard, setDashboard] = useState(null);
  const [diaSelecionado, setDiaSelecionado] = useState(null);
  const [pagamentosDoDia, setPagamentosDoDia] = useState([]);
  const [carregandoPagamentosDia, setCarregandoPagamentosDia] = useState(false);
  // Conferência diária (modal) — {dia, operadorEmail, esperado:{recuperado,honorario}}.
  const [conferencia, setConferencia] = useState(null);
  const [semOperador, setSemOperador] = useState(null);
  const [carregandoDashboard, setCarregandoDashboard] = useState(true);
  const [erro, setErro] = useState("");
  // Snapshot manual: metadados da última atualização salva (sem polling).
  const [snapshotMeta, setSnapshotMeta] = useState(null); // {status, atualizado_em, atualizado_por, duracao_ms, erro_resumo, e_gestao}
  const [atualizandoProjecao, setAtualizandoProjecao] = useState(false);

  const [arquivo, setArquivo] = useState(null);
  const [linhasPreview, setLinhasPreview] = useState([]);
  const [importando, setImportando] = useState(false);
  const [ehRetroativo, setEhRetroativo] = useState(false);
  const [mensagemImportacao, setMensagemImportacao] = useState("");

  const [historicoImportacoes, setHistoricoImportacoes] = useState([]);
  const [auditoriaAcoes, setAuditoriaAcoes] = useState([]);
  const [lancamentosHoje, setLancamentosHoje] = useState([]);
  const [substituindoImportacaoId, setSubstituindoImportacaoId] = useState(null);
  const [processandoAcaoId, setProcessandoAcaoId] = useState(null);
  const [exportandoPdf, setExportandoPdf] = useState(false);
  const [serieMeses, setSerieMeses] = useState(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const { data } = await supabase.rpc("projecao_serie_recuperado", { p_mes: mesReferencia });
        if (vivo) setSerieMeses(Array.isArray(data) ? data : []);
      } catch { if (vivo) setSerieMeses([]); }
    })();
    return () => { vivo = false; };
  }, [mesReferencia]);

  async function exportarProjecaoPDF() {
    setExportandoPdf(true);
    try {
      const { data: rel, error } = await supabase.rpc("projecao_relatorio_pdf", { p_mes: mesReferencia });
      if (error || !rel) { alert("Não foi possível gerar o PDF: " + (error?.message || "sem dados")); return; }
      const carregarLogo = async () => {
        try {
          const resp = await fetch("/logo_padrao_email.png");
          if (!resp.ok) return null;
          const blob = await resp.blob();
          return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
        } catch { return null; }
      };
      const BR = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      const N = (v) => (Number(v) || 0).toLocaleString("pt-BR");
      const DDMM = (d) => { const [, m, dd] = String(d).slice(0, 10).split("-"); return `${dd}/${m}`; };
      const MESNOME = (() => {
        const [an, me] = String(mesReferencia).split("-");
        const nomes = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
        return `${nomes[Number(me)] || me}/${an}`;
      })();
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const PW = 595.28, PH = 841.89, M = 40, CW = PW - 2 * M;
      const BLUE = [37, 99, 235], INK = [31, 41, 55], MUT = [107, 114, 128], LINE = [229, 231, 235], SOFT = [244, 246, 250], SOFTBLUE = [232, 238, 246];
      let y = 0;
      const need = (h) => { if (y + h > PH - 46) { doc.addPage(); y = 48; } };
      doc.setFillColor(...BLUE); doc.rect(0, 0, PW, 5, "F");
      y = 30;
      const logo = await carregarLogo();
      let lh = 0;
      if (logo) { const lw = 128; lh = (128 * 150) / 356; try { doc.addImage(logo, "PNG", M, y, lw, lh); } catch { /* sem logo */ } }
      y += (lh || 40) + 16;
      doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(...INK);
      doc.text("Projeção Hora a Hora — Recuperação · " + MESNOME, M, y);
      y += 15;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUT);
      doc.text(rel.e_gestao ? "Visão da gestão — total da empresa." : ("Operador: " + (rel.operador_nome || "-")), M, y);
      y += 20;
      const t = rel.total || {};
      const kpis = [["RECUPERADO", BR(t.recuperado)], ["HONORÁRIOS", BR(t.honorarios)], ["PAGAMENTOS", N(t.pagamentos)], ["DIAS", N(t.dias)]];
      const gap = 10, kw = (CW - 3 * gap) / 4, kh = 54;
      kpis.forEach((k, i) => {
        const x = M + i * (kw + gap);
        doc.setFillColor(...(i === 0 ? SOFTBLUE : SOFT)); doc.roundedRect(x, y, kw, kh, 7, 7, "F");
        doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...MUT); doc.text(k[0], x + 10, y + 17);
        doc.setFont("helvetica", "bold"); doc.setFontSize(k[1].length > 12 ? 11 : 14); doc.setTextColor(...INK); doc.text(k[1], x + 10, y + 38);
      });
      y += kh + 22;
      // Recuperado por mês (comparativo, no topo)
      const mlbl = (ym) => { const [an, me] = String(ym).split("-"); const ab = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]; return `${ab[Number(me)] || me}/${an.slice(2)}`; };
      const serie = rel.serie_meses || [];
      if (serie.length) {
        const chH = 150; need(chH + 10);
        doc.setDrawColor(...LINE); doc.roundedRect(M, y, CW, chH, 8, 8, "S");
        doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...INK); doc.text("Recuperado por mês", M + 14, y + 22);
        const cx = M + 16, cw = CW - 32, cBottom = y + chH - 34, cArea = chH - 74;
        const maxV = Math.max(1, ...serie.map((s) => Number(s.recuperado) || 0)); const slot = cw / serie.length, bw = Math.min(slot * 0.5, 64);
        serie.forEach((s, i) => {
          const v = Number(s.recuperado) || 0, h = (v / maxV) * cArea, x = cx + i * slot + (slot - bw) / 2, yb = cBottom - h;
          doc.setFillColor(...BLUE); doc.roundedRect(x, yb, bw, Math.max(h, 1.5), 3, 3, "F");
          doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...INK);
          doc.text("R$ " + (v / 1000000).toFixed(2) + "M", x + bw / 2, yb - 5, { align: "center" });
          doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUT);
          doc.text(mlbl(s.mes), x + bw / 2, cBottom + 13, { align: "center" });
        });
        doc.setDrawColor(...LINE); doc.line(cx, cBottom, cx + cw, cBottom);
        y += chH + 20;
      }
      // Gráfico por operador (gestão)
      const ops = rel.por_operador || [];
      if (rel.e_gestao && ops.length) {
        const chH = 190; need(chH + 10);
        doc.setDrawColor(...LINE); doc.roundedRect(M, y, CW, chH, 8, 8, "S");
        doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...INK); doc.text("Recuperação por operador", M + 14, y + 22);
        const top = ops.slice(0, 8), cx = M + 16, cw = CW - 32, cBottom = y + chH - 40, cArea = chH - 80;
        const maxV = Math.max(1, ...top.map((o) => Number(o.recuperado) || 0)); const slot = cw / top.length, bw = slot * 0.5;
        top.forEach((o, i) => {
          const v = Number(o.recuperado) || 0, h = (v / maxV) * cArea, x = cx + i * slot + (slot - bw) / 2, yb = cBottom - h;
          doc.setFillColor(...BLUE); doc.roundedRect(x, yb, bw, Math.max(h, 1.5), 3, 3, "F");
          doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(...INK);
          doc.text("R$ " + (v / 1000).toFixed(0) + "k", x + bw / 2, yb - 5, { align: "center" });
          doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...INK);
          doc.text(String(o.operador || "-").split(" ")[0], x + bw / 2, cBottom + 14, { align: "center" });
        });
        doc.setDrawColor(...LINE); doc.line(cx, cBottom, cx + cw, cBottom);
        y += chH + 20;
      }
      const tabela = (titulo, cabec, linhas, aligns) => {
        if (!linhas.length) return;
        need(46);
        doc.setFillColor(...BLUE); doc.rect(M, y - 9, 3, 13, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...INK); doc.text(titulo, M + 10, y); y += 10;
        const ncol = cabec.length, labelW = CW * 0.40, numW = (CW - labelW) / (ncol - 1);
        const colX = (i) => (i === 0 ? M + 6 : M + labelW + i * numW - 6);
        doc.setFillColor(...SOFT); doc.rect(M, y, CW, 18, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...MUT);
        cabec.forEach((c, i) => doc.text(c, colX(i), y + 12, { align: aligns[i] })); y += 18;
        doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...INK);
        linhas.forEach((l, r) => {
          need(16); if (r % 2 === 1) { doc.setFillColor(...SOFT); doc.rect(M, y, CW, 15, "F"); }
          l.forEach((cel, i) => { const s = i === 0 ? doc.splitTextToSize(String(cel), labelW - 12)[0] : String(cel); doc.text(s, colX(i), y + 11, { align: aligns[i] }); });
          y += 15;
        }); y += 18;
      };
      const A4 = ["left", "right", "right", "right"];
      if (rel.e_gestao) tabela("Ranking por operador", ["Operador", "Pagamentos", "Recuperado", "Honorários"], ops.map((o) => [o.operador, N(o.pagamentos), BR(o.recuperado), BR(o.honorarios)]), A4);
      tabela("Dias de maior recuperação", ["Dia", "Pagamentos", "Recuperado", "Honorários"], (rel.dias_maior || []).map((di) => [DDMM(di.dia), N(di.pagamentos), BR(di.recuperado), BR(di.honorarios)]), A4);
      if (rel.e_gestao) tabela("Por unidade (campus)", ["Unidade", "Pagamentos", "Recuperado", "Honorários"], (rel.por_unidade || []).map((u) => [u.unidade, N(u.pagamentos), BR(u.recuperado), BR(u.honorarios)]), A4);
      const pgs = doc.getNumberOfPages();
      for (let p = 1; p <= pgs; p++) {
        doc.setPage(p); doc.setDrawColor(...LINE); doc.line(M, PH - 34, PW - M, PH - 34);
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...MUT);
        doc.text("ReATIVA · Projeção Hora a Hora · exportado da tela", M, PH - 15);
        doc.text("Gerado em " + new Date().toLocaleString("pt-BR") + " · Página " + p + "/" + pgs, PW - M, PH - 15, { align: "right" });
      }
      doc.save("projecao-hora-a-hora_" + mesReferencia + ".pdf");
    } finally { setExportandoPdf(false); }
  }

  const [formMeta, setFormMeta] = useState({
    meta_operacional: "",
    meta_unidades: "",
    meta_honorario: "",
    m1_valor: "",
    m1_percentual: "",
    m2_valor: "",
    m2_percentual: "",
    m3_valor: "",
    m3_percentual: "",
    m4_valor: "",
    m4_percentual: "",
  });
  const [salvandoMeta, setSalvandoMeta] = useState(false);

  // Linhas onde o valor pago veio zerado mas o honorário veio preenchido --
  // sinal forte de que a celula de valor pago veio vazia so nessa linha na
  // planilha original (nao e mudanca de layout do arquivo inteiro).
  const linhasSuspeitas = linhasPreview.filter(
    (l) => Number(l.valor_pago) === 0 && Number(l.valor_honorario) > 0
  );

  // Sempre mostra as linhas suspeitas na previa, mesmo que estejam alem das
  // primeiras 20 -- senao ficam escondidas e passam despercebidas.
  const linhasParaMostrar = (() => {
    const primeiras20 = linhasPreview.slice(0, 20);
    if (linhasSuspeitas.length === 0) return primeiras20;
    const jaIncluidas = new Set(primeiras20);
    const suspeitasFaltando = linhasSuspeitas.filter((l) => !jaIncluidas.has(l));
    return [...primeiras20, ...suspeitasFaltando];
  })();

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      const email = data?.user?.email || null;
      let podeGerir = false;
      if (email) podeGerir = podeGerirFinanceiro(email);
      setUsuario({ email, podeGerir });
    })();
    // Popula o seletor de unidade (opção "Todos" + unidades distintas).
    // KILL SWITCH: RPC analítica suspensa em modo de contenção.
    if (!analiticasSuspensas()) {
      (async () => {
        const { data, error } = await supabase.rpc("projecao_unidades_disponiveis");
        if (!error && Array.isArray(data)) {
          setUnidades(data.map((u) => u.unidade).filter(Boolean));
        }
      })();
    }
  }, []);

  // Snapshot manual: ao abrir (e ao trocar o mês) faz UMA leitura leve do
  // último snapshot salvo. Sem polling, sem cálculo pesado, sem projecao_dashboard.
  useEffect(() => {
    if (!usuario) return;
    carregarSnapshot();
    // Carrega os lançamentos do dia já na abertura (antes só carregava depois
    // de importar/ações), pra gestão ver e reatribuir TODOS os pagamentos do
    // dia — inclusive os Sem Operador — sem precisar importar nada.
    carregarLancamentosHoje();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesReferencia, usuario, unidadeFiltro]);

  useEffect(() => {
    if (aba === "HISTORICO") carregarHistorico();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba]);

  // Recarrega os pagamentos do dia já aberto (usado depois de alterar
  // operador, pra lista e somatória refletirem a troca na hora).
  async function carregarPagamentosDia(dia) {
    setCarregandoPagamentosDia(true);
    // Amanda ADM vê SOMENTE os pagamentos dela (operador_email). id/
    // operador_email entram no select pra permitir alterar operador aqui.
    // Filtro de unidade opcional: inner join com alunos só quando uma unidade
    // é escolhida (senão pagamentos sem aluno_id sumiriam) -- e sempre dentro
    // dos pagamentos dela.
    const colunasDia = "id, aluno_nome, valor_pago, valor_honorario, operador_nome, operador_email, titulo_numero";
    let consultaDia = supabase
      .from("pagamentos")
      .select(unidadeFiltro ? `${colunasDia}, alunos!inner(unidade)` : colunasDia)
      .eq("data_pagamento", dia)
      .order("valor_pago", { ascending: false });

    if (usuario?.email?.toLowerCase() === "cobranca07@aelbra.com.br") {
      consultaDia = consultaDia.eq("operador_email", "cobranca07@aelbra.com.br");
    }
    if (unidadeFiltro) consultaDia = consultaDia.eq("alunos.unidade", unidadeFiltro);

    const { data, error } = await consultaDia;

    if (error) {
      console.error("Erro ao carregar pagamentos do dia:", error);
      setPagamentosDoDia([]);
    } else {
      setPagamentosDoDia(data || []);
    }
    setCarregandoPagamentosDia(false);
  }

  async function abrirDiaSelecionado(dia) {
    if (diaSelecionado === dia) {
      setDiaSelecionado(null);
      setPagamentosDoDia([]);
      return;
    }
    setDiaSelecionado(dia);
    await carregarPagamentosDia(dia);
  }

  async function carregarProjecaoTodos() {
    if (analiticasSuspensas()) { setCarregandoTodos(false); return; }
    setCarregandoTodos(true);
    const { data, error } = await supabase.rpc("projecao_todos_operadores", { p_mes: mesReferencia });
    if (!error) setProjecaoTodos(data);
    setCarregandoTodos(false);
  }

  useEffect(() => {
    const podeVerTodos = usuario?.podeGerir && usuario?.email?.toLowerCase() !== "cobranca07@aelbra.com.br";
    if (podeVerTodos && subAbaDashboard === "POR_OPERADOR") {
      carregarProjecaoTodos();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subAbaDashboard, mesReferencia, usuario]);

  // LEITURA LEVE: lê o último snapshot salvo (1 SELECT por PK no backend).
  // Não dispara a RPC pesada nem cálculo. Mantém os dados anteriores em tela
  // em caso de falha de rede (sem loading infinito).
  async function carregarSnapshot() {
    setErro("");
    const { data, error } = await supabase.rpc("projecao_snapshot_ler", {
      p_mes: mesReferencia,
    });
    setCarregandoDashboard(false);
    if (error) {
      setErro("Erro ao ler a projeção salva: " + error.message);
      return;
    }
    setSnapshotMeta({
      status: data?.status,
      atualizado_em: data?.atualizado_em,
      atualizado_por: data?.atualizado_por,
      duracao_ms: data?.duracao_ms,
      erro_resumo: data?.erro_resumo,
      e_gestao: data?.e_gestao === true,
    });
    // Só troca os dados em tela quando há payload; assim uma atualização com
    // erro (dados null) preserva o que já estava sendo exibido.
    if (data?.dados) aplicarDadosDashboard(data.dados);
    // Gestão: aba "Por Operador" alimentada direto pela lista do snapshot
    // (leitura leve; sem projecao_dashboard e sem projecao_todos_operadores).
    if (data?.e_gestao === true && Array.isArray(data?.operadores)) {
      setProjecaoTodos({ operadores: data.operadores });
      setSemOperador(data?.sem_operador || null);
    }
  }

  // Botão "Atualizar projeção" — só Amanda/Fernanda (autorização real no
  // backend por allowlist de e-mail em SECURITY DEFINER). Uma execução por vez
  // (lock no backend). Mantém os dados anteriores enquanto recalcula.
  async function atualizarProjecao() {
    if (atualizandoProjecao) return;
    setAtualizandoProjecao(true);
    setErro("");
    const { data, error } = await supabase.rpc("projecao_snapshot_atualizar", {
      p_mes: mesReferencia,
    });
    if (error) {
      // Ex.: 55P03 (já em andamento) ou 42501 (sem permissão). Dados anteriores ficam.
      setErro("Não foi possível atualizar agora: " + error.message);
    } else if (data?.status === "erro") {
      setErro("A atualização falhou (snapshot anterior mantido): " + (data?.erro_resumo || ""));
    } else {
      // Mesmo gatilho atualiza os snapshots gerenciais (DRE e Visão Executiva),
      // que passaram a ler snapshot (nao ao vivo). Falha aqui nao quebra a projeção.
      try {
        const anoRef = parseInt(String(mesReferencia).slice(0, 4), 10) || null;
        await supabase.rpc("atualizar_snapshots_gerenciais", { p_ano: anoRef });
      } catch (e) {
        /* silencioso: a projeção segue */
      }
      // Mesmo gatilho regenera o snapshot da TV ReATIVA (a TV lê só esse
      // snapshot; sem esta chamada ela não teria dados frescos). Falha aqui
      // não quebra a projeção — a TV mantém o snapshot anterior.
      try {
        await supabase.rpc("tv_snapshot_atualizar");
      } catch (e) {
        /* silencioso: a projeção segue */
      }
      // Grava a foto DIÁRIA da projeção (recuperado/honorário/projeção) pra
      // habilitar o comparativo "vs ontem" na aba Evolução. Upsert por dia:
      // a última atualização do dia vence. Falha aqui não quebra a projeção.
      try {
        await supabase.rpc("projecao_historico_diario_gravar", { p_mes: mesReferencia });
      } catch (e) {
        /* silencioso: a projeção segue */
      }
    }
    // Recarrega o snapshot (novo ou o anterior preservado) via leitura leve.
    await carregarSnapshot();
    setAtualizandoProjecao(false);
  }

  function aplicarDadosDashboard(data) {
    setDashboard(data);
    {
      const cfg = data?.config_metas || {};
      setFormMeta({
        meta_operacional: cfg?.meta_operacional ?? data?.meta_recuperacao ?? "",
        meta_unidades: cfg?.meta_unidades || "",
        meta_honorario: cfg?.meta_honorario ?? data?.meta_honorario ?? "",
        m1_valor: cfg?.m1_valor || "",
        m1_percentual: cfg?.m1_percentual || "",
        m2_valor: cfg?.m2_valor || "",
        m2_percentual: cfg?.m2_percentual || "",
        m3_valor: cfg?.m3_valor || "",
        m3_percentual: cfg?.m3_percentual || "",
        m4_valor: cfg?.m4_valor || "",
        m4_percentual: cfg?.m4_percentual || "",
      });
    }
    setCarregandoDashboard(false);
  }

  async function carregarLancamentosHoje() {
    const hojeISO = new Date().toISOString().slice(0, 10);
    const colunasLanc = "id, data_pagamento, aluno_nome, operador_email, operador_nome, valor_pago, valor_honorario";
    let consulta = supabase
      .from("pagamentos")
      .select(unidadeFiltro ? `${colunasLanc}, alunos!inner(unidade)` : colunasLanc)
      .eq("data_pagamento", hojeISO)
      .order("valor_pago", { ascending: false });

    // Operador comum e Amanda ADM veem só os próprios lançamentos.
    if ((!usuario?.podeGerir || usuario?.email?.toLowerCase() === "cobranca07@aelbra.com.br") && usuario?.email) {
      consulta = consulta.eq("operador_email", usuario.email);
    }
    if (unidadeFiltro) consulta = consulta.eq("alunos.unidade", unidadeFiltro);

    const { data, error } = await consulta;
    if (!error) setLancamentosHoje(data || []);
  }

  async function carregarHistorico() {
    const { data, error } = await supabase
      .from("importacoes")
      .select("*")
      .in("tipo", ["PROJECAO_DIARIA", "PROJECAO_RETROATIVA"])
      .order("created_at", { ascending: false })
      .limit(100);
    if (!error) setHistoricoImportacoes(data || []);

    if (usuario?.podeGerir) {
      const { data: auditoria, error: erroAuditoria } = await supabase
        .from("auditoria")
        .select("id, usuario, acao, tabela_afetada, registro_id, detalhes, created_at")
        .in("acao", [
          "IMPORTOU",
          "SUBSTITUIU_IMPORTACAO",
          "EXCLUIU_IMPORTACAO",
          "REPROCESSOU_IMPORTACAO",
          "ALTEROU_OPERADOR",
          "CONFIGUROU_METAS",
        ])
        .order("created_at", { ascending: false })
        .limit(100);
      if (!erroAuditoria) setAuditoriaAcoes(auditoria || []);
    }
  }

  function selecionarArquivo(evento) {
    const arquivoSelecionado = evento.target.files?.[0];
    if (!arquivoSelecionado) return;
    setArquivo(arquivoSelecionado);
    setMensagemImportacao("");

    const leitor = new FileReader();
    leitor.onload = (e) => {
      const buffer = new Uint8Array(e.target.result);
      const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
      const primeiraAba = workbook.SheetNames[0];
      // header: 1 -> array de arrays por posição (o arquivo não tem
      // cabeçalho de verdade, a 1ª linha é só um título "Data de
      // Pagamento: ..."). Ignora linhas totalmente vazias.
      const linhasBrutas = XLSX.utils.sheet_to_json(workbook.Sheets[primeiraAba], {
        header: 1,
        defval: "",
        raw: true,
      });
      // Antes sempre pulava a linha 0 (slice(1)) assumindo que era o
      // título "Data de Pagamento: ...". Só que ALGUNS arquivos vêm SEM
      // essa linha de título -- a 1ª linha já é um pagamento de verdade,
      // e ela estava sendo descartada (perdendo pagamento real, ex.:
      // 2 pagamentos no arquivo, só 1 carregado). Agora não se assume
      // mais nada sobre a linha 0: qualquer linha (incluindo a 1ª) que
      // tenha um valor pago numérico válido (coluna K) é considerada um
      // pagamento de verdade. Isso identifica e descarta a linha de
      // título (que não tem número em "valor pago") sem depender de
      // posição fixa.
      const linhaTemDado = (linha) => {
        const valorPago = linha?.[10];
        const temValorPago = typeof valorPago === "number" && valorPago !== 0;
        if (temValorPago) return true;

        // Rede de segurança: se por algum motivo a coluna K não veio
        // numérica mas a linha claramente tem outros dados de pagamento
        // (aluno + data de pagamento), ainda considera válida.
        const aluno = linha?.[1];
        const dataPagamento = linha?.[9];
        const temAluno = typeof aluno === "string" && aluno.trim() !== "";
        const temData = dataPagamento instanceof Date || typeof dataPagamento === "number";
        return temAluno && temData;
      };
      const linhasDeDados = linhasBrutas.filter(linhaTemDado);
      setLinhasPreview(linhasDeDados.map(normalizarLinhaSantander));
    };
    leitor.readAsArrayBuffer(arquivoSelecionado);
  }

  async function confirmarImportacao() {
    if (!linhasPreview.length) return;
    setImportando(true);
    setMensagemImportacao("");

    const nomeArquivo = arquivo?.name || "planilha_diaria";
    let idParaSubstituir = substituindoImportacaoId;
    let motivoSubstituicao = null;

    // Antes de gravar, checa se esse arquivo já foi importado nessa
    // competência. Se já foi, pergunta se é pra substituir a importação
    // existente ou cancelar -- evita duplicar Projeção/Hora a Hora.
    if (!idParaSubstituir) {
      const { data: existentes, error: erroChecagem } = await supabase.rpc("projecao_checar_importacao_existente", {
        p_mes_referencia: mesReferencia,
        p_arquivo_nome: nomeArquivo,
      });
      if (erroChecagem) {
        setMensagemImportacao("Erro ao checar duplicidade: " + erroChecagem.message);
        setImportando(false);
        return;
      }
      if (existentes && existentes.length > 0) {
        const jaImportado = existentes[0];
        const confirmar = window.confirm(
          `O arquivo "${nomeArquivo}" já foi importado nesta competência em ` +
            `${new Date(jaImportado.created_at).toLocaleString("pt-BR")} por ${jaImportado.usuario} ` +
            `(${jaImportado.qtd_registros} registros).\n\n` +
            `Clique OK para SUBSTITUIR essa importação pela nova, ou Cancelar para não importar.`
        );
        if (!confirmar) {
          setMensagemImportacao("Importação cancelada — arquivo já existia nesta competência.");
          setImportando(false);
          return;
        }
        idParaSubstituir = jaImportado.id;
        motivoSubstituicao = prompt("Motivo da substituição (fica registrado na auditoria):") || "Reenvio do mesmo arquivo";
      }
    } else {
      motivoSubstituicao = prompt("Motivo da substituição (fica registrado na auditoria):") || "Substituição manual";
    }

    const { data, error } = await supabase.rpc("projecao_importar_pagamentos", {
      p_arquivo_nome: nomeArquivo,
      p_usuario: usuario?.email || "",
      p_linhas: linhasPreview,
      p_mes_referencia: mesReferencia,
      p_retroativo: ehRetroativo,
      p_substituir_importacao_id: idParaSubstituir,
      p_motivo_substituicao: motivoSubstituicao,
    });

    if (error) {
      setMensagemImportacao("Erro ao importar: " + error.message);
    } else {
      const resultado = data?.[0];
      setMensagemImportacao(
        `Importação ${idParaSubstituir ? "(substituindo a anterior) " : ""}concluída: ` +
          `${resultado?.linhas_gravadas ?? linhasPreview.length} pagamentos gravados` +
          (ehRetroativo ? " (retroativo — só entra na visão macro, não afeta comissão/ranking do mês)." : ".")
      );
      setArquivo(null);
      setLinhasPreview([]);
      setEhRetroativo(false);
      setSubstituindoImportacaoId(null);
      carregarSnapshot();
      carregarLancamentosHoje();
      carregarHistorico();
    }
    setImportando(false);
  }

  function iniciarSubstituicaoImportacao(importacaoAlvo) {
    setSubstituindoImportacaoId(importacaoAlvo.id);
    setAba("IMPORTAR");
    setMensagemImportacao(
      `Selecione o novo arquivo pra substituir "${importacaoAlvo.arquivo_nome}" ` +
        `(${new Date(importacaoAlvo.created_at).toLocaleString("pt-BR")}).`
    );
  }

  async function reprocessarImportacao(importacaoId) {
    if (!window.confirm("Reprocessar essa importação e recalcular os indicadores dela?")) return;
    setProcessandoAcaoId(importacaoId);
    const { error } = await supabase.rpc("projecao_reprocessar_importacao", { p_importacao_id: importacaoId });
    if (error) {
      alert("Erro ao reprocessar: " + error.message);
    } else {
      carregarSnapshot();
      carregarHistorico();
    }
    setProcessandoAcaoId(null);
  }

  async function excluirImportacao(importacaoId) {
    const motivo = prompt("Motivo da exclusão (fica registrado na auditoria):");
    if (!motivo) return;
    if (!window.confirm("Excluir essa importação? Os pagamentos dela saem da Projeção, do Hora a Hora e dos indicadores.")) return;
    setProcessandoAcaoId(importacaoId);
    const { error } = await supabase.rpc("projecao_excluir_importacao", {
      p_importacao_id: importacaoId,
      p_motivo: motivo,
    });
    if (error) {
      alert("Erro ao excluir: " + error.message);
    } else {
      carregarSnapshot();
      carregarLancamentosHoje();
      carregarHistorico();
    }
    setProcessandoAcaoId(null);
  }

  async function salvarMeta() {
    setSalvandoMeta(true);
    const { error } = await supabase.rpc("projecao_definir_meta", {
      p_mes_referencia: mesReferencia,
      p_meta_operacional: Number(formMeta.meta_operacional) || 0,
      p_meta_unidades: Number(formMeta.meta_unidades) || 0,
      p_meta_honorario: Number(formMeta.meta_honorario) || 0,
      p_m1_valor: Number(formMeta.m1_valor) || 0,
      p_m1_percentual: Number(formMeta.m1_percentual) || 0,
      p_m2_valor: Number(formMeta.m2_valor) || 0,
      p_m2_percentual: Number(formMeta.m2_percentual) || 0,
      p_m3_valor: Number(formMeta.m3_valor) || 0,
      p_m3_percentual: Number(formMeta.m3_percentual) || 0,
      p_m4_valor: Number(formMeta.m4_valor) || 0,
      p_m4_percentual: Number(formMeta.m4_percentual) || 0,
    });
    if (error) {
      alert("Erro ao salvar meta: " + error.message);
    } else {
      carregarSnapshot();
    }
    setSalvandoMeta(false);
  }

  async function buscarPagamentoMes(evento) {
    if (evento) evento.preventDefault();
    const termo = buscaTermo.trim();
    if (termo.length < 3) {
      setBuscaResultado({ total: 0, itens: [], aviso: "Digite ao menos 3 letras do nome ou 6 dígitos do CPF." });
      return;
    }
    setBuscando(true);
    try {
      const { data, error } = await supabase.rpc("projecao_pesquisar_pagamento_mes", {
        p_mes: mesReferencia,
        p_termo: termo,
      });
      if (error) {
        setBuscaResultado({ total: 0, itens: [], aviso: "Erro na busca: " + error.message });
      } else {
        setBuscaResultado(data);
      }
    } finally {
      setBuscando(false);
    }
  }

  async function alterarOperador(pagamentoId, operadorAtualEmail) {
    const novoNome = prompt("Nome do novo operador responsável:");
    if (!novoNome) return;
    const motivo = prompt("Motivo da troca (fica registrado na auditoria):") || "";
    const novoEmail = emailPorNomeOperador(novoNome) || operadorAtualEmail;

    const { error } = await supabase.rpc("projecao_alterar_operador", {
      p_pagamento_id: pagamentoId,
      p_novo_operador_email: novoEmail,
      p_novo_operador_nome: novoNome,
      p_motivo: motivo,
    });

    if (error) {
      alert("Erro ao alterar operador: " + error.message);
    } else {
      // A troca só grava em `pagamentos`; o operador enxerga a projeção pelo
      // SNAPSHOT (projecao_snapshot), que não é regenerado pela RPC de troca.
      // Sem regerar aqui, o pagamento sumia do painel do operador antigo mas
      // só entrava no do novo depois de alguém clicar "Atualizar projeção".
      // Por isso regeneramos o snapshot na hora (Fernanda está na allowlist).
      await atualizarProjecao();
      carregarLancamentosHoje();
      // Se a troca foi feita pelo painel de um dia da evolução, recarrega
      // aquele dia pra lista e somatória já mostrarem o novo operador.
      if (diaSelecionado) carregarPagamentosDia(diaSelecionado);
    }
  }

  const ranking = useMemo(() => dashboard?.ranking_equipe || [], [dashboard]);
  const historicoDia = useMemo(() => dashboard?.historico_dia_a_dia || [], [dashboard]);
  // Amanda ADM (cobranca07) vê SOMENTE a projeção dos pagamentos dela
  // (painel pessoal + comissão 8%), como um operador. O painel gerencial
  // da filial (totais gerais, ranking, por operador) fica só para a gestão
  // (Amanda Seibel / Fernanda).
  const eAmandaAdm = usuario?.email?.toLowerCase() === "cobranca07@aelbra.com.br";
  // Autoridade da visão de gestão = o backend (snapshot_ler retorna e_gestao só
  // para Amanda/Fernanda). Amanda ADM e operadores NUNCA veem ranking/individuais.
  const vePainelGestao = snapshotMeta?.e_gestao === true && !eAmandaAdm;
  // Não-gestão (Amanda ADM e operadores) visualizam o snapshot da FILIAL
  // (totais + evolução), sem ranking, sem maior pagamento, sem dados de outros
  // operadores, e sem botão de atualização.
  const veFilialSomente = !vePainelGestao;
  const maiorValorGrafico = useMemo(
    () => Math.max(1, ...historicoDia.map((d) => Number(d.valor_recuperado) || 0)),
    [historicoDia]
  );

  // Mapa email -> payload completo do operador (gestão; vem do snapshot_ler).
  const operadoresPayloadPorEmail = useMemo(() => {
    const m = {};
    (projecaoTodos?.operadores || []).forEach((o) => {
      if (o?.operador_email && o?.payload) m[o.operador_email] = o.payload;
    });
    return m;
  }, [projecaoTodos]);

  // Operador em foco para a visão individual (hero + gráfico + conferência):
  //  - não-gestão: o próprio usuário (payload = dashboard);
  //  - gestão: o operador selecionado (payload completo do snapshot); sem
  //    seleção, mostra a visão de Total da Empresa.
  const emailFoco = vePainelGestao ? operadorSelecionado : (usuario?.email || "");
  const payloadFoco = vePainelGestao
    ? (operadorSelecionado ? operadoresPayloadPorEmail[operadorSelecionado] : null)
    : dashboard;
  const historicoFoco = payloadFoco?.historico_dia_a_dia || [];

  function abrirConferenciaDia(dia) {
    if (!emailFoco) return;
    const d = (historicoFoco || []).find((x) => x.dia === dia) || {};
    setConferencia({
      dia,
      operadorEmail: emailFoco,
      esperado: {
        recuperado: Number(d.recuperado_dia ?? d.valor_recuperado ?? 0),
        honorario: Number(d.honorario_dia ?? d.valor_honorario ?? 0),
      },
    });
  }

  // NB: o kill switch global (analiticasSuspensas) permanece ATIVO para as
  // demais telas analíticas (Dashboard/DRE/Visão Gerencial/Panorama/TV). Esta
  // rota é liberada de forma controlada porque NÃO chama a RPC pesada ao abrir:
  // lê apenas o último snapshot salvo (projecao_snapshot_ler) e só recalcula
  // sob o botão manual (Amanda/Fernanda).
  return (
    <div className="main ph-root" style={{ background: "#f4f6fa", padding: "6px 4px 28px", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`
        .ph-root h3 { font-family: ${PH_FONTE_TITULO}; font-size: 15px; font-weight: 700; color: #0d1321; }
        .ph-root table tbody tr:hover { background: #f6fbf9; }
      `}</style>
      <div style={estilos.cabecalho}>
        <div>
          <h1 style={{ fontFamily: PH_FONTE_TITULO, fontSize: 26, fontWeight: 800, color: "#0d1321", letterSpacing: "-0.03em" }}>
            ⏱️ Projeção Hora a Hora
          </h1>
          <p style={{ color: "#8a93a3", marginTop: 4, fontSize: 13.5 }}>
            Acompanhamento em tempo real da operação e projeção automática do fechamento do mês.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={unidadeFiltro}
            onChange={(e) => setUnidadeFiltro(e.target.value)}
            style={estilos.inputMes}
            title="Filtrar por unidade/estabelecimento (opcional)"
          >
            <option value="">Todos</option>
            {unidades.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
          <input
            type="month"
            value={mesReferencia}
            onChange={(e) => setMesReferencia(e.target.value)}
            style={estilos.inputMes}
          />
          {/* Botão manual: só Amanda/Fernanda (backend decide via e_gestao). */}
          {snapshotMeta?.e_gestao && (
            <button
              onClick={atualizarProjecao}
              disabled={atualizandoProjecao}
              style={{ ...estilos.botaoPrimario, marginTop: 0, padding: "8px 16px", fontSize: 13, opacity: atualizandoProjecao ? 0.6 : 1 }}
              title="Recalcula a projeção da filial e salva um novo snapshot"
            >
              {atualizandoProjecao ? "Atualizando…" : "🔄 Atualizar projeção"}
            </button>
          )}
          <button
            onClick={exportarProjecaoPDF}
            disabled={exportandoPdf}
            style={{ ...estilos.botaoPrimario, marginTop: 0, padding: "8px 16px", fontSize: 13, background: "#fff", color: "#2563eb", border: "1px solid #2563eb", opacity: exportandoPdf ? 0.6 : 1 }}
            title="Exporta a Projeção do mês em PDF"
          >
            {exportandoPdf ? "Gerando…" : "⬇ Exportar PDF"}
          </button>
          {podeVerRelatorios(usuario?.email) && (
            <BoundaryLocal label="Relatórios">
              <CentralRelatorios
                email={usuario?.email}
                mes={mesReferencia}
                filialPayload={dashboard}
                operadoresPayloadPorEmail={operadoresPayloadPorEmail}
              />
            </BoundaryLocal>
          )}
        </div>
      </div>

      {/* Recuperado por mês (comparativo, no topo) */}
      {serieMeses && serieMeses.length > 0 && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: "14px 16px", margin: "4px 4px 12px", background: "#fff" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#0d1321", marginBottom: 10 }}>Recuperado por mês</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 120, borderBottom: "1px solid #eef1f5" }}>
            {(() => {
              const maxV = Math.max(1, ...serieMeses.map((s) => Number(s.recuperado) || 0));
              const ab = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
              return serieMeses.map((s, i) => {
                const v = Number(s.recuperado) || 0;
                const [an, me] = String(s.mes).split("-");
                return (
                  <div key={i} style={{ flex: "0 0 66px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }} title={moeda(v)}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#0d1321", marginBottom: 3 }}>{"R$ " + (v / 1000000).toFixed(2) + "M"}</div>
                    <div style={{ width: 36, background: "#2563eb", borderRadius: "4px 4px 0 0", height: Math.max((v / maxV) * 90, 3) }} />
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 5 }}>{(ab[Number(me)] || me) + "/" + an.slice(2)}</div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* Última atualização do snapshot (sem polling: só muda ao clicar Atualizar). */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "2px 4px 10px", fontSize: 12.5, color: "#64748b" }}>
        {snapshotMeta?.atualizado_em ? (
          <span>
            Última atualização:{" "}
            <strong style={{ color: "#0d1321" }}>
              {new Date(snapshotMeta.atualizado_em).toLocaleString("pt-BR")}
            </strong>
            {snapshotMeta?.atualizado_por ? ` · por ${snapshotMeta.atualizado_por}` : ""}
            {typeof snapshotMeta?.duracao_ms === "number" ? ` · ${snapshotMeta.duracao_ms} ms` : ""}
          </span>
        ) : (
          <span>Projeção ainda não foi gerada para {mesReferencia}.</span>
        )}
        {snapshotMeta?.status === "erro" && (
          <span style={{ color: "#b45309" }}>
            ⚠️ A última tentativa de atualização falhou — exibindo o snapshot anterior.
          </span>
        )}
      </div>

      <div style={estilos.abas}>
        <button style={aba === "DASHBOARD" ? estilos.abaAtiva : estilos.aba} onClick={() => setAba("DASHBOARD")}>
          📊 Dashboard
        </button>
        {snapshotMeta?.e_gestao && (
          <button style={aba === "ANO_VS_ANO" ? estilos.abaAtiva : estilos.aba} onClick={() => setAba("ANO_VS_ANO")}>
            📉 Ano vs Ano
          </button>
        )}
        {usuario?.podeGerir && (
          <button style={aba === "IMPORTAR" ? estilos.abaAtiva : estilos.aba} onClick={() => setAba("IMPORTAR")}>
            📥 Importar Planilha
          </button>
        )}
        <button style={aba === "HISTORICO" ? estilos.abaAtiva : estilos.aba} onClick={() => setAba("HISTORICO")}>
          🗂️ Histórico de Importações
        </button>
        {usuario?.podeGerir && (
          <button style={aba === "SUSPEITAS_DUPLICADOS" ? estilos.abaAtiva : estilos.aba} onClick={() => setAba("SUSPEITAS_DUPLICADOS")}>
            🔁 Suspeitas de pagamentos duplicados
          </button>
        )}
      </div>

      {erro && <p style={{ color: "#f87171" }}>{erro}</p>}

      {aba === "DASHBOARD" && (
        <>
          {carregandoDashboard ? (
            <p style={{ opacity: 0.7 }}>Carregando indicadores...</p>
          ) : (
            <>
              {/* Busca: "o aluno pagou este mês?". Operador vê só os próprios
                  pagamentos; gestão (Amanda/Fernanda) vê de todos. */}
              <div style={estilos.blocoRanking}>
                <h3 style={{ marginBottom: 4 }}>🔎 O aluno pagou este mês?</h3>
                <p style={{ opacity: 0.7, fontSize: 12.5, marginTop: 0, marginBottom: 10 }}>
                  {usuario?.podeGerir && !eAmandaAdm
                    ? "Pesquisa nos pagamentos de todos os operadores no mês selecionado."
                    : "Pesquisa nos SEUS pagamentos do mês selecionado."}
                </p>
                <form onSubmit={buscarPagamentoMes} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input
                    value={buscaTermo}
                    onChange={(e) => setBuscaTermo(e.target.value)}
                    placeholder="Nome do aluno ou CPF"
                    style={{ ...estilos.input, maxWidth: 320, marginBottom: 0 }}
                  />
                  <button type="submit" disabled={buscando} style={{ ...estilos.botaoPrimario, marginTop: 0 }}>
                    {buscando ? "Buscando..." : "Buscar"}
                  </button>
                  {buscaResultado && (
                    <button
                      type="button"
                      onClick={() => { setBuscaTermo(""); setBuscaResultado(null); }}
                      style={{ ...estilos.botaoPrimario, marginTop: 0, background: "#fff", color: "#475569", border: `1px solid ${PH_BORDA}` }}
                    >
                      Limpar
                    </button>
                  )}
                </form>
                <p style={{ opacity: 0.6, fontSize: 11.5, marginTop: 8 }}>
                  Aviso: a busca por CPF pode não encontrar pagamentos que ainda não estão vinculados ao cadastro do aluno. Em caso de dúvida, pesquise pelo nome.
                </p>
                {buscaResultado && (
                  <div style={{ marginTop: 12 }}>
                    {buscaResultado.aviso ? (
                      <p style={{ color: "#b45309", fontSize: 13 }}>{buscaResultado.aviso}</p>
                    ) : buscaResultado.total === 0 ? (
                      <p style={{ opacity: 0.8 }}>
                        Nenhum pagamento de <b>{buscaResultado.termo}</b> encontrado em {mesReferencia}.
                      </p>
                    ) : (
                      <>
                        <p style={{ fontSize: 13, marginBottom: 8 }}>
                          <b>{buscaResultado.total}</b> pagamento(s) encontrado(s) em {mesReferencia}
                          {buscaResultado.total > (buscaResultado.itens?.length || 0) ? ` (mostrando ${buscaResultado.itens.length})` : ""}.
                        </p>
                        <table style={estilos.tabela}>
                          <thead>
                            <tr>
                              <th style={estilos.th}>Data</th>
                              <th style={estilos.th}>Aluno</th>
                              {usuario?.podeGerir && !eAmandaAdm && <th style={estilos.th}>Operador</th>}
                              <th style={estilos.th}>Valor pago</th>
                              <th style={estilos.th}>Honorário</th>
                            </tr>
                          </thead>
                          <tbody>
                            {buscaResultado.itens.map((it, i) => (
                              <tr key={i} style={estilos.tr}>
                                <td style={estilos.td}>{it.data_pagamento}</td>
                                <td style={estilos.td}>{it.aluno_nome || "-"}</td>
                                {usuario?.podeGerir && !eAmandaAdm && <td style={estilos.td}>{it.operador || "-"}</td>}
                                <td style={estilos.td}>{moeda(it.valor_pago)}</td>
                                <td style={estilos.td}>{moeda(it.valor_honorario)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                )}
              </div>

              {vePainelGestao && (
                <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
                  {[
                    ["VISAO_GERAL", "📊 Visão Geral"],
                    ["POR_OPERADOR", "👤 Por Operador"],
                    ["EVOLUCAO", "📈 Evolução & Ranking"],
                    ["CONFIGURACOES", "🎯 Configurações"],
                  ].map(([chave, rotulo]) => (
                    <button
                      key={chave}
                      onClick={() => setSubAbaDashboard(chave)}
                      style={
                        subAbaDashboard === chave
                          ? { ...estilos.botaoPrimario, marginTop: 0, padding: "8px 16px", fontSize: 13 }
                          : { ...estilos.botaoPrimario, marginTop: 0, padding: "8px 16px", fontSize: 13, background: "#fff", color: "#475569", border: `1px solid ${PH_BORDA}` }
                      }
                    >
                      {rotulo}
                    </button>
                  ))}
                </div>
              )}

              {/* Bloco da filial (meta geral, % geral etc.) é informação
                  gerencial -- só aparece pra quem gerencia (Amanda/Fernanda).
                  Operador vê só o que é dele: honorário hoje/mês e a
                  projeção individual mais abaixo. */}
              {/* GESTÃO (Amanda/Fernanda): visão da FILIAL. */}
              {vePainelGestao && subAbaDashboard === "VISAO_GERAL" && (
                <>
                  <div style={estilos.hero}>
                    <div style={estilos.heroTopo}>
                      <span style={estilos.heroEyebrow}>HONORÁRIO DA REATIVA · {mesReferencia}</span>
                      <span style={estilos.heroBadge}>
                        {dashboard?.dias_uteis_restantes ?? 0} dias úteis restantes
                      </span>
                    </div>

                    <div style={estilos.heroNumeroLinha}>
                      <div>
                        <div style={estilos.heroNumero}>{moeda(dashboard?.honorario_mes_filial ?? dashboard?.recuperado_reativa_mes)}</div>
                        <div style={estilos.heroSubLabel}>Honorário realizado</div>
                      </div>
                      <div style={estilos.heroProjBloco}>
                        <div style={{ ...estilos.heroNumero, color: "#1d4ed8" }}>{moeda(dashboard?.projecao_honorario_filial)}</div>
                        <div style={{ ...estilos.heroSubLabel, color: "#1d4ed8" }}>
                          Projeção de fechamento · {dashboard?.percentual_projecao_filial ?? 0}% da meta
                        </div>
                      </div>
                      <div style={estilos.heroMeta}>
                        <span style={estilos.heroMetaLabel}>META</span>
                        <span style={estilos.heroMetaValor}>{moeda(dashboard?.meta_honorario)}</span>
                      </div>
                    </div>

                    <div style={estilos.heroBarraFundo}>
                      <div
                        style={{
                          ...estilos.heroBarraPreenchida,
                          width: `${Math.min(dashboard?.percentual_meta_filial ?? 0, 100)}%`,
                        }}
                      />
                    </div>

                    <div style={estilos.heroRodape}>
                      <span>
                        <strong>{dashboard?.percentual_meta_filial ?? 0}%</strong> da meta atingido
                      </span>
                      <span>
                        Projeção pelo ritmo atual · <strong>{dashboard?.dias_uteis_restantes ?? 0}</strong> dias úteis restantes
                      </span>
                    </div>
                  </div>

                  <div style={estilos.faixaStats}>
                    <FaixaItem label="Recuperado hoje" valor={moeda(dashboard?.recuperado_hoje_filial)} />
                    <FaixaItem label="Honorário hoje" valor={moeda(dashboard?.honorario_hoje)} />
                    <FaixaItem label="Falta p/ meta" valor={moeda(dashboard?.valor_restante_meta)} />
                    <FaixaItem label="Média diária necessária" valor={moeda(dashboard?.media_diaria_necessaria)} />
                    <FaixaItem label="Ritmo (dias úteis)" valor={`${dashboard?.dias_uteis_passados ?? 0} / ${dashboard?.dias_uteis_total_mes ?? 0}`} />
                  </div>
                </>
              )}

              {/* OPERADOR / AMANDA ADM: SOMENTE os próprios números — foco no
                  ACUMULADO DO MÊS (não o de hoje). Dados do snapshot individual.
                  Tudo null-safe; sem dados = mensagem clara. */}
              {veFilialSomente && !dashboard && (
                <div style={{ padding: "28px 20px", background: "#fff", border: `1px solid ${PH_BORDA}`, borderRadius: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 30, marginBottom: 8 }}>🕒</div>
                  <p style={{ fontSize: 15, fontWeight: 700, color: "#0d1321", margin: 0 }}>
                    Os dados ainda não foram atualizados pela gestão.
                  </p>
                  <p style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
                    Assim que a Amanda ou a Fernanda atualizarem, seus números aparecem aqui.
                  </p>
                </div>
              )}
              {/* AMANDA ADM (cobranca07): painel próprio — 8% sobre honorários,
                  sem meta/faixa (layout de ontem). Só os próprios valores. */}
              {veFilialSomente && dashboard && eAmandaAdm && (
                <>
                  <h3 style={{ margin: "0 0 12px" }}>💼 Meu painel (Amanda ADM)</h3>
                  <div style={estilos.grade}>
                    <Cartao label="Recuperado por mim no mês" valor={moeda(dashboard?.recuperado_mes_amanda_adm ?? dashboard?.acumulado_mes)} />
                    <Cartao label="Honorários no mês" valor={moeda(dashboard?.honorario_mes)} />
                    <Cartao
                      label="Minha comissão (8% sobre honorários)"
                      valor={moeda(dashboard?.comissao_amanda_adm ?? dashboard?.comissao_estimada_individual)}
                      destaque
                    />
                  </div>
                  <p style={{ opacity: 0.6, fontSize: 12.5, marginTop: 6 }}>
                    Sem meta e sem faixa — comissão fixa de 8% sobre o honorário que você mesma recuperou no mês.
                  </p>
                </>
              )}

              {/* OPERADOR: layout de ontem — HONORÁRIO no mês como métrica
                  principal, META (M4 sobre honorários), % da meta, faixa atual,
                  comissão; recuperado/acumulado e projeção como apoio. Só os
                  próprios valores, vindos do snapshot individual. */}
              {veFilialSomente && dashboard && !eAmandaAdm && (
                <PainelIndividual dados={dashboard} mes={mesReferencia} />
              )}

              {vePainelGestao && subAbaDashboard === "POR_OPERADOR" && (
                <div style={estilos.blocoMeta}>
                  <h3 style={{ marginBottom: 4 }}>🏆 Projeção de fechamento — todos os operadores</h3>
                  <p style={{ opacity: 0.6, fontSize: 12.5, margin: "0 0 12px" }}>
                    Total da empresa, com cada operador lado a lado. Estimativa com base no ritmo atual de cada um.
                  </p>

                  {carregandoTodos ? (
                    <p style={{ opacity: 0.7 }}>Carregando...</p>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={estilos.tabela}>
                        <thead>
                          <tr>
                            <th style={estilos.th}>Operador</th>
                            <th style={estilos.th}>Honorário no mês</th>
                            <th style={estilos.th}>Projeção de fechamento</th>
                            <th style={estilos.th}>% da meta (projetado)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(projecaoTodos?.operadores || []).map((op) => (
                            <tr key={op.operador_email} style={estilos.tr}>
                              <td style={{ ...estilos.td, fontWeight: 700 }}>{op.operador_nome || op.operador_email}</td>
                              <td style={estilos.td}>{moeda(op.honorario_mes)}</td>
                              <td style={{ ...estilos.td, fontWeight: 700 }}>{moeda(op.projecao)}</td>
                              <td
                                style={{
                                  ...estilos.td,
                                  color: (op.percentual_projecao ?? 0) >= 100 ? "#1e40af" : "#d97706",
                                  fontWeight: 700,
                                }}
                              >
                                {op.percentual_projecao ?? 0}%
                              </td>
                            </tr>
                          ))}
                          <tr style={{ borderTop: `2px solid ${PH_BORDA}` }}>
                            <td style={{ ...estilos.td, fontWeight: 800 }}>TOTAL EMPRESA</td>
                            <td style={{ ...estilos.td, fontWeight: 800 }}>
                              {moeda((projecaoTodos?.operadores || []).reduce((s, o) => s + Number(o.honorario_mes || 0), 0))}
                            </td>
                            <td style={{ ...estilos.td, fontWeight: 800 }}>
                              {moeda((projecaoTodos?.operadores || []).reduce((s, o) => s + Number(o.projecao || 0), 0))}
                            </td>
                            <td style={estilos.td}></td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {vePainelGestao && subAbaDashboard === "POR_OPERADOR" && (
                <div style={estilos.blocoMeta}>
                  <h3 style={{ marginBottom: 10 }}>👤 Ver detalhes de um operador específico</h3>
                  <select
                    value={operadorSelecionado}
                    onChange={(e) => setOperadorSelecionado(e.target.value)}
                    style={{ ...estilos.input, maxWidth: 260 }}
                  >
                    <option value="">Selecione...</option>
                    {EQUIPE_9.map(({ email, nome }) => (
                      <option key={email} value={email}>{nome}</option>
                    ))}
                  </select>
                  {!operadorSelecionado && (
                    <p style={{ opacity: 0.6, fontSize: 12.5, marginTop: 10 }}>
                      Escolha um dos 9 acima pra ver a meta, projeção e premiação detalhada dele.
                    </p>
                  )}
                  {semOperador && (
                    <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, background: "#fff7e6", border: "1px solid #fde3b3", fontSize: 12.5, color: "#b45309" }}>
                      ⚠️ <strong>Sem operador</strong> (indicador de gestão, fora do ranking/premiação):{" "}
                      {moeda(semOperador?.acumulado_mes)} recuperado · {moeda(semOperador?.honorario_mes)} honorário no mês.
                    </div>
                  )}
                </div>
              )}

              {/* Painel pessoal da Amanda ADM (recuperado/comissão individual)
                  depende de dados que NÃO estão no snapshot da filial e segue sob
                  o kill switch. Nesta release ela visualiza o snapshot filial,
                  como os operadores — bloco pessoal removido intencionalmente. */}

              {vePainelGestao && subAbaDashboard === "POR_OPERADOR" && operadorSelecionado && (
                payloadFoco ? (
                <>
                  <h3 style={{ margin: "0 0 14px" }}>
                    Números de {OPERADORES_POR_EMAIL[operadorSelecionado] || operadorSelecionado}
                  </h3>
                  <PainelIndividual dados={payloadFoco} mes={mesReferencia} />
                </>
                ) : (
                  <p style={{ opacity: 0.7 }}>Sem snapshot para este operador nesta competência.</p>
                )
              )}

              {vePainelGestao && subAbaDashboard === "CONFIGURACOES" && (
                <div style={estilos.blocoMeta}>
                  <h3 style={{ marginBottom: 4 }}>🎯 Configuração de metas da competência ({mesReferencia})</h3>
                  <p style={{ opacity: 0.65, fontSize: 12, marginBottom: 14 }}>
                    Cadastrada pelo Gerente/Supervisor. É usada automaticamente no Dashboard, Hora a Hora,
                    Projeção e Card de Desempenho do Operador — sem precisar mexer em código.
                    <br />
                    Representa apenas a <strong>meta operacional da equipe</strong> (M1–M4 são faixas dessa meta).
                    Não é usada no cálculo da comissão individual do operador — essa regra continua separada.
                  </p>

                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
                    <Campo label="Meta Operacional (R$)">
                      <input
                        type="number"
                        value={formMeta.meta_operacional}
                        onChange={(e) => setFormMeta((f) => ({ ...f, meta_operacional: e.target.value }))}
                        style={estilos.input}
                      />
                    </Campo>
                    <Campo label="Meta prevista das Unidades (R$)">
                      <input
                        type="number"
                        value={formMeta.meta_unidades}
                        onChange={(e) => setFormMeta((f) => ({ ...f, meta_unidades: e.target.value }))}
                        style={estilos.input}
                      />
                    </Campo>
                    <Campo label="Meta de honorário (R$)">
                      <input
                        type="number"
                        value={formMeta.meta_honorario}
                        onChange={(e) => setFormMeta((f) => ({ ...f, meta_honorario: e.target.value }))}
                        style={estilos.input}
                      />
                    </Campo>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
                    {["m1", "m2", "m3", "m4"].map((marco, i) => (
                      <div key={marco} style={estilos.cartaoMarco}>
                        <div style={{ fontWeight: 700, marginBottom: 8 }}>{`M${i + 1}`}</div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <Campo label="Valor (R$)">
                            <input
                              type="number"
                              value={formMeta[`${marco}_valor`]}
                              onChange={(e) =>
                                setFormMeta((f) => ({ ...f, [`${marco}_valor`]: e.target.value }))
                              }
                              style={{ ...estilos.input, width: 110 }}
                            />
                          </Campo>
                          <Campo label="%">
                            <input
                              type="number"
                              value={formMeta[`${marco}_percentual`]}
                              onChange={(e) =>
                                setFormMeta((f) => ({ ...f, [`${marco}_percentual`]: e.target.value }))
                              }
                              style={{ ...estilos.input, width: 80 }}
                            />
                          </Campo>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button style={estilos.botaoPrimario} onClick={salvarMeta} disabled={salvandoMeta}>
                    {salvandoMeta ? "Salvando..." : "Salvar configuração de metas"}
                  </button>
                </div>
              )}

              {(!vePainelGestao || subAbaDashboard === "EVOLUCAO" || (vePainelGestao && subAbaDashboard === "POR_OPERADOR" && operadorSelecionado)) && (
              <div style={estilos.blocoGrafico}>
                <h3 style={{ marginBottom: 4 }}>
                  📈 Evolução do mês
                  {emailFoco ? ` · ${OPERADORES_POR_EMAIL[emailFoco] || emailFoco}` : " · Total da Empresa"}
                </h3>
                <BoundaryLocal label="Gráfico de evolução">
                  <GraficoEvolucaoProjecao
                    historico={emailFoco ? historicoFoco : historicoDia}
                    clicavel={true}
                    onClickDia={abrirDiaSelecionado}
                  />
                </BoundaryLocal>
                <p style={{ opacity: 0.6, fontSize: 12, marginTop: 6 }}>
                  💡 Clique em um dia do gráfico para ver os pagamentos daquele dia aqui embaixo.
                </p>
                {/* Pagamentos do dia clicado — inline (sem pop-up). Gestão vê
                    todos os operadores + Sem Operador e pode reatribuir qualquer caso. */}
                {diaSelecionado && (
                  <div style={{ marginTop: 14, borderTop: `1px solid ${PH_BORDA}`, paddingTop: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                      <h4 style={{ margin: 0 }}>🧾 Pagamentos de {diaSelecionado.split("-").reverse().join("/")}</h4>
                      <button
                        type="button"
                        onClick={() => { setDiaSelecionado(null); setPagamentosDoDia([]); }}
                        style={{ ...estilos.botaoPrimario, marginTop: 0, padding: "6px 12px", fontSize: 12, background: "#fff", color: "#475569", border: `1px solid ${PH_BORDA}` }}
                      >
                        Fechar
                      </button>
                    </div>
                    {carregandoPagamentosDia ? (
                      <p style={{ opacity: 0.7 }}>Carregando pagamentos do dia...</p>
                    ) : pagamentosDoDia.length === 0 ? (
                      <p style={{ opacity: 0.7 }}>Nenhum pagamento neste dia.</p>
                    ) : (
                      <table style={estilos.tabela}>
                        <thead>
                          <tr>
                            <th style={estilos.th}>Aluno</th>
                            {usuario?.podeGerir && <th style={estilos.th}>Operador</th>}
                            <th style={estilos.th}>Valor pago</th>
                            <th style={estilos.th}>Honorário</th>
                            {usuario?.podeGerir && <th style={estilos.th}>Ação</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {pagamentosDoDia.map((p) => (
                            <tr key={p.id} style={estilos.tr}>
                              <td style={estilos.td}>{p.aluno_nome || "-"}</td>
                              {usuario?.podeGerir && (
                                <td style={estilos.td}>{p.operador_nome || p.operador_email || "⚠️ SEM OPERADOR"}</td>
                              )}
                              <td style={estilos.td}>{moeda(p.valor_pago)}</td>
                              <td style={estilos.td}>{moeda(p.valor_honorario)}</td>
                              {usuario?.podeGerir && (
                                <td style={estilos.td}>
                                  <button style={estilos.botaoLink} onClick={() => alterarOperador(p.id, p.operador_email)}>
                                    Alterar operador
                                  </button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {usuario?.podeGerir && (
                      <p style={{ opacity: 0.6, fontSize: 12, marginTop: 8 }}>
                        Toda troca de operador fica registrada em auditoria (quem alterou, de/para e motivo).
                      </p>
                    )}
                  </div>
                )}
              </div>
              )}

              {vePainelGestao && subAbaDashboard === "EVOLUCAO" && (
                <>
                  <BoundaryLocal label="Painel de análise">
                    <PainelAnaliseEvolucao dados={dashboard} mes={mesReferencia} />
                  </BoundaryLocal>

                  <div style={estilos.blocoRanking}>
                    <h3 style={{ marginBottom: 10 }}>
                      {usuario?.podeGerir ? "🏆 Ranking da equipe (mês)" : "🏆 Meu desempenho (mês)"}
                    </h3>
                    {usuario?.podeGerir ? (
                      ranking.length === 0 ? (
                        <p style={{ opacity: 0.7 }}>Sem dados no período.</p>
                      ) : (
                        <table style={estilos.tabela}>
                          <thead>
                            <tr>
                              <th style={estilos.th}>#</th>
                              <th style={estilos.th}>Operador</th>
                              <th style={estilos.th}>Recuperado</th>
                              <th style={estilos.th}>Honorário</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ranking.map((r, i) => (
                              <tr key={r.operador_email} style={estilos.tr}>
                                <td style={estilos.td}>{i + 1}º</td>
                                <td style={{ ...estilos.td, fontWeight: 700 }}>{r.operador_nome || r.operador_email}</td>
                                <td style={estilos.td}>{moeda(r.valor_recuperado)}</td>
                                <td style={estilos.td}>{moeda(r.valor_honorario)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )
                    ) : (
                      // Cada operador ve so o proprio desempenho -- ranking
                      // com nome/valor dos colegas fica so pra gestao.
                      <div style={estilos.grade}>
                        <Cartao label="Recuperado no mês" valor={moeda(dashboard?.acumulado_mes)} />
                        <Cartao label="Honorário no mês" valor={moeda(dashboard?.honorario_mes)} destaque />
                      </div>
                    )}
                  </div>

                  <div style={estilos.blocoRanking}>
                    <h3 style={{ marginBottom: 10 }}>
                      {usuario?.podeGerir ? "🧾 Lançamentos de hoje" : "🧾 Meus lançamentos de hoje"}
                    </h3>
                    {lancamentosHoje.length === 0 ? (
                      <p style={{ opacity: 0.7 }}>Nenhum pagamento lançado hoje ainda.</p>
                    ) : (
                      <table style={estilos.tabela}>
                        <thead>
                          <tr>
                            <th style={estilos.th}>Aluno</th>
                            {usuario?.podeGerir && <th style={estilos.th}>Operador</th>}
                            <th style={estilos.th}>Valor pago</th>
                            <th style={estilos.th}>Honorário</th>
                            {usuario?.podeGerir && <th style={estilos.th}>Ação</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {lancamentosHoje.map((l) => (
                            <tr key={l.id} style={estilos.tr}>
                              <td style={estilos.td}>{l.aluno_nome || "-"}</td>
                              {usuario?.podeGerir && (
                                <td style={estilos.td}>{l.operador_nome || l.operador_email || "-"}</td>
                              )}
                              <td style={estilos.td}>{moeda(l.valor_pago)}</td>
                              <td style={estilos.td}>{moeda(l.valor_honorario)}</td>
                              {usuario?.podeGerir && (
                                <td style={estilos.td}>
                                  <button style={estilos.botaoLink} onClick={() => alterarOperador(l.id, l.operador_email)}>
                                    Alterar operador
                                  </button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {usuario?.podeGerir && (
                      <p style={{ opacity: 0.6, fontSize: 12, marginTop: 8 }}>
                        Toda troca de operador responsável fica registrada em auditoria (quem alterou, de/para e motivo).
                      </p>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {aba === "ANO_VS_ANO" && snapshotMeta?.e_gestao && (
        <BoundaryLocal label="Comparativo ano vs ano">
          <ComparativoAnoAno />
        </BoundaryLocal>
      )}

      {aba === "IMPORTAR" && usuario?.podeGerir && (
        <div style={estilos.blocoImportar}>
          {substituindoImportacaoId && (
            <div style={{ ...estilos.avisoSubstituicao }}>
              🔁 Modo substituição: o arquivo selecionado vai substituir uma importação existente.
              <button
                style={{ ...estilos.botaoLink, marginLeft: 10 }}
                onClick={() => {
                  setSubstituindoImportacaoId(null);
                  setMensagemImportacao("");
                }}
              >
                cancelar substituição
              </button>
            </div>
          )}
          <p style={{ opacity: 0.8, marginBottom: 12 }}>
            Selecione o arquivo com os pagamentos do dia. Colunas esperadas: Data, Aluno, CPF, Operador,
            Valor Pago, Honorário, Tipo. O sistema tenta reconhecer variações comuns dos nomes das colunas.
            <br />
            Você pode importar quantos arquivos precisar na mesma competência — os valores de todas as
            importações válidas são somados automaticamente na Projeção e no Hora a Hora.
          </p>
          <input type="file" accept=".xls,.xlsx" onChange={selecionarArquivo} />

          <label style={estilos.checkboxRetroativo}>
            <input
              type="checkbox"
              checked={ehRetroativo}
              onChange={(e) => setEhRetroativo(e.target.checked)}
            />
            Lançamento retroativo (mês fechado / catch-up) — entra só na visão macro do mês,
            não afeta comissão nem ranking operacional
          </label>

          {linhasPreview.length > 0 && (
            <>
              <p style={{ marginTop: 16, marginBottom: 8 }}>
                <strong>{linhasPreview.length}</strong> linhas encontradas. Confira a prévia antes de confirmar:
              </p>

              {linhasSuspeitas.length > 0 && (
                <div style={estilos.avisoSubstituicao} className="linhas-suspeitas-aviso">
                  ⚠️ <strong>{linhasSuspeitas.length} linha(s) suspeita(s)</strong>: valor pago veio zerado, mas o
                  honorário veio preenchido — provavelmente a célula de valor pago veio vazia na planilha
                  original pra essas linhas. Confira o arquivo antes de confirmar (marcadas em vermelho abaixo).
                </div>
              )}

              <div style={{ overflowX: "auto", maxHeight: 300 }}>
                <table style={estilos.tabela}>
                  <thead>
                    <tr>
                      <th style={estilos.th}>Data</th>
                      <th style={estilos.th}>Aluno</th>
                      <th style={estilos.th}>Operador</th>
                      <th style={estilos.th}>Valor Pago</th>
                      <th style={estilos.th}>Honorário</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhasParaMostrar.map((l, i) => {
                      const suspeita = Number(l.valor_pago) === 0 && Number(l.valor_honorario) > 0;
                      return (
                        <tr
                          key={i}
                          style={{
                            ...estilos.tr,
                            background: suspeita ? "#fef2f2" : undefined,
                          }}
                        >
                          <td style={estilos.td}>{l.data_pagamento || "⚠️ sem data"}</td>
                          <td style={estilos.td}>{l.aluno_nome || "-"}</td>
                          <td style={estilos.td}>
                            {l.operador_email ? (
                              l.operador_nome
                            ) : l.operador_nome ? (
                              <span style={{ color: "#fcd34d" }} title="Nome não bate com nenhum operador cadastrado no sistema">
                                ⚠️ {l.operador_nome} (fora da equipe)
                              </span>
                            ) : (
                              <span style={{ color: "#fcd34d" }}>⚠️ sem operador</span>
                            )}
                          </td>
                          <td style={{ ...estilos.td, color: suspeita ? "#b91c1c" : undefined, fontWeight: suspeita ? "bold" : undefined }}>
                            {suspeita ? "⚠️ " : ""}{moeda(l.valor_pago)}
                          </td>
                          <td style={estilos.td}>{moeda(l.valor_honorario)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {linhasPreview.length > linhasParaMostrar.length && (
                  <p style={{ opacity: 0.6, fontSize: 12, marginTop: 6 }}>
                    Mostrando {linhasParaMostrar.length} de {linhasPreview.length} linhas
                    {linhasSuspeitas.length > 0 ? " (todas as suspeitas estão incluídas acima)." : "."}
                  </p>
                )}
              </div>
              <button style={estilos.botaoPrimario} onClick={confirmarImportacao} disabled={importando}>
                {importando ? "Importando..." : "Confirmar importação"}
              </button>
            </>
          )}
          {mensagemImportacao && <p style={{ marginTop: 12 }}>{mensagemImportacao}</p>}
        </div>
      )}

      {aba === "HISTORICO" && (
        <div>
          <div style={{ overflowX: "auto" }}>
            <table style={estilos.tabela}>
              <thead>
                <tr>
                  <th style={estilos.th}>Arquivo</th>
                  <th style={estilos.th}>Competência</th>
                  <th style={estilos.th}>Dia de pagamento</th>
                  <th style={estilos.th}>Tipo</th>
                  <th style={estilos.th}>Usuário</th>
                  <th style={estilos.th}>Importado em</th>
                  <th style={estilos.th}>Registros</th>
                  <th style={estilos.th}>Status</th>
                  {usuario?.podeGerir && <th style={estilos.th}>Ações</th>}
                </tr>
              </thead>
              <tbody>
                {historicoImportacoes.length === 0 ? (
                  <tr>
                    <td style={estilos.td} colSpan={usuario?.podeGerir ? 9 : 8}>
                      Nenhuma importação registrada ainda.
                    </td>
                  </tr>
                ) : (
                  historicoImportacoes.map((imp) => (
                    <tr key={imp.id} style={estilos.tr}>
                      <td style={estilos.td}>{imp.arquivo_nome}</td>
                      <td style={estilos.td}>{imp.mes_referencia || "-"}</td>
                      <td style={estilos.td}>{imp.dia_pagamento ? formatarDataCurta(imp.dia_pagamento) : "-"}</td>
                      <td style={estilos.td}>
                        {imp.retroativo ? (
                          <span style={estilos.tagAmarela}>Retroativo</span>
                        ) : (
                          <span style={estilos.tagVerde}>Operacional</span>
                        )}
                      </td>
                      <td style={estilos.td}>{imp.usuario}</td>
                      <td style={estilos.td}>{new Date(imp.created_at).toLocaleString("pt-BR")}</td>
                      <td style={estilos.td}>{imp.qtd_registros}</td>
                      <td style={estilos.td}>
                        <span
                          style={
                            imp.status === "CONCLUIDO"
                              ? estilos.tagVerde
                              : imp.status === "EXCLUIDA"
                              ? estilos.tagVermelha
                              : estilos.tagAmarela
                          }
                          title={
                            imp.status === "SUBSTITUIDA"
                              ? `Substituída por ${imp.substituido_por || "-"} em ${imp.substituido_em ? new Date(imp.substituido_em).toLocaleString("pt-BR") : "-"}`
                              : imp.status === "EXCLUIDA"
                              ? `Excluída por ${imp.excluido_por || "-"} em ${imp.excluido_em ? new Date(imp.excluido_em).toLocaleString("pt-BR") : "-"} — ${imp.motivo_exclusao || ""}`
                              : undefined
                          }
                        >
                          {imp.status}
                        </span>
                      </td>
                      {usuario?.podeGerir && (
                        <td style={estilos.td}>
                          {imp.status === "CONCLUIDO" ? (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button
                                style={estilos.botaoLink}
                                onClick={() => iniciarSubstituicaoImportacao(imp)}
                                disabled={processandoAcaoId === imp.id}
                              >
                                Substituir
                              </button>
                              <button
                                style={estilos.botaoLink}
                                onClick={() => reprocessarImportacao(imp.id)}
                                disabled={processandoAcaoId === imp.id}
                              >
                                Reprocessar
                              </button>
                              <button
                                style={{ ...estilos.botaoLink, color: "#f87171" }}
                                onClick={() => excluirImportacao(imp.id)}
                                disabled={processandoAcaoId === imp.id}
                              >
                                Excluir
                              </button>
                            </div>
                          ) : (
                            <span style={{ opacity: 0.5, fontSize: 12 }}>—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {usuario?.podeGerir && (
            <div style={{ marginTop: 28 }}>
              <h3 style={{ marginBottom: 4 }}>🕵️ Auditoria de ações</h3>
              <p style={{ opacity: 0.6, fontSize: 12, marginBottom: 10 }}>
                Importações, substituições, exclusões, reprocessamentos, trocas de operador e configuração de metas.
              </p>
              <div style={{ overflowX: "auto" }}>
                <table style={estilos.tabela}>
                  <thead>
                    <tr>
                      <th style={estilos.th}>Ação</th>
                      <th style={estilos.th}>Usuário</th>
                      <th style={estilos.th}>Detalhes</th>
                      <th style={estilos.th}>Data/hora</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditoriaAcoes.length === 0 ? (
                      <tr>
                        <td style={estilos.td} colSpan={4}>
                          Nenhuma ação registrada ainda.
                        </td>
                      </tr>
                    ) : (
                      auditoriaAcoes.map((a) => (
                        <tr key={a.id} style={estilos.tr}>
                          <td style={estilos.td}>{a.acao}</td>
                          <td style={estilos.td}>{a.usuario}</td>
                          <td style={estilos.td}>
                            <span style={{ fontSize: 12, opacity: 0.8 }}>
                              {Object.entries(a.detalhes || {})
                                .filter(([, v]) => v !== null && v !== undefined && v !== "")
                                .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
                                .join(" · ")}
                            </span>
                          </td>
                          <td style={estilos.td}>{new Date(a.created_at).toLocaleString("pt-BR")}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {aba === "SUSPEITAS_DUPLICADOS" && usuario?.podeGerir && (
        <SuspeitasPagamentosDuplicados />
      )}

    </div>
  );
}

function FaixaItem({ label, valor }) {
  return (
    <div style={estilos.faixaItem}>
      <div style={estilos.faixaValor}>{valor}</div>
      <div style={estilos.faixaLabel}>{label}</div>
    </div>
  );
}

// Visão individual (mesma para operador e para a gestão ao selecionar um dos 9):
// honorário como destaque, meta M4, progresso, faixa, premiação, próxima faixa
// e "quanto falta"; recuperado e resultado do dia como apoio.
function PainelIndividual({ dados, mes }) {
  const pctMeta = Math.min(Number(dados?.percentual_meta_individual_realizado ?? 0), 100);
  const temProxima = Number(dados?.proxima_faixa_valor || 0) > 0;
  const honMes = Number(dados?.honorario_mes || 0);
  const cfg = dados?.config_metas || {};
  const escadaMetas = ["m1", "m2", "m3", "m4"]
    .map((k) => ({ marco: k.toUpperCase(), valor: Number(cfg[`${k}_valor`] || 0), percentual: Number(cfg[`${k}_percentual`] || 0) }))
    .filter((m) => m.valor > 0);
  return (
    <>
      <div style={estilos.hero}>
        <div style={estilos.heroTopo}>
          <span style={estilos.heroEyebrow}>HONORÁRIO NO MÊS · {mes}</span>
          <span style={estilos.heroBadge}>Faixa atual: {dados?.faixa_atual || "-"}</span>
        </div>
        <div style={estilos.heroNumeroLinha}>
          <div style={estilos.heroNumero}>{moeda(dados?.honorario_mes)}</div>
          <div style={estilos.heroMeta}>
            <span style={estilos.heroMetaLabel}>META (M4)</span>
            <span style={estilos.heroMetaValor}>{moeda(dados?.meta_honorario_individual)}</span>
          </div>
        </div>
        <div style={estilos.heroBarraFundo}>
          <div style={{ ...estilos.heroBarraPreenchida, width: `${pctMeta}%` }} />
        </div>
        <div style={estilos.heroRodape}>
          <span>
            <strong>{dados?.percentual_meta_individual_realizado ?? 0}%</strong> da meta ·{" "}
            {temProxima
              ? <>faltam <strong>{moeda(dados?.falta_proxima_faixa)}</strong> p/ a próxima faixa ({moeda(dados?.proxima_faixa_valor)})</>
              : <strong>faixa máxima atingida</strong>}
          </span>
          <span>
            No ritmo atual, fecha em <strong>{moeda(dados?.projecao_honorario_individual)}</strong>{" "}
            ({dados?.percentual_projecao_individual ?? 0}% da meta)
          </span>
        </div>
      </div>

      {/* Escada de metas individuais (M1→M4): o operador precisa enxergar TODAS
          as faixas, não só a M4. Vem de config_metas do snapshot. */}
      {escadaMetas.length > 0 && (
        <div style={{ ...estilos.hero, padding: "18px 24px" }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.12em", color: PH_VERDE, marginBottom: 10 }}>
            MINHAS METAS · FAIXAS DE PREMIAÇÃO
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            {escadaMetas.map((m) => {
              const atingida = honMes >= m.valor;
              return (
                <div
                  key={m.marco}
                  style={{
                    border: `1px solid ${atingida ? "#bdeed4" : PH_BORDA}`,
                    background: atingida ? "#ecfdf5" : "#f8fafc",
                    borderRadius: 12,
                    padding: "10px 12px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 700, color: atingida ? PH_VERDE : "#64748b" }}>
                    <span>{m.marco}</span>
                    <span>{atingida ? "✅ atingida" : `faltam ${moeda(m.valor - honMes)}`}</span>
                  </div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#0d1321", marginTop: 4 }}>{moeda(m.valor)}</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>premiação {m.percentual}% do honorário</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={estilos.faixaStats}>
        <FaixaItem label="Recuperado hoje" valor={moeda(dados?.recuperado_hoje)} />
        <FaixaItem label="Honorários hoje" valor={moeda(dados?.honorario_hoje)} />
        <FaixaItem label="Pagamentos hoje" valor={`${dados?.qtd_pagamentos_hoje ?? 0}`} />
        <FaixaItem label="Premiação estimada" valor={moeda(dados?.comissao_estimada_individual)} />
        <FaixaItem label="Falta p/ próxima faixa" valor={temProxima ? moeda(dados?.falta_proxima_faixa) : "—"} />
      </div>

      <p style={{ opacity: 0.6, fontSize: 12.5, marginTop: 2, marginBottom: 22 }}>
        Premiação calculada sobre o <strong>honorário do mês</strong> pela faixa vigente. Recuperado é
        informação complementar. Projeção é estimativa pelo ritmo de honorário por dia útil.
      </p>
    </>
  );
}

function Cartao({ label, valor, destaque, cor }) {
  return (
    <div style={{ ...estilos.cartao, ...(destaque ? estilos.cartaoDestaque : {}) }}>
      <div style={{ ...estilos.numero, color: cor }}>{valor}</div>
      <div style={estilos.label}>{label}</div>
    </div>
  );
}

function Campo({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const PH_BORDA = "#e3e7ee";
const PH_BORDA_SUAVE = "#edf0f5";
const PH_SOMBRA = "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)";
const PH_FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const PH_VERDE = "#2563eb";

const estilos = {
  hero: {
    background: "#fff",
    border: `1px solid ${PH_BORDA_SUAVE}`,
    borderRadius: 22,
    padding: "28px 32px",
    marginBottom: 16,
    color: "#0d1321",
    boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
  },
  heroTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  heroEyebrow: { fontSize: 11.5, fontWeight: 800, letterSpacing: "0.12em", color: PH_VERDE },
  heroBadge: {
    fontSize: 11.5,
    fontWeight: 700,
    color: PH_VERDE,
    background: "#ecfdf5",
    border: "1px solid #bdeed4",
    borderRadius: 999,
    padding: "4px 12px",
  },
  heroNumeroLinha: { display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap", marginBottom: 16 },
  heroNumero: {
    fontFamily: PH_FONTE_TITULO,
    fontSize: "clamp(34px, 4vw, 48px)",
    fontWeight: 800,
    letterSpacing: "-0.02em",
    color: "#0d1321",
  },
  heroSubLabel: { fontSize: 12, fontWeight: 600, color: "#8a93a3", marginTop: 4 },
  heroProjBloco: {
    paddingLeft: 18,
    borderLeft: `2px solid #bfdbfe`,
  },
  heroMeta: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    paddingLeft: 18,
    borderLeft: `1px solid ${PH_BORDA}`,
  },
  heroMetaLabel: { fontSize: 10.5, fontWeight: 800, letterSpacing: "0.1em", color: PH_VERDE },
  heroMetaValor: { fontFamily: PH_FONTE_TITULO, fontSize: 22, fontWeight: 800, color: "#0d1321" },
  heroBarraFundo: { height: 8, borderRadius: 999, background: "#eef1f5", overflow: "hidden", marginBottom: 14 },
  heroBarraPreenchida: { height: "100%", borderRadius: 999, background: `linear-gradient(90deg, ${PH_VERDE}, #60a5fa)`, transition: "width 0.4s ease" },
  heroRodape: { display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, fontSize: 13, color: "#64748b" },
  faixaStats: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
    gap: 1,
    background: PH_BORDA_SUAVE,
    borderRadius: 16,
    overflow: "hidden",
    marginBottom: 22,
    border: `1px solid ${PH_BORDA_SUAVE}`,
  },
  faixaItem: { background: "#fff", padding: "16px 18px" },
  faixaValor: { fontFamily: PH_FONTE_TITULO, fontSize: 19, fontWeight: 800, color: "#0d1321", marginBottom: 3 },
  faixaLabel: { fontSize: 11.5, color: "#8a93a3", fontWeight: 600 },

  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 4 },
  inputMes: {
    padding: "9px 13px",
    borderRadius: 10,
    border: `1px solid ${PH_BORDA}`,
    background: "#fff",
    color: "#344054",
    fontSize: 13,
    boxShadow: PH_SOMBRA,
  },
  abas: { display: "flex", gap: 8, margin: "20px 0 24px", flexWrap: "wrap" },
  aba: {
    padding: "10px 18px",
    borderRadius: 10,
    border: `1px solid ${PH_BORDA}`,
    background: "#fff",
    color: "#475569",
    cursor: "pointer",
    fontSize: 13.5,
    fontWeight: 700,
    boxShadow: "0 1px 2px rgba(16,24,40,0.04)",
  },
  abaAtiva: {
    padding: "10px 18px",
    borderRadius: 10,
    border: `1px solid ${PH_VERDE}`,
    background: PH_VERDE,
    color: "#fff",
    cursor: "pointer",
    fontSize: 13.5,
    fontWeight: 800,
    boxShadow: "0 4px 14px rgba(15,157,107,0.35)",
  },
  blocoFilial: {
    padding: "18px 20px",
    borderRadius: 16,
    background: "linear-gradient(135deg, #eafaf1 0%, #ffffff 100%)",
    border: "1px solid #c7d7fe",
    marginBottom: 22,
    boxShadow: PH_SOMBRA,
  },
  gradeFilial: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 14,
  },
  cartaoFilial: { padding: "14px 16px", borderRadius: 12, background: "#fff", border: "1px solid #d7f3e3" },
  numeroFilial: { fontSize: 21, fontWeight: 800, color: "#0d1321", fontFamily: PH_FONTE_TITULO },
  grade: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 14,
    marginBottom: 22,
  },
  cartao: { padding: "16px 18px", borderRadius: 14, background: "#fff", border: `1px solid ${PH_BORDA_SUAVE}`, boxShadow: PH_SOMBRA },
  cartaoDestaque: { background: "#eef6ff", border: "1px solid #cfe6ff" },
  numero: { fontSize: 23, fontWeight: 800, color: "#0d1321", fontFamily: PH_FONTE_TITULO },
  label: { fontSize: 11.5, color: "#8a93a3", fontWeight: 600, marginTop: 5 },
  blocoMeta: { padding: "18px 20px", borderRadius: 16, background: "#fff", border: `1px solid ${PH_BORDA_SUAVE}`, marginBottom: 22, boxShadow: PH_SOMBRA },
  cartaoMarco: {
    padding: 14,
    borderRadius: 12,
    background: "#f8fafc",
    border: `1px solid ${PH_BORDA_SUAVE}`,
  },
  blocoGrafico: { padding: "18px 20px", borderRadius: 16, background: "#fff", border: `1px solid ${PH_BORDA_SUAVE}`, marginBottom: 22, boxShadow: PH_SOMBRA },
  blocoPagamentosDia: { marginTop: 16, paddingTop: 16, borderTop: `1px solid ${PH_BORDA_SUAVE}` },
  blocoRanking: { padding: "18px 20px", borderRadius: 16, background: "#fff", border: `1px solid ${PH_BORDA_SUAVE}`, marginBottom: 22, boxShadow: PH_SOMBRA },
  blocoImportar: { padding: "18px 20px", borderRadius: 16, background: "#fff", border: `1px solid ${PH_BORDA_SUAVE}`, boxShadow: PH_SOMBRA },
  checkboxRetroativo: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "#475569",
    marginTop: 14,
    maxWidth: 520,
  },
  barras: { display: "flex", gap: 10, alignItems: "flex-end", height: 170, overflowX: "auto", padding: "0 4px" },
  colunaBarra: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 28 },
  barra: { width: 20, background: `linear-gradient(180deg, ${PH_VERDE}, #1e3a8a)`, borderRadius: "6px 6px 0 0" },
  legendaBarra: { fontSize: 10, color: "#98a2b3" },
  input: {
    padding: "9px 12px",
    borderRadius: 10,
    border: `1px solid ${PH_BORDA}`,
    background: "#fff",
    color: "#344054",
    width: 160,
    fontSize: 13,
  },
  botaoPrimario: {
    padding: "11px 20px",
    borderRadius: 10,
    border: "none",
    background: PH_VERDE,
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
    marginTop: 12,
    fontSize: 13.5,
  },
  botaoLink: {
    background: "transparent",
    border: "none",
    color: PH_VERDE,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    textDecoration: "underline",
  },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "10px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: `1px solid ${PH_BORDA}` },
  td: { padding: "11px 12px", borderBottom: `1px solid ${PH_BORDA_SUAVE}`, color: "#475569" },
  tr: {},
  tagVerde: { background: "#e9f9f1", color: "#0f7a4f", fontSize: 11.5, fontWeight: 700, padding: "3px 11px", borderRadius: 999 },
  tagAmarela: { background: "#fff7e6", color: "#b45309", fontSize: 11.5, fontWeight: 700, padding: "3px 11px", borderRadius: 999 },
  tagVermelha: { background: "#fef2f2", color: "#b91c1c", fontSize: 11.5, fontWeight: 700, padding: "3px 11px", borderRadius: 999 },
  avisoSubstituicao: {
    padding: "11px 15px",
    borderRadius: 12,
    background: "#eef6ff",
    border: "1px solid #cfe6ff",
    color: "#1d4ed8",
    fontSize: 13,
    marginBottom: 16,
  },
};

// Export com Error Boundary local: erro de render nunca deixa a tela branca.
export default function ProjecaoHoraHora() {
  return (
    <ErrorBoundaryProjecao>
      <ProjecaoHoraHoraInner />
    </ErrorBoundaryProjecao>
  );
}
