import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { buscarTudo } from "../utils/paginado";
import { Carregando } from "../ui/estados";
import {
  ETAPA_LABEL,
  ETAPAS_ASSINATURA,
  etapaDe,
  dataEtapa,
  casaBusca,
  ehDispensado,
  naTrilha,
  podeDevolverAoOperador,
  MOTIVOS_DISPENSA,
  rotuloMotivoDispensa,
} from "../utils/termosAssinatura";
import {
  urlTermo,
  enviarTermo,
  concluirAssinaturaTermo,
  desfazerAssinaturaConcluida,
  descartarViaAluno,
} from "../utils/documentoFinanceiro";
import { juntarEmPdf, nomeArquivoPdf } from "../utils/juntarPdf";

const ADM_AUTORIZADOS = [
  "cobranca04@aelbra.com.br", // Fernanda
  "cobranca07@aelbra.com.br", // Amanda ADM
  "amanda.seibel@aelbra.com.br", // Amanda gestora
];

const STATUS_LABEL = {
  TERMO_ENVIADO_ADM: "Termo enviado ADM",
  TERMO_RECEBIDO_LIBERADO: "Termo recebido - liberado",
  TERMO_REJEITADO: "Termo rejeitado",
  TERMO_LIBERADO_AUTOMATICO_GOV: "Liberado automático (gov.br)",
};

// Motivos padronizados de rejeição (não havia lista oficial no sistema).
const MOTIVOS_REJEICAO = [
  "Assinatura ausente",
  "Arquivo ilegível",
  "Documento incompleto",
  "Assinatura divergente",
  "Termo incorreto",
  "Outro",
];

// Motivos para DEVOLVER um termo já liberado ao operador: aqui o problema não é
// a assinatura, é o conteúdo do acordo. Vira o "Retorno ADM" que o operador lê
// na ficha antes de reenviar.
const MOTIVOS_DEVOLUCAO = [
  "Valor do acordo incorreto",
  "Parcelas ou vencimentos incorretos",
  "Dados do aluno incorretos",
  "Termo de outro aluno / arquivo trocado",
  "Falta documento ou assinatura",
  "Outro",
];

function traduzStatus(status) {
  return STATUS_LABEL[status] || status || "-";
}

// Falha ao anexar precisa dizer o que fazer, não devolver o código cru. Em
// todos os casos nada é apagado: o descarte só roda depois do arquivo aceito.
function erroAnexo(codigo) {
  const fim = " Nada foi apagado.";
  if (codigo === "mime_invalido") {
    return "Formato não aceito. Envie PDF, JPG, PNG ou Word — foto em HEIC precisa ser convertida." + fim;
  }
  if (codigo === "tamanho_invalido" || codigo === "tamanho_excedido") {
    return "Arquivo acima de 20 MB. Reduza a qualidade da digitalização e tente de novo." + fim;
  }
  if (codigo === "acesso_negado" || codigo === "forbidden") {
    return "Seu usuário não tem permissão para anexar a via assinada." + fim;
  }
  if (codigo === "sessao_expirada") {
    return "Sua sessão expirou. Entre de novo e repita o anexo." + fim;
  }
  return "Não foi possível anexar a via assinada (" + codigo + ")." + fim;
}

function corEtapa(etapa) {
  if (etapa === "COMPLETO") return { background: "#d1e7dd", color: "#0f5132", border: "1px solid #badbcc" };
  if (etapa === "ENVIADO_ASSINATURA") return { background: "#fff3cd", color: "#664d03", border: "1px solid #ffe69c" };
  if (etapa === "PENDENTE_ENVIO") return { background: "#cff4fc", color: "#055160", border: "1px solid #b6effb" };
  if (etapa === "NAO_VERIFICADO") return { background: "#e2e3e5", color: "#41464b", border: "1px solid #d3d6d8" };
  if (etapa === "DISPENSADO") return { background: "#f8d7da", color: "#842029", border: "1px solid #f5c2c7" };
  return { background: "#f8f9fa", color: "#6c757d", border: "1px solid #e9ecef" };
}

