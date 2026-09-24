import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";
import Aluno from "./Aluno";
import DadosAcademicos from "../components/DadosAcademicos";

// Conferência Prime: títulos que SAÍRAM DA COBRANÇA e esperam decisão humana.
//
// Só chega aqui o que a detecção do grupo A colocou em EM_CONFIRMACAO:
// liquidação real na Prime (depois do vencimento + 30 e da importação), o
// próprio boleto no portador 195, CPF coerente, sem conflito, e corroboração
// independente -- pagamento ReATIVA no dia ou valor pago acima do bruto. A data
// crua da Prime, sozinha, nunca mais traz título para esta tela.
//
// Premissa 6: nada aqui é automático. Cada decisão é um clique de gente e fica
// registrada. As três saídas:
//   - CONFIRMAR A1 (sem acordo na janela) -> baixa oficial; a evidência é
//     conferida de novo no momento do clique.
//   - CONFIRMAR A2 que o acordo cobre -> VÍNCULO ao acordo existente. Sem baixa
//     independente: a dívida fica só nas parcelas do acordo.
//   - REJEITAR -> o título volta a ser cobrado (ABERTO). A mesma evidência não
//     o traz de volta para cá; só fato novo.
// A2 inconclusivo ou que o acordo não cobre, e aluno com acordo cancelado no
// histórico, exigem motivo escrito.
//
// REGRA DE ENTRADA (18/09/2026): toda liquidação NOVA da Prime chega por
// classificação de origem, nunca pela data. "Prime liquidado" não é pagamento.
//   - A_PAGAMENTO_COMPROVADO / B_ACORDO_COMPROVADO -> a ação é VINCULAR ao
//     acordo comprovado (acordo QUITADO só vira PAGO com dinheiro real).
//   - C_SEM_PROVA -> LIQUIDAÇÃO SEM ORIGEM COMPROVADA: o padrão é manter em
//     confirmação. Com acordo perto da data, vincular com motivo; com
//     pagamento identificado, seguir o pagamento (o motor conclui). Nunca há
//     "Confirmar PAGO" aqui.

const SUBGRUPO = {
  A1: { rotulo: "sem acordo na janela", dica: "A Prime liquidou e não há acordo vivo perto da data: confirmar = baixa oficial (só com pagamento ReATIVA no dia)." },
  A2_COBRE: { rotulo: "acordo cobre", dica: "O acordo feito na data da liquidação cobre este título: confirmar = vincular ao acordo." },
  A2_NAO_COBRE: { rotulo: "acordo não cobre", dica: "Há acordo perto da data, mas ele não cobre este título. Decida com motivo." },
  A2_INCONCLUSIVO: { rotulo: "inconclusivo", dica: "Há acordo perto da data e não dá para afirmar se cobre este título. Decida com motivo." },
  A_PAGAMENTO_COMPROVADO: { rotulo: "pagamento comprovado", dica: "O boleto está na composição de um acordo quitado com pagamentos baixados que cobrem o acordo: vincular deixa o título pago." },
  B_ACORDO_COMPROVADO: { rotulo: "acordo comprovado", dica: "O boleto está na composição de um acordo ativo do aluno: vincular deixa o título negociado (a dívida fica nas parcelas)." },
  C_SEM_PROVA: { rotulo: "LIQUIDAÇÃO SEM ORIGEM COMPROVADA", dica: "A Prime liquidou, mas não há pagamento ReATIVA que cubra o título nem acordo comprovado. Padrão: manter em confirmação." },
};

const CORROBORACAO = {
  PAGAMENTO_REATIVA: "pagamento ReATIVA no dia",
  VALOR_PAGO_ACIMA_DO_BRUTO: "valor pago acima do bruto (não é caixa)",
  NENHUMA: "sem corroboração",
};

// TRIAGEM OPERACIONAL (19/09/2026): snapshot horário (cron :55) + botão
// Recalcular. Só organiza: prioridade, origem provável e grupo histórico. A
// classe humana registra o que a gestão viu no Prime e NÃO executa efeito
// financeiro: a decisão continua PENDENTE e segue pelas rotas oficiais.
const PRIORIDADES = ["CRITICO", "ALTO", "NORMAL", "BAIXO"];
const PRIORIDADE = {
  CRITICO: { rotulo: "CRÍTICO", cor: "vermelho" },
  ALTO: { rotulo: "ALTO", cor: "ambar" },
  NORMAL: { rotulo: "NORMAL", cor: "roxo" },
  BAIXO: { rotulo: "BAIXO", cor: "neutro" },
};
const ORIGEM = {
  PAGAMENTO_COMPROVADO: "pagamento comprovado",
  ACORDO_COMPROVADO: "acordo comprovado",
  PAGAMENTO_CANDIDATO: "pagamento candidato",
  ACORDO_CANDIDATO: "acordo candidato",
  NAO_COMPROVADA: "origem não comprovada",
  INSTITUCIONAL_PROVAVEL: "institucional provável",
  CANCELAMENTO_PROVAVEL: "cancelamento provável",
  FIES_ISENCAO_PROVAVEL: "FIES/isenção provável",
  RESIDUO: "resíduo",
};
const GRUPO_HIST = {
  NOVO_APOS_CORTE: "novo após o corte",
  D2_OUTRA_DIVIDA: "D2 (outra dívida)",
  D_LOTE_48: "D lote 48",
  D3: "D3",
  C_166: "C (portador 166)",
  C_PARCIAL: "C parcial",
  A1_HISTORICO: "A1 histórico",
  A2_HISTORICO: "A2 histórico",
};
const CLASSES_HUMANAS = [
  ["PAGAMENTO_REAL", "Pagamento real"],
  ["ACORDO", "Acordo"],
  ["LIQUIDACAO_INSTITUCIONAL", "Liquidação institucional"],
  ["CANCELAMENTO_ESTORNO", "Cancelamento / estorno"],
  ["ISENCAO_FIES_BOLSA", "Isenção / FIES / bolsa"],
  ["SUBSTITUICAO_TITULO", "Substituição de título"],
  ["INCONCLUSIVO", "Inconclusivo"],
];
const FAIXAS_VALOR = [
  ["TODAS", "Qualquer valor"], ["<200", "até R$ 200"], ["200-1000", "R$ 200 a 1.000"],
  ["1000-5000", "R$ 1.000 a 5.000"], [">=5000", "R$ 5.000 ou mais"],
];
const TEMPOS = [["TODOS", "Qualquer tempo"], [">1", "mais de 1 dia"], [">3", "mais de 3 dias"], [">7", "mais de 7 dias"]];

// Classes humanas que admitem a saída administrativa (título vira CANCELADA).
const ADMINISTRATIVAS = new Set(["CANCELAMENTO_ESTORNO", "ISENCAO_FIES_BOLSA"]);

// VALIDAÇÃO DA GESTÃO: o que você viu na tela do Prime é a evidência.
//
// A conferência automática só aceita prova de máquina -- `baixar` exige
// corroboração por pagamento ReATIVA, `confirmar` recusa C_SEM_PROVA e o
// encerramento administrativo só aceita 2 destas classes, e só depois de uma
// classificação gravada antes. Quando a gestão abre o Prime e vê o que
// aconteceu, essa leitura passa a valer: a classe escolhida decide o destino
// do título, e o que foi visto fica registrado título a título.
const CLASSES_VALIDAVEIS = [
  ["PAGAMENTO_REAL", "Pagamento real", "PAGO"],
  ["LIQUIDACAO_INSTITUCIONAL", "Liquidação institucional", "CANCELADA"],
  ["CANCELAMENTO_ESTORNO", "Cancelamento / estorno", "CANCELADA"],
  ["ISENCAO_FIES_BOLSA", "Isenção / FIES / bolsa", "CANCELADA"],
  ["SUBSTITUICAO_TITULO", "Substituição de título", "CANCELADA"],
];

