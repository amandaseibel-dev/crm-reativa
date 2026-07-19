import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";
import { podeGerirFinanceiro, emailPorNomeOperador, nomeOperadorPorEmail, OPERADORES_POR_EMAIL } from "../utils/operadores";

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
// (NOME.SOBRENOME) | E código convênio+título | F convênio | G data
// referência | H valor original | I honorário | J data de pagamento |
// K valor pago
function normalizarLinhaSantander(linhaArray) {
  const [
    ,
    alunoBruto,
    tituloNumero,
    operadorBruto,
    numeroParcelaCompleto,
    ,
    ,
    ,
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

  // Operador vem como "NOME.SOBRENOME" -- usa só o primeiro nome pra
  // casar com o mapeamento de operadores já existente no sistema.
  const primeiroNome = String(operadorBruto || "").split(".")[0];
  const emailOperador = emailPorNomeOperador(primeiroNome);

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
    operador_email: emailOperador,
    operador_nome: emailOperador ? nomeOperadorPorEmail(emailOperador) : (operadorBruto || null),
    aluno_nome: aluno || null,
    cpf: null,
  };
}

export default function ProjecaoHoraHora() {
  const [usuario, setUsuario] = useState(null);
  const [aba, setAba] = useState("DASHBOARD");
  const [subAbaDashboard, setSubAbaDashboard] = useState("VISAO_GERAL");
  const [operadorSelecionado, setOperadorSelecionado] = useState("");
  const [projecaoTodos, setProjecaoTodos] = useState(null);
  const [carregandoTodos, setCarregandoTodos] = useState(false);
  const [mesReferencia, setMesReferencia] = useState(mesAtualISO());

  const [dashboard, setDashboard] = useState(null);
  const [diaSelecionado, setDiaSelecionado] = useState(null);
  const [pagamentosDoDia, setPagamentosDoDia] = useState([]);
  const [carregandoPagamentosDia, setCarregandoPagamentosDia] = useState(false);
  const [carregandoDashboard, setCarregandoDashboard] = useState(true);
  const [erro, setErro] = useState("");

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
  }, []);

  useEffect(() => {
    if (!usuario) return;
    carregarDashboard();
    carregarLancamentosHoje();
    // Atualiza os indicadores em tempo real a cada 30s.
    const intervalo = setInterval(() => {
      carregarDashboard();
      carregarLancamentosHoje();
    }, 30000);
    return () => clearInterval(intervalo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesReferencia, usuario, operadorSelecionado]);

  useEffect(() => {
    if (aba === "HISTORICO") carregarHistorico();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba]);

  // Recarrega os pagamentos do dia já aberto (usado depois de alterar
  // operador, pra lista e somatória refletirem a troca na hora).
  async function carregarPagamentosDia(dia) {
    setCarregandoPagamentosDia(true);
    // RLS garante operador só vendo o próprio; mas Amanda ADM tem RLS de
    // gestão (por causa de outras telas), então aqui filtramos na mão
    // pra ela também só ver os próprios pagamentos, igual um operador.
    // id/operador_email entram no select pra permitir alterar operador aqui.
    let consultaDia = supabase
      .from("pagamentos")
      .select("id, aluno_nome, valor_pago, valor_honorario, operador_nome, operador_email, titulo_numero")
      .eq("data_pagamento", dia)
      .order("valor_pago", { ascending: false });

    if (usuario?.email?.toLowerCase() === "cobranca07@aelbra.com.br") {
      consultaDia = consultaDia.eq("operador_email", "cobranca07@aelbra.com.br");
    }

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

  async function carregarDashboard() {
    setErro("");
    const { data, error } = await supabase.rpc("projecao_dashboard", {
      p_mes: mesReferencia,
      p_operador_email: operadorSelecionado || null,
    });
    if (error) {
      setErro("Erro ao carregar indicadores: " + error.message);
    } else {
      setDashboard(data);
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
    let consulta = supabase
      .from("pagamentos")
      .select("id, data_pagamento, aluno_nome, operador_email, operador_nome, valor_pago, valor_honorario")
      .eq("data_pagamento", hojeISO)
      .order("valor_pago", { ascending: false });

    // Quem não é gestão (ou é Amanda ADM, que aqui vê só o dela) só pode
    // ver os próprios lançamentos.
    if ((!usuario?.podeGerir || usuario?.email?.toLowerCase() === "cobranca07@aelbra.com.br") && usuario?.email) {
      consulta = consulta.eq("operador_email", usuario.email);
    }

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
      carregarDashboard();
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
      carregarDashboard();
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
      carregarDashboard();
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
      carregarDashboard();
    }
    setSalvandoMeta(false);
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
      carregarDashboard();
      carregarLancamentosHoje();
      // Se a troca foi feita pelo painel de um dia da evolução, recarrega
      // aquele dia pra lista e somatória já mostrarem o novo operador.
      if (diaSelecionado) carregarPagamentosDia(diaSelecionado);
    }
  }

  const ranking = useMemo(() => dashboard?.ranking_equipe || [], [dashboard]);
  const historicoDia = useMemo(() => dashboard?.historico_dia_a_dia || [], [dashboard]);
  // Amanda ADM (cobranca07) tem permissão de gestão pra outras telas
  // (financeiro, importação), mas na Projeção/Hora a Hora ela deve ver
  // só o que é dela -- não o painel gerencial do time inteiro.
  const vePainelGestao =
    usuario?.podeGerir && usuario?.email?.toLowerCase() !== "cobranca07@aelbra.com.br";
  const maiorValorGrafico = useMemo(
    () => Math.max(1, ...historicoDia.map((d) => Number(d.valor_recuperado) || 0)),
    [historicoDia]
  );

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
        <input
          type="month"
          value={mesReferencia}
          onChange={(e) => setMesReferencia(e.target.value)}
          style={estilos.inputMes}
        />
      </div>

      <div style={estilos.abas}>
        <button style={aba === "DASHBOARD" ? estilos.abaAtiva : estilos.aba} onClick={() => setAba("DASHBOARD")}>
          📊 Dashboard
        </button>
        {usuario?.podeGerir && (
          <button style={aba === "IMPORTAR" ? estilos.abaAtiva : estilos.aba} onClick={() => setAba("IMPORTAR")}>
            📥 Importar Planilha
          </button>
        )}
        <button style={aba === "HISTORICO" ? estilos.abaAtiva : estilos.aba} onClick={() => setAba("HISTORICO")}>
          🗂️ Histórico de Importações
        </button>
      </div>

      {erro && <p style={{ color: "#f87171" }}>{erro}</p>}

      {aba === "DASHBOARD" && (
        <>
          {carregandoDashboard ? (
            <p style={{ opacity: 0.7 }}>Carregando indicadores...</p>
          ) : (
            <>
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
                      <div style={estilos.heroNumero}>{moeda(dashboard?.honorario_mes_filial ?? dashboard?.recuperado_reativa_mes)}</div>
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
                        No ritmo atual, fecha em <strong>{moeda(dashboard?.projecao_honorario_filial)}</strong>{" "}
                        ({dashboard?.percentual_projecao_filial ?? 0}% da meta)
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
                    {Object.entries(OPERADORES_POR_EMAIL).map(([email, nome]) => (
                      <option key={email} value={email}>{nome}</option>
                    ))}
                  </select>
                  {!operadorSelecionado && (
                    <p style={{ opacity: 0.6, fontSize: 12.5, marginTop: 10 }}>
                      Escolha um operador acima pra ver a meta, projeção e comissão detalhada dele.
                    </p>
                  )}
                </div>
              )}

              {usuario?.email?.toLowerCase() === "cobranca07@aelbra.com.br" && (
                <>
                  <h3 style={{ margin: "20px 0 10px" }}>💼 Meu painel (Amanda ADM)</h3>
                  <div style={estilos.grade}>
                    <Cartao label="Recuperado por mim no mês" valor={moeda(dashboard?.recuperado_mes_amanda_adm)} />
                    <Cartao
                      label="Minha comissão (8% flat sobre o recuperado)"
                      valor={moeda(dashboard?.comissao_amanda_adm)}
                      destaque
                    />
                  </div>
                  <p style={{ opacity: 0.6, fontSize: 12.5, marginTop: -6 }}>
                    Sem meta e sem faixa — comissão fixa de 8% sobre o valor que você mesma recuperou
                    fechando acordos no mês.
                  </p>
                </>
              )}

              {(!usuario?.podeGerir || (vePainelGestao && subAbaDashboard === "POR_OPERADOR" && operadorSelecionado)) && (
                <>
                  {vePainelGestao && (
                    <h3 style={{ margin: "0 0 14px" }}>
                      Números de {OPERADORES_POR_EMAIL[operadorSelecionado] || operadorSelecionado}
                    </h3>
                  )}

                  <div style={estilos.hero}>
                    <div style={estilos.heroTopo}>
                      <span style={estilos.heroEyebrow}>HONORÁRIO NO MÊS</span>
                      <span style={estilos.heroBadge}>Faixa atual: {dashboard?.faixa_atual || "-"}</span>
                    </div>

                    <div style={estilos.heroNumeroLinha}>
                      <div style={estilos.heroNumero}>{moeda(dashboard?.honorario_mes)}</div>
                      <div style={estilos.heroMeta}>
                        <span style={estilos.heroMetaLabel}>META</span>
                        <span style={estilos.heroMetaValor}>{moeda(dashboard?.meta_honorario_individual)}</span>
                      </div>
                    </div>

                    <div style={estilos.heroBarraFundo}>
                      <div
                        style={{
                          ...estilos.heroBarraPreenchida,
                          width: `${Math.min(dashboard?.percentual_meta_individual_realizado ?? 0, 100)}%`,
                        }}
                      />
                    </div>

                    <div style={estilos.heroRodape}>
                      <span>
                        <strong>{dashboard?.percentual_meta_individual_realizado ?? 0}%</strong> da meta atingido
                      </span>
                      <span>
                        No ritmo atual, fecha em <strong>{moeda(dashboard?.projecao_honorario_individual)}</strong>{" "}
                        ({dashboard?.percentual_projecao_individual ?? 0}% da meta)
                      </span>
                    </div>
                  </div>

                  <div style={estilos.faixaStats}>
                    <FaixaItem label="Recuperado hoje" valor={moeda(dashboard?.recuperado_hoje)} />
                    <FaixaItem label="Honorários hoje" valor={moeda(dashboard?.honorario_hoje)} />
                    <FaixaItem label="Acumulado do mês" valor={moeda(dashboard?.acumulado_mes)} />
                    <FaixaItem label="Comissão estimada" valor={moeda(dashboard?.comissao_estimada_individual)} />
                    <FaixaItem label="Ritmo (dias úteis)" valor={`${dashboard?.dias_uteis_passados ?? 0} / ${dashboard?.dias_uteis_total_mes ?? 0}`} />
                  </div>

                  <p style={{ opacity: 0.6, fontSize: 12.5, marginTop: 2 }}>
                    Comissão calculada por faixa progressiva (igual imposto de renda) sobre o honorário do
                    mês — cada faixa comissiona só a fatia que cai dentro dela. Projeção é uma estimativa
                    com base no ritmo médio de honorário por dia útil, não é garantia.
                  </p>
                </>
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

              {(!vePainelGestao || subAbaDashboard === "EVOLUCAO") && (
              <div style={estilos.blocoGrafico}>
                <h3 style={{ marginBottom: 12 }}>📈 Evolução do mês (recuperado por dia)</h3>
                <p style={{ opacity: 0.6, fontSize: 12, marginTop: -6, marginBottom: 10 }}>
                  Clique numa barra pra ver quem pagou naquele dia.
                </p>
                {historicoDia.length === 0 ? (
                  <p style={{ opacity: 0.7 }}>Nenhum pagamento importado neste mês ainda.</p>
                ) : (
                  <div style={estilos.barras}>
                    {historicoDia.map((d) => (
                      <div
                        key={d.dia}
                        style={{ ...estilos.colunaBarra, cursor: "pointer" }}
                        title={moeda(d.valor_recuperado)}
                        onClick={() => abrirDiaSelecionado(d.dia)}
                      >
                        <div
                          style={{
                            ...estilos.barra,
                            height: `${Math.max(4, (Number(d.valor_recuperado) / maiorValorGrafico) * 140)}px`,
                            outline: diaSelecionado === d.dia ? "2px solid #7dd3fc" : "none",
                          }}
                        />
                        <span style={estilos.legendaBarra}>{formatarDataCurta(d.dia)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {diaSelecionado && (
                  <div style={estilos.blocoPagamentosDia}>
                    <h4 style={{ margin: "14px 0 8px" }}>
                      💳 Pagamentos de {formatarDataCurta(diaSelecionado)}
                    </h4>
                    {carregandoPagamentosDia ? (
                      <p style={{ opacity: 0.7 }}>Carregando...</p>
                    ) : pagamentosDoDia.length === 0 ? (
                      <p style={{ opacity: 0.7 }}>Nenhum pagamento encontrado nesse dia.</p>
                    ) : (
                      <>
                        {(() => {
                          const totalPago = pagamentosDoDia.reduce((soma, p) => soma + (Number(p.valor_pago) || 0), 0);
                          const totalHonorario = pagamentosDoDia.reduce((soma, p) => soma + (Number(p.valor_honorario) || 0), 0);
                          return (
                            <div
                              style={{
                                display: "flex",
                                gap: 24,
                                padding: "8px 12px",
                                marginBottom: 10,
                                background: "rgba(125, 211, 252, 0.08)",
                                borderRadius: 8,
                                fontWeight: 600,
                              }}
                            >
                              <span>Total do dia ({pagamentosDoDia.length} pagamentos):</span>
                              <span>Recuperado: {moeda(totalPago)}</span>
                              <span>Honorário: {moeda(totalHonorario)}</span>
                            </div>
                          );
                        })()}
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
                            {pagamentosDoDia.map((p, i) => (
                              <tr key={p.id || i} style={estilos.tr}>
                                <td style={estilos.td}>{p.aluno_nome || "-"}</td>
                                {usuario?.podeGerir && <td style={estilos.td}>{p.operador_nome || "-"}</td>}
                                <td style={estilos.td}>{moeda(p.valor_pago)}</td>
                                <td style={estilos.td}>{moeda(p.valor_honorario)}</td>
                                {usuario?.podeGerir && (
                                  <td style={estilos.td}>
                                    {p.id ? (
                                      <button style={estilos.botaoLink} onClick={() => alterarOperador(p.id, p.operador_email)}>
                                        Alterar operador
                                      </button>
                                    ) : "-"}
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                )}
              </div>
              )}

              {(!vePainelGestao || subAbaDashboard === "EVOLUCAO") && usuario?.email?.toLowerCase() !== "cobranca07@aelbra.com.br" && (
                <>
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
const PH_VERDE = "#0f9d6b";

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
  heroBarraPreenchida: { height: "100%", borderRadius: 999, background: `linear-gradient(90deg, ${PH_VERDE}, #34d399)`, transition: "width 0.4s ease" },
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
