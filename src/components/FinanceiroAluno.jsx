import { useEffect, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import { podeGerirFinanceiro, nomeOperadorPorEmail, OPERADORES_POR_EMAIL } from "../utils/operadores";

function formatarData(data) {
  if (!data) return "-";
  return new Date(data + "T00:00:00").toLocaleDateString("pt-BR");
}

function moeda(valor) {
  if (valor == null) return "-";
  return Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarDataSimples(data) {
  if (!data) return "-";
  try {
    const partes = String(data).slice(0, 10).split("-");
    if (partes.length === 3) {
      const [ano, mes, dia] = partes;
      return `${dia}/${mes}/${ano}`;
    }
    return new Date(data).toLocaleDateString("pt-BR");
  } catch {
    return "-";
  }
}

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function somarMeses(dataISO, meses) {
  const [ano, mes, dia] = String(dataISO).split("-").map(Number);
  const totalMeses = mes - 1 + meses;
  const anoFinal = ano + Math.floor(totalMeses / 12);
  const mesFinal = (totalMeses % 12) + 1;
  const ultimoDiaMes = new Date(anoFinal, mesFinal, 0).getDate();
  const diaFinal = Math.min(dia, ultimoDiaMes);
  return `${anoFinal}-${String(mesFinal).padStart(2, "0")}-${String(diaFinal).padStart(2, "0")}`;
}

// Campo de data dentro de um <label> às vezes não repassa o clique certo
// pro seletor nativo do navegador (foca o campo, mas não abre o
// calendário). Forçando o showPicker() no clique, garante que abre
// sempre -- em navegadores sem suporte a essa API, cai pro comportamento
// padrão sem quebrar nada.
function abrirCalendario(evento) {
  try {
    evento.target.showPicker?.();
  } catch {
    // Sem suporte a showPicker() nesse navegador -- segue o clique normal.
  }
}

function paraNumero(v) {
  let t = String(v || "").replace("R$", "").replace(/\s/g, "").trim();
  const temVirgula = t.includes(",");
  const temPonto = t.includes(".");
  if (temVirgula && temPonto) t = t.replace(/\./g, "").replace(",", ".");
  else if (temVirgula) t = t.replace(",", ".");
  return Number(t) || 0;
}

function paraDataISO(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let d = m[1], mo = m[2], ano = m[3];
    if (ano.length === 2) ano = "20" + ano;
    return `${ano}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

function paraDataBR(v) {
  const t = String(v || "").trim();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return t;
}

const STATUS_PARCELA_LABEL = {
  A_VENCER: "A vencer",
  VENCIDA: "Vencida",
  PAGO: "Paga",
  CANCELADA: "Cancelada",
};

const CORES_STATUS = {
  em_aberto: { barra: "#185FA5", bg: "rgba(24,95,165,0.16)", texto: "#7cb5f0", label: "Em aberto" },
  em_dia: { barra: "#639922", bg: "rgba(99,153,34,0.18)", texto: "#a3d15f", label: "Em dia" },
  atraso: { barra: "#EF9F27", bg: "rgba(239,159,39,0.18)", texto: "#f2c67a", label: "Em atraso" },
  vencida: { barra: "#E24B4A", bg: "rgba(226,75,74,0.18)", texto: "#f0999a", label: "Vencida" },
  quebrado: { barra: "#E24B4A", bg: "rgba(226,75,74,0.18)", texto: "#f0999a", label: "Quebrado" },
  quitado: { barra: "#1D9E75", bg: "rgba(29,158,117,0.18)", texto: "#6fd7b6", label: "Quitado" },
  cancelado: { barra: "#64748b", bg: "rgba(100,116,139,0.18)", texto: "#94a3b8", label: "Cancelado" },
};

function diasAtraso(venc) {
  if (!venc) return -9999;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  return Math.floor((hoje - new Date(String(venc).slice(0, 10) + "T00:00:00")) / 86400000);
}

function statusAcordo(acordo, parcelas) {
  if (acordo?.status === "CANCELADO") {
    return "cancelado";
  }
  if (acordo?.status === "QUITADO" || (parcelas.length > 0 && parcelas.every((p) => p.status === "PAGO"))) {
    return "quitado";
  }
  let maiorAtraso = -9999;
  let algumaPaga = false;
  let algumaVencida = false;
  parcelas.forEach((p) => {
    if (p.status === "PAGO") {
      algumaPaga = true;
      return;
    }
    const dl = diasAtraso(p.vencimento);
    if (dl > 0) {
      algumaVencida = true;
      if (dl > maiorAtraso) maiorAtraso = dl;
    }
  });
  if (maiorAtraso > 30) return "quebrado";
  if (algumaVencida) return "atraso";
  // Um acordo novo, sem nenhuma parcela vencida (mesmo que ainda nenhuma
  // tenha sido paga), já está "em dia" -- antes só virava "em dia" depois
  // da primeira baixa, e até lá aparecia como "em aberto", o que passava
  // a ideia errada de que já tinha algo pendurado.
  return "em_dia";
}

function valorTitulo(t) {
  return Number(t.valor_em_aberto || t.saldo_corrigido || t.valor_original || 0);
}

function novoAcordoInicial() {
  return {
    valorTotal: "",
    qtdParcelas: "1",
    temEntrada: false,
    entradaRs: "",
    entradaPct: "",
    entradaPaga: true,
    dataEntrada: paraDataBR(hojeISO()),
    honorariosEntrada: "0",
    honorarios: "",
    primeiroVenc: paraDataBR(somarMeses(hojeISO(), 1)),
    titulosSel: [],
    parcelas: [],
  };
}

// Cadastro manual de mensalidade -- pra corrigir caso que ficou de fora
// de algum bordero (não é o fluxo normal, que é a importação em lote).
function mensalidadeManualInicial() {
  return {
    documento: "",
    vencimento: "",
    valor: "",
    valorAberto: "",
    tipoBoleto: "",
    competencia: "",
    motivo: "",
  };
}

export default function FinanceiroAluno({ aluno }) {
  const [titulos, setTitulos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [acordos, setAcordos] = useState([]);
  const [parcelasPorAcordo, setParcelasPorAcordo] = useState({});
  // Saldo oficial vindo da fonte unica no banco (RPC SECURITY DEFINER).
  // Necessario porque acordos/parcelas tem RLS por responsavel: quem abre o
  // card sem ser o dono via SELECT direto voltar vazio e o resumo mostrava
  // "0 parcela(s)" mesmo com parcelas em aberto. O RPC ignora o RLS e usa
  // exatamente os mesmos filtros do total, garantindo valor e quantidade
  // pela MESMA fonte.
  const [saldoOficial, setSaldoOficial] = useState(null);
  const [usuario, setUsuario] = useState(null);
  const [recarga, setRecarga] = useState(0);
  const [titulosSelecionaveis, setTitulosSelecionaveis] = useState([]);
  const [acordoAlvoId, setAcordoAlvoId] = useState("");
  const [novoAberto, setNovoAberto] = useState(true);
  const [novo, setNovo] = useState(novoAcordoInicial());

  const [formMensalidadeAberto, setFormMensalidadeAberto] = useState(false);
  const [novaMensalidade, setNovaMensalidade] = useState(mensalidadeManualInicial());
  const [salvandoMensalidade, setSalvandoMensalidade] = useState(false);
  const [erroMensalidade, setErroMensalidade] = useState("");
  // Trava de execução única: garante que um duplo-clique (ou clique enquanto
  // o insert ainda está em voo) não crie dois títulos. O disabled do botão
  // cobre o caso normal; o ref cobre a corrida antes do setState propagar.
  const salvandoMensalidadeRef = useRef(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUsuario(data?.user || null));
  }, []);

  useEffect(() => {
    // Vínculo SEMPRE por aluno_id (matrícula), NUNCA por CPF -- o mesmo CPF
    // pode ter mais de uma matrícula e carregar por CPF misturava títulos de
    // matrículas diferentes no card.
    if (!aluno?.id) {
      setTitulos([]);
      setCarregando(false);
      return;
    }

    async function carregar() {
      setCarregando(true);
      const { data } = await supabase
        .from("acordos_titulos")
        .select("id, acordo_id, documento, vencimento, valor_original, saldo_corrigido, valor_em_aberto, situacao, tipo_boleto, status")
        .eq("aluno_id", String(aluno.id))
        .order("vencimento", { ascending: true });

      // Em aberto no topo; depois por vencimento (mantido da query).
      const emAbertoPrimeiro = (data || []).slice().sort((a, b) => {
        const aAberto = String(a.status || "").toLowerCase() === "em_aberto" && a.situacao !== "PAGO" ? 0 : 1;
        const bAberto = String(b.status || "").toLowerCase() === "em_aberto" && b.situacao !== "PAGO" ? 0 : 1;
        if (aAberto !== bAberto) return aAberto - bAberto;
        return String(a.vencimento || "").localeCompare(String(b.vencimento || ""));
      });

      setTitulos(emAbertoPrimeiro);
      setCarregando(false);
    }

    carregar();
    // recarga entra aqui pra lista de "Total em aberto"/títulos recarregar
    // depois de criar um acordo -- sem isso, as mensalidades recém-vinculadas
    // continuavam aparecendo como em aberto até dar refresh na página.
  }, [aluno?.id, recarga]);

  useEffect(() => {
    if (!aluno?.id) {
      setAcordos([]);
      setParcelasPorAcordo({});
      setTitulosSelecionaveis([]);
      return;
    }

    async function carregarAcordos() {
      const { data: acordosData } = await supabase
        .from("acordos")
        .select("*")
        .eq("aluno_id", String(aluno.id))
        .order("criado_em", { ascending: false });

      setAcordos(acordosData || []);

      if (acordosData && acordosData.length > 0) {
        const ids = acordosData.map((a) => a.id);
        const { data: parcelasData } = await supabase
          .from("parcelas")
          .select("*")
          .in("acordo_id", ids)
          .order("numero", { ascending: true });

        const agrupado = {};
        (parcelasData || []).forEach((p) => {
          if (!agrupado[p.acordo_id]) agrupado[p.acordo_id] = [];
          agrupado[p.acordo_id].push(p);
        });
        setParcelasPorAcordo(agrupado);
      } else {
        setParcelasPorAcordo({});
      }

      const { data: titulosData } = await supabase
        .from("acordos_titulos")
        .select("id, documento, vencimento, valor_original, saldo_corrigido, valor_em_aberto, status")
        .eq("aluno_id", String(aluno.id))
        .eq("status", "em_aberto")
        .order("vencimento", { ascending: true });
      setTitulosSelecionaveis(titulosData || []);
    }

    carregarAcordos();
  }, [aluno?.id, recarga]);

  // Fonte unica do saldo (nao depende de RLS de acordos/parcelas).
  useEffect(() => {
    const id = aluno?.id;
    if (!id) {
      setSaldoOficial(null);
      return;
    }
    let ativo = true;
    (async () => {
      const { data, error } = await supabase.rpc("aluno_saldo_pendente_detalhe", {
        p_aluno_id: id,
      });
      if (!ativo) return;
      setSaldoOficial(error ? null : data || null);
    })();
    return () => {
      ativo = false;
    };
  }, [aluno?.id, recarga]);

  const podeBaixar = podeGerirFinanceiro(usuario?.email || "");

  // HOTFIX quitacao parcial (24/07/2026)
  //
  // A versao anterior desta funcao decidia a quitacao olhando SOMENTE as
  // parcelas do acordo. Ela nunca consultava acordos_titulos, entao um
  // aluno com o acordo quitado mas com mensalidade avulsa em aberto era
  // gravado como QUITADO e saia da carteira -- direto pelo frontend.
  //
  // Agora quem decide e o banco, em transacao unica, via a fonte unica de
  // saldo (aluno_saldo_pendente_detalhe). O frontend nao faz mais nenhum
  // UPDATE de status para QUITADO nem mexe em carteira_operador.
  async function checarQuitacao(acordoId) {
    const { data, error } = await supabase.rpc("avaliar_quitacao_aluno", {
      p_aluno_id: aluno?.id ? String(aluno.id) : null,
      p_acordo_id: acordoId,
      p_ignorar_confirmacao_id: null,
    });

    if (error) {
      console.error("Erro ao avaliar quitacao:", error);
      alert("Pagamento registrado, mas nao foi possivel reavaliar a quitacao: " + error.message);
      return null;
    }

    // Quando sobra saldo, a RPC nao quita nada e devolve o detalhamento --
    // serve pro operador entender por que o aluno continua na fila.
    if (data && data.quitou_aluno === false) {
      const d = data.detalhe || {};
      console.info("Aluno segue com saldo pendente:", d);
    }
    return data;
  }

  async function baixarParcela(acordo, parcela, dados) {
    // Baixa/confirmação/estorno de pagamento: SOMENTE gestão financeira
    // (Amanda, Fernanda/supervisão, Amanda ADM). O operador envia o comprovante
    // para a Fila de Confirmação; não efetiva baixa direta em baixas_pagamento.
    if (!podeBaixar) { alert("Baixa de pagamento é exclusiva da gestão financeira. Envie o comprovante para a Fila de Confirmação."); return; }
    const agora = new Date().toISOString();
    const email = usuario?.email || "";
    const responsavelOperador = acordo.operador_responsavel_email || acordo.criado_por_email || null;
    // pago_em usa a data real informada no formulário (não a data em que a
    // baixa foi processada no sistema) -- isso importa pra lançamentos
    // retroativos não entrarem na visão "deste mês" do operador.
    const dataPagamento = dados.data ? new Date(dados.data + "T00:00:00").toISOString() : agora;

    const { error: erroParcela } = await supabase
      .from("parcelas")
      .update({ status: "PAGO", pago_em: dataPagamento, confirmado_por_email: email, atualizado_em: agora })
      .eq("id", parcela.id);

    if (erroParcela) {
      alert("Erro ao dar baixa na parcela: " + erroParcela.message);
      return;
    }

    const { error: erroBaixa } = await supabase.from("baixas_pagamento").insert({
      aluno_id: String(aluno.id),
      aluno_nome: aluno.nome || null,
      aluno_cpf: aluno.cpf || null,
      parcela_id: parcela.id,
      acordo_id: acordo.id,
      valor_pago: dados.valor,
      honorarios_recebidos: dados.honorarios,
      data_pagamento: dados.data,
      status_baixa: "REALIZADA",
      responsavel_baixa_email: responsavelOperador,
      baixado_por_email: email,
      recebido_em: agora,
      atualizado_em: agora,
      baixado_em: agora,
    });

    if (erroBaixa) {
      console.error("Erro ao registrar baixa:", erroBaixa);
      alert("Parcela baixada, mas houve erro ao registrar a baixa: " + erroBaixa.message);
    }

    const res = await checarQuitacao(acordo.id);
    setRecarga((r) => r + 1);
    alert(
      res && res.quitou_aluno === false
        ? "Baixa registrada. O aluno continua na carteira: ainda ha saldo em aberto de " +
          moeda(Number(res.detalhe?.total || 0)) + "."
        : "Baixa registrada."
    );
  }

  async function quitarCartao(acordo, parcelasAbertas, dados) {
    if (!podeBaixar) { alert("Quitação/baixa é exclusiva da gestão financeira. Envie o comprovante para a Fila de Confirmação."); return; }
    const agora = new Date().toISOString();
    const email = usuario?.email || "";
    const responsavelOperador = acordo.operador_responsavel_email || acordo.criado_por_email || null;
    const dataPagamento = dados.data ? new Date(dados.data + "T00:00:00").toISOString() : agora;

    const { error: erroParcelas } = await supabase
      .from("parcelas")
      .update({ status: "PAGO", pago_em: dataPagamento, confirmado_por_email: email, atualizado_em: agora })
      .eq("acordo_id", acordo.id)
      .neq("status", "PAGO");

    if (erroParcelas) {
      alert("Erro ao quitar as parcelas: " + erroParcelas.message);
      return;
    }

    const linhas = parcelasAbertas.map((p) => ({
      aluno_id: String(aluno.id),
      aluno_nome: aluno.nome || null,
      aluno_cpf: aluno.cpf || null,
      parcela_id: p.id,
      acordo_id: acordo.id,
      valor_pago: Number(p.valor || 0),
      honorarios_recebidos: p.honorarios != null ? Number(p.honorarios) : null,
      data_pagamento: dados.data,
      comprovante_url: dados.comprovante,
      status_baixa: "REALIZADA",
      responsavel_baixa_email: responsavelOperador,
      baixado_por_email: email,
      recebido_em: agora,
      atualizado_em: agora,
      baixado_em: agora,
    }));

    if (linhas.length > 0) {
      const { error: erroBaixa } = await supabase.from("baixas_pagamento").insert(linhas);
      if (erroBaixa) {
        console.error("Erro ao registrar baixas do cartão:", erroBaixa);
      }
    }

    const res = await checarQuitacao(acordo.id);
    setRecarga((r) => r + 1);
    alert(
      res && res.quitou_aluno === false
        ? "Acordo quitado no cartão. O aluno continua na carteira: ainda ha saldo em aberto de " +
          moeda(Number(res.detalhe?.total || 0)) + "."
        : "Acordo quitado no cartão."
    );
  }

  // Reverte uma baixa feita errada -- volta a parcela pra "a vencer" e some
  // com o registro de pagamento. Se essa baixa tinha sido a que quitou o
  // acordo inteiro, desfaz também os efeitos colaterais da quitação
  // (título voltando pra "vinculada", aluno voltando ativo na carteira).
  async function desfazerBaixa(acordo, parcela) {
    if (!podeBaixar) { alert("Estorno de baixa é exclusivo da gestão financeira."); return; }
    if (parcela.status !== "PAGO") return;

    const confirmado = window.confirm(
      `Desfazer a baixa da parcela ${parcela.numero} (${moeda(parcela.valor)})? Ela volta pra "a vencer" e sai do valor baixado do mês.`
    );
    if (!confirmado) return;

    const agora = new Date().toISOString();
    const email = usuario?.email || "";

    // baixas_pagamento não tem política de DELETE no banco -- um .delete()
    // aqui falha silenciosamente (sem erro, sem apagar nada) e deixa o
    // registro "fantasma", travando a exclusão do acordo depois. Em vez
    // de apagar, marca como devolvida (a tabela já tem campo pra isso).
    await supabase
      .from("baixas_pagamento")
      .update({
        status_baixa: "DEVOLVIDA",
        devolvido_por_email: email,
        devolvido_em: agora,
        motivo_devolucao: "Baixa desfeita na ficha do aluno (correção)",
      })
      .eq("parcela_id", parcela.id);

    const { error: erroParcela } = await supabase
      .from("parcelas")
      .update({ status: "A_VENCER", pago_em: null, confirmado_por_email: null, atualizado_em: agora })
      .eq("id", parcela.id);

    if (erroParcela) {
      alert("Erro ao desfazer a baixa: " + erroParcela.message);
      return;
    }

    if (acordo.status === "QUITADO") {
      const { data: parcelasAtuais } = await supabase
        .from("parcelas")
        .select("status, valor")
        .eq("acordo_id", acordo.id);

      const novoSaldo = (parcelasAtuais || [])
        .filter((p) => p.status !== "PAGO")
        .reduce((soma, p) => soma + Number(p.valor || 0), 0);

      await supabase
        .from("acordos")
        .update({ status: "ATIVO", saldo: novoSaldo, atualizado_em: agora })
        .eq("id", acordo.id);

      const { data: vinculos } = await supabase
        .from("acordo_titulo_vinculo")
        .select("titulo_id")
        .eq("acordo_id", acordo.id)
        .eq("ativo", true);
      const idsTitulos = (vinculos || []).map((v) => v.titulo_id);
      if (idsTitulos.length > 0) {
        await supabase
          .from("acordos_titulos")
          .update({ status: "vinculada", atualizado_em: agora })
          .in("id", idsTitulos);
      }

      if (aluno?.id) {
        await supabase
          .from("carteira_operador")
          .update({ status: "ativo", saiu_em: null })
          .eq("aluno_id", String(aluno.id))
          .eq("status", "quitado_saiu");

        // Espelha o que checarQuitacao faz -- se o aluno tinha sido
        // marcado como QUITADO por causa desse acordo, volta a ficar
        // ativo na fila (só reverte se ainda estiver como QUITADO; se já
        // foi mudado por outro motivo, não mexe).
        await supabase
          .from("alunos")
          .update({
            status_jornada: "EM_ATENDIMENTO",
            status_atual: "EM_ATENDIMENTO",
            status_acionamento: "EM_ATENDIMENTO",
            proxima_acao: "CONTATAR",
          })
          .eq("id", String(aluno.id))
          .eq("status_jornada", "QUITADO");
      }
    }

    setRecarga((r) => r + 1);
    alert("Baixa desfeita.");
  }

  // Exclui um acordo criado por engano -- bloqueia se já tiver parcela paga
  // ou baixa registrada (protege histórico financeiro real) e devolve os
  // títulos vinculados pro status "em_aberto", pra poderem entrar em outro
  // acordo depois.
  // Um aluno pode ter mais de um acordo, cada um tocado por um operador
  // diferente (ex: um da Amanda ADM, outro da Olga) -- puxar sempre do
  // responsável atual do aluno (1 valor só) não dá conta disso, por isso
  // dá pra trocar o responsável de cada acordo individualmente aqui.
  async function alterarResponsavelAcordo(acordo, novoEmail, motivo) {
    if (!novoEmail) { alert("Selecione o novo responsável do acordo."); return; }
    // Motivo é opcional: segue vazio quando não informado.
    const m = String(motivo || "").trim();
    // RPC manual segura (executor; so Amanda/Fernanda). Sem UPDATE direto.
    const { data: r, error } = await supabase.rpc("alterar_responsavel_acordo", {
      p_acordo_id: acordo.id, p_novo_email: novoEmail, p_motivo: m, p_origem: "financeiro_aluno",
    });
    if (error || !r?.ok) {
      alert("Nao foi possivel alterar o responsavel do acordo: " + (r?.erro || error?.message || "erro"));
      return;
    }
    setRecarga((x) => x + 1);
  }

  async function excluirAcordo(acordo) {
    const parcelas = parcelasPorAcordo[acordo.id] || [];

    if (parcelas.some((p) => p.status === "PAGO")) {
      alert(
        "Esse acordo já tem parcela paga -- não dá pra cancelar (protege o histórico financeiro). Se foi um erro, fale com quem confirmou o pagamento antes de mexer."
      );
      return;
    }

    const { data: baixasExistentes } = await supabase
      .from("baixas_pagamento")
      .select("id")
      .eq("acordo_id", acordo.id)
      .is("devolvido_em", null)
      .limit(1);

    if (baixasExistentes && baixasExistentes.length > 0) {
      alert("Esse acordo já tem alguma baixa/pagamento registrado -- não dá pra cancelar por aqui.");
      return;
    }

    const confirmado = window.confirm(
      `Cancelar esse acordo de ${moeda(acordo.valor_total)} em ${acordo.qtd_parcelas}x? Os títulos vinculados a ele voltam a ficar em aberto, pra poderem entrar num acordo novo.`
    );
    if (!confirmado) return;

    const agora = new Date().toISOString();

    const { data: vinculos } = await supabase
      .from("acordo_titulo_vinculo")
      .select("titulo_id")
      .eq("acordo_id", acordo.id);

    const idsTitulos = (vinculos || []).map((v) => v.titulo_id);

    if (idsTitulos.length > 0) {
      const { error: erroReverter } = await supabase
        .from("acordos_titulos")
        .update({ status: "em_aberto", atualizado_em: agora })
        .in("id", idsTitulos);
      if (erroReverter) {
        alert("Erro ao devolver os títulos pro status em aberto: " + erroReverter.message);
        return;
      }
    }

    // acordos e parcelas não têm permissão de exclusão (DELETE) no banco
    // -- tentar apagar falha silenciosamente, sem erro, e o registro
    // continua lá do mesmo jeito. Por isso cancela (marca status) em vez
    // de apagar -- o que também é melhor pra manter histórico/auditoria.
    await supabase.from("acordo_titulo_vinculo").delete().eq("acordo_id", acordo.id);

    await supabase
      .from("parcelas")
      .update({ status: "CANCELADA", atualizado_em: agora })
      .eq("acordo_id", acordo.id)
      .neq("status", "PAGO");

    const { error: erroCancelar } = await supabase
      .from("acordos")
      .update({ status: "CANCELADO", saldo: 0, atualizado_em: agora })
      .eq("id", acordo.id);

    if (erroCancelar) {
      alert("Erro ao cancelar o acordo: " + erroCancelar.message);
      return;
    }

    // Sinaliza que o caso saiu da carteira ativa -- dispara a reposicao
    // automatica (mesmo mecanismo da confirmacao de pagamento).
    if (aluno?.id) {
      const { error: erroLiberar } = await supabase.rpc("liberar_caso_por_evento", {
        p_aluno_id: aluno.id,
        p_evento: "CANCELADO",
      });

      if (erroLiberar) {
        console.error("Erro ao liberar caso (reposição automática):", erroLiberar);
      }
    }

    setRecarga((r) => r + 1);
    alert("Acordo cancelado.");
  }

  // ---- Montar novo acordo (direto na ficha) ----
  function atualizarNovo(campo, valor) {
    setNovo((atual) => ({ ...atual, [campo]: valor }));
  }

  function atualizarValorTotal(valor) {
    setNovo((atual) => {
      // Quando o valor total muda (digitado à mão ou via "usar soma dos
      // títulos"), a entrada em R$ ficava travada no valor antigo -- o
      // saldo das parcelas saía errado porque a entrada não acompanhava.
      // Aqui a % da entrada fica fixa e o valor em R$ é recalculado.
      if (!atual.temEntrada || !atual.entradaPct) {
        return { ...atual, valorTotal: valor };
      }
      const total = paraNumero(valor);
      const pct = Number(String(atual.entradaPct).replace(",", ".")) || 0;
      const rs = total > 0 ? ((total * pct) / 100).toFixed(2) : atual.entradaRs;
      return { ...atual, valorTotal: valor, entradaRs: rs };
    });
  }

  function atualizarEntradaRs(valor) {
    setNovo((atual) => {
      const total = paraNumero(atual.valorTotal);
      const rs = paraNumero(valor);
      const pct = total > 0 ? ((rs / total) * 100).toFixed(1) : "";
      return { ...atual, entradaRs: valor, entradaPct: pct };
    });
  }

  function atualizarEntradaPct(valor) {
    setNovo((atual) => {
      const total = paraNumero(atual.valorTotal);
      const pct = Number(String(valor).replace(",", ".")) || 0;
      const rs = total > 0 ? ((total * pct) / 100).toFixed(2) : "";
      return { ...atual, entradaPct: valor, entradaRs: rs };
    });
  }

  function alternarTitulo(id) {
    setNovo((atual) => {
      const jaTem = atual.titulosSel.includes(id);
      const titulosSel = jaTem ? atual.titulosSel.filter((x) => x !== id) : [...atual.titulosSel, id];
      return { ...atual, titulosSel };
    });
  }

  function usarSomaTitulos() {
    setNovo((atual) => {
      const soma = titulosSelecionaveis
        .filter((t) => atual.titulosSel.includes(t.id))
        .reduce((acc, t) => acc + valorTitulo(t), 0);

      if (!atual.temEntrada || !atual.entradaPct) {
        return { ...atual, valorTotal: soma.toFixed(2) };
      }
      const pct = Number(String(atual.entradaPct).replace(",", ".")) || 0;
      const rs = soma > 0 ? ((soma * pct) / 100).toFixed(2) : atual.entradaRs;
      return { ...atual, valorTotal: soma.toFixed(2), entradaRs: rs };
    });
  }

  function gerarParcelasNovo() {
    const total = paraNumero(novo.valorTotal);
    if (total <= 0) {
      alert("Informe o valor total do acordo.");
      return;
    }
    const qtd = Math.max(1, parseInt(novo.qtdParcelas) || 1);
    const entrada = novo.temEntrada ? Math.min(paraNumero(novo.entradaRs), total) : 0;
    const honTotal = paraNumero(novo.honorarios);
    const saldo = Math.max(0, total - entrada);
    const vParc = saldo / qtd;
    const honEnt = total > 0 ? honTotal * (entrada / total) : 0;
    const honSaldo = Math.max(0, honTotal - honEnt);
    const honCada = honSaldo / qtd;
    const base = paraDataISO(novo.primeiroVenc) || hojeISO();
    const parcelas = [];
    for (let i = 1; i <= qtd; i++) {
      parcelas.push({
        numero: i,
        vencimento: paraDataBR(somarMeses(base, i - 1)),
        valor: vParc.toFixed(2),
        honorarios: honCada.toFixed(2),
        status: "A_VENCER",
      });
    }
    setNovo((atual) => ({ ...atual, parcelas, honorariosEntrada: honEnt.toFixed(2) }));
  }

  function atualizarParcelaNovo(index, campo, valor) {
    setNovo((atual) => {
      const parcelas = atual.parcelas.map((p, i) => (i === index ? { ...p, [campo]: valor } : p));
      return { ...atual, parcelas };
    });
  }

  async function vincularTitulosExistente() {
    if (!novo.titulosSel.length) { alert("Marque ao menos um título para vincular."); return; }
    if (!acordoAlvoId) { alert("Escolha o acordo que vai receber os títulos."); return; }
    // RPC unica: marca a mensalidade como NEGOCIADO (sai do "a cobrar"), liga ao
    // acordo e registra auditoria. Funciona mesmo com o acordo JA PAGO/QUITADO
    // (vincular mensalidades a parcelas ja pagas). Nao altera pagamento.
    const { data, error } = await supabase.rpc("vincular_titulos_acordo", {
      p_titulo_ids: novo.titulosSel,
      p_acordo_id: acordoAlvoId,
    });
    if (error || (data && data.ok === false)) {
      alert("Erro ao vincular: " + (error?.message || data?.erro || "falha"));
      return;
    }
    setNovo(novoAcordoInicial());
    setAcordoAlvoId("");
    setNovoAberto(false);
    setRecarga((r) => r + 1);
    alert(`${(data && data.vinculados) || novo.titulosSel.length} mensalidade(s) vinculada(s) ao acordo (marcadas como negociadas).`);
  }

  async function salvarNovoAcordo() {
    if (!podeBaixar) { alert("Criação de acordo com baixa de entrada é exclusiva da gestão financeira."); return; }
    if (!novo.parcelas.length) {
      alert('Clique em "Gerar parcelas" antes de salvar.');
      return;
    }
    const total = paraNumero(novo.valorTotal);
    if (total <= 0) {
      alert("Informe o valor total do acordo.");
      return;
    }
    const email = usuario?.email || "";
    const agora = new Date().toISOString();
    // Quem cria o acordo (normalmente a Amanda) nem sempre é o operador
    // responsável pelo caso -- o "dono" do caso pra fins de carteira/KPI é
    // sempre o responsável atual do aluno, não quem apertou salvar.
    const operadorResponsavel = aluno.responsavel_atual_email || email;
    const entrada = novo.temEntrada ? Math.min(paraNumero(novo.entradaRs), total) : 0;
    const pct = total > 0 && novo.temEntrada ? Number(((entrada / total) * 100).toFixed(2)) : null;
    const honTotal = paraNumero(novo.honorarios);
    const saldo = Math.max(0, total - entrada);

    const { data: acordo, error } = await supabase
      .from("acordos")
      .insert({
        aluno_id: String(aluno.id),
        cpf: aluno.cpf,
        tipo: "ACORDO",
        forma_pagamento: "PARCELADO",
        valor_total: total,
        qtd_parcelas: novo.parcelas.length,
        valor_entrada: novo.temEntrada ? entrada : null,
        entrada_percentual: pct,
        entrada_paga: novo.temEntrada ? Boolean(novo.entradaPaga) : false,
        data_entrada: novo.temEntrada && novo.entradaPaga ? (paraDataISO(novo.dataEntrada) || hojeISO()) : null,
        honorarios_valor: honTotal || null,
        saldo: saldo,
        status: "ATIVO",
        operador_responsavel_email: operadorResponsavel,
        criado_por_nome: nomeOperadorPorEmail(email),
        criado_por_email: email,
        confirmado_por_email: email,
        confirmado_em: agora,
      })
      .select()
      .single();

    if (error) {
      alert("Erro ao criar acordo: " + error.message);
      return;
    }

    const parcelas = novo.parcelas.map((p) => ({
      acordo_id: acordo.id,
      numero: p.numero,
      valor: paraNumero(p.valor),
      honorarios: p.honorarios != null ? paraNumero(p.honorarios) : null,
      vencimento: paraDataISO(p.vencimento) || p.vencimento,
      status: p.status,
    }));

    const { error: e2 } = await supabase.from("parcelas").insert(parcelas);
    if (e2) {
      alert("Acordo criado, mas houve erro ao gerar as parcelas: " + e2.message);
      return;
    }

    // Entrada já paga vira um registro de pagamento de verdade (parcela
    // número 0 + baixa), não só uma marcação no acordo -- sem isso, o
    // valor da entrada nunca aparecia em nenhum KPI de "valor baixado" ou
    // "honorários", porque esses somam de baixas/parcelas reais.
    if (novo.temEntrada && novo.entradaPaga && entrada > 0) {
      const dataEntradaEscolhida = paraDataISO(novo.dataEntrada) || hojeISO();
      const honEntrada = paraNumero(novo.honorariosEntrada);

      const { data: parcelaEntrada, error: erroEntrada } = await supabase
        .from("parcelas")
        .insert({
          acordo_id: acordo.id,
          numero: 0,
          valor: entrada,
          honorarios: honEntrada || 0,
          vencimento: dataEntradaEscolhida,
          status: "PAGO",
          pago_em: dataEntradaEscolhida,
          confirmado_por_email: email,
        })
        .select()
        .single();

      if (erroEntrada) {
        console.error("Erro ao registrar a entrada como paga:", erroEntrada);
        alert("Acordo criado, mas houve erro ao registrar a entrada como paga: " + erroEntrada.message);
      } else {
        await supabase.from("baixas_pagamento").insert({
          aluno_id: String(aluno.id),
          aluno_nome: aluno.nome || null,
          aluno_cpf: aluno.cpf || null,
          valor_pago: entrada,
          honorarios_recebidos: honEntrada || 0,
          status_baixa: "REALIZADA",
          responsavel_baixa_nome: nomeOperadorPorEmail(operadorResponsavel),
          responsavel_baixa_email: operadorResponsavel,
          baixado_por_email: email,
          data_pagamento: dataEntradaEscolhida,
          parcela_id: parcelaEntrada?.id || null,
          acordo_id: acordo.id,
        });
      }
    }

    // Montar novo acordo NAO vincula titulos automaticamente.
    // O vinculo de mensalidades e feito apenas pelo botao "Vincular a acordo existente".

    setNovo(novoAcordoInicial());
    setNovoAberto(false);
    setRecarga((r) => r + 1);
    alert("Acordo criado com sucesso!");
  }

  async function salvarMensalidadeManual() {
    setErroMensalidade("");

    // Trava de duplo-clique: se já há um insert em voo, ignora a chamada.
    if (salvandoMensalidadeRef.current) return;

    if (!aluno?.id) {
      setErroMensalidade("Este aluno não tem cadastro (id) — não dá pra vincular o título.");
      return;
    }

    const vencimentoISO = paraDataISO(novaMensalidade.vencimento);
    if (!vencimentoISO) {
      setErroMensalidade("Informe o vencimento no formato dd/mm/aaaa.");
      return;
    }
    const valorOriginal = paraNumero(novaMensalidade.valor);
    if (!valorOriginal) {
      setErroMensalidade("Informe um valor original válido.");
      return;
    }
    // Valor em aberto é opcional: quando não informado, assume o valor
    // original (caso comum de mensalidade que nunca foi paga em parte).
    const valorAberto = novaMensalidade.valorAberto
      ? paraNumero(novaMensalidade.valorAberto)
      : valorOriginal;
    if (valorAberto < 0 || valorAberto > valorOriginal) {
      setErroMensalidade("O valor em aberto não pode ser negativo nem maior que o valor original.");
      return;
    }

    const competencia = novaMensalidade.competencia.trim() || null;
    // Referência determinística: a MESMA mensalidade (mesmo aluno + competência
    // + vencimento + valor original) gera sempre o mesmo documento. Assim o
    // UNIQUE(documento) do banco também barra a duplicata mesmo sem número de
    // título informado -- antes usava MANUAL-<timestamp>, que nunca colidia.
    const valorCentavos = Math.round(valorOriginal * 100);
    const referenciaManual =
      `MANUAL-${aluno.id}-${competencia || "SEMCOMP"}-${vencimentoISO}-${valorCentavos}`;
    const documento = novaMensalidade.documento.trim() || referenciaManual;

    salvandoMensalidadeRef.current = true;
    setSalvandoMensalidade(true);

    // Antes de inserir, confere se já existe uma mensalidade equivalente e
    // ainda válida (não paga/cancelada) para o mesmo aluno: mesma competência,
    // vencimento e valor original. Se existir, bloqueia e mostra a atual em vez
    // de criar outro registro. Complementa o UNIQUE(documento) para o caso de
    // número de título digitado à mão diferente.
    let consultaDup = supabase
      .from("acordos_titulos")
      .select("id, documento, vencimento, valor_original, competencia, situacao, status")
      .eq("aluno_id", String(aluno.id))
      .eq("vencimento", vencimentoISO)
      .eq("valor_original", valorOriginal)
      .not("situacao", "in", "(PAGO,CANCELADO)")
      .not("status", "in", "(quitada,cancelado)");
    consultaDup = competencia
      ? consultaDup.eq("competencia", competencia)
      : consultaDup.is("competencia", null);
    const { data: existentes, error: erroDup } = await consultaDup.limit(1);

    if (erroDup) {
      setSalvandoMensalidade(false);
      salvandoMensalidadeRef.current = false;
      setErroMensalidade("Não foi possível checar duplicidade: " + erroDup.message);
      return;
    }
    if (existentes && existentes.length > 0) {
      const ex = existentes[0];
      setSalvandoMensalidade(false);
      salvandoMensalidadeRef.current = false;
      setErroMensalidade(
        `Já existe uma mensalidade em aberto para este aluno com essa competência, vencimento (${paraDataBR(ex.vencimento)}) e valor (${moeda(ex.valor_original)}) — título "${ex.documento}". Não foi criado outro registro.`
      );
      return;
    }

    const agora = new Date().toISOString();
    // Auto-preenchimento a partir do cadastro do aluno (regra existente):
    // matrícula é o próprio aluno_id, CPF/unidade/responsável vêm da ficha.
    // Não há colunas dedicadas em acordos_titulos para esses campos, então
    // ficam registrados em `dados` (auditoria) + motivo_ajuste (leitura).
    const auditoria = {
      origem: "inclusao_manual_ficha",
      incluido_por_email: usuario?.email || null,
      incluido_por_nome: nomeOperadorPorEmail(usuario?.email || ""),
      incluido_em: agora,
      aluno_id: String(aluno.id),
      matricula: aluno.matricula || null,
      cpf: aluno.cpf || null,
      unidade: aluno.unidade || null,
      responsavel_atual_email: aluno.responsavel_atual_email || null,
      responsavel_atual_nome: aluno.responsavel_atual_nome || null,
      campos: {
        documento,
        competencia,
        vencimento: vencimentoISO,
        valor_original: valorOriginal,
        valor_em_aberto: valorAberto,
        descricao: novaMensalidade.motivo || null,
        tipo_boleto: novaMensalidade.tipoBoleto || null,
      },
    };

    const { data: criado, error } = await supabase
      .from("acordos_titulos")
      .insert({
        aluno_id: String(aluno.id),
        cpf: aluno.cpf || null,
        documento,
        vencimento: vencimentoISO,
        valor_original: valorOriginal,
        saldo_corrigido: valorAberto,
        valor_em_aberto: valorAberto,
        situacao: "ABERTO",
        status: "em_aberto",
        tipo_boleto: novaMensalidade.tipoBoleto || null,
        competencia,
        dados: auditoria,
        motivo_ajuste: `Inclusão manual na ficha do aluno${
          usuario?.email ? " por " + usuario.email : ""
        }${novaMensalidade.motivo ? " — " + novaMensalidade.motivo : ""}`,
      })
      .select()
      .single();

    setSalvandoMensalidade(false);
    salvandoMensalidadeRef.current = false;

    if (error) {
      // Código 23505 = violação de UNIQUE -- já existe um título com esse
      // número de documento (provavelmente já veio de algum bordero).
      if (error.code === "23505") {
        setErroMensalidade(
          `Já existe um título com o documento "${documento}" no sistema. Confira se não é esse mesmo que você está procurando.`
        );
      } else {
        setErroMensalidade("Erro ao salvar: " + error.message);
      }
      return;
    }

    setTitulos((anteriores) =>
      [...anteriores, criado].sort((a, b) =>
        String(a.vencimento || "").localeCompare(String(b.vencimento || ""))
      )
    );
    // Sem isso, a mensalidade criada na mão não aparecia na lista de
    // "títulos em aberto" do Montar novo acordo -- essa lista vem de uma
    // busca separada, filtrada por aluno_id + status em_aberto.
    setTitulosSelecionaveis((anteriores) =>
      [
        ...anteriores,
        {
          id: criado.id,
          documento: criado.documento,
          vencimento: criado.vencimento,
          valor_original: criado.valor_original,
          saldo_corrigido: criado.saldo_corrigido,
          valor_em_aberto: criado.valor_em_aberto,
          status: criado.status,
        },
      ].sort((a, b) => String(a.vencimento || "").localeCompare(String(b.vencimento || "")))
    );
    setNovaMensalidade(mensalidadeManualInicial());
    setFormMensalidadeAberto(false);
    // Recalcula o saldo pela fonte única (RPC aluno_saldo_pendente_detalhe) e
    // recarrega as listas — sem isso o "Total geral em aberto" ficava com o
    // valor antigo até dar refresh na página. Não toca em acordos/pagamentos.
    setRecarga((r) => r + 1);
  }

  if (carregando) return null;

  // Valor de mensalidades: títulos (acordos_titulos) que ainda não foram
  // pagos nem entraram em nenhum acordo -- "vinculada"/"quitada" já saíram
  // daqui pra não duplicar com o valor de acordos abaixo.
  // Titulo vinculado a acordo NAO entra aqui: a obrigacao dele ja esta
  // representada pelas parcelas do acordo (evita dupla contagem). O
  // acordo_id entra no filtro porque ha uma janela em que ele e o unico
  // sinal do vinculo.
  const emAberto = titulos.filter(
    (t) =>
      t.situacao !== "PAGO" &&
      t.situacao !== "NEGOCIADO" &&
      t.status !== "vinculada" &&
      t.status !== "quitada" &&
      !t.acordo_id
  );
  const valorMensalidades = emAberto.reduce(
    (soma, t) => soma + Number(t.saldo_corrigido ?? t.valor_original ?? 0),
    0
  );

  // Valor de acordos: soma das parcelas em aberto, só de acordos que ainda
  // estão ativos -- acordo CANCELADO fica de fora inteiro, e dentro de um
  // acordo ativo as parcelas PAGO/CANCELADA também não entram (senão o
  // total sobe indevidamente).
  const acordosNaoCancelados = acordos.filter((a) => a.status !== "CANCELADO");
  const acordosAtivos = acordos.filter((a) => a.status === "ATIVO");
  // Vincular mensalidades tambem a acordos JA PAGOS/QUITADOS (parcelas pagas):
  // marca a mensalidade como NEGOCIADO (sai do "a cobrar"), sem alterar pagamento.
  const acordosVinculaveis = acordos.filter((a) => a.status !== "CANCELADO");
  const parcelasEmAberto = acordosNaoCancelados
    .flatMap((a) => parcelasPorAcordo[a.id] || [])
    .filter((p) => p.status !== "PAGO" && p.status !== "CANCELADA");
  const valorAcordos = parcelasEmAberto.reduce((soma, p) => soma + Number(p.valor || 0), 0);

  // Valor de honorários: soma dos honorários das parcelas em aberto (mesmo
  // filtro de parcelasEmAberto acima) -- fica separado do valor de acordos
  // pra bater com o card de resumo, mas some junto no total do aluno.
  const valorHonorarios = parcelasEmAberto.reduce((soma, p) => soma + Number(p.honorarios || 0), 0);

  // Valor total do aluno = mensalidades em aberto + honorários em aberto + acordos em aberto.
  const valorTotalAluno = valorMensalidades + valorHonorarios + valorAcordos;

  const pagoMensalidades = titulos
    .filter((t) => t.situacao === "PAGO" || t.status === "quitada")
    .reduce((soma, t) => soma + Number(t.valor_original ?? t.saldo_corrigido ?? 0), 0);
  const parcelasPagas = acordos
    .flatMap((a) => parcelasPorAcordo[a.id] || [])
    .filter((p) => p.status === "PAGO");
  const pagoAcordos = parcelasPagas.reduce((soma, p) => soma + Number(p.valor || 0), 0);
  const pagoHonorarios = parcelasPagas.reduce((soma, p) => soma + Number(p.honorarios || 0), 0);
  const pagoTotal = pagoMensalidades + pagoHonorarios + pagoAcordos;
  const estiloPago = { fontSize: 11, color: "#16a34a", fontWeight: 700, marginTop: 2 };

  // Contadores por seção (para a área financeira do card).
  const qtdMensalidadesAbertas = emAberto.length;
  const qtdParcelasAbertas = parcelasEmAberto.length;

  // Fonte unica: quando o RPC respondeu, valor E quantidade das parcelas de
  // acordo (e o total) vem exatamente dele -- mesmos filtros, imune ao RLS.
  // Sem RPC (ex.: erro de rede) cai no calculo local ja existente.
  const temOficial = saldoOficial && !saldoOficial.erro;
  const qtdParcelasExibir = temOficial
    ? Number(saldoOficial.parcelas_abertas_qtd || 0)
    : qtdParcelasAbertas;
  const valorParcelasExibir = temOficial
    ? Number(saldoOficial.parcelas_abertas_valor || 0)
    : valorAcordos;
  const valorMensalidadesExibir = temOficial
    ? Number(saldoOficial.titulos_abertos || 0)
    : valorMensalidades;
  const valorTotalExibir = temOficial ? Number(saldoOficial.total || 0) : valorTotalAluno;

  // "Zerado" nunca é decidido só pela mensalidade original: se há parcela de
  // acordo em aberto (ou título/honorário), o card NÃO pode aparecer como zero.
  const temSaldoOperacional =
    valorTotalExibir > 0.005 || (temOficial && saldoOficial.tem_pendencia === true);
  const somenteParcelasAcordo = valorMensalidades <= 0.005 && (valorAcordos + valorHonorarios) > 0.005;
  const temAlgumValor = titulos.length > 0 || acordos.length > 0;

  const somaTitulosMarcados = titulosSelecionaveis
    .filter((t) => novo.titulosSel.includes(t.id))
    .reduce((acc, t) => acc + valorTitulo(t), 0);

  return (
    <>
      {(temAlgumValor || temSaldoOperacional) && (
        <>
          {somenteParcelasAcordo && (
            <div style={estilos.bannerSomenteAcordo}>
              Somente parcelas de acordo em aberto — o aluno continua com saldo e disponível para atendimento.
            </div>
          )}
          <div style={estilos.resumoFinanceiroTopo}>
            <div style={estilos.resumoFinanceiroItem}>
              <span style={estilos.resumoFinanceiroLabel}>Mensalidades em aberto</span>
              <span style={estilos.resumoFinanceiroValor}>{moeda(valorMensalidadesExibir)}</span>
              <span style={estiloPago}>{qtdMensalidadesAbertas} em aberto · já pago: {moeda(pagoMensalidades)}</span>
            </div>
            <div style={estilos.resumoFinanceiroItem}>
              <span style={estilos.resumoFinanceiroLabel}>Honorários em aberto</span>
              <span style={estilos.resumoFinanceiroValor}>{moeda(valorHonorarios)}</span>
              <span style={estiloPago}>já pago: {moeda(pagoHonorarios)}</span>
            </div>
            <div style={estilos.resumoFinanceiroItem}>
              <span style={estilos.resumoFinanceiroLabel}>Parcelas de acordo em aberto</span>
              <span style={estilos.resumoFinanceiroValor}>{moeda(valorParcelasExibir)}</span>
              <span style={estiloPago}>{qtdParcelasExibir} {qtdParcelasExibir === 1 ? "parcela" : "parcelas"} em aberto · já pago: {moeda(pagoAcordos)}</span>
            </div>
            <div style={{ ...estilos.resumoFinanceiroItem, ...estilos.resumoFinanceiroItemTotal }}>
              <span style={estilos.resumoFinanceiroLabel}>💰 Total geral em aberto</span>
              <span style={estilos.totalGeral}>{moeda(valorTotalExibir)}</span>
              <span style={estiloPago}>já pago: {moeda(pagoTotal)}</span>
            </div>
          </div>
        </>
      )}

      {podeBaixar && aluno?.id && (
        <div style={estilos.caixa}>
          <div style={estilos.cabecalho}>
            <strong>➕ Montar novo acordo</strong>
            <button style={estilos.botaoPequeno} onClick={() => setNovoAberto((v) => !v)}>
              {novoAberto ? "Fechar" : "Abrir"}
            </button>
          </div>

          {novoAberto && (
            <div style={{ marginTop: 10 }}>
              <div style={estilos.blocoTitulos}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                  Títulos em aberto — marque os que entram neste acordo
                </div>
                {titulosSelecionaveis.length === 0 ? (
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    Nenhum título em aberto para este aluno. Você pode montar o acordo mesmo assim.
                  </div>
                ) : (
                  <>
                    {titulosSelecionaveis.map((t) => (
                      <label key={t.id} style={estilos.linhaTitulo}>
                        <input
                          type="checkbox"
                          checked={novo.titulosSel.includes(t.id)}
                          onChange={() => alternarTitulo(t.id)}
                        />
                        <span style={{ flex: 1 }}>
                          Título {t.documento || "-"} — venc. {formatarDataSimples(t.vencimento)}
                        </span>
                        <span style={{ fontWeight: 700 }}>{moeda(valorTitulo(t))}</span>
                      </label>
                    ))}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                      <span style={{ fontSize: 12 }}>Soma marcados: <strong>{moeda(somaTitulosMarcados)}</strong></span>
                      <button style={estilos.botaoPequeno} onClick={usarSomaTitulos}>
                        Usar soma como valor total
                      </button>
                    </div>
                    {acordosVinculaveis.length > 0 && novo.titulosSel.length > 0 && (
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, paddingTop: 8, borderTop: "1px solid #eef2f6", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, fontWeight: 700 }}>Ou vincular a um acordo existente:</span>
                        <select value={acordoAlvoId} onChange={(e) => setAcordoAlvoId(e.target.value)} style={estilos.input}>
                          <option value="">Escolha o acordo…</option>
                          {acordosVinculaveis.map((a) => (
                            <option key={a.id} value={a.id}>
                              {moeda(a.valor_total)} — {a.qtd_parcelas}x{a.status !== "ATIVO" ? ` (${a.status === "QUITADO" ? "pago" : String(a.status || "").toLowerCase()})` : ""}
                            </option>
                          ))}
                        </select>
                        <button style={estilos.botaoPequeno} onClick={vincularTitulosExistente}>Vincular a este acordo</button>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div style={estilos.gridCampos}>
                <label style={estilos.campo}>
                  Valor total (R$)
                  <input style={estilos.input} value={novo.valorTotal} placeholder="Ex: 1500,00"
                    onChange={(e) => atualizarValorTotal(e.target.value)} />
                </label>
                <label style={estilos.campo}>
                  Nº de parcelas
                  <input style={estilos.input} type="number" min="1" value={novo.qtdParcelas}
                    onChange={(e) => atualizarNovo("qtdParcelas", e.target.value)} />
                </label>
                <label style={estilos.campo}>
                  Honorários (R$)
                  <input style={estilos.input} value={novo.honorarios} placeholder="Ex: 300,00"
                    onChange={(e) => atualizarNovo("honorarios", e.target.value)} />
                </label>
                <label style={estilos.campo}>
                  1º vencimento
                  <input style={estilos.input} type="text" placeholder="dd/mm/aaaa" value={novo.primeiroVenc}
                    onChange={(e) => atualizarNovo("primeiroVenc", e.target.value)} />
                </label>
              </div>

              <label style={{ ...estilos.campo, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
                <input type="checkbox" checked={novo.temEntrada}
                  onChange={(e) => atualizarNovo("temEntrada", e.target.checked)} />
                Tem entrada
              </label>

              {novo.temEntrada && (
                <div style={estilos.gridCampos}>
                  <label style={estilos.campo}>
                    Entrada (R$)
                    <input style={estilos.input} value={novo.entradaRs}
                      onChange={(e) => atualizarEntradaRs(e.target.value)} />
                  </label>
                  <label style={estilos.campo}>
                    Entrada (%)
                    <input style={estilos.input} value={novo.entradaPct}
                      onChange={(e) => atualizarEntradaPct(e.target.value)} />
                  </label>
                  <label style={{ ...estilos.campo, flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={novo.entradaPaga}
                      onChange={(e) => atualizarNovo("entradaPaga", e.target.checked)} />
                    Entrada já paga
                  </label>
                  {novo.entradaPaga && (
                    <label style={estilos.campo}>
                      Data em que a entrada foi paga
                      <input type="text" placeholder="dd/mm/aaaa" style={estilos.input} value={novo.dataEntrada}
                        onChange={(e) => atualizarNovo("dataEntrada", e.target.value)} />
                    </label>
                  )}
                </div>
              )}

              {(() => {
                // Resumo visível de total / entrada / saldo -- sem isso,
                // parecia que a entrada não estava sendo descontada (ela
                // era, só que só aparecia embutida no valor de cada
                // parcela, sem nenhum total explícito pra conferir).
                const totalPrev = paraNumero(novo.valorTotal);
                if (totalPrev <= 0) return null;
                const entradaPrev = novo.temEntrada ? Math.min(paraNumero(novo.entradaRs), totalPrev) : 0;
                const saldoPrev = Math.max(0, totalPrev - entradaPrev);
                return (
                  <div style={estilos.resumoAcordo}>
                    <span>Valor total: <strong>{moeda(totalPrev)}</strong></span>
                    {novo.temEntrada && <span>Entrada: <strong>-{moeda(entradaPrev)}</strong></span>}
                    <span>Saldo a parcelar: <strong>{moeda(saldoPrev)}</strong></span>
                  </div>
                );
              })()}

              <button style={{ ...estilos.botaoPequeno, marginTop: 10 }} onClick={gerarParcelasNovo}>
                Gerar parcelas
              </button>

              {novo.parcelas.length > 0 && (
                <div style={{ marginTop: 10, border: "1px solid rgba(148,163,184,0.25)", borderRadius: 8, overflow: "hidden" }}>
                  <div style={estilos.parcHead}>
                    <span>Nº</span><span>Vencimento</span><span>Valor</span><span>Honor.</span>
                  </div>
                  {novo.parcelas.map((p, index) => (
                    <div key={index} style={estilos.parcRow}>
                      <span>{p.numero}</span>
                      <input style={estilos.inputTabela} type="text" placeholder="dd/mm/aaaa" value={p.vencimento}
                        onChange={(e) => atualizarParcelaNovo(index, "vencimento", e.target.value)} />
                      <input style={estilos.inputTabela} value={p.valor}
                        onChange={(e) => atualizarParcelaNovo(index, "valor", e.target.value)} />
                      <input style={estilos.inputTabela} value={p.honorarios}
                        onChange={(e) => atualizarParcelaNovo(index, "honorarios", e.target.value)} />
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button style={estilos.botaoConfirmar} onClick={salvarNovoAcordo}>
                  Salvar acordo
                </button>
                <button style={estilos.botaoCancelar} onClick={() => { setNovo(novoAcordoInicial()); setNovoAberto(false); }}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {titulos.length === 0 ? (
        <div style={estilos.caixa}>
          <div style={estilos.cabecalho}>
            <strong>💰 Financeiro</strong>
            {podeBaixar && (
              <button
                style={estilos.botaoPequeno}
                onClick={() => setFormMensalidadeAberto((v) => !v)}
              >
                {formMensalidadeAberto ? "Cancelar" : "+ Adicionar mensalidade manual"}
              </button>
            )}
          </div>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "6px 0 0" }}>
            {aluno?.cpf
              ? `Nenhum título importado pelos borderôs para o CPF ${aluno.cpf}.`
              : "Este aluno não tem CPF cadastrado, então não dá pra casar com os borderôs."}
          </p>
          {podeBaixar && formMensalidadeAberto && <FormMensalidadeManual
            aluno={aluno}
            novaMensalidade={novaMensalidade}
            setNovaMensalidade={setNovaMensalidade}
            salvando={salvandoMensalidade}
            erro={erroMensalidade}
            onSalvar={salvarMensalidadeManual}
            onCancelar={() => { setFormMensalidadeAberto(false); setErroMensalidade(""); }}
          />}
        </div>
      ) : (
        <div style={estilos.caixa}>
          <div style={estilos.cabecalho}>
            <strong>💰 Financeiro (borderôs)</strong>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {emAberto.length > 0 && (
                <span style={estilos.totalAberto}>{moeda(valorMensalidades)} em aberto</span>
              )}
              {podeBaixar && (
                <button
                  style={estilos.botaoPequeno}
                  onClick={() => setFormMensalidadeAberto((v) => !v)}
                >
                  {formMensalidadeAberto ? "Cancelar" : "+ Mensalidade manual"}
                </button>
              )}
            </div>
          </div>

          {podeBaixar && formMensalidadeAberto && <FormMensalidadeManual
            aluno={aluno}
            novaMensalidade={novaMensalidade}
            setNovaMensalidade={setNovaMensalidade}
            salvando={salvandoMensalidade}
            erro={erroMensalidade}
            onSalvar={salvarMensalidadeManual}
            onCancelar={() => { setFormMensalidadeAberto(false); setErroMensalidade(""); }}
          />}

          <div style={{ marginTop: 10 }}>
            {titulos.map((titulo) => {
              const pago = titulo.situacao === "PAGO" || titulo.status === "quitada";
              // Reconhece o vinculo por qualquer um dos tres sinais: o
              // gatilho grava situacao=NEGOCIADO + status=vinculada, mas ha
              // uma janela em que so o acordo_id esta preenchido.
              const negociada =
                !pago &&
                (titulo.status === "vinculada" ||
                  titulo.situacao === "NEGOCIADO" ||
                  !!titulo.acordo_id);
              const acordoDoTitulo = titulo.acordo_id
                ? acordos.find((a) => String(a.id) === String(titulo.acordo_id))
                : null;
              const vencida = !pago && !negociada && diasAtraso(titulo.vencimento) > 0;
              const cor = pago ? CORES_STATUS.quitado : negociada ? CORES_STATUS.em_dia : CORES_STATUS.em_aberto;
              return (
                <div
                  key={titulo.id || titulo.documento}
                  style={{ ...estilos.linha, borderLeft: `3px solid ${cor.barra}`, paddingLeft: 8 }}
                >
                  <div>
                    <div style={{ fontSize: 13 }}>
                      Título {titulo.documento}
                      {titulo.tipo_boleto ? ` · ${titulo.tipo_boleto}` : ""}
                    </div>
                    <div style={estilos.subLinha}>
                      Vencimento: {formatarData(titulo.vencimento)}
                      {vencida ? <span style={estilos.marcaVencida}>• vencida</span> : null}
                    </div>
                    {negociada && (
                      <div style={estilos.subLinha}>
                        Vinculada ao acordo{" "}
                        {acordoDoTitulo
                          ? `${moeda(acordoDoTitulo.valor_total)} em ${acordoDoTitulo.qtd_parcelas || "?"}x`
                          : titulo.acordo_id
                          ? String(titulo.acordo_id).slice(0, 8)
                          : "(vínculo sem acordo localizado)"}
                        {" — não somada de novo no total"}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {moeda(titulo.saldo_corrigido ?? titulo.valor_original)}
                    </div>
                    <span style={{ ...estilos.tagBase, background: cor.bg, color: cor.texto }}>
                      {pago ? "Quitada" : negociada ? "Negociado" : "Em aberto"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}


      <SecaoAcordos
        acordos={acordos}
        parcelasPorAcordo={parcelasPorAcordo}
        podeBaixar={podeBaixar}
        onBaixarParcela={baixarParcela}
        onQuitarCartao={quitarCartao}
        onExcluirAcordo={excluirAcordo}
        onDesfazerBaixa={desfazerBaixa}
        onAlterarResponsavel={alterarResponsavelAcordo}
      />
    </>
  );
}

function FormMensalidadeManual({ aluno, novaMensalidade, setNovaMensalidade, salvando, erro, onSalvar, onCancelar }) {
  // Etapa de revisão: ao clicar em "Revisar", mostra um resumo (com os campos
  // digitados + os auto-preenchidos da ficha) para conferência antes de gravar.
  const [revisando, setRevisando] = useState(false);

  function setCampo(campo, valor) {
    setNovaMensalidade((anterior) => ({ ...anterior, [campo]: valor }));
  }

  function irParaRevisao() {
    // Validação leve só pra não abrir o resumo com o essencial faltando --
    // a validação forte (formato/limites) continua no salvarMensalidadeManual.
    if (!paraDataISO(novaMensalidade.vencimento)) {
      alert("Informe o vencimento no formato dd/mm/aaaa antes de revisar.");
      return;
    }
    if (!paraNumero(novaMensalidade.valor)) {
      alert("Informe o valor original antes de revisar.");
      return;
    }
    setRevisando(true);
  }

  const valorOriginalNum = paraNumero(novaMensalidade.valor);
  const valorAbertoNum = novaMensalidade.valorAberto
    ? paraNumero(novaMensalidade.valorAberto)
    : valorOriginalNum;

  if (revisando) {
    return (
      <div style={estilos.formBaixa}>
        <p style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>
          Confira antes de incluir
        </p>
        <div style={estilos.resumoInclusao}>
          <div><span style={estilos.resumoRotulo}>Aluno:</span> {aluno?.nome || "-"}</div>
          <div><span style={estilos.resumoRotulo}>Matrícula:</span> {aluno?.matricula || String(aluno?.id || "-")}</div>
          <div><span style={estilos.resumoRotulo}>CPF:</span> {aluno?.cpf || "-"}</div>
          <div><span style={estilos.resumoRotulo}>Unidade:</span> {aluno?.unidade || "-"}</div>
          <div><span style={estilos.resumoRotulo}>Responsável atual:</span> {aluno?.responsavel_atual_nome || aluno?.responsavel_atual_email || "-"}</div>
          <div style={estilos.resumoDivisor} />
          <div><span style={estilos.resumoRotulo}>Competência:</span> {novaMensalidade.competencia || "-"}</div>
          <div><span style={estilos.resumoRotulo}>Vencimento:</span> {paraDataBR(paraDataISO(novaMensalidade.vencimento))}</div>
          <div><span style={estilos.resumoRotulo}>Valor original:</span> {moeda(valorOriginalNum)}</div>
          <div><span style={estilos.resumoRotulo}>Valor em aberto:</span> {moeda(valorAbertoNum)}</div>
          <div><span style={estilos.resumoRotulo}>Nº do título:</span> {novaMensalidade.documento.trim() || "(gerado automaticamente)"}</div>
          <div><span style={estilos.resumoRotulo}>Descrição:</span> {novaMensalidade.motivo || "-"}</div>
        </div>

        {erro && <p style={{ color: "#f0999a", fontSize: 12, marginTop: 8 }}>{erro}</p>}

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button style={estilos.botaoConfirmar} onClick={onSalvar} disabled={salvando}>
            {salvando ? "Salvando..." : "Confirmar inclusão"}
          </button>
          <button style={estilos.botaoCancelar} onClick={() => setRevisando(false)} disabled={salvando}>
            Voltar e editar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={estilos.formBaixa}>
      <p style={{ fontSize: 12, opacity: 0.8, margin: "0 0 8px" }}>
        Uso pontual — pra incluir uma mensalidade direto na ficha, sem borderô/arquivo.
        Aluno, matrícula, CPF, unidade e responsável são preenchidos automaticamente.
        O número do título é opcional; se tiver o mesmo número da planilha, use pra não
        duplicar quando o borderô for reimportado.
      </p>
      <div style={estilos.formLinha}>
        <label style={estilos.formLabel}>
          Competência
          <input
            style={estilos.formInput}
            value={novaMensalidade.competencia}
            onChange={(e) => setCampo("competencia", e.target.value)}
            placeholder="Ex: 05/2026"
          />
        </label>
        <label style={estilos.formLabel}>
          Vencimento * (dd/mm/aaaa)
          <input
            type="text"
            inputMode="numeric"
            style={estilos.formInput}
            value={novaMensalidade.vencimento}
            onChange={(e) => setCampo("vencimento", e.target.value)}
            placeholder="dd/mm/aaaa"
          />
        </label>
      </div>
      <div style={{ ...estilos.formLinha, marginTop: 8 }}>
        <label style={estilos.formLabel}>
          Valor original *
          <input
            style={estilos.formInput}
            value={novaMensalidade.valor}
            onChange={(e) => setCampo("valor", e.target.value)}
            placeholder="Ex: 850,00"
          />
        </label>
        <label style={estilos.formLabel}>
          Valor em aberto
          <input
            style={estilos.formInput}
            value={novaMensalidade.valorAberto}
            onChange={(e) => setCampo("valorAberto", e.target.value)}
            placeholder="Igual ao original se vazio"
          />
        </label>
      </div>
      <div style={{ ...estilos.formLinha, marginTop: 8 }}>
        <label style={estilos.formLabel}>
          Nº do título / borderô (opcional)
          <input
            style={estilos.formInput}
            value={novaMensalidade.documento}
            onChange={(e) => setCampo("documento", e.target.value)}
            placeholder="Deixe em branco se não tiver"
          />
        </label>
        <label style={{ ...estilos.formLabel, flex: 2 }}>
          Descrição (fica registrada no histórico)
          <input
            style={estilos.formInput}
            value={novaMensalidade.motivo}
            onChange={(e) => setCampo("motivo", e.target.value)}
            placeholder="Ex: não veio no bordero 624"
          />
        </label>
      </div>

      {erro && <p style={{ color: "#f0999a", fontSize: 12, marginTop: 8 }}>{erro}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button style={estilos.botaoConfirmar} onClick={irParaRevisao} disabled={salvando}>
          Revisar
        </button>
        <button style={estilos.botaoCancelar} onClick={onCancelar} disabled={salvando}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function SeletorResponsavelAcordo({ acordo, operadoresAtivos, onAplicar }) {
  const [email, setEmail] = useState(acordo.operador_responsavel_email || "");
  const [motivo, setMotivo] = useState("");
  const [aplicando, setAplicando] = useState(false);
  // Trava de execução única: um clique = uma chamada, mesmo em duplo-clique.
  const emExecucaoRef = useRef(false);
  async function aplicar() {
    if (emExecucaoRef.current) return;
    emExecucaoRef.current = true;
    setAplicando(true);
    try {
      await onAplicar(email, motivo);
    } finally {
      setAplicando(false);
      emExecucaoRef.current = false;
    }
  }
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <select value={email} onChange={(e) => setEmail(e.target.value)} style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e6eaf0", fontSize: 12 }}>
        <option value="">Selecione</option>
        {operadoresAtivos.map((op) => (<option key={op.email} value={op.email}>{op.nome}</option>))}
      </select>
      <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo (opcional)" style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e6eaf0", fontSize: 12 }} />
      <button type="button" onClick={aplicar} disabled={aplicando} style={{ padding: "6px 10px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontWeight: 600, cursor: aplicando ? "default" : "pointer", fontSize: 12, opacity: aplicando ? 0.6 : 1 }}>{aplicando ? "Aplicando..." : "Aplicar"}</button>
    </span>
  );
}

function SecaoAcordos({ acordos, parcelasPorAcordo, podeBaixar, onBaixarParcela, onQuitarCartao, onExcluirAcordo, onDesfazerBaixa, onAlterarResponsavel }) {
  const [formParcela, setFormParcela] = useState(null);
  const [formCartao, setFormCartao] = useState(null);
  const [campos, setCampos] = useState({});

  if (!acordos || acordos.length === 0) return null;

  function abrirParcela(p) {
    setFormCartao(null);
    setFormParcela(p.id);
    setCampos({ data: hojeISO(), valor: String(p.valor ?? ""), honorarios: p.honorarios != null ? String(p.honorarios) : "0" });
  }

  function abrirCartao(acordoId) {
    setFormParcela(null);
    setFormCartao(acordoId);
    setCampos({ data: hojeISO(), comprovante: "" });
  }

  return (
    <div style={estilos.caixa}>
      <strong>📄 Acordos e parcelas</strong>

      <div style={{ marginTop: 10 }}>
        {acordos.map((acordo) => {
          const parcelas = parcelasPorAcordo[acordo.id] || [];
          const parcelasAbertas = parcelas.filter((p) => p.status !== "PAGO" && p.status !== "CANCELADA");
          const totalAcordoAberto = parcelasAbertas.reduce((soma, p) => soma + Number(p.valor || 0), 0);
          const chave = statusAcordo(acordo, parcelas);
          const cor = CORES_STATUS[chave];

          // Entrada: pode existir como parcela fisica (is_entrada, ex.: acordos
          // reconstruidos do lote 63fbaa7b) ou apenas como campo valor_entrada
          // (acordos manuais antigos -- Grupo B). No 2o caso exibimos uma linha
          // "Entrada do acordo" a partir de valor_entrada, SEM criar parcela,
          // pra nao duplicar valor no saldo.
          const parcelaEntrada = parcelas.find((p) => p.is_entrada);
          const temParcelaEntrada = !!parcelaEntrada;
          const entradaValor = temParcelaEntrada
            ? Number(parcelaEntrada.valor || 0)
            : Number(acordo.valor_entrada || 0);
          const temEntrada = entradaValor > 0.005;
          const entradaPaga = temParcelaEntrada ? parcelaEntrada.status === "PAGO" : !!acordo.entrada_paga;
          const corEntrada = entradaPaga ? CORES_STATUS.quitado : CORES_STATUS.em_aberto;
          // Parcelado restante em aberto (exclui a entrada, quando ela e parcela).
          const parceladoRestanteAberto = parcelasAbertas
            .filter((p) => !p.is_entrada)
            .reduce((soma, p) => soma + Number(p.valor || 0), 0);
          const totalPagoAcordo = parcelas
            .filter((p) => p.status === "PAGO")
            .reduce((soma, p) => soma + Number(p.valor || 0), 0);

          return (
            <div
              key={acordo.id}
              style={{ marginBottom: 14, borderLeft: `4px solid ${cor.barra}`, paddingLeft: 10, borderRadius: 4 }}
            >
              <div style={estilos.cabecalho}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {acordo.forma_pagamento === "A_VISTA" ? "À vista" : `Parcelado em ${acordo.qtd_parcelas}x`}{" "}
                    — {moeda(acordo.valor_total)}
                  </div>
                  <span style={{ ...estilos.tagBase, background: cor.bg, color: cor.texto }}>{cor.label}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {totalAcordoAberto > 0 && (
                    <span style={estilos.totalAberto}>{moeda(totalAcordoAberto)} em aberto</span>
                  )}
                  {podeBaixar && acordo.status !== "CANCELADO" && (
                    <button
                      style={estilos.botaoExcluir}
                      onClick={() => onExcluirAcordo(acordo)}
                      title="Cancelar acordo (só funciona se não tiver parcela paga)"
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </div>

              {/* Grupo B: entrada so no campo valor_entrada -> exibe linha
                  "Entrada do acordo" sem parcela fisica (evita dupla contagem).
                  Quando a entrada e parcela is_entrada, ela ja aparece na lista
                  abaixo e nao repetimos aqui. */}
              {temEntrada && !temParcelaEntrada ? (
                <div style={{ ...estilos.linha, borderTop: `1px dashed ${cor.barra}`, marginTop: 6 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>Entrada do acordo</div>
                    <div style={estilos.subLinha}>
                      {acordo.data_entrada ? `Vencimento: ${formatarDataSimples(acordo.data_entrada)}` : "Vencimento não informado"}
                      {" · Origem: acordo manual"}
                      <span style={{ marginLeft: 6, fontSize: 11.5, opacity: 0.85 }}>
                        • integra o valor total (não somada ao saldo atual)
                      </span>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{moeda(entradaValor)}</div>
                    <span style={{ ...estilos.tagBase, background: corEntrada.bg, color: corEntrada.texto }}>
                      {entradaPaga ? "Paga" : "Em aberto"}
                    </span>
                  </div>
                </div>
              ) : null}

              {temEntrada ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, margin: "8px 0", fontSize: 12, opacity: 0.9 }}>
                  <span><b>Valor total:</b> {moeda(acordo.valor_total)}</span>
                  <span><b>Entrada:</b> {moeda(entradaValor)}{entradaPaga ? " (paga)" : " (em aberto)"}</span>
                  <span><b>Parcelado restante:</b> {moeda(parceladoRestanteAberto)}</span>
                  <span><b>Total pago:</b> {moeda(totalPagoAcordo)}</span>
                  <span><b>Saldo atual:</b> {moeda(totalAcordoAberto)}</span>
                </div>
              ) : null}

              <div style={{ ...estilos.subLinha, display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                Responsável pelo acordo:
                {podeBaixar ? (
                  <SeletorResponsavelAcordo
                    acordo={acordo}
                    operadoresAtivos={Object.entries(OPERADORES_POR_EMAIL).map(([email, nome]) => ({ email, nome }))}
                    onAplicar={(email, motivo) => onAlterarResponsavel(acordo, email, motivo)}
                  />
                ) : (
                  <strong>{acordo.operador_responsavel_nome || OPERADORES_POR_EMAIL[acordo.operador_responsavel_email] || acordo.operador_responsavel_email || "Sem responsável"}</strong>
                )}
              </div>

              {podeBaixar && parcelasAbertas.length > 0 && (
                <div style={{ margin: "8px 0" }}>
                  <button style={estilos.botaoCartao} onClick={() => abrirCartao(acordo.id)}>
                    Quitar tudo no cartão
                  </button>
                </div>
              )}

              {podeBaixar && formCartao === acordo.id && (
                <div style={estilos.formBaixa}>
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
                    Cartão: um comprovante quita todas as {parcelasAbertas.length} parcelas em aberto.
                  </div>
                  <div style={estilos.formLinha}>
                    <label style={estilos.formLabel}>
                      Data
                      <input type="date" style={estilos.formInput} value={campos.data || ""}
                        onClick={abrirCalendario}
                        onChange={(e) => setCampos({ ...campos, data: e.target.value })} />
                    </label>
                    <label style={estilos.formLabel}>
                      Comprovante (link/nº)
                      <input type="text" style={estilos.formInput} placeholder="opcional" value={campos.comprovante || ""}
                        onChange={(e) => setCampos({ ...campos, comprovante: e.target.value })} />
                    </label>
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                    <button style={estilos.botaoConfirmar} onClick={() => { onQuitarCartao(acordo, parcelasAbertas, campos); setFormCartao(null); }}>
                      Confirmar quitação
                    </button>
                    <button style={estilos.botaoCancelar} onClick={() => setFormCartao(null)}>Cancelar</button>
                  </div>
                </div>
              )}

              {parcelas.map((p) => {
                const pago = p.status === "PAGO";
                const cancelada = p.status === "CANCELADA";
                const diasP = diasAtraso(p.vencimento);
                const vencida = !pago && !cancelada && diasP > 0;
                const venceAmanha = !pago && !cancelada && diasP === -1;
                const corP = pago
                  ? CORES_STATUS.quitado
                  : cancelada
                  ? CORES_STATUS.cancelado
                  : vencida
                  ? CORES_STATUS.vencida
                  : CORES_STATUS.em_aberto;
                return (
                  <div key={p.id}>
                    <div style={estilos.linha}>
                      <div>
                        <div style={{ fontSize: 13 }}>Parcela {p.numero}</div>
                        <div style={estilos.subLinha}>
                          Vencimento: {formatarDataSimples(p.vencimento)}
                          {vencida ? <span style={estilos.marcaVencida}>• vencida</span> : null}
                          {venceAmanha ? (
                            <span style={estilos.marcaLembrete}>• vence amanhã — envie um lembrete ao aluno</span>
                          ) : null}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 10 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{moeda(p.valor)}</div>
                          <span style={{ ...estilos.tagBase, background: corP.bg, color: corP.texto }}>
                            {pago ? "Paga" : STATUS_PARCELA_LABEL[p.status] || "A vencer"}
                          </span>
                        </div>
                        {podeBaixar && !pago && (
                          <button style={estilos.botaoPequeno} onClick={() => abrirParcela(p)}>Baixar</button>
                        )}
                        {podeBaixar && pago && (
                          <button style={estilos.botaoExcluir} onClick={() => onDesfazerBaixa(acordo, p)}>
                            Desfazer
                          </button>
                        )}
                      </div>
                    </div>

                    {podeBaixar && formParcela === p.id && (
                      <div style={estilos.formBaixa}>
                        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
                          Boleto: informe o pagamento desta parcela (sem comprovante obrigatório).
                        </div>
                        <div style={estilos.formLinha}>
                          <label style={estilos.formLabel}>
                            Data
                            <input type="date" style={estilos.formInput} value={campos.data || ""}
                              onClick={abrirCalendario}
                              onChange={(e) => setCampos({ ...campos, data: e.target.value })} />
                          </label>
                          <label style={estilos.formLabel}>
                            Valor pago
                            <input type="number" step="0.01" style={estilos.formInput} value={campos.valor || ""}
                              onChange={(e) => setCampos({ ...campos, valor: e.target.value })} />
                          </label>
                          <label style={estilos.formLabel}>
                            Honorários recebidos
                            <input type="number" step="0.01" style={estilos.formInput} value={campos.honorarios || ""}
                              onChange={(e) => setCampos({ ...campos, honorarios: e.target.value })} />
                          </label>
                        </div>
                        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                          <button style={estilos.botaoConfirmar}
                            onClick={() => {
                              onBaixarParcela(acordo, p, { data: campos.data, valor: Number(campos.valor) || 0, honorarios: Number(campos.honorarios) || 0 });
                              setFormParcela(null);
                            }}>
                            Confirmar baixa
                          </button>
                          <button style={estilos.botaoCancelar} onClick={() => setFormParcela(null)}>Cancelar</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const estilos = {
  caixa: { padding: "12px 16px", marginTop: 14, marginBottom: 14, borderRadius: 10, background: "rgba(56,189,248,0.06)", border: "1px solid rgba(56,189,248,0.25)" },
  cabecalho: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  totalAberto: { fontSize: 13, color: "#fcd34d", fontWeight: 700 },
  caixaResumo: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", marginTop: 14, marginBottom: 4, borderRadius: 10, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.3)" },
  totalGeral: { fontSize: 16, fontWeight: 800, color: "#60a5fa" },
  bannerSomenteAcordo: { marginTop: 14, marginBottom: 4, padding: "10px 14px", borderRadius: 10, background: "rgba(234,179,8,0.12)", border: "1px solid rgba(234,179,8,0.4)", color: "#fcd34d", fontSize: 12.5, fontWeight: 700 },
  resumoFinanceiroTopo: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, marginBottom: 4 },
  resumoFinanceiroItem: { flex: "1 1 180px", display: "flex", flexDirection: "column", gap: 4, padding: "12px 16px", borderRadius: 10, background: "rgba(148,163,184,0.08)", border: "1px solid rgba(148,163,184,0.2)" },
  resumoFinanceiroItemTotal: { background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.3)" },
  resumoFinanceiroLabel: { fontSize: 12, opacity: 0.8, fontWeight: 600 },
  resumoFinanceiroValor: { fontSize: 16, fontWeight: 800, color: "#e2e8f0" },
  linha: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid rgba(148,163,184,0.12)" },
  subLinha: { fontSize: 11, opacity: 0.7, marginTop: 2 },
  marcaVencida: { color: "#f0999a", fontWeight: 700, marginLeft: 6 },
  marcaLembrete: { color: "#fcd34d", fontWeight: 700, marginLeft: 6 },
  tagBase: { fontSize: 11, padding: "2px 8px", borderRadius: 999, fontWeight: 700 },
  botaoPequeno: { background: "#0ea5e9", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 12 },
  botaoCartao: { background: "#7c3aed", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 12 },
  botaoConfirmar: { background: "#198754", color: "#fff", border: "none", padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13 },
  botaoCancelar: { background: "rgba(148,163,184,0.25)", color: "#e2e8f0", border: "none", padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13 },
  botaoExcluir: { background: "rgba(239,68,68,0.14)", color: "#f0999a", border: "1px solid rgba(239,68,68,0.4)", padding: "4px 10px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 12 },
  resumoAcordo: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, marginTop: 10, padding: "8px 12px", background: "rgba(148,163,184,0.08)", borderRadius: 8 },
  seletorResponsavel: {
    background: "#1e293b",
    color: "#f1f5f9",
    border: "1px solid rgba(148,163,184,0.4)",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 12,
    colorScheme: "dark",
  },
  formBaixa: { background: "rgba(15,23,42,0.35)", border: "1px solid rgba(148,163,184,0.25)", borderRadius: 8, padding: 10, margin: "6px 0 10px" },
  formLinha: { display: "flex", gap: 10, flexWrap: "wrap" },
  formLabel: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, opacity: 0.85, flex: 1, minWidth: 120 },
  formInput: { padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(148,163,184,0.4)", background: "rgba(15,23,42,0.6)", color: "#e2e8f0", fontSize: 12 },
  resumoInclusao: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "#e2e8f0", background: "rgba(24,95,165,0.12)", border: "1px solid rgba(24,95,165,0.3)", borderRadius: 8, padding: 10 },
  resumoRotulo: { opacity: 0.7, marginRight: 6 },
  resumoDivisor: { borderTop: "1px solid rgba(148,163,184,0.25)", margin: "4px 0" },
  blocoTitulos: { background: "rgba(24,95,165,0.12)", border: "1px solid rgba(24,95,165,0.3)", borderRadius: 8, padding: 10, marginBottom: 10 },
  linhaTitulo: { display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderTop: "1px solid rgba(148,163,184,0.15)", fontSize: 13 },
  gridCampos: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 },
  campo: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, opacity: 0.9, flex: 1, minWidth: 130 },
  input: { padding: "8px 10px", borderRadius: 6, border: "1px solid rgba(148,163,184,0.4)", background: "rgba(15,23,42,0.6)", color: "#e2e8f0", fontSize: 13 },
  parcHead: { display: "grid", gridTemplateColumns: "40px 1fr 1fr 1fr", gap: 8, background: "rgba(148,163,184,0.12)", padding: "6px 10px", fontSize: 11, fontWeight: 700, opacity: 0.8 },
  parcRow: { display: "grid", gridTemplateColumns: "40px 1fr 1fr 1fr", gap: 8, padding: "6px 10px", alignItems: "center", borderTop: "1px solid rgba(148,163,184,0.15)", fontSize: 13 },
  inputTabela: { padding: "6px", borderRadius: 6, border: "1px solid rgba(148,163,184,0.4)", background: "rgba(15,23,42,0.6)", color: "#e2e8f0", fontSize: 12 },
};