// Pergunta a classe pelo número, já sugerindo a que a gestão registrou antes.
function escolherClasseValidacao(sugestao) {
  const lista = CLASSES_VALIDAVEIS.map(([, r], i) => `${i + 1}) ${r}`).join("\n");
  const padrao = CLASSES_VALIDAVEIS.findIndex(([c]) => c === sugestao);
  for (;;) {
    const r = window.prompt(
      "O que você viu na tela do Prime?\n\n" +
        lista +
        "\n\n(1 marca o título como PAGO; 2 a 5 encerram o título como CANCELADA, sem efeito financeiro.)\n\nDigite o número:",
      padrao >= 0 ? String(padrao + 1) : ""
    );
    if (r === null) return null;
    const n = parseInt(String(r).trim(), 10);
    if (n >= 1 && n <= CLASSES_VALIDAVEIS.length) return CLASSES_VALIDAVEIS[n - 1];
    alert(`Digite um número de 1 a ${CLASSES_VALIDAVEIS.length}.`);
  }
}

const REGRA_NOVA = new Set(["A_PAGAMENTO_COMPROVADO", "B_ACORDO_COMPROVADO", "C_SEM_PROVA"]);
const VINCULA_DIRETO = new Set(["A2_COBRE", "A_PAGAMENTO_COMPROVADO", "B_ACORDO_COMPROVADO"]);

// Os 37 do recorte D2 (18/09) entraram sem subgrupo, antes do CHECK aceitar
// C_SEM_PROVA; o motivo de entrada diz o que eles são.
function subgrupoEfetivo(t) {
  if (t.subgrupo) return t.subgrupo;
  return /^PRIME_LIQUIDA/.test(String(t.motivo_entrada || "")) ? "C_SEM_PROVA" : t.subgrupo;
}

// As evidências que a regra de entrada guardou para o título (item 13):
// pagamento, acordo, portador, data, valor, ou a ausência de cada um.
function evidencias(t) {
  const ev = t.evidencia || {};
  const prime = ev.prime || {};
  const itens = [];
  itens.push({ ok: null, texto: `Prime: liquidado em ${dia(prime.liquidado_em || t.liquidado_em)} · portador ${prime.portador ?? t.portador ?? "-"} · bruto ${moeda(prime.valor_bruto)} · "pago" ${moeda(prime.valor_pago)} (dívida corrigida, não caixa)` });
  if (prime.cpf_confere === false) itens.push({ ok: false, texto: "CPF do boleto na Prime não confere com a ficha" });
  if (ev.pagamento_candidato_id) {
    itens.push({ ok: true, texto: `pagamento ReATIVA próximo (${ev.pagamento_candidato_status || "sem conciliação"})${ev.pagamento_cobre_o_titulo ? ", cobre o título" : ", NÃO cobre o título"}` });
  } else {
    itens.push({ ok: false, texto: "nenhum pagamento ReATIVA até 10 dias da liquidação" });
  }
  if (ev.acordo_composicao) {
    const a = ev.acordo_composicao;
    itens.push({ ok: true, texto: `boleto na composição do acordo ${a.numero} (${a.status})${a.status === "QUITADO" ? (a.pago_de_verdade?.suficiente ? ", pago de verdade" : ", SEM pagamentos que cubram") : ""}` });
  } else if (ev.acordo_candidato) {
    const a = ev.acordo_candidato;
    itens.push({ ok: null, texto: `acordo ${a.numero} (${a.status}) criado em ${dia(a.criado_em)}, sem composição que cite o boleto` });
  } else {
    itens.push({ ok: false, texto: "nenhum acordo no CRM perto da data" });
  }
  if (ev.no_portador_166 === true) itens.push({ ok: null, texto: "CPF listado no portador 166 (só indica que negociou algum dia; não prova este título)" });
  if (ev.acordo_cancelado_no_historico) itens.push({ ok: null, texto: "aluno tem acordo cancelado no histórico" });
  return itens;
}