function formatarData(data) {
  if (!data) return "-";
  try {
    return new Date(data).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

// CPF parcial: só os 3 primeiros e 2 últimos dígitos (evita expor completo).
function cpfParcial(cpf) {
  if (!cpf) return "Não informado";
  const d = String(cpf).replace(/\D/g, "");
  if (d.length < 5) return "***";
  return `${d.slice(0, 3)}.***.***-${d.slice(-2)}`;
}

function extensaoDe(nome) {
  if (!nome) return "";
  const m = String(nome).toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/);
  return m ? m[1] : "";
}

function corStatus(status) {
  if (status === "TERMO_RECEBIDO_LIBERADO") {
    return { background: "#d1e7dd", color: "#0f5132", border: "1px solid #badbcc" };
  }
  if (status === "TERMO_REJEITADO") {
    return { background: "#f8d7da", color: "#842029", border: "1px solid #f5c2c7" };
  }
  if (status === "TERMO_LIBERADO_AUTOMATICO_GOV") {
    return { background: "#e0cffc", color: "#4b1e8f", border: "1px solid #d0bcf5" };
  }
  return { background: "#cff4fc", color: "#055160", border: "1px solid #b6effb" };
}

function mensagemErro(erro) {
  switch (erro) {
    case "acesso_negado":
      return "Seu usuário não tem permissão para validar assinatura.";
    case "motivo_obrigatorio":
      return "Informe o motivo da rejeição.";
    case "status_invalido":
      return "Este termo já foi processado por outro usuário. A fila será atualizada.";
    case "termo_nao_encontrado":
      return "Termo não encontrado. A fila será atualizada.";
    case "decisao_invalida":
      return "Ação inválida.";
    default:
      return "Não foi possível concluir a ação. Tente novamente.";
  }
}

// gov.br pendente de auditoria = documento ainda não conferido pela ADM. Enquanto
// pendente, validado_por mantém o marcador automático "AUTOMATICO_GOV_BR"; ao
// validar/rejeitar, passa a ser o e-mail da ADM e sai do conjunto pendente.
// Gov legado (anterior ao portão de validação) foi rotulado
// "LEGADO_GOV_PRE_AUDITORIA" e NÃO é acionável — fica só como histórico.
function ehGovPendenteAuditoria(t) {
  return t?.status === "TERMO_LIBERADO_AUTOMATICO_GOV" && t?.validado_por === "AUTOMATICO_GOV_BR";
}

// Assinatura gov.br x manual. Termo antigo pode ter tipo_assinatura vazio: nesse
// caso vale a mesma leitura dos cards, que tratam o vazio como "Manual + RG".
function ehAssinaturaGov(t) {
  return t?.tipo_assinatura === "GOV_BR";
}

// Data que ordena os liberados: quando a ADM liberou. Termo liberado antes de o
// carimbo existir cai pro envio, para nunca ficar sem data.
function dataLiberacao(t) {
  const bruto = t?.validado_em || t?.criado_em;
  const ms = bruto ? new Date(bruto).getTime() : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

// Termo sem NENHUM arquivo guardado no CRM. Acontece de duas origens medidas em
// 2026-08-26: gov liberado automaticamente sem documento, e termo que foi
// concluído e depois teve a assinatura desfeita quando a via completa já era o
// único arquivo (furo fechado em 20260826150000). Nesses, abrir e marcar envio
// são impossíveis — a fila precisa dizer isso na cara, não devolver
// "documento indisponível".
function semArquivo(t) {
  return !t?.arquivo_url && !t?.arquivo_final_url;
}

// A mensagem antiga ("Documento indisponível") mandava a ADM caçar problema de
// permissão ou de formato que não existe. Diz o que houve e o que fazer.
function mensagemSemArquivo(t) {
  return (
    `O termo de ${t?.aluno_nome || "este aluno"} está sem arquivo nenhum no CRM.\n\n` +
    "Não é falha de formato nem de permissão: não há documento guardado. " +
    "Reanexe a via a partir da pasta de backup em \"Anexar via assinada\" — " +
    "só depois dá para baixar e marcar o envio."
  );
}

// Termo em que a ADM pode decidir (validar/rejeitar): manual aguardando ADM ou
// gov pendente de auditoria.
function ehTermoAcionavel(t) {
  return t?.status === "TERMO_ENVIADO_ADM" || ehGovPendenteAuditoria(t);
}

export default function FilaAdmTermos() {
  const [usuario, setUsuario] = useState(null);
  const [termos, setTermos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [filtro, setFiltro] = useState("PENDENTES");
  // Sub-filtros que só valem na aba Liberados.
  const [tipoLiberado, setTipoLiberado] = useState("TODOS");
  const [ordemLiberados, setOrdemLiberados] = useState("RECENTE");

  // --- Aba Assinaturas (testemunhas + Ulbra) ---
  const [etapaFiltro, setEtapaFiltro] = useState("TODAS");
  const [buscaAssinatura, setBuscaAssinatura] = useState("");
  const [selecionados, setSelecionados] = useState([]);
  const [modalAnexo, setModalAnexo] = useState(null);
  const [anexoArquivo, setAnexoArquivo] = useState(null);
  const [testemunha1, setTestemunha1] = useState("");
  const [testemunha2, setTestemunha2] = useState("");
  const [processando, setProcessando] = useState(false);
  // id do termo cujo PDF está sendo montado (o botão trava só naquele card)
  const [juntando, setJuntando] = useState(null);

  // --- Estado do modal de validação em tela única ---
  const [modalTermo, setModalTermo] = useState(null);
  const [previewCampo, setPreviewCampo] = useState("arquivo");
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErro, setPreviewErro] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [obs, setObs] = useState("");
  const [motivoSel, setMotivoSel] = useState("");
  const [motivoTxt, setMotivoTxt] = useState("");
  const [salvando, setSalvando] = useState(false);

  // --- Decisão sobre termo JÁ LIBERADO: "não será assinado" ou "devolver" ---
  // { tipo: "DISPENSAR" | "DEVOLVER", termo }
  const [modalDecisao, setModalDecisao] = useState(null);
  const [decisaoMotivo, setDecisaoMotivo] = useState("");
  const [decisaoTxt, setDecisaoTxt] = useState("");

  useEffect(() => {
    carregarUsuario();
    carregarTermos();
  }, []);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarTermos() {
    setCarregando(true);
    // A API entrega no maximo 1000 linhas por requisicao, mesmo sem .limit(),
    // e responde 206 (sucesso). Esta consulta ainda cabe, mas a tabela cresce
    // todo dia -- sem paginar, o corte chegaria calado.
    let data;
    let error = null;
    try {
      data = await buscarTudo((de, ate) =>
        supabase
          .from("termos_acordo")
          .select("*")
          .order("criado_em", { ascending: false })
          // Desempate estavel entre paginas.
          .order("id", { ascending: true })
          .range(de, ate)
      );
    } catch (e) {
      error = e;
    }
    if (error) {
      alert("Erro ao carregar fila ADM: " + error.message);
      setCarregando(false);
      return;
    }
    setTermos(data || []);
    setCarregando(false);
  }

  // --- Preview embutido (URL assinada de curta duração; nunca window.open) ---
  async function carregarPreview(termo, campo) {
    setPreviewCampo(campo);
    setPreviewLoading(true);
    setPreviewErro(false);
    setPreviewUrl(null);
    setZoom(1);
    const url = await urlTermo(termo.id, campo);
    if (!url) {
      setPreviewErro(true);
      setPreviewLoading(false);
      return;
    }
    setPreviewUrl(url);
    setPreviewLoading(false);
  }

  function abrirValidacao(termo) {
    setModalTermo(termo);
    setObs("");
    setMotivoSel("");
    setMotivoTxt("");
    carregarPreview(termo, "arquivo");
  }

  async function abrirValidacaoPorId(id) {
    const { data } = await supabase
      .from("termos_acordo")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (data) abrirValidacao(data);
    else fecharModal();
  }

  function fecharModal() {
    setModalTermo(null);
    setPreviewUrl(null);
    setPreviewErro(false);
    setPreviewLoading(false);
  }

  function motivoFinal() {
    if (!motivoSel) return "";
    if (motivoSel === "Outro") return motivoTxt.trim();
    const compl = motivoTxt.trim();
    return compl ? `${motivoSel} — ${compl}` : motivoSel;
  }

  async function decidir(decisao, abrirProximo = false) {
    if (!modalTermo || salvando) return;

    let motivo = null;
    if (decisao === "REJEITAR") {
      motivo = motivoFinal();
      if (!motivo) {
        alert("Selecione o motivo da rejeição (e detalhe, se 'Outro').");
        return;
      }
    }

    const ehGov = modalTermo.status === "TERMO_LIBERADO_AUTOMATICO_GOV";
    const okConfirm = window.confirm(
      decisao === "APROVAR"
        ? ehGov
          ? "Confirmar: documento gov.br conferido e liberar ao operador? O operador será avisado para liberar o acordo."
          : "Confirmar: assinatura validada e termo liberado para operação?"
        : "Confirmar rejeição e devolução ao operador?"
    );
    if (!okConfirm) return;

    setSalvando(true);
    const { data, error } = await supabase.rpc("validar_assinatura_termo", {
      p_termo_id: modalTermo.id,
      p_decisao: decisao,
      p_observacao: decisao === "APROVAR" ? obs.trim() || null : null,
      p_motivo: motivo,
      p_abrir_proximo: abrirProximo,
    });
    setSalvando(false);

    if (error) {
      alert("Erro ao processar: " + error.message);
      return;
    }
    if (!data?.ok) {
      alert(mensagemErro(data?.erro));
      if (data?.erro === "status_invalido" || data?.erro === "termo_nao_encontrado") {
        await carregarTermos();
        fecharModal();
      }
      return;
    }

    await carregarTermos();
    const proximo = data.proximo && data.proximo.id ? data.proximo : null;
    if (abrirProximo && proximo) {
      abrirValidacaoPorId(proximo.id);
    } else {
      fecharModal();
    }
  }

  // --- Ações do fluxo de assinatura ---------------------------------------

  // Baixar a via e marcar o envio são o MESMO gesto: a ADM pega o PDF para
  // mandar ao gov.br. O download vem primeiro; se ele não sair, nada é marcado.
  // O "Desfazer envio" cobre o clique errado.
  //
  // O que sai é o PDF ÚNICO (termo + RG + verso), o mesmo do botão de baixar:
  // mandar o termo sem o RG anexo obrigava a juntar os arquivos na mão depois.
  async function baixarEMarcarEnviado(termo) {
    // RG sozinho não é termo: sem a via, não há o que mandar para assinatura.
    if (semArquivo(termo)) {
      alert(mensagemSemArquivo(termo));
      return;
    }
    const baixou = await baixarPdfDoAluno(termo);
    if (!baixou) return;
    await marcarEnviados([termo.id]);
  }

  // Termo, RG e verso são três arquivos separados; a operação precisa deles como
  // um documento só. Cada arquivo tem a URL assinada pedida na hora (nunca
  // reaproveitada) e a junção acontece aqui no navegador — nada sobe e nada
  // muda de etapa: baixar é só baixar.
  //
  // Devolve true quando o PDF chegou ao disco. Quem marca envio depende disso:
  // sem documento na mão, marcar "enviado para assinatura" é mentira.
  async function baixarPdfDoAluno(termo) {
    // A via completa só entra quando a do aluno já não existe: com as duas, a
    // do aluno é a que vai para assinatura.
    const campos = [
      ["Termo", "arquivo", termo.arquivo_url],
      ["Via assinada", "final", termo.arquivo_url ? null : termo.arquivo_final_url],
      ["RG", "rg", termo.arquivo_rg_url],
      ["Verso", "verso", termo.arquivo_verso_url],
    ].filter(([, , url]) => !!url);

    if (campos.length === 0) {
      alert(mensagemSemArquivo(termo));
      return false;
    }

    setJuntando(termo.id);
    const pecas = [];
    const naoBaixados = [];
    for (const [rotulo, campo] of campos) {
      try {
        const url = await urlTermo(termo.id, campo);
        if (!url) throw new Error("sem_url");
        const resposta = await fetch(url);
        if (!resposta.ok) throw new Error("http_" + resposta.status);
        pecas.push({ rotulo, bytes: new Uint8Array(await resposta.arrayBuffer()) });
      } catch {
        naoBaixados.push(rotulo);
      }
    }

    const res = await juntarEmPdf(pecas);
    setJuntando(null);

    if (!res.bytes) {
      alert("Não foi possível montar o PDF: nenhum arquivo deste aluno pôde ser lido.");
      return false;
    }

    const blob = new Blob([res.bytes], { type: "application/pdf" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = nomeArquivoPdf(termo.aluno_nome);
    link.click();
    URL.revokeObjectURL(href);

    // Arquivo que ficou de fora precisa ser dito: PDF incompleto sem aviso é
    // pior que PDF que não saiu.
    const fora = [...naoBaixados, ...res.falhas.map((f) => `${f.rotulo} (${f.motivo})`)];
    if (fora.length > 0) {
      alert(
        `PDF baixado com ${res.paginas} página(s), mas ficou incompleto.\n\n` +
          `Não entrou: ${fora.join(", ")}.`,
      );
    }
    return true;
  }

  async function marcarEnviados(ids) {
    if (!ids || ids.length === 0) return;
    setProcessando(true);
    const { data, error } = await supabase.rpc("termos_marcar_envio_assinatura", { p_ids: ids });
    setProcessando(false);
    if (error || !data?.ok) {
      alert("Não foi possível marcar o envio: " + (error?.message || data?.erro || "erro desconhecido"));
      return;
    }
    setSelecionados([]);
    carregarTermos();
  }

  async function desfazerEnvio(termo) {
    setProcessando(true);
    const { data, error } = await supabase.rpc("termo_desfazer_envio_assinatura", { p_termo_id: termo.id });
    setProcessando(false);
    if (error || !data?.ok) {
      alert("Não foi possível desfazer: " + (error?.message || data?.erro || "erro desconhecido"));
      return;
    }
    carregarTermos();
  }

  // "Termo assinado" marcado por engano (ex.: anexou a via sem testemunhas).
  // Volta para "A enviar"; o arquivo anexado é descartado — o termo assinado
  // de verdade é anexado depois, quando voltar.
  async function desfazerAssinatura(termo) {
    // O texto muda conforme haja ou não outra via no CRM: prometer descarte
    // quando o arquivo vai ser mantido (e vice-versa) é o que fez a ADM apagar
    // 10 termos sem perceber em 2026-08-25.
    const unicoArquivo = !termo.arquivo_url;
    const motivo = window.prompt(
      `Desfazer "Termo assinado" de ${termo.aluno_nome || "este aluno"}?\n\n` +
        (unicoArquivo
          ? "O termo volta para \"A enviar\". A via assinada é o ÚNICO arquivo deste termo " +
            "no CRM, então ela é MANTIDA — nada será apagado."
          : "O termo volta para \"A enviar\" e o arquivo anexado como via assinada é descartado. " +
            "A via assinada pelo aluno continua no CRM.") +
        "\n\nMotivo (opcional):",
      "",
    );
    if (motivo === null) return;
    setProcessando(true);
    const res = await desfazerAssinaturaConcluida(termo.id, motivo);
    setProcessando(false);
    if (!res.ok) {
      alert("Não foi possível desfazer: " + (res.erro === "etapa_invalida" ? "Este termo já não está como assinado. A fila será atualizada." : mensagemErro(res.erro)));
      return;
    }
    if (res.descarte === "mantido_unico_arquivo") {
      alert(
        "Termo de volta em \"A enviar\". A via assinada foi MANTIDA por ser o único " +
          "arquivo deste termo no CRM — assim ele não fica sem documento.",
      );
    } else if (res.pendentes_no_storage > 0) {
      alert("Desfeito, mas o arquivo anexado ainda não saiu do Storage. Avise o suporte.");
    }
    carregarTermos();
  }

  // --- Termo liberado que não vai adiante --------------------------------------

  function abrirDecisao(tipo, termo) {
    setModalDecisao({ tipo, termo });
    setDecisaoMotivo("");
    setDecisaoTxt("");
  }

  function fecharDecisao() {
    setModalDecisao(null);
  }

  // "Não será assinado": o acordo não foi cumprido e o termo sai da trilha de
  // assinatura (etapa DISPENSADO). Nada é apagado — a via assinada de quem não
  // pagou é a confissão de dívida — e dá para voltar atrás.
  async function dispensarAssinatura(termo) {
    const detalhe = decisaoTxt.trim();
    if (!decisaoMotivo) {
      alert("Selecione o motivo.");
      return;
    }
    if (decisaoMotivo === "OUTRO" && !detalhe) {
      alert("Descreva o motivo (obrigatório para 'Outro').");
      return;
    }
    setProcessando(true);
    const { data, error } = await supabase.rpc("termo_dispensar_assinatura", {
      p_termo_id: termo.id,
      p_motivo: decisaoMotivo,
      p_detalhe: detalhe || null,
    });
    setProcessando(false);
    if (error || !data?.ok) {
      const cod = error?.message || data?.erro || "erro desconhecido";
      alert(
        cod === "etapa_invalida"
          ? "Este termo já não está na fila de assinatura. A lista será atualizada."
          : "Não foi possível tirar o termo da fila: " + cod,
      );
      if (data?.erro === "etapa_invalida") carregarTermos();
      return;
    }
    fecharDecisao();
    carregarTermos();
  }

  // "Devolver ao operador": termo liberado com algo errado no acordo. Vira
  // TERMO_REJEITADO com o motivo e o caso volta ao operador, que reenvia um
  // termo novo pela ficha. O arquivo conferido fica como histórico.
  async function devolverAoOperador(termo) {
    const compl = decisaoTxt.trim();
    if (!decisaoMotivo) {
      alert("Selecione o motivo da devolução.");
      return;
    }
    if (decisaoMotivo === "Outro" && !compl) {
      alert("Descreva o motivo (obrigatório para 'Outro').");
      return;
    }
    const motivo =
      decisaoMotivo === "Outro" ? compl : compl ? `${decisaoMotivo} — ${compl}` : decisaoMotivo;

    setProcessando(true);
    const { data, error } = await supabase.rpc("termo_devolver_ao_operador", {
      p_termo_id: termo.id,
      p_motivo: motivo,
    });
    setProcessando(false);
    if (error || !data?.ok) {
      const cod = error?.message || data?.erro || "erro desconhecido";
      alert(
        cod === "assinatura_concluida"
          ? "Este termo já está assinado por testemunhas e Ulbra. Use 'Desfazer assinatura' antes de devolver."
          : cod === "status_invalido"
            ? "Este termo não está liberado; só termo liberado pode ser devolvido. A lista será atualizada."
            : "Não foi possível devolver o termo: " + cod,
      );
      if (data?.erro === "status_invalido") carregarTermos();
      return;
    }
    fecharDecisao();
    alert(
      `Termo de ${termo.aluno_nome || "aluno"} devolvido. O operador ` +
        `${termo.operador_nome || termo.operador_email || ""} foi avisado e o caso voltou para a fila dele.`,
    );
    carregarTermos();
  }

  function confirmarDecisao() {
    if (!modalDecisao || processando) return;
    if (modalDecisao.tipo === "DISPENSAR") return dispensarAssinatura(modalDecisao.termo);
    return devolverAoOperador(modalDecisao.termo);
  }

  // Dispensado por engano, ou aluno que voltou a pagar: volta para "A enviar".
  async function reativarAssinatura(termo) {
    const ok = window.confirm(
      `Voltar o termo de ${termo.aluno_nome || "este aluno"} para a fila de assinatura?\n\n` +
        'Ele volta como "A enviar".',
    );
    if (!ok) return;
    setProcessando(true);
    const { data, error } = await supabase.rpc("termo_reativar_assinatura", { p_termo_id: termo.id });
    setProcessando(false);
    if (error || !data?.ok) {
      alert("Não foi possível voltar o termo para a fila: " + (error?.message || data?.erro || "erro desconhecido"));
      return;
    }
    carregarTermos();
  }

  function abrirAnexo(termo) {
    setModalAnexo(termo);
    setAnexoArquivo(null);
    setTestemunha1(termo.testemunha_1_nome || "");
    setTestemunha2(termo.testemunha_2_nome || "");
  }

  // Sobe a via completa e conclui. A ordem é upload -> conclusão -> descarte
  // (feito pela Edge): a via do aluno só sai depois de o arquivo novo estar
  // confirmado no bucket. Sem confirmação de backup, conclui SEM descartar.
  async function salvarViaCompleta() {
    if (!modalAnexo || !anexoArquivo) {
      alert("Selecione o arquivo da via assinada.");
      return;
    }
    setProcessando(true);

    const envio = await enviarTermo(modalAnexo.id, "final", anexoArquivo);
    if (!envio.ok && envio.erro !== "ja_vinculado") {
      setProcessando(false);
      alert(erroAnexo(envio.erro));
      return;
    }

    // O descarte é automático: anexar a via completa É a decisão de descartar a
    // do aluno. A trava que sobra é a do backend — sem o arquivo novo confirmado
    // no bucket, nada é apagado.
    const res = await concluirAssinaturaTermo(modalAnexo.id, {
      testemunha1,
      testemunha2,
      backupConfirmado: true,
    });
    setProcessando(false);

    if (!res.ok) {
      alert("A via foi anexada, mas a conclusão falhou (" + res.erro + "). Nada foi apagado.");
      return;
    }

    if (res.descarte === "adiado_sem_backup") {
      alert("Termo marcado como assinado completo. A via do aluno NÃO foi apagada — confirme o backup para descartá-la.");
    } else if (res.pendentes_no_storage > 0) {
      alert("Termo concluído, mas " + res.pendentes_no_storage + " arquivo(s) não saíram do Storage. Ficaram registrados para nova tentativa.");
    } else {
      alert("Termo assinado. Via completa guardada e via do aluno descartada.");
    }

    setModalAnexo(null);
    carregarTermos();
  }

  async function descartarSomenteViaAluno(termo) {
    const ok = window.confirm(
      "Confirma que as vias já estão salvas na pasta de backup?\n\n" +
        "A via assinada pelo aluno (e RG/verso) será apagada do CRM. Isso não pode ser desfeito."
    );
    if (!ok) return;
    setProcessando(true);
    const res = await descartarViaAluno(termo.id, { backupConfirmado: true });
    setProcessando(false);
    if (!res.ok) {
      alert("Não foi possível descartar: " + res.erro);
      return;
    }
    carregarTermos();
  }

  async function abrirDocumentoFinal(termo) {
    const url = await urlTermo(termo.id, "final");
    if (!url) {
      alert("Documento indisponível ou você não tem permissão para visualizá-lo.");
      return;
    }
    window.open(url, "_blank", "noreferrer");
  }

  function alternarSelecao(id) {
    setSelecionados((atual) =>
      atual.includes(id) ? atual.filter((x) => x !== id) : [...atual, id]
    );
  }

  const emailUsuario = usuario?.email || "";
  const podeValidar = ADM_AUTORIZADOS.includes(emailUsuario);

  const contadores = useMemo(() => {
    return {
      pendentes: termos.filter((t) => t.status === "TERMO_ENVIADO_ADM").length,
      liberados: termos.filter((t) => t.status === "TERMO_RECEBIDO_LIBERADO").length,
      rejeitados: termos.filter((t) => t.status === "TERMO_REJEITADO").length,
      auditoria: termos.filter(ehGovPendenteAuditoria).length,
      todos: termos.length,
    };
  }, [termos]);

  const termosLiberados = useMemo(
    () => termos.filter((t) => t.status === "TERMO_RECEBIDO_LIBERADO"),
    [termos]
  );

  const contadoresLiberados = useMemo(() => {
    const gov = termosLiberados.filter(ehAssinaturaGov).length;
    return { todos: termosLiberados.length, gov, manual: termosLiberados.length - gov };
  }, [termosLiberados]);

  const termosFiltrados = useMemo(() => {
    if (filtro === "PENDENTES") return termos.filter((t) => t.status === "TERMO_ENVIADO_ADM");
    if (filtro === "LIBERADOS") {
      const porTipo =
        tipoLiberado === "TODOS"
          ? termosLiberados
          : termosLiberados.filter((t) => ehAssinaturaGov(t) === (tipoLiberado === "GOV_BR"));

      return [...porTipo].sort((a, b) =>
        ordemLiberados === "RECENTE"
          ? dataLiberacao(b) - dataLiberacao(a)
          : dataLiberacao(a) - dataLiberacao(b)
      );
    }
    if (filtro === "REJEITADOS") return termos.filter((t) => t.status === "TERMO_REJEITADO");
    if (filtro === "AUDITORIA") return termos.filter(ehGovPendenteAuditoria);
    if (filtro === "ASSINATURAS") {
      // "Todas" é a trilha viva; o dispensado só aparece no filtro dele.
      const porEtapa =
        etapaFiltro === "TODAS"
          ? termos.filter(naTrilha)
          : etapaFiltro === "DISPENSADO"
            ? termos.filter(ehDispensado)
            : termos.filter((t) => etapaDe(t) === etapaFiltro);
      const porBusca = porEtapa.filter((t) => casaBusca(t, buscaAssinatura));
      return [...porBusca].sort((a, b) =>
        ordemLiberados === "RECENTE"
          ? dataEtapa(b) - dataEtapa(a)
          : dataEtapa(a) - dataEtapa(b)
      );
    }
    return termos;
  }, [termos, termosLiberados, filtro, tipoLiberado, ordemLiberados, etapaFiltro, buscaAssinatura]);

  // Contadores da trilha de assinatura. Valem para TODO termo liberado —
  // manual e gov.br —, porque todos precisam das testemunhas e da Ulbra.
  const contadoresEtapa = useMemo(() => {
    const base = { NAO_VERIFICADO: 0, PENDENTE_ENVIO: 0, ENVIADO_ASSINATURA: 0, COMPLETO: 0, DISPENSADO: 0, TODAS: 0 };
    for (const t of termos) {
      const e = etapaDe(t);
      if (e === "NAO_APLICAVEL") continue;
      base[e] += 1;
      // O dispensado não entra em "Todas": foi tirado da fila de propósito.
      if (naTrilha(t)) base.TODAS += 1;
    }
    return base;
  }, [termos]);

  // Só faz sentido marcar envio em lote no que ainda não saiu.
  const selecionaveis = useMemo(
    () => termosFiltrados.filter((t) => ["NAO_VERIFICADO", "PENDENTE_ENVIO"].includes(etapaDe(t))),
    [termosFiltrados]
  );

  if (carregando) {
    return <div style={styles.container}><Carregando texto="Carregando fila ADM…" /></div>;
  }

  if (!podeValidar) {
    return (
      <div style={styles.container}>
        <h1 style={styles.titulo}>Fila ADM de Termos</h1>
        <div style={styles.alerta}>Seu usuário não tem permissão para validar termos.</div>
        <p>
          Usuário logado: <strong>{emailUsuario || "Não identificado"}</strong>
        </p>
        <p style={styles.texto}>Usuários autorizados: Fernanda, Amanda ADM e Amanda gestora.</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Fila ADM de Termos</h1>
          <p style={styles.subtitulo}>Validação dos termos de acordo enviados pela operação.</p>
        </div>
        <button style={styles.botaoAtualizar} onClick={carregarTermos}>
          Atualizar fila
        </button>
      </div>

      <div style={styles.cardsIndicadores}>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.pendentes}</span>
          <span style={styles.descricao}>Pendentes</span>
        </div>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.liberados}</span>
          <span style={styles.descricao}>Liberados</span>
        </div>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.rejeitados}</span>
          <span style={styles.descricao}>Rejeitados</span>
        </div>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.auditoria}</span>
          <span style={styles.descricao}>Auditoria (gov.br)</span>
        </div>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.todos}</span>
          <span style={styles.descricao}>Total</span>
        </div>
      </div>

      <div style={styles.filtros}>
        {["PENDENTES", "LIBERADOS", "REJEITADOS", "AUDITORIA", "ASSINATURAS", "TODOS"].map((f) => (
          <button
            key={f}
            style={filtro === f ? styles.filtroAtivo : styles.filtro}
            onClick={() => setFiltro(f)}
          >
            {f === "AUDITORIA"
              ? "Auditoria (gov.br)"
              : f === "ASSINATURAS"
                ? `Assinaturas (${contadoresEtapa.TODAS})`
                : f.charAt(0) + f.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {filtro === "LIBERADOS" && (
        <div style={styles.subFiltros}>
          <div style={styles.grupoSubFiltro}>
            <span style={styles.rotuloSubFiltro}>Assinatura:</span>
            {[
              { chave: "TODOS", label: `Todas (${contadoresLiberados.todos})` },
              { chave: "MANUAL", label: `Manual + RG (${contadoresLiberados.manual})` },
              { chave: "GOV_BR", label: `Gov.br (${contadoresLiberados.gov})` },
            ].map((op) => (
              <button
                key={op.chave}
                style={tipoLiberado === op.chave ? styles.subFiltroAtivo : styles.subFiltro}
                onClick={() => setTipoLiberado(op.chave)}
              >
                {op.label}
              </button>
            ))}
          </div>

          <div style={styles.grupoSubFiltro}>
            <span style={styles.rotuloSubFiltro}>Liberação:</span>
            {[
              { chave: "RECENTE", label: "Mais recentes primeiro" },
              { chave: "ANTIGO", label: "Mais antigos primeiro" },
            ].map((op) => (
              <button
                key={op.chave}
                style={ordemLiberados === op.chave ? styles.subFiltroAtivo : styles.subFiltro}
                onClick={() => setOrdemLiberados(op.chave)}
              >
                {op.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {filtro === "ASSINATURAS" && (
        <>
          <div style={styles.subFiltros}>
            <div style={styles.grupoSubFiltro}>
              <span style={styles.rotuloSubFiltro}>Aluno:</span>
              <input
                style={styles.campoBusca}
                placeholder="Pesquisar por nome ou CPF"
                value={buscaAssinatura}
                onChange={(e) => setBuscaAssinatura(e.target.value)}
              />
              {buscaAssinatura.trim() !== "" && (
                <button style={styles.subFiltro} onClick={() => setBuscaAssinatura("")}>
                  Limpar busca
                </button>
              )}
            </div>

            <div style={styles.grupoSubFiltro}>
              <span style={styles.rotuloSubFiltro}>Etapa:</span>
              {[{ chave: "TODAS", label: `Todas (${contadoresEtapa.TODAS})` }].concat(
                ETAPAS_ASSINATURA.map((e) => ({
                  chave: e,
                  label: `${ETAPA_LABEL[e]} (${contadoresEtapa[e]})`,
                })),
                [{ chave: "DISPENSADO", label: `${ETAPA_LABEL.DISPENSADO} (${contadoresEtapa.DISPENSADO})` }]
              ).map((op) => (
                <button
                  key={op.chave}
                  style={etapaFiltro === op.chave ? styles.subFiltroAtivo : styles.subFiltro}
                  onClick={() => {
                    setEtapaFiltro(op.chave);
                    setSelecionados([]);
                  }}
                >
                  {op.label}
                </button>
              ))}
            </div>

            <div style={styles.grupoSubFiltro}>
              <span style={styles.rotuloSubFiltro}>Ordem:</span>
              {[
                { chave: "RECENTE", label: "Mais recentes primeiro" },
                { chave: "ANTIGO", label: "Mais antigos primeiro" },
              ].map((op) => (
                <button
                  key={op.chave}
                  style={ordemLiberados === op.chave ? styles.subFiltroAtivo : styles.subFiltro}
                  onClick={() => setOrdemLiberados(op.chave)}
                >
                  {op.label}
                </button>
              ))}
            </div>
          </div>

          {buscaAssinatura.trim() !== "" && (
            <div style={styles.avisoBusca}>
              Mostrando <strong>{termosFiltrados.length}</strong> termo(s) de{" "}
              {etapaFiltro === "TODAS" ? contadoresEtapa.TODAS : contadoresEtapa[etapaFiltro]} nesta
              etapa. Os contadores acima seguem contando tudo, não só a busca.
            </div>
          )}

          <div style={styles.barraLote}>
            <span style={styles.rotuloSubFiltro}>
              {selecionados.length > 0
                ? `${selecionados.length} termo(s) selecionado(s)`
                : "Selecione termos para mandar para assinatura em lote"}
            </span>
            <button
              style={styles.subFiltro}
              onClick={() => setSelecionados(selecionaveis.map((t) => t.id))}
              disabled={selecionaveis.length === 0}
            >
              Selecionar todos desta lista ({selecionaveis.length})
            </button>
            <button
              style={styles.subFiltro}
              onClick={() => setSelecionados([])}
              disabled={selecionados.length === 0}
            >
              Limpar seleção
            </button>
            <button
              style={styles.botaoValidar}
              onClick={() => marcarEnviados(selecionados)}
              disabled={selecionados.length === 0 || processando}
            >
              Marcar como aguardando assinaturas
            </button>
          </div>
        </>
      )}

      {termosFiltrados.length === 0 && (
        <div style={styles.vazio}>Nenhum termo encontrado neste filtro.</div>
      )}

      {termosFiltrados.map((termo) => {
        const acionavel = ehTermoAcionavel(termo);
        const ehGov = termo.status === "TERMO_LIBERADO_AUTOMATICO_GOV";
        return (
          <div key={termo.id} style={styles.card}>
            <div style={styles.topoCard}>
              <div>
                <h2 style={styles.nome}>{termo.aluno_nome || "Aluno sem nome"}</h2>
                <p style={styles.info}>
                  <strong>CPF:</strong> {cpfParcial(termo.aluno_cpf)}
                </p>
                <p style={styles.info}>
                  <strong>Operador:</strong>{" "}
                  {termo.operador_nome || termo.operador_email || "Não informado"}
                </p>
                <p style={styles.info}>
                  <strong>Enviado em:</strong> {formatarData(termo.criado_em)}
                </p>
                {termo.status === "TERMO_RECEBIDO_LIBERADO" && (
                  <p style={styles.info}>
                    <strong>Liberado em:</strong> {formatarData(termo.validado_em)}
                  </p>
                )}
                {termo.assinatura_enviada_em && (
                  <p style={styles.info}>
                    <strong>Foi para assinatura em:</strong>{" "}
                    {formatarData(termo.assinatura_enviada_em)} por{" "}
                    {termo.assinatura_enviada_por || "-"}
                  </p>
                )}
                {termo.assinatura_completa_em && (
                  <p style={styles.info}>
                    <strong>Termo assinado em:</strong>{" "}
                    {formatarData(termo.assinatura_completa_em)} por{" "}
                    {termo.assinatura_completa_por || "-"}
                  </p>
                )}
                <p style={styles.info}>
                  <strong>Assinatura:</strong>{" "}
                  {termo.tipo_assinatura === "GOV_BR"
                    ? "Gov.br (validada eletronicamente)"
                    : "Manual + RG"}
                </p>
              </div>
              <div style={styles.selos}>
                <span style={{ ...styles.status, ...corStatus(termo.status) }}>
                  {traduzStatus(termo.status)}
                </span>
                {etapaDe(termo) !== "NAO_APLICAVEL" && (
                  <span style={{ ...styles.status, ...corEtapa(etapaDe(termo)) }}>
                    {ETAPA_LABEL[etapaDe(termo)]}
                  </span>
                )}
              </div>
            </div>

            <div style={styles.bloco}>
              <strong>Observação da operação:</strong>
              <p style={styles.paragrafo}>{termo.observacao_operador || "Sem observação."}</p>
            </div>

            {termo.observacao_adm && (
              <div style={styles.blocoRetorno}>
                <strong>Retorno ADM:</strong>
                <p style={styles.paragrafo}>{termo.observacao_adm}</p>
                <p style={styles.info}>
                  <strong>Validado por:</strong> {termo.validado_por || "-"}
                </p>
                <p style={styles.info}>
                  <strong>Validado em:</strong> {formatarData(termo.validado_em)}
                </p>
              </div>
            )}

            {filtro === "ASSINATURAS" && semArquivo(termo) && (
              <div style={styles.avisoSemArquivo}>
                <strong>Sem arquivo no CRM.</strong> Não há documento guardado para este
                termo — não dá para abrir nem marcar o envio. Reanexe a via a partir da
                pasta de backup em "Anexar via assinada".
              </div>
            )}

            {ehDispensado(termo) && (
              <div style={styles.blocoRetorno}>
                <strong>Fora da fila de assinatura.</strong>
                <p style={styles.paragrafo}>
                  {rotuloMotivoDispensa(termo.dispensa_motivo)}
                  {termo.dispensa_detalhe ? ` — ${termo.dispensa_detalhe}` : ""}
                </p>
                <p style={styles.info}>
                  <strong>Por:</strong> {termo.dispensado_por || "-"} <strong>em</strong>{" "}
                  {formatarData(termo.dispensado_em)}
                </p>
              </div>
            )}

            {filtro === "ASSINATURAS" && (
              <div style={styles.acoesAssinatura}>
                {ehDispensado(termo) && (
                  <button
                    style={styles.botaoVer}
                    onClick={() => reativarAssinatura(termo)}
                    disabled={processando}
                    title="Dispensado por engano, ou o aluno voltou a pagar: volta para 'A enviar'."
                  >
                    Voltar para a fila
                  </button>
                )}

                {["NAO_VERIFICADO", "PENDENTE_ENVIO", "ENVIADO_ASSINATURA"].includes(etapaDe(termo)) && (
                  <button
                    style={styles.botaoDescartar}
                    onClick={() => abrirDecisao("DISPENSAR", termo)}
                    disabled={processando}
                    title="Acordo não cumprido: o termo sai da fila de assinatura. Nada é apagado e dá para voltar."
                  >
                    Não será assinado
                  </button>
                )}

                {["NAO_VERIFICADO", "PENDENTE_ENVIO"].includes(etapaDe(termo)) && (
                  <>
                    <label style={styles.checkLinha}>
                      <input
                        type="checkbox"
                        checked={selecionados.includes(termo.id)}
                        onChange={() => alternarSelecao(termo.id)}
                      />
                      Selecionar
                    </label>
                    <button
                      style={styles.botaoValidar}
                      onClick={() => baixarEMarcarEnviado(termo)}
                      disabled={processando || juntando === termo.id || semArquivo(termo)}
                      title={
                        semArquivo(termo)
                          ? "Termo sem arquivo no CRM: reanexe a via antes de enviar."
                          : "Baixa termo, RG e verso num PDF só e marca como enviado para assinatura."
                      }
                    >
                      {juntando === termo.id ? "Montando PDF..." : "Baixar PDF para assinatura"}
                    </button>
                  </>
                )}

                {(termo.arquivo_url || termo.arquivo_final_url || termo.arquivo_rg_url || termo.arquivo_verso_url) && (
                  <button
                    style={styles.botaoVer}
                    onClick={() => baixarPdfDoAluno(termo)}
                    disabled={juntando === termo.id}
                    title="Baixa termo, RG e verso deste aluno juntos, num PDF só. Não marca envio."
                  >
                    {juntando === termo.id ? "Montando PDF..." : "Baixar tudo num PDF"}
                  </button>
                )}

                {etapaDe(termo) === "ENVIADO_ASSINATURA" && (
                  <button
                    style={styles.botaoVer}
                    onClick={() => desfazerEnvio(termo)}
                    disabled={processando}
                  >
                    Desfazer envio
                  </button>
                )}

                {etapaDe(termo) === "COMPLETO" && (
                  <button
                    style={styles.botaoDescartar}
                    onClick={() => desfazerAssinatura(termo)}
                    disabled={processando}
                    title="Marcado como assinado por engano? Volta para 'A enviar' e descarta o arquivo anexado."
                  >
                    Desfazer assinatura
                  </button>
                )}

                {etapaDe(termo) !== "COMPLETO" && !ehDispensado(termo) && (
                  <button
                    style={styles.botaoValidar}
                    onClick={() => abrirAnexo(termo)}
                    disabled={processando}
                  >
                    Anexar via assinada
                  </button>
                )}

                {termo.arquivo_final_url && (
                  <button
                    style={styles.botaoVer}
                    onClick={() => abrirDocumentoFinal(termo)}
                  >
                    Abrir via assinada
                  </button>
                )}

                {termo.arquivo_url && etapaDe(termo) !== "COMPLETO" && (
                  <button
                    style={styles.botaoDescartar}
                    onClick={() => descartarSomenteViaAluno(termo)}
                    disabled={processando}
                  >
                    Descartar via do aluno
                  </button>
                )}
              </div>
            )}

            <div style={styles.acoes}>
              {acionavel ? (
                <button style={styles.botaoValidar} onClick={() => abrirValidacao(termo)}>
                  {ehGov ? "Validar documento (gov.br)" : "Validar assinatura"}
                </button>
              ) : (
                termo.arquivo_url && (
                  <button style={styles.botaoVer} onClick={() => abrirValidacao(termo)}>
                    Ver documento
                  </button>
                )
              )}
              {podeDevolverAoOperador(termo) && (
                <button
                  style={styles.botaoRejeitar}
                  onClick={() => abrirDecisao("DEVOLVER", termo)}
                  disabled={processando}
                  title="Algo errado no acordo? O termo volta como rejeitado e o operador é avisado para corrigir e reenviar."
                >
                  Devolver ao operador
                </button>
              )}
            </div>
          </div>
        );
      })}

      {modalTermo && (
        <ModalValidacao
          termo={modalTermo}
          previewCampo={previewCampo}
          previewUrl={previewUrl}
          previewLoading={previewLoading}
          previewErro={previewErro}
          zoom={zoom}
          setZoom={setZoom}
          trocarCampo={(campo) => carregarPreview(modalTermo, campo)}
          recarregarPreview={() => carregarPreview(modalTermo, previewCampo)}
          obs={obs}
          setObs={setObs}
          motivoSel={motivoSel}
          setMotivoSel={setMotivoSel}
          motivoTxt={motivoTxt}
          setMotivoTxt={setMotivoTxt}
          salvando={salvando}
          onFechar={fecharModal}
          onDecidir={decidir}
        />
      )}

      {modalDecisao && (
        <ModalDecisao
          tipo={modalDecisao.tipo}
          termo={modalDecisao.termo}
          motivo={decisaoMotivo}
          setMotivo={setDecisaoMotivo}
          texto={decisaoTxt}
          setTexto={setDecisaoTxt}
          processando={processando}
          onConfirmar={confirmarDecisao}
          onFechar={fecharDecisao}
        />
      )}

      {modalAnexo && (
        <div style={styles.overlay}>
          <div style={styles.modalAnexo}>
            <h2 style={styles.titulo}>Anexar via assinada</h2>
            <p style={styles.texto}>
              {modalAnexo.aluno_nome || "Aluno sem nome"} — a via completa deve ter a
              assinatura do aluno, das duas testemunhas e da Ulbra.
            </p>

            <div style={styles.bloco}>
              <label style={styles.label}>Arquivo da via assinada</label>
              {/* O accept precisa espelhar o que a Edge Function aceita. Mais
                  estreito aqui deixa o arquivo CINZA na pasta e parece que ele
                  sumiu. Extensões junto dos MIME: em alguns sistemas o diálogo
                  casa por extensão, não por tipo. */}
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,application/pdf,image/png,image/jpeg,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => setAnexoArquivo(e.target.files?.[0] || null)}
              />
              <p style={styles.texto}>
                Aceita PDF, JPG, PNG e Word, até 20 MB. Foto de iPhone em HEIC não
                entra: converta para JPG ou PDF antes.
              </p>
            </div>

            <div style={styles.bloco}>
              <label style={styles.label}>Testemunhas (opcional)</label>
              <input
                style={styles.campoTexto}
                placeholder="Nome da 1ª testemunha"
                value={testemunha1}
                onChange={(e) => setTestemunha1(e.target.value)}
              />
              <input
                style={{ ...styles.campoTexto, marginTop: "8px" }}
                placeholder="Nome da 2ª testemunha"
                value={testemunha2}
                onChange={(e) => setTestemunha2(e.target.value)}
              />
            </div>

            <div style={styles.avisoBackup}>
              <strong>Ao salvar, a via assinada só pelo aluno é apagada do CRM</strong>
              <p style={styles.texto}>
                O RG e o verso saem junto. Isso só acontece depois que a via completa
                estiver confirmada no armazenamento — se o envio falhar, nada é apagado.
                Guarde as vias na pasta de backup antes, porque o descarte não tem volta.
              </p>
            </div>

            <div style={styles.acoes}>
              <button
                style={styles.botaoValidar}
                onClick={salvarViaCompleta}
                disabled={processando || !anexoArquivo}
              >
                {processando ? "Salvando…" : "Salvar via assinada e descartar a do aluno"}
              </button>
              <button
                style={styles.botaoVer}
                onClick={() => setModalAnexo(null)}
                disabled={processando}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Decisão sobre termo já liberado. Dois usos com a mesma casca:
//   DISPENSAR -> sai da fila de assinatura (motivo fechado; reversível; nada apagado)
//   DEVOLVER  -> volta ao operador como rejeitado (motivo livre com lista de apoio)
function ModalDecisao({ tipo, termo, motivo, setMotivo, texto, setTexto, processando, onConfirmar, onFechar }) {
  const dispensar = tipo === "DISPENSAR";
  const nome = termo.aluno_nome || "este aluno";
  const outro = dispensar ? motivo === "OUTRO" : motivo === "Outro";

  return (
    <div style={styles.overlay} onClick={onFechar}>
      <div style={styles.modalAnexo} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.titulo}>{dispensar ? "Não será assinado" : "Devolver ao operador"}</h2>
        <p style={styles.texto}>
          {dispensar ? (
            <>
              O termo de <strong>{nome}</strong> sai da fila de assinatura (testemunhas + Ulbra).
              Nenhum arquivo é apagado e dá para voltar atrás em "Voltar para a fila".
            </>
          ) : (
            <>
              O termo de <strong>{nome}</strong> volta como <strong>rejeitado</strong> para{" "}
              {termo.operador_nome || termo.operador_email || "o operador"}, que recebe o motivo
              na ficha e reenvia um termo corrigido. O documento conferido fica guardado.
            </>
          )}
        </p>

        <div style={styles.bloco}>
          <label style={styles.label}>Motivo</label>
          <select
            style={styles.select}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            aria-label="Motivo"
          >
            <option value="">Selecione o motivo...</option>
            {dispensar
              ? MOTIVOS_DISPENSA.map((m) => (
                  <option key={m.codigo} value={m.codigo}>
                    {m.rotulo}
                  </option>
                ))
              : MOTIVOS_DEVOLUCAO.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
          </select>
          <textarea
            style={{ ...styles.textarea, marginTop: 8 }}
            placeholder={
              outro
                ? "Descreva o motivo (obrigatório para 'Outro')."
                : dispensar
                  ? "Detalhe (opcional)."
                  : "O que o operador precisa ajustar (opcional, vai junto no retorno)."
            }
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            aria-label="Detalhe do motivo"
          />
        </div>

        <div style={styles.acoes}>
          <button
            style={dispensar ? styles.botaoDescartar : styles.botaoRejeitar}
            onClick={onConfirmar}
            disabled={processando}
          >
            {processando
              ? "Processando…"
              : dispensar
                ? "Confirmar: não será assinado"
                : "Confirmar devolução"}
          </button>
          <button style={styles.botaoVer} onClick={onFechar} disabled={processando}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalValidacao(props) {
  const {
    termo, previewCampo, previewUrl, previewLoading, previewErro, zoom, setZoom,
    trocarCampo, recarregarPreview, obs, setObs, motivoSel, setMotivoSel,
    motivoTxt, setMotivoTxt, salvando, onFechar, onDecidir,
  } = props;

  const ehGov = termo.status === "TERMO_LIBERADO_AUTOMATICO_GOV";
  const acionavel = ehTermoAcionavel(termo);
  // Manual sem doc -> só rejeição. gov.br: anexo é opcional (assinatura já é
  // eletrônica), então a decisão não exige preview carregado.
  const podeDecidir = acionavel && !previewLoading && (ehGov || !!previewUrl);

  const nomeCampo =
    previewCampo === "rg" ? termo.arquivo_rg_nome
      : previewCampo === "verso" ? termo.arquivo_verso_nome
      : termo.arquivo_nome;
  const ext = extensaoDe(nomeCampo) || extensaoDe(previewUrl);
  const ehImagem = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);

  const campos = [
    { chave: "arquivo", rotulo: "Termo", tem: !!termo.arquivo_url },
    { chave: "rg", rotulo: "RG", tem: !!termo.arquivo_rg_url },
    { chave: "verso", rotulo: "Verso", tem: !!termo.arquivo_verso_url },
  ].filter((c) => c.tem);

  return (
    <div style={styles.overlay} onClick={onFechar}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* LADO ESQUERDO: documento */}
        <div style={styles.painelDoc}>
          <div style={styles.docToolbar}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {campos.map((c) => (
                <button
                  key={c.chave}
                  onClick={() => trocarCampo(c.chave)}
                  style={previewCampo === c.chave ? styles.abaAtiva : styles.aba}
                >
                  {c.rotulo}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button style={styles.zoomBtn} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}>
                −
              </button>
              <span style={{ fontSize: 12, minWidth: 42, textAlign: "center" }}>
                {Math.round(zoom * 100)}%
              </span>
              <button style={styles.zoomBtn} onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}>
                +
              </button>
            </div>
          </div>

          <div style={styles.docViewport}>
            {previewLoading && <div style={styles.docEstado}>Carregando documento...</div>}
            {previewErro && !previewLoading && (
              <div style={styles.docEstado}>
                Documento indisponível.
                <br />
                <button style={styles.botaoVer} onClick={recarregarPreview}>
                  Tentar novamente
                </button>
              </div>
            )}
            {!previewLoading && !previewErro && previewUrl && (
              <div
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: "top center",
                  width: "100%",
                  height: ehImagem ? "auto" : "100%",
                }}
              >
                {ehImagem ? (
                  <img src={previewUrl} alt="Documento assinado" style={styles.docImg} />
                ) : (
                  <iframe src={previewUrl} title="Documento assinado" style={styles.docIframe} />
                )}
              </div>
            )}
            {!previewLoading && !previewErro && !previewUrl && (
              <div style={styles.docEstado}>Este termo foi enviado sem anexo localizado.</div>
            )}
          </div>
        </div>

        {/* LADO DIREITO: validação */}
        <div style={styles.painelValidacao}>
          <div style={styles.validacaoTopo}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{termo.aluno_nome || "Aluno sem nome"}</h2>
            <button style={styles.fechar} onClick={onFechar}>
              ✕
            </button>
          </div>

          <span style={{ ...styles.status, ...corStatus(termo.status), alignSelf: "flex-start" }}>
            {traduzStatus(termo.status)}
          </span>

          <div style={styles.validacaoDados}>
            <p style={styles.info}>
              <strong>CPF:</strong> {cpfParcial(termo.aluno_cpf)}
            </p>
            <p style={styles.info}>
              <strong>Operador:</strong> {termo.operador_nome || termo.operador_email || "-"}
            </p>
            <p style={styles.info}>
              <strong>Enviado em:</strong> {formatarData(termo.criado_em)}
            </p>
            <p style={styles.info}>
              <strong>Assinatura:</strong>{" "}
              {termo.tipo_assinatura === "GOV_BR" ? "Gov.br (eletrônica)" : "Manual + RG"}
            </p>
            {termo.observacao_operador && (
              <p style={styles.info}>
                <strong>Obs. operação:</strong> {termo.observacao_operador}
              </p>
            )}
          </div>

          {acionavel ? (
            <div style={styles.validacaoAcoes}>
              <label style={styles.label}>Observação (aprovação)</label>
              <textarea
                style={styles.textarea}
                placeholder="Ex.: termo conferido, dados compatíveis."
                value={obs}
                onChange={(e) => setObs(e.target.value)}
              />

              <label style={{ ...styles.label, marginTop: 12 }}>Motivo (rejeição)</label>
              <select
                style={styles.select}
                value={motivoSel}
                onChange={(e) => setMotivoSel(e.target.value)}
              >
                <option value="">Selecione o motivo...</option>
                {MOTIVOS_REJEICAO.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <textarea
                style={{ ...styles.textarea, marginTop: 8 }}
                placeholder={
                  motivoSel === "Outro"
                    ? "Descreva o motivo (obrigatório para 'Outro')."
                    : "Observação complementar (opcional)."
                }
                value={motivoTxt}
                onChange={(e) => setMotivoTxt(e.target.value)}
              />

              <div style={styles.botoesDecisao}>
                <button
                  style={{ ...styles.botaoAprovar, opacity: podeDecidir && !salvando ? 1 : 0.6 }}
                  disabled={!podeDecidir || salvando}
                  onClick={() => onDecidir("APROVAR", false)}
                >
                  {salvando
                    ? "Processando..."
                    : ehGov
                    ? "Validar e liberar ao operador"
                    : "Assinatura validada"}
                </button>
                <button
                  style={{ ...styles.botaoRejeitar, opacity: salvando ? 0.6 : 1 }}
                  disabled={salvando}
                  onClick={() => onDecidir("REJEITAR", false)}
                >
                  {ehGov ? "Rejeitar documento" : "Rejeitar assinatura"}
                </button>
              </div>
              {!ehGov && (
                <button
                  style={{ ...styles.botaoProximo, opacity: podeDecidir && !salvando ? 1 : 0.6 }}
                  disabled={!podeDecidir || salvando}
                  onClick={() => onDecidir("APROVAR", true)}
                >
                  Validar e abrir próximo
                </button>
              )}
              {ehGov ? (
                <p style={{ color: "#4b1e8f", fontSize: 13, marginTop: 8 }}>
                  Assinatura via gov.br já é validada eletronicamente. Confira os dados do
                  documento e clique em <strong>Validar e liberar ao operador</strong> — só então
                  o operador é avisado para liberar o acordo. Se algo estiver errado, rejeite.
                </p>
              ) : (
                !previewUrl &&
                !previewLoading && (
                  <p style={{ color: "#b45309", fontSize: 13, marginTop: 8 }}>
                    Sem documento carregado: aprovação bloqueada. É possível rejeitar por arquivo
                    ilegível/ausente.
                  </p>
                )
              )}
            </div>
          ) : (
            <div style={styles.blocoRetorno}>
              <strong>Termo já processado.</strong>
              {termo.observacao_adm && <p style={styles.paragrafo}>{termo.observacao_adm}</p>}
              <p style={styles.info}>
                <strong>Validado por:</strong> {termo.validado_por || "-"}
              </p>
              <p style={styles.info}>
                <strong>Validado em:</strong> {formatarData(termo.validado_em)}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    padding: "24px",
    fontFamily: "Arial, sans-serif",
    background: "#f4f6f8",
    minHeight: "100%",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
    marginBottom: "18px",
  },
  titulo: { margin: 0, marginBottom: "6px", color: "#111827" },
  subtitulo: { color: "#555", margin: 0 },
  texto: { color: "#555" },
  botaoAtualizar: {
    background: "#111827",
    color: "#fff",
    border: "none",
    padding: "11px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  cardsIndicadores: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: "12px",
    marginBottom: "18px",
  },
  indicador: {
    background: "#fff",
    borderRadius: "12px",
    padding: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  numero: { display: "block", fontSize: "28px", fontWeight: "bold", color: "#111827" },
  descricao: { display: "block", color: "#6b7280", marginTop: "4px" },
  filtros: { display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "18px" },
  subFiltros: {
    display: "flex",
    flexWrap: "wrap",
    gap: "18px",
    alignItems: "center",
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    padding: "12px 14px",
    marginBottom: "18px",
  },
  grupoSubFiltro: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" },
  campoBusca: {
    padding: "7px 12px",
    borderRadius: "999px",
    border: "1px solid #d1d5db",
    fontSize: "13px",
    minWidth: "230px",
  },
  avisoBusca: {
    background: "#e9f5ff",
    border: "1px solid #b6effb",
    color: "#055160",
    borderRadius: "10px",
    padding: "10px 14px",
    marginBottom: "12px",
    fontSize: "13px",
  },
  barraLote: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    alignItems: "center",
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    padding: "12px 14px",
    marginBottom: "18px",
  },
  selos: { display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-end" },
  acoesAssinatura: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    alignItems: "center",
    marginTop: "14px",
    paddingTop: "14px",
    borderTop: "1px dashed #e5e7eb",
  },
  checkLinha: { display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#374151" },
  botaoDescartar: {
    background: "#fff",
    color: "#b02a37",
    border: "1px solid #f1aeb5",
    padding: "10px 14px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  modalAnexo: {
    background: "#fff",
    borderRadius: "14px",
    padding: "22px",
    width: "min(560px, 96vw)",
    maxHeight: "92vh",
    overflowY: "auto",
    boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
  },
  campoTexto: {
    width: "100%",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    boxSizing: "border-box",
  },
  avisoBackup: {
    marginTop: "14px",
    background: "#fff3cd",
    border: "1px solid #ffe69c",
    borderRadius: "8px",
    padding: "12px",
  },
  // Vermelho, não amarelo: não é ressalva, é um termo que não funciona até
  // alguém reanexar a via.
  avisoSemArquivo: {
    marginTop: "10px",
    background: "#fdecea",
    border: "1px solid #f5c2c0",
    borderRadius: "8px",
    padding: "10px 12px",
    fontSize: "13px",
    color: "#7f1d1d",
    lineHeight: 1.45,
  },
  rotuloSubFiltro: { fontSize: "13px", fontWeight: "bold", color: "#374151" },
  subFiltro: {
    background: "#f3f4f6",
    color: "#374151",
    border: "1px solid #d1d5db",
    padding: "6px 12px",
    borderRadius: "999px",
    cursor: "pointer",
    fontSize: "13px",
  },
  subFiltroAtivo: {
    background: "#0d6efd",
    color: "#fff",
    border: "1px solid #0d6efd",
    padding: "6px 12px",
    borderRadius: "999px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: "bold",
  },
  filtro: {
    background: "#fff",
    color: "#111827",
    border: "1px solid #d1d5db",
    padding: "9px 14px",
    borderRadius: "999px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  filtroAtivo: {
    background: "#0d6efd",
    color: "#fff",
    border: "1px solid #0d6efd",
    padding: "9px 14px",
    borderRadius: "999px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  alerta: {
    background: "#fff3cd",
    border: "1px solid #ffe69c",
    color: "#664d03",
    padding: "14px",
    borderRadius: "8px",
    marginBottom: "16px",
  },
  vazio: { background: "#fff", padding: "18px", borderRadius: "10px" },
  card: {
    background: "#fff",
    borderRadius: "14px",
    padding: "20px",
    marginBottom: "18px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
  },
  topoCard: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    alignItems: "flex-start",
    marginBottom: "16px",
  },
  nome: { margin: "0 0 8px 0", color: "#111827" },
  info: { margin: "5px 0", color: "#555" },
  status: {
    padding: "8px 12px",
    borderRadius: "999px",
    fontWeight: "bold",
    fontSize: "13px",
    whiteSpace: "nowrap",
  },
  bloco: { marginTop: "14px" },
  blocoRetorno: {
    marginTop: "14px",
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "12px",
  },
  paragrafo: { color: "#374151", lineHeight: 1.4, margin: "8px 0" },
  label: { display: "block", fontWeight: "bold", marginBottom: "6px", color: "#111827" },
  textarea: {
    width: "100%",
    minHeight: "60px",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    resize: "vertical",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
  },
  select: {
    width: "100%",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
    background: "#fff",
  },
  acoes: { display: "flex", flexWrap: "wrap", gap: "10px", marginTop: "16px" },
  botaoValidar: {
    background: "#0d6efd",
    color: "#fff",
    border: "none",
    padding: "12px 18px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoVer: {
    background: "#fff",
    color: "#0d6efd",
    border: "1px solid #0d6efd",
    padding: "10px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoAprovar: {
    flex: 1,
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "12px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoRejeitar: {
    flex: 1,
    background: "#dc3545",
    color: "#fff",
    border: "none",
    padding: "12px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoProximo: {
    marginTop: 10,
    width: "100%",
    background: "#111827",
    color: "#fff",
    border: "none",
    padding: "11px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  // --- Modal tela única ---
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: "2vh 2vw",
  },
  modal: {
    background: "#fff",
    borderRadius: "14px",
    width: "100%",
    maxWidth: "1280px",
    height: "96vh",
    display: "flex",
    overflow: "hidden",
    boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
  },
  painelDoc: {
    flex: "1 1 62%",
    display: "flex",
    flexDirection: "column",
    background: "#3a3f45",
    minWidth: 0,
  },
  docToolbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    background: "#2b2f34",
    color: "#fff",
  },
  aba: {
    background: "transparent",
    color: "#cbd5e1",
    border: "1px solid #4b5563",
    padding: "6px 12px",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: 13,
  },
  abaAtiva: {
    background: "#0d6efd",
    color: "#fff",
    border: "1px solid #0d6efd",
    padding: "6px 12px",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: 13,
  },
  zoomBtn: {
    background: "#fff",
    color: "#111827",
    border: "none",
    width: 30,
    height: 30,
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: 16,
  },
  docViewport: {
    flex: 1,
    overflow: "auto",
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: 12,
  },
  docIframe: { width: "100%", height: "100%", minHeight: "70vh", border: "none", background: "#fff" },
  docImg: { width: "100%", height: "auto", display: "block", background: "#fff" },
  docEstado: {
    color: "#e5e7eb",
    textAlign: "center",
    margin: "auto",
    fontSize: 15,
    lineHeight: 1.8,
  },
  painelValidacao: {
    flex: "1 1 38%",
    display: "flex",
    flexDirection: "column",
    padding: "18px",
    gap: 10,
    overflowY: "auto",
    minWidth: 320,
  },
  validacaoTopo: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  fechar: {
    background: "#f3f4f6",
    border: "none",
    width: 34,
    height: 34,
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: 16,
    fontWeight: "bold",
  },
  validacaoDados: {
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "12px",
  },
  validacaoAcoes: { display: "flex", flexDirection: "column" },
  botoesDecisao: { display: "flex", gap: 10, marginTop: 16 },
};