function moeda(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dia(v) {
  if (!v) return "-";
  // Data pura (YYYY-MM-DD) não pode passar por fuso: viraria o dia anterior.
  const [a, m, d] = String(v).slice(0, 10).split("-");
  return d && m && a ? `${d}/${m}/${a}` : "-";
}

function formatCpf(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length !== 11) return v || "-";
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

// Motivo obrigatório: pede de novo até ter o mínimo, ou devolve null se cancelar.
function pedirMotivo(texto, minimo, sugestao = "") {
  let atual = sugestao;
  for (;;) {
    const r = window.prompt(texto, atual);
    if (r === null) return null;
    if (r.trim().length >= minimo) return r.trim();
    alert(`Escreva o motivo (mínimo ${minimo} caracteres).`);
    atual = r;
  }
}

function exigeMotivo(t) {
  return t.revisao_obrigatoria || t.subgrupo === "A2_NAO_COBRE" || t.subgrupo === "A2_INCONCLUSIVO";
}

export default function ConferenciaPrime() {
  const [itens, setItens] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [semPermissao, setSemPermissao] = useState(false);
  const [grupo, setGrupo] = useState("TODOS");
  const [busca, setBusca] = useState("");
  const [processando, setProcessando] = useState({});
  const [nomeCopiado, setNomeCopiado] = useState("");
  // Ficha do aluno: conferir o caso antes de decidir é o que se pede aqui.
  const [fichaId, setFichaId] = useState(null);
  // Triagem operacional
  const [painel, setPainel] = useState(null);
  const [filtro, setFiltro] = useState({ prioridade: "TODAS", campus: "TODOS", curso: "TODOS", grupoHist: "TODOS",
    origem: "TODAS", faixa: "TODAS", liqDe: "", liqAte: "", tempo: "TODOS", classe: "TODAS" });
  const [recalculando, setRecalculando] = useState(false);
  // Ficha de decisão (o que a gestão vê antes de classificar)
  const [decisao, setDecisao] = useState(null); // { titulo, dados }
  const [decisaoCarregando, setDecisaoCarregando] = useState(false);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);
    setErro("");
    setSemPermissao(false);
    try {
      const { data: bruto, error } = await supabase.rpc("prime_conferencia_fila");
      const data = (bruto || []).map((i) => ({ ...i, subgrupo: subgrupoEfetivo(i) }));
      if (error) throw error;
      setItens(data || []);
      const { data: p } = await supabase.rpc("prime_conferencia_painel");
      setPainel(p || null);
    } catch (e) {
      // O portão está dentro da RPC: quem não é da gestão recebe 42501.
      if (e?.code === "42501") setSemPermissao(true);
      else setErro(e?.message || String(e));
      setItens([]);
    } finally {
      setCarregando(false);
    }
  }

  function marcar(chave, ligado) {
    setProcessando((p) => {
      const n = { ...p };
      if (ligado) n[chave] = true;
      else delete n[chave];
      return n;
    });
  }

  async function recalcular() {
    if (recalculando) return;
    setRecalculando(true);
    try {
      const { data, error } = await supabase.rpc("prime_conferencia_triagem_recalcular", { p_titulos: null });
      if (error) throw error;
      await carregar();
      alert(`Triagem recalculada: ${data?.triados ?? 0} títulos em ${data?.segundos ?? "?"}s. Nenhuma decisão humana foi alterada.`);
    } catch (e) {
      alert("Não deu para recalcular a triagem: " + (e?.message || e));
    } finally {
      setRecalculando(false);
    }
  }

  async function abrirDecisao(t) {
    setDecisao({ titulo: t, dados: null });
    setDecisaoCarregando(true);
    try {
      const { data, error } = await supabase.rpc("prime_conferencia_ficha", { p_titulo_id: t.titulo_id });
      if (error) throw error;
      setDecisao({ titulo: t, dados: data });
    } catch (e) {
      setDecisao({ titulo: t, dados: null, erro: e?.message || String(e) });
    } finally {
      setDecisaoCarregando(false);
    }
  }

  // Registra o que a gestão viu no Prime. SÓ REGISTRO: nada financeiro muda.
  async function classificarHumano(t, classe) {
    const rotulo = (CLASSES_HUMANAS.find(([c]) => c === classe) || [])[1] || classe;
    const obs = pedirMotivo(
      `Classificar o boleto ${t.documento} como "${rotulo}".\n\n` +
        "Escreva o que apareceu no Prime (motivo/tipo da baixa, pagamento, acordo, estorno, isenção...).\n" +
        "Isto só registra a conferência: a decisão financeira continua pendente.",
      10,
      t.classe_humana_obs || ""
    );
    if (obs === null) return;
    const chave = `classe:${t.titulo_id}`;
    if (processando[chave]) return;
    marcar(chave, true);
    try {
      const { data, error } = await supabase.rpc("prime_conferencia_classificar_humano", {
        p_titulo_id: t.titulo_id, p_classe: classe, p_obs: obs,
      });
      if (error) throw error;
      const agora = new Date().toISOString();
      const patch = { classe_humana: classe, classe_humana_obs: obs, classe_humana_em: agora };
      setItens((prev) => prev.map((x) => (x.titulo_id === t.titulo_id ? { ...x, ...patch } : x)));
      setDecisao((d) => (d && d.titulo.titulo_id === t.titulo_id
        ? { ...d, titulo: { ...d.titulo, ...patch }, dados: d.dados ? { ...d.dados, decisao: { ...d.dados.decisao, ...patch } } : d.dados }
        : d));
      if (data?.efeito_financeiro !== "nenhum") alert("Atenção: resposta inesperada da classificação.");
    } catch (e) {
      alert("Não deu para classificar: " + (e?.message || e));
    } finally {
      marcar(chave, false);
    }
  }

  // Saida definitiva ADMINISTRATIVA: so com classe humana CANCELAMENTO_ESTORNO
  // ou ISENCAO_FIES_BOLSA. O titulo sai da base (CANCELADA), a decisao vira
  // ENCERRADO_ADMINISTRATIVO; nada de pagamento, acordo ou recuperacao.
  async function encerrarAdministrativo(t) {
    const rotulo = (CLASSES_HUMANAS.find(([c]) => c === t.classe_humana) || [])[1] || t.classe_humana;
    const obs = pedirMotivo(
      `Encerrar administrativamente o boleto ${t.documento} (${moeda(t.valor)})?\n\n` +
        `Aluno: ${t.aluno_nome}\nClasse humana: ${rotulo}\nEvidência: ${t.classe_humana_obs || "-"}\n\n` +
        "O título sai da base como CANCELADA e deixa de ser exigível por motivo administrativo/acadêmico. " +
        "Não é pagamento, não é acordo, não conta como recuperação. Escreva a observação do encerramento.",
      10
    );
    if (obs === null) return;
    const chave = `enc:${t.titulo_id}`;
    if (processando[chave]) return;
    marcar(chave, true);
    try {
      const { data, error } = await supabase.rpc("prime_conferencia_encerrar_administrativo", {
        p_titulo_id: t.titulo_id, p_observacao: obs,
      });
      if (error) throw error;
      tirarDaTela([t.titulo_id]);
      setDecisao((d) => (d && d.titulo.titulo_id === t.titulo_id ? null : d));
      const caso = data?.caso?.encerrado ? "caso encerrado como SEM_SALDO_EM_ABERTO" : `aluno ${data?.aluno || "-"}`;
      alert(`Boleto ${t.documento} encerrado administrativamente (${caso}). Sem efeito financeiro.`);
    } catch (e) {
      alert("Não deu para encerrar: " + (e?.message || e));
    } finally {
      marcar(chave, false);
    }
  }

  function tirarDaTela(ids) {
    const s = new Set(ids);
    setItens((prev) => prev.filter((x) => !s.has(x.titulo_id)));
  }

  async function confirmar(t) {
    const vinculo = VINCULA_DIRETO.has(t.subgrupo);
    const pergunta = vinculo
      ? `Vincular o boleto ${t.documento} ao acordo ${t.acordo_numero || "?"}?\n\n` +
        `Aluno: ${t.aluno_nome}\nValor do título: ${moeda(t.valor)}\n\n` +
        "O título passa a fazer parte do acordo: a dívida fica só nas parcelas dele. " +
        (t.acordo_status === "QUITADO"
          ? "O acordo está quitado com pagamentos reais: o título fica pago. "
          : "Acordo ativo: o título fica negociado. ") +
        "Nada é baixado por fora, nenhum acordo ou parcela é criado."
      : `Confirmar a liquidação do boleto ${t.documento}?\n\n` +
        `Aluno: ${t.aluno_nome}\nVencimento: ${dia(t.vencimento)}\nValor: ${moeda(t.valor)}\n` +
        `Liquidado na Prime em ${dia(t.liquidado_em)} (${CORROBORACAO[t.corroboracao] || t.corroboracao}).\n\n` +
        "O título fica como pago, com a origem registrada. A evidência é conferida de novo agora.";
    let obs = null;
    if (t.revisao_obrigatoria) {
      obs = pedirMotivo(
        pergunta + "\n\nEste aluno tem acordo cancelado no histórico: escreva o motivo da decisão.",
        10
      );
      if (obs === null) return;
    } else if (!window.confirm(pergunta)) {
      return;
    }
    if (processando[t.titulo_id]) return;
    marcar(t.titulo_id, true);
    try {
      const { error } = await supabase.rpc("prime_conferencia_confirmar", {
        p_titulo_id: t.titulo_id,
        p_observacao: obs,
      });
      if (error) throw error;
      tirarDaTela([t.titulo_id]);
    } catch (e) {
      alert("Não foi possível confirmar: " + (e?.message || String(e)));
    } finally {
      marcar(t.titulo_id, false);
    }
  }

  // A2 inconclusivo / que o acordo não cobre, e C sem prova com acordo perto
  // da data: gente decide, com motivo.
  async function vincularComMotivo(t, acordo = null) {
    const acordoId = acordo?.acordo_id || t.acordo_id;
    const numero = acordo?.numero || t.acordo_numero || "?";
    if (!acordoId) {
      alert("Nenhum acordo sugerido para este título. Vincule pela ficha do aluno ou mantenha em confirmação.");
      return;
    }
    const motivo = pedirMotivo(
      `Vincular o boleto ${t.documento} ao acordo ${numero}?\n\n` +
        `${SUBGRUPO[t.subgrupo]?.dica || ""}\n\nPor que este acordo cobre o título?`,
      10
    );
    if (motivo === null) return;
    marcar(t.titulo_id, true);
    try {
      const { error } = await supabase.rpc("prime_conferencia_vincular", {
        p_titulo_id: t.titulo_id,
        p_acordo_id: acordoId,
        p_observacao: motivo,
      });
      if (error) throw error;
      tirarDaTela([t.titulo_id]);
    } catch (e) {
      alert("Não foi possível vincular: " + (e?.message || String(e)));
    } finally {
      marcar(t.titulo_id, false);
    }
  }

  async function baixarComMotivo(t) {
    const motivo = pedirMotivo(
      `Dar baixa no boleto ${t.documento} sem vincular a acordo?\n\n` +
        `${SUBGRUPO[t.subgrupo]?.dica || ""}\n\nPor que a liquidação vale como pagamento deste título?`,
      10
    );
    if (motivo === null) return;
    marcar(t.titulo_id, true);
    try {
      const { error } = await supabase.rpc("prime_conferencia_baixar", {
        p_titulo_id: t.titulo_id,
        p_observacao: motivo,
      });
      if (error) throw error;
      tirarDaTela([t.titulo_id]);
    } catch (e) {
      alert("Não foi possível baixar: " + (e?.message || String(e)));
    } finally {
      marcar(t.titulo_id, false);
    }
  }

  // ROTA A pela tela: o pagamento está identificado mas ainda pendente no
  // motor. O título volta para o fluxo oficial, que conclui pela cadeia
  // pagamento -> acordo/parcela -> título. Nada é marcado pago aqui.
  async function seguirPagamento(t) {
    const ev = t.evidencia || {};
    const pg = (ev.pagamentos_proximos || [])[0];
    if (!ev.pagamento_candidato_id) {
      alert("Nenhum pagamento identificado para este título.");
      return;
    }
    const motivo = pedirMotivo(
      `Seguir o pagamento de ${dia(pg?.data)} (${moeda(pg?.valor)}, ${pg?.status_conciliacao || "sem conciliação"}) para o boleto ${t.documento}?\n\n` +
        "O título volta para o fluxo oficial de pagamento e sai desta fila; o motor conclui " +
        "(à vista quita; parcela de parcelado deixa negociado). Nada é marcado pago por aqui.\n\n" +
        "Por que este pagamento é deste título?",
      10
    );
    if (motivo === null) return;
    marcar(t.titulo_id, true);
    try {
      const { error } = await supabase.rpc("prime_conferencia_seguir_pagamento", {
        p_titulo_id: t.titulo_id,
        p_pagamento_id: ev.pagamento_candidato_id,
        p_motivo: motivo,
      });
      if (error) throw error;
      tirarDaTela([t.titulo_id]);
    } catch (e) {
      alert("Não foi possível seguir o pagamento: " + (e?.message || String(e)));
    } finally {
      marcar(t.titulo_id, false);
    }
  }

  // REJEITAR devolve o título para a cobrança. Não baixa nada.
  async function rejeitar(lista, descricao) {
    if (!lista.length) return;
    const total = lista.reduce((s, x) => s + (Number(x.valor) || 0), 0);
    const motivo = pedirMotivo(
      `Rejeitar ${lista.length} título(s) — ${descricao} — ${moeda(total)}.\n\n` +
        "O título volta a ser cobrado (em aberto) e sai desta fila. " +
        "A mesma evidência não o traz de volta.\n\nPor que a liquidação não vale?",
      5
    );
    if (motivo === null) return;
    const chave = lista.length === 1 ? lista[0].titulo_id : `lote:${descricao}`;
    marcar(chave, true);
    try {
      const { error } =
        lista.length === 1
          ? await supabase.rpc("prime_conferencia_rejeitar", { p_titulo_id: lista[0].titulo_id, p_motivo: motivo })
          : await supabase.rpc("prime_conferencia_rejeitar_lote", {
              p_titulo_ids: lista.map((x) => x.titulo_id),
              p_motivo: motivo,
            });
      if (error) throw error;
      tirarDaTela(lista.map((x) => x.titulo_id));
    } catch (e) {
      alert("Não foi possível rejeitar: " + (e?.message || String(e)));
      carregar();
    } finally {
      marcar(chave, false);
    }
  }

  // VALIDAR: a leitura da gestão na tela do Prime vira a decisão -- em lote.
  //
  // Não existe caminho automático para estes títulos: a estrutura do acordo
  // não é exposta pela API da Prime (docs/integracoes/prime-gaps.md, VERMELHO),
  // então a prova que a conferência espera não vai chegar. Quem decide é quem
  // abriu a tela. O que sustenta a decisão é o que essa pessoa escreve aqui, e
  // isso fica em auditoria, movimentação e classificação, título a título.
  async function validarComoGestao(lista, descricao) {
    if (!lista.length) return;
    const escolha = escolherClasseValidacao(lista.length === 1 ? lista[0].classe_humana : null);
    if (!escolha) return;
    const [classe, rotulo, destino] = escolha;
    const total = lista.reduce((s, x) => s + (Number(x.valor) || 0), 0);
    const obs = pedirMotivo(
      `Validar ${lista.length} título(s) — ${descricao} — ${moeda(total)} como "${rotulo}".\n\n` +
        (destino === "PAGO"
          ? "O título passa a PAGO. Nenhum pagamento é criado: é a sua leitura do Prime que sustenta a baixa."
          : "O título sai da base como CANCELADA e deixa de ser exigível. Não é pagamento, não conta como recuperação.") +
        "\n\nEscreva o que você viu no Prime (mínimo 15 caracteres) — isto fica no lugar da prova automática:",
      15,
      lista.length === 1 ? lista[0].classe_humana_obs || "" : ""
    );
    if (obs === null) return;
    const chave = lista.length === 1 ? `val:${lista[0].titulo_id}` : `val-lote:${descricao}`;
    if (processando[chave]) return;
    marcar(chave, true);
    try {
      const { data, error } = await supabase.rpc("prime_conferencia_validar_lote", {
        p_titulo_ids: lista.map((x) => x.titulo_id),
        p_classe: classe,
        p_observacao: obs,
      });
      if (error) throw error;
      const aplicados = Number(data?.aplicados || 0);
      const ignorados = Number(data?.ignorados || 0);
      tirarDaTela(lista.map((x) => x.titulo_id));
      setDecisao((d) => (d && lista.some((x) => x.titulo_id === d.titulo.titulo_id) ? null : d));
      alert(
        `${aplicados} título(s) validado(s) como ${rotulo} (${destino}) — ${moeda(Number(data?.valor_total || 0))}.` +
          (ignorados
            ? `\n\n${ignorados} não entraram (já decididos ou fora da confirmação) — a lista foi recarregada.`
            : "")
      );
      if (ignorados) carregar();
    } catch (e) {
      alert("Não deu para validar: " + (e?.message || String(e)));
      carregar();
    } finally {
      marcar(chave, false);
    }
  }

  function copiarNome(nome) {
    navigator.clipboard.writeText(nome || "").then(() => {
      setNomeCopiado(nome);
      setTimeout(() => setNomeCopiado(""), 1500);
    });
  }

  const filtrados = useMemo(() => {
    let lista = itens.filter((i) => {
      if (grupo === "TODOS") return true;
      if (grupo === "A2") return String(i.subgrupo || "").startsWith("A2");
      if (grupo === "REVISAO") return exigeMotivo(i);
      if (grupo === "COMPROVADOS") return i.subgrupo === "A_PAGAMENTO_COMPROVADO" || i.subgrupo === "B_ACORDO_COMPROVADO";
      return i.subgrupo === grupo;
    });
    const f = filtro;
    lista = lista.filter((i) => {
      if (f.prioridade !== "TODAS" && (i.prioridade || "SEM") !== f.prioridade) return false;
      if (f.campus !== "TODOS" && (i.campus || "-") !== f.campus) return false;
      if (f.curso !== "TODOS" && (i.curso || "-") !== f.curso) return false;
      if (f.grupoHist !== "TODOS" && (i.grupo_historico || "-") !== f.grupoHist) return false;
      if (f.origem !== "TODAS" && (i.origem_provavel || "-") !== f.origem) return false;
      if (f.classe !== "TODAS" && (f.classe === "SEM" ? !!i.classe_humana : i.classe_humana !== f.classe)) return false;
      const v = Number(i.valor) || 0;
      if (f.faixa === "<200" && !(v < 200)) return false;
      if (f.faixa === "200-1000" && !(v >= 200 && v < 1000)) return false;
      if (f.faixa === "1000-5000" && !(v >= 1000 && v < 5000)) return false;
      if (f.faixa === ">=5000" && !(v >= 5000)) return false;
      const liq = i.liquidado_em || "";
      if (f.liqDe && liq < f.liqDe) return false;
      if (f.liqAte && liq > f.liqAte) return false;
      const d = Number(i.dias_pendente) || 0;
      if (f.tempo === ">1" && !(d > 1)) return false;
      if (f.tempo === ">3" && !(d > 3)) return false;
      if (f.tempo === ">7" && !(d > 7)) return false;
      return true;
    });
    const t = busca.trim().toLowerCase();
    if (t) {
      const digitos = t.replace(/\D/g, "");
      lista = lista.filter((i) => {
        const nomeOk = String(i.aluno_nome || "").toLowerCase().includes(t);
        const cpfOk = digitos && String(i.cpf || "").replace(/\D/g, "").includes(digitos);
        const docOk = digitos && String(i.documento || "").includes(digitos);
        return nomeOk || cpfOk || docOk;
      });
    }
    return lista;
  }, [itens, grupo, busca, filtro]);

  const opcoes = useMemo(() => {
    const uniq = (k) => Array.from(new Set(itens.map((i) => i[k] || "-"))).sort();
    return { campus: uniq("campus"), curso: uniq("curso"), grupoHist: uniq("grupo_historico"), origem: uniq("origem_provavel") };
  }, [itens]);
  const setF = (k, v) => setFiltro((f) => ({ ...f, [k]: v }));

  // 1 card por aluno, como nas outras filas. A2 primeiro: é onde mora o risco
  // de cobrar a mesma dívida duas vezes.
  const grupos = useMemo(() => {
    const mapa = new Map();
    for (const i of filtrados) {
      const chave = i.aluno_id || `SEM-${i.titulo_id}`;
      if (!mapa.has(chave)) {
        mapa.set(chave, {
          chave,
          alunoId: i.aluno_id,
          nome: i.aluno_nome,
          cpf: i.cpf,
          responsavel: i.operador_responsavel,
          outrasDividas: i.outras_dividas,
          titulos: [],
        });
      }
      mapa.get(chave).titulos.push(i);
    }
    const arr = Array.from(mapa.values());
    for (const g of arr) {
      g.total = g.titulos.reduce((s, t) => s + (Number(t.valor) || 0), 0);
      g.temA2 = g.titulos.some((t) => String(t.subgrupo || "").startsWith("A2"));
      g.prio = Math.min(...g.titulos.map((t) => { const k = PRIORIDADES.indexOf(t.prioridade); return k < 0 ? 9 : k; }));
    }
    arr.sort((a, b) => a.prio - b.prio || Number(b.temA2) - Number(a.temA2) || b.total - a.total);
    return arr;
  }, [filtrados]);

  const contagens = useMemo(
    () => ({
      a1: itens.filter((i) => i.subgrupo === "A1").length,
      a2: itens.filter((i) => String(i.subgrupo || "").startsWith("A2")).length,
      revisao: itens.filter(exigeMotivo).length,
      semProva: itens.filter((i) => i.subgrupo === "C_SEM_PROVA").length,
      comprovados: itens.filter((i) => i.subgrupo === "A_PAGAMENTO_COMPROVADO" || i.subgrupo === "B_ACORDO_COMPROVADO").length,
    }),
    [itens]
  );

  const totalFiltrado = filtrados.reduce((s, i) => s + (Number(i.valor) || 0), 0);

  if (carregando) {
    return (
      <div style={A.wrap}>
        <Carregando texto="Carregando a Conferência Prime…" />
      </div>
    );
  }

  return (
    <div style={A.wrap}>
      <div style={A.topo}>
        <div>
          <h1 style={A.titulo}>Conferência Prime</h1>
          <p style={A.sub}>
            Títulos fora da cobrança por liquidação corroborada na Prime, aguardando sua decisão.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            style={{ ...A.btnGhost, ...(recalculando ? A.btnBusy : {}) }}
            disabled={recalculando}
            onClick={recalcular}
            title="Recalcula prioridade e origem provável de todos os pendentes. Não altera nenhuma classificação humana."
          >
            {recalculando ? "Recalculando…" : "Recalcular triagem"}
          </button>
          <button type="button" style={A.btnGhost} onClick={carregar}>Atualizar</button>
        </div>
      </div>

      {erro && <div style={A.erroBox}>⚠️ {erro}</div>}

      {painel && !semPermissao && (
        <div style={estilos.painel} title={painel.triagem_em ? `Triagem de ${new Date(painel.triagem_em).toLocaleString("pt-BR")}` : "Sem triagem ainda"}>
          {[
            ["Em confirmação", painel.total],
            ["Valor", moeda(painel.valor)],
            ["Novos após o corte", painel.novos_apos_corte],
            ["Históricos", painel.historicos],
            ["Resolvidos hoje", painel.resolvidos_hoje],
            ["Classificados hoje", painel.classificados_hoje],
            ["> 1 dia", painel.pendentes_mais_1_dia],
            ["> 3 dias", painel.pendentes_mais_3_dias],
            ["> 7 dias", painel.pendentes_mais_7_dias],
            ["Conferência manual", painel.necessita_manual],
          ].map(([r, v]) => (
            <div key={r} style={estilos.painelCard}>
              <span style={estilos.painelNum}>{v ?? "-"}</span>
              <span style={estilos.painelRotulo}>{r}</span>
            </div>
          ))}
          <div style={estilos.painelOrigens}>
            {Object.keys(ORIGEM).map((k) => (
              <span key={k} style={estilos.painelOrigem}>
                <b>{painel.por_origem?.[k] ?? 0}</b> {ORIGEM[k]}
              </span>
            ))}
            {PRIORIDADES.map((k) => (
              <span key={k} style={{ ...estilos.painelOrigem, ...corSelo(PRIORIDADE[k].cor) }}>
                <b>{painel.por_prioridade?.[k] ?? 0}</b> {PRIORIDADE[k].rotulo}
              </span>
            ))}
          </div>
        </div>
      )}

      {semPermissao ? (
        <p style={A.muted}>A Conferência Prime é decisão da gestão.</p>
      ) : itens.length === 0 && !erro ? (
        <p style={A.muted}>Nenhum título aguardando decisão.</p>
      ) : (
        <>
          <div style={A.barra}>
            <select style={A.select} value={grupo} onChange={(e) => setGrupo(e.target.value)}>
              <option value="TODOS">Todos ({itens.length})</option>
              <option value="C_SEM_PROVA">Liquidação sem origem comprovada ({contagens.semProva})</option>
              <option value="COMPROVADOS">Pagamento/acordo comprovado — vincular ({contagens.comprovados})</option>
              <option value="A2">Histórico: com acordo na janela — A2 ({contagens.a2})</option>
              <option value="A1">Histórico: sem acordo na janela — A1 ({contagens.a1})</option>
              <option value="REVISAO">Exigem motivo ({contagens.revisao})</option>
            </select>
            <input
              style={A.input}
              placeholder="Buscar por nome, CPF ou boleto..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <div style={A.contadores}>
              <span style={A.contadorAlunos}>{grupos.length} alunos</span>
              <span style={A.contadorAcordos}>{filtrados.length} títulos</span>
              <span style={A.contadorValor}>{moeda(totalFiltrado)}</span>
            </div>
          </div>

          <div style={estilos.filtros}>
            <select style={A.select} value={filtro.prioridade} onChange={(e) => setF("prioridade", e.target.value)}>
              <option value="TODAS">Prioridade: todas</option>
              {PRIORIDADES.map((k) => <option key={k} value={k}>{PRIORIDADE[k].rotulo}</option>)}
            </select>
            <select style={A.select} value={filtro.origem} onChange={(e) => setF("origem", e.target.value)}>
              <option value="TODAS">Origem provável: todas</option>
              {opcoes.origem.map((k) => <option key={k} value={k}>{ORIGEM[k] || k}</option>)}
            </select>
            <select style={A.select} value={filtro.grupoHist} onChange={(e) => setF("grupoHist", e.target.value)}>
              <option value="TODOS">Grupo: todos</option>
              {opcoes.grupoHist.map((k) => <option key={k} value={k}>{GRUPO_HIST[k] || k}</option>)}
            </select>
            <select style={A.select} value={filtro.campus} onChange={(e) => setF("campus", e.target.value)}>
              <option value="TODOS">Campus: todos</option>
              {opcoes.campus.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <select style={A.select} value={filtro.curso} onChange={(e) => setF("curso", e.target.value)}>
              <option value="TODOS">Curso: todos</option>
              {opcoes.curso.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <select style={A.select} value={filtro.faixa} onChange={(e) => setF("faixa", e.target.value)}>
              {FAIXAS_VALOR.map(([k, r]) => <option key={k} value={k}>{r}</option>)}
            </select>
            <select style={A.select} value={filtro.tempo} onChange={(e) => setF("tempo", e.target.value)}>
              {TEMPOS.map(([k, r]) => <option key={k} value={k}>{r}</option>)}
            </select>
            <select style={A.select} value={filtro.classe} onChange={(e) => setF("classe", e.target.value)}>
              <option value="TODAS">Classe humana: todas</option>
              <option value="SEM">sem classe</option>
              {CLASSES_HUMANAS.map(([k, r]) => <option key={k} value={k}>{r}</option>)}
            </select>
            <label style={estilos.rotuloData}>Liquidação de
              <input type="date" style={A.input} value={filtro.liqDe} onChange={(e) => setF("liqDe", e.target.value)} />
            </label>
            <label style={estilos.rotuloData}>até
              <input type="date" style={A.input} value={filtro.liqAte} onChange={(e) => setF("liqAte", e.target.value)} />
            </label>
          </div>

          <div style={estilos.aviso}>
            Estes títulos <b>não estão sendo cobrados</b> e <b>não foram baixados</b>: o valor segue
            igual e o responsável continua o mesmo. <b>Liquidado na Prime não é pagamento</b>: sem
            pagamento ReATIVA ou acordo comprovado, o título fica em confirmação. Vincular usa o
            acordo comprovado; seguir pagamento devolve o título ao fluxo oficial; rejeitar devolve
            o título para a cobrança.
          </div>

          {grupos.length === 0 ? (
            <p style={A.muted}>Nenhum título neste filtro.</p>
          ) : (
            <div style={A.cards}>
              {grupos.map((g) => (
                <div key={g.chave} style={A.card}>
                  <div style={A.cardHead}>
                    <div style={A.cardHeadInfo}>
                      <span style={A.cardNome}>{g.nome || "-"}</span>
                      <button
                        type="button"
                        onClick={() => copiarNome(g.nome)}
                        style={estilos.btnCopiar}
                        title="Copiar o nome do aluno"
                      >
                        {nomeCopiado === g.nome ? "✓ Copiado" : "📋 Copiar"}
                      </button>
                      <span style={A.cardCpf}>CPF {formatCpf(g.cpf)}</span>
                      {g.titulos[0]?.matricula && <span style={A.cardCpf}>mat. {g.titulos[0].matricula}</span>}
                      {g.titulos[0]?.campus && <span style={A.cardCpf}>{g.titulos[0].campus}</span>}
                      {g.outrasDividas ? (
                        <span style={estilos.seloAtencao} title="O aluno segue em cobrança pelas outras dívidas">
                          tem outras dívidas
                        </span>
                      ) : (
                        <span style={estilos.selo} title="Só este(s) título(s) em aberto: o caso não ocupa vaga enquanto espera">
                          só aguarda esta decisão
                        </span>
                      )}
                    </div>
                    <div style={A.cardHeadDir}>
                      <span style={A.cardResumo}>
                        {g.titulos.length} título{g.titulos.length > 1 ? "s" : ""} · {moeda(g.total)}
                      </span>
                      <span style={A.cardUnidade}>{g.responsavel}</span>
                      {g.titulos.length > 1 && (
                        <button
                          type="button"
                          style={{ ...A.btnConf, ...(processando[`val-lote:${g.chave}`] ? A.btnBusy : {}) }}
                          disabled={!!processando[`val-lote:${g.chave}`]}
                          onClick={() => validarComoGestao(g.titulos, g.chave)}
                          title="Você conferiu na tela do Prime: aplica a sua decisão a todos os títulos deste aluno"
                        >
                          Validar os {g.titulos.length}
                        </button>
                      )}
                      {g.titulos.length > 1 && (
                        <button
                          type="button"
                          style={{ ...estilos.btnRejeitar, ...(processando[`lote:${g.chave}`] ? A.btnBusy : {}) }}
                          disabled={!!processando[`lote:${g.chave}`]}
                          onClick={() => rejeitar(g.titulos, g.chave)}
                          title="Devolve todos os títulos deste aluno para a cobrança"
                        >
                          Rejeitar os {g.titulos.length}
                        </button>
                      )}
                      {g.alunoId && (
                        <button
                          type="button"
                          style={A.btnFicha}
                          onClick={() => setFichaId(g.alunoId)}
                          title="Abrir a ficha para conferir o caso antes de decidir"
                        >
                          Abrir ficha
                        </button>
                      )}
                    </div>
                  </div>

                  <table style={A.tabela}>
                    <thead>
                      <tr>
                        <th style={A.th}>Boleto</th>
                        <th style={A.th}>Vencimento</th>
                        <th style={A.th}>Liquidado na Prime</th>
                        <th style={A.th}>Classificação</th>
                        <th style={A.thNum}>Valor</th>
                        <th style={A.th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.titulos.map((t) => {
                        const busy = !!processando[t.titulo_id];
                        const sub = SUBGRUPO[t.subgrupo] || { rotulo: t.subgrupo, dica: "" };
                        const decideComMotivo = t.subgrupo === "A2_NAO_COBRE" || t.subgrupo === "A2_INCONCLUSIVO";
                        const regraNova = REGRA_NOVA.has(t.subgrupo);
                        const semProva = t.subgrupo === "C_SEM_PROVA";
                        const ev = t.evidencia || {};
                        return (
                          <tr key={t.titulo_id}>
                            <td style={A.td}>{t.documento || "-"}</td>
                            <td style={A.td}>{dia(t.vencimento)}</td>
                            <td style={A.td}>
                              {dia(t.liquidado_em)}
                              {!regraNova && (
                                <span style={estilos.seloComDinheiro}>
                                  {CORROBORACAO[t.corroboracao] || t.corroboracao}
                                </span>
                              )}
                            </td>
                            <td style={A.td}>
                              <span
                                style={semProva ? estilos.seloAlerta : String(t.subgrupo || "").startsWith("A2") ? estilos.seloAtencao : estilos.selo}
                                title={sub.dica}
                              >
                                {sub.rotulo}
                                {t.acordo_numero ? ` · acordo ${t.acordo_numero}` : ""}
                              </span>
                              {regraNova && (
                                <ul style={estilos.evidencias} title="Evidências encontradas pela regra de entrada">
                                  {evidencias(t).map((e, i) => (
                                    <li key={i} style={e.ok === true ? estilos.evOk : e.ok === false ? estilos.evFalta : estilos.evNeutra}>
                                      {e.ok === true ? "✓ " : e.ok === false ? "✗ " : "· "}{e.texto}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {t.revisao_obrigatoria && (
                                <span
                                  style={estilos.seloAlerta}
                                  title="O aluno tem acordo cancelado no histórico. Isso sozinho não impede a liquidação, mas a decisão exige motivo."
                                >
                                  acordo cancelado no histórico
                                </span>
                              )}
                              <div style={estilos.triagemLinha}>
                                {t.prioridade && (
                                  <span style={{ ...estilos.seloTriagem, ...corSelo(PRIORIDADE[t.prioridade]?.cor) }} title={(t.triagem?.motivos || []).join(" · ") || "sem motivo registrado"}>
                                    {PRIORIDADE[t.prioridade]?.rotulo || t.prioridade}
                                  </span>
                                )}
                                {t.origem_provavel && (
                                  <span style={estilos.seloTriagem} title="Origem provável pela triagem automática (não é prova)">
                                    {ORIGEM[t.origem_provavel] || t.origem_provavel}
                                  </span>
                                )}
                                {t.grupo_historico && (
                                  <span style={estilos.seloTriagem}>{GRUPO_HIST[t.grupo_historico] || t.grupo_historico}</span>
                                )}
                                {Number(t.dias_pendente) > 0 && (
                                  <span style={estilos.seloTriagem}>{t.dias_pendente} dia{t.dias_pendente > 1 ? "s" : ""} pendente</span>
                                )}
                                {t.classe_humana && (
                                  <span style={{ ...estilos.seloTriagem, ...corSelo("verde") }} title={`${t.classe_humana_obs || ""} (${t.classe_humana_por || "?"}, ${dia(t.classe_humana_em)})`}>
                                    ✓ {(CLASSES_HUMANAS.find(([c]) => c === t.classe_humana) || [])[1] || t.classe_humana}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td style={A.tdNum}>{moeda(t.valor)}</td>
                            <td style={A.td}>
                              <div style={A.acoes}>
                                {ADMINISTRATIVAS.has(t.classe_humana) && (
                                  <button
                                    type="button"
                                    style={{ ...estilos.btnRejeitar, ...(processando[`enc:${t.titulo_id}`] ? A.btnBusy : {}) }}
                                    disabled={!!processando[`enc:${t.titulo_id}`]}
                                    onClick={() => encerrarAdministrativo(t)}
                                    title="Saída administrativa: o título sai da base (CANCELADA), sem pagamento, acordo ou recuperação"
                                  >
                                    Encerrar administrativamente
                                  </button>
                                )}
                                <button
                                  type="button"
                                  style={A.btnFicha}
                                  onClick={() => abrirDecisao(t)}
                                  title="Abre a ficha de decisão: evidências, pagamentos, acordos, contrato, narrativas e o mesmo evento na Prime"
                                >
                                  Decidir
                                </button>
                                {semProva ? (
                                  <>
                                    <span style={estilos.manter} title="Sem prova, o título fica em confirmação: não é pago, não é negociado, não é cobrado">
                                      mantido em confirmação
                                    </span>
                                    {ev.acordo_candidato && (
                                      <button
                                        type="button"
                                        style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                        disabled={busy}
                                        onClick={() => vincularComMotivo(t, ev.acordo_candidato)}
                                        title={`Vincula ao acordo ${ev.acordo_candidato.numero}, com motivo`}
                                      >
                                        Vincular acordo {ev.acordo_candidato.numero}
                                      </button>
                                    )}
                                    {ev.pagamento_candidato_id && (
                                      <button
                                        type="button"
                                        style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                        disabled={busy}
                                        onClick={() => seguirPagamento(t)}
                                        title="O título volta ao fluxo oficial de pagamento; o motor conclui"
                                      >
                                        Seguir pagamento
                                      </button>
                                    )}
                                  </>
                                ) : decideComMotivo ? (
                                  <>
                                    {t.acordo_id && (
                                      <button
                                        type="button"
                                        style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                        disabled={busy}
                                        onClick={() => vincularComMotivo(t)}
                                        title="Vincula ao acordo sugerido, com motivo"
                                      >
                                        Vincular
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                      disabled={busy}
                                      onClick={() => baixarComMotivo(t)}
                                      title="Dá baixa sem vincular, com motivo"
                                    >
                                      Baixar
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                    disabled={busy}
                                    onClick={() => confirmar(t)}
                                    title={sub.dica}
                                  >
                                    {busy ? "Processando..." : VINCULA_DIRETO.has(t.subgrupo) ? "Vincular ao acordo" : "Confirmar"}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                  disabled={busy}
                                  onClick={() => validarComoGestao([t], `boleto ${t.documento}`)}
                                  title="Você conferiu na tela do Prime: aplica a sua decisão, com o que viu registrado"
                                >
                                  Validar
                                </button>
                                <button
                                  type="button"
                                  style={{ ...estilos.btnRejeitar, ...(busy ? A.btnBusy : {}) }}
                                  disabled={busy}
                                  onClick={() => rejeitar([t], `boleto ${t.documento}`)}
                                  title="A liquidação não vale: o título volta a ser cobrado"
                                >
                                  Rejeitar
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {decisao && (
        <div style={A.modalOverlay} onClick={() => setDecisao(null)}>
          <div style={{ ...A.modalBox, maxWidth: 980 }} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <span style={A.modalTitulo}>Ficha de decisão · boleto {decisao.titulo.documento} · {moeda(decisao.titulo.valor)}</span>
              <button type="button" style={{ ...A.modalFechar, marginLeft: "auto" }} onClick={() => setDecisao(null)}>Fechar ✕</button>
            </div>
            <div style={{ ...A.modalConteudo, padding: 16 }}>
              {decisaoCarregando && <Carregando texto="Reunindo evidências…" />}
              {decisao.erro && <div style={A.erroBox}>⚠️ {decisao.erro}</div>}
              {decisao.dados && <FichaDecisao dados={decisao.dados} />}
              <div style={estilos.classeBox}>
                <div style={estilos.classeTitulo}>O que apareceu no Prime? <span style={A.muted}>(só registra; nenhum efeito financeiro)</span></div>
                <div style={estilos.classeBotoes}>
                  {CLASSES_HUMANAS.map(([c, r]) => (
                    <button
                      key={c}
                      type="button"
                      style={{ ...(decisao.titulo.classe_humana === c ? A.btnConf : A.btnGhost), ...(processando[`classe:${decisao.titulo.titulo_id}`] ? A.btnBusy : {}) }}
                      disabled={!!processando[`classe:${decisao.titulo.titulo_id}`]}
                      onClick={() => classificarHumano(decisao.titulo, c)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                {ADMINISTRATIVAS.has(decisao.titulo.classe_humana) && (
                  <div style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      style={{ ...estilos.btnRejeitar, ...(processando[`enc:${decisao.titulo.titulo_id}`] ? A.btnBusy : {}) }}
                      disabled={!!processando[`enc:${decisao.titulo.titulo_id}`]}
                      onClick={() => encerrarAdministrativo(decisao.titulo)}
                    >
                      Encerrar administrativamente (sai da base, sem efeito financeiro)
                    </button>
                  </div>
                )}
                {decisao.titulo.classe_humana && (
                  <p style={A.muted}>
                    Classificado como <b>{(CLASSES_HUMANAS.find(([c]) => c === decisao.titulo.classe_humana) || [])[1]}</b>
                    {decisao.titulo.classe_humana_por ? ` por ${decisao.titulo.classe_humana_por}` : ""} em {dia(decisao.titulo.classe_humana_em)}: {decisao.titulo.classe_humana_obs}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {fichaId && (
        <div style={A.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <span style={A.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...A.modalFechar, marginLeft: "auto" }}
                onClick={() => setFichaId(null)}
              >
                Fechar ✕
              </button>
            </div>
            <div style={{ padding: "0 16px" }}>
              <DadosAcademicos aluno={{ id: fichaId }} />
            </div>
            <div style={A.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function corSelo(cor) {
  if (cor === "vermelho") return { background: "var(--rv-vermelho-fundo)", color: "var(--rv-vermelho-texto)", borderColor: "var(--rv-vermelho-borda)" };
  if (cor === "ambar") return { background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)", borderColor: "var(--rv-ambar-borda)" };
  if (cor === "roxo") return { background: "var(--rv-roxo-fundo)", color: "var(--rv-roxo-texto)", borderColor: "var(--rv-roxo-borda)" };
  if (cor === "verde") return { background: "var(--rv-verde-ok-fundo)", color: "var(--rv-verde-ok-texto)", borderColor: "var(--rv-verde-ok-borda)" };
  return {};
}

function Bloco({ titulo, children }) {
  return (
    <div style={estilos.bloco}>
      <div style={estilos.blocoTitulo}>{titulo}</div>
      {children}
    </div>
  );
}

function FichaDecisao({ dados }) {
  const t = dados.titulo || {};
  const a = dados.aluno || {};
  const d = dados.decisao || {};
  const ev = dados.evidencias || {};
  const tri = d.triagem || {};
  const prime = ev.prime || {};
  const linha = (r, v) => (
    <div style={estilos.kv}><span style={estilos.k}>{r}</span><span>{v ?? "-"}</span></div>
  );
  return (
    <div style={estilos.ficha}>
      <Bloco titulo="Título">
        {linha("Boleto", t.documento)}
        {linha("Vencimento", dia(t.vencimento))}
        {linha("Valor", moeda(t.valor))}
        {linha("Situação", `${t.situacao || "-"} / ${t.status || "-"}`)}
        {linha("Importado em", dia(t.importado_em))}
        {linha("Grupo histórico", GRUPO_HIST[tri.grupo_historico] || tri.grupo_historico)}
        {linha("Motivo de entrada", d.motivo_entrada)}
      </Bloco>
      <Bloco titulo="Aluno">
        {linha("Nome", a.nome)}
        {linha("CPF", formatCpf(a.cpf))}
        {linha("Matrícula", a.matricula)}
        {linha("Campus / curso", `${a.campus || "-"} · ${a.curso || "-"}`)}
        {linha("Situação operacional", a.situacao_operacional)}
        {linha("Situação acadêmica", a.situacao_academica)}
        {linha("Responsável", a.responsavel)}
      </Bloco>
      <Bloco titulo="Triagem automática (não é prova)">
        {linha("Prioridade", PRIORIDADE[tri.prioridade]?.rotulo || tri.prioridade)}
        {linha("Origem provável", ORIGEM[tri.origem_provavel] || tri.origem_provavel)}
        {linha("Motivos", (tri.motivos || []).join(" · ") || "-")}
        {linha("Triada em", d.triagem_em ? new Date(d.triagem_em).toLocaleString("pt-BR") : "-")}
      </Bloco>
      <Bloco titulo="Evidência Prime">
        {linha("Liquidado em", dia(prime.liquidado_em))}
        {linha("Portador", prime.portador)}
        {linha("Valor bruto / valor pago", `${moeda(prime.valor_bruto)} / ${moeda(prime.valor_pago)} (valor pago não é caixa)`)}
        {linha("CPF confere", prime.cpf_confere === undefined ? "-" : prime.cpf_confere ? "sim" : "NÃO")}
        {linha("Liquidação real", prime.liquidacao_real === undefined ? "-" : prime.liquidacao_real ? "sim" : "não")}
        {linha("Portador 166", ev.no_portador_166 === undefined ? "-" : ev.no_portador_166 ? "sim" : "não")}
      </Bloco>
      <Bloco titulo={`Pagamentos ReATIVA próximos (${(ev.pagamentos_proximos || []).length})`}>
        {(ev.pagamentos_proximos || []).length === 0 ? <p style={A.muted}>Nenhum pagamento até 10 dias da liquidação.</p> : (
          <ul style={estilos.lista}>
            {(ev.pagamentos_proximos || []).map((p, i) => (
              <li key={i}>{dia(p.data)} · {moeda(p.valor)} · {p.status_conciliacao || "-"} · boleto {p.boleto || "-"}{p.cobre_o_titulo ? " · cobre o título" : ""}</li>
            ))}
          </ul>
        )}
      </Bloco>
      <Bloco titulo="Acordos">
        {ev.vinculo_ativo && linha("Vínculo ativo", `acordo ${ev.vinculo_ativo.numero} (${ev.vinculo_ativo.status})`)}
        {ev.acordo_composicao && linha("Composição documental", `acordo ${ev.acordo_composicao.numero} (${ev.acordo_composicao.status}) · pago de verdade: ${ev.acordo_composicao.pago_de_verdade?.suficiente ? "sim" : "não"}`)}
        {ev.acordo_candidato && linha("Acordo perto da data", `acordo ${ev.acordo_candidato.numero} (${ev.acordo_candidato.status}) · criado ${dia(ev.acordo_candidato.criado_em)}`)}
        {linha("Acordos no CRM", tri.evidencias_resumo?.acordos_crm || "nenhum")}
        {linha("Acordo cancelado no histórico", ev.acordo_cancelado_no_historico ? "sim" : "não")}
      </Bloco>
      <Bloco titulo={`Contratos Prime (${(dados.contratos || []).length})`}>
        {(dados.contratos || []).length === 0 ? <p style={A.muted}>Sem contrato coletado.</p> : (
          <ul style={estilos.lista}>
            {(dados.contratos || []).map((c, i) => (
              <li key={i}>{c.status} · {c.tipo || "-"} · {c.turno || "-"} · {dia(c.valid_from)} a {dia(c.valid_to)}{c.cancelado_em ? ` · cancelado em ${dia(c.cancelado_em)}` : ""} · mat. {c.registration || "-"}</li>
            ))}
          </ul>
        )}
      </Bloco>
      <Bloco titulo={`Mesmo evento na Prime (${(dados.mesmo_evento || []).length} outros boletos liquidados no mesmo dia)`}>
        {(dados.mesmo_evento || []).length === 0 ? <p style={A.muted}>Nenhum outro boleto do aluno liquidado nesse dia.</p> : (
          <ul style={estilos.lista}>
            {(dados.mesmo_evento || []).map((x, i) => (
              <li key={i}>boleto {x.boleto} · portador {x.portador} {x.portador_nome ? `(${x.portador_nome})` : ""} · venc. {dia(x.vencimento)} · {moeda(x.valor_bruto)}</li>
            ))}
          </ul>
        )}
      </Bloco>
      <Bloco titulo={`Outros títulos do aluno na fila (${(dados.outros_na_fila || []).length})`}>
        {(dados.outros_na_fila || []).length === 0 ? <p style={A.muted}>Nenhum.</p> : (
          <ul style={estilos.lista}>
            {(dados.outros_na_fila || []).map((x, i) => (
              <li key={i}>boleto {x.documento} · {moeda(x.valor)} · liq. {dia(x.liquidado_em)} · {PRIORIDADE[x.prioridade]?.rotulo || x.prioridade || "-"}{x.classe_humana ? ` · ✓ ${x.classe_humana}` : ""}</li>
            ))}
          </ul>
        )}
      </Bloco>
      <Bloco titulo={`Solicitações ao financeiro (${(dados.solicitacoes || []).length})`}>
        {(dados.solicitacoes || []).length === 0 ? <p style={A.muted}>Nenhuma.</p> : (
          <ul style={estilos.lista}>
            {(dados.solicitacoes || []).map((x, i) => (
              <li key={i}>{dia(x.em)} · {x.tipo} · {x.status} · {x.motivo || "-"}{x.retorno ? ` → ${x.retorno}` : ""}</li>
            ))}
          </ul>
        )}
      </Bloco>
      <Bloco titulo={`Narrativas recentes (${(dados.narrativas || []).length})`}>
        {(dados.narrativas || []).length === 0 ? <p style={A.muted}>Nenhuma.</p> : (
          <ul style={estilos.lista}>
            {(dados.narrativas || []).map((x, i) => (
              <li key={i}>{dia(x.em)} · {x.tipo} · {x.texto}</li>
            ))}
          </ul>
        )}
      </Bloco>
    </div>
  );
}

const estilos = {
  painel: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  painelCard: { display: "flex", flexDirection: "column", minWidth: 92, padding: "8px 12px", borderRadius: 10, background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)" },
  painelNum: { fontSize: 20, fontWeight: 800, color: "var(--rv-texto)" },
  painelRotulo: { fontSize: 11, color: "var(--rv-texto-suave)" },
  painelOrigens: { flexBasis: "100%", display: "flex", flexWrap: "wrap", gap: 6 },
  painelOrigem: { fontSize: 11.5, border: "1px solid var(--rv-borda)", borderRadius: 999, padding: "3px 10px", color: "var(--rv-texto)", background: "var(--rv-superficie)" },
  filtros: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, alignItems: "center" },
  rotuloData: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--rv-texto-suave)" },
  triagemLinha: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 },
  seloTriagem: { fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: "2px 8px", border: "1px solid var(--rv-borda)", background: "var(--rv-superficie)", color: "var(--rv-texto-suave)", whiteSpace: "nowrap" },
  ficha: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 10 },
  bloco: { border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "10px 12px", background: "var(--rv-superficie)", fontSize: 12.5 },
  blocoTitulo: { fontWeight: 800, fontSize: 12, marginBottom: 6, color: "var(--rv-texto)" },
  kv: { display: "flex", gap: 8, lineHeight: 1.5 },
  k: { minWidth: 150, color: "var(--rv-texto-suave)" },
  lista: { margin: 0, paddingLeft: 18, lineHeight: 1.5 },
  classeBox: { marginTop: 14, borderTop: "1px solid var(--rv-borda)", paddingTop: 12 },
  classeTitulo: { fontWeight: 800, fontSize: 13, marginBottom: 8 },
  classeBotoes: { display: "flex", flexWrap: "wrap", gap: 8 },
  // evidências da regra de entrada: o que foi encontrado e o que falta
  evidencias: { listStyle: "none", margin: "6px 0 0", padding: 0, fontSize: 11.5, lineHeight: 1.45, color: "var(--rv-texto-suave)" },
  evOk: { color: "var(--rv-verde-ok-texto)" },
  evFalta: { color: "var(--rv-vermelho-texto)" },
  evNeutra: { color: "var(--rv-texto-suave)" },
  manter: { fontSize: 11.5, fontWeight: 700, color: "var(--rv-texto-suave)", border: "1px dashed var(--rv-borda-forte)", borderRadius: 8, padding: "5px 10px", whiteSpace: "nowrap" },
  seloComDinheiro: { marginLeft: 6, fontSize: 11, fontWeight: 800, color: "var(--rv-verde-ok-texto)", background: "var(--rv-verde-ok-fundo)", border: "1px solid var(--rv-verde-ok-borda)", borderRadius: 999, padding: "2px 8px" },
  btnCopiar: { background: "var(--rv-superficie)", color: "var(--rv-texto)", border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "3px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  btnRejeitar: { background: "var(--rv-superficie)", color: "var(--rv-vermelho-texto)", border: "1px solid var(--rv-vermelho-borda)", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  aviso: {
    background: "var(--rv-ambar-fundo)",
    border: "1px solid var(--rv-ambar-borda)",
    color: "var(--rv-ambar-texto)",
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 13,
    lineHeight: 1.5,
    marginBottom: 14,
  },
  seloAlerta: {
    marginLeft: 6,
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "2px 10px",
    background: "var(--rv-vermelho-fundo)",
    color: "var(--rv-vermelho-texto)",
    border: "1px solid var(--rv-vermelho-borda)",
    whiteSpace: "nowrap",
  },
  seloAtencao: {
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "2px 10px",
    background: "var(--rv-ambar-fundo)",
    color: "var(--rv-ambar-texto)",
    border: "1px solid var(--rv-ambar-borda)",
    whiteSpace: "nowrap",
  },
  selo: {
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "2px 10px",
    background: "var(--rv-roxo-fundo)",
    color: "var(--rv-roxo-texto)",
    border: "1px solid var(--rv-roxo-borda)",
    whiteSpace: "nowrap",
  },
};
