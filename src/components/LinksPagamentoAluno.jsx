import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { enviarComprovanteLink } from "../utils/documentoFinanceiro";

const STATUS_LABELS = {
  SOLICITADO_LINK: "Link solicitado",
  SOLICITADO: "Link solicitado",
  LINK_GERADO: "Link gerado",
  LINK_PRONTO_PARA_ENVIO: "Link pronto para envio",
  AGUARDANDO_COMPROVANTE: "Aguardando comprovante",
  LINK_ENVIADO_ALUNO: "Link enviado ao aluno",
  LINK_ENVIADO_AO_ALUNO: "Link enviado ao aluno",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  PAGO_AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_REALIZADA: "Baixa realizada",
  BAIXA_DEVOLVIDA: "Baixa devolvida",
  CANCELADO: "Cancelado",
};

function textoSeguro(valor) {
  return String(valor || "").trim();
}

// Traduz o resultado de enviarComprovanteLink em mensagem operacional real
// (sem a genérica "sem permissão ou falha de envio", sem dados pessoais).
function mensagemErroComprovante(res) {
  const c = res?.erro;
  if (c === "sessao_expirada") return "Sessão expirada. Entre novamente e tente de novo.";
  if (c === "acesso_negado") return "Acesso negado: sem permissão para anexar comprovante neste registro.";
  if (c === "objeto_invalido") return "O arquivo já enviado está inválido ou vazio. Selecione o comprovante novamente e reenvie.";
  if (c === "mime_invalido") return "Formato não permitido. Envie PDF, PNG ou JPG.";
  if (c === "tamanho_invalido") return "Arquivo acima do limite (20 MB).";
  if (c === "ja_vinculado") return "Este link já tem um comprovante anexado.";
  return `Não foi possível anexar o comprovante (código: ${c || "desconhecido"}${res?.etapa ? `, etapa: ${res.etapa}` : ""}${res?.status ? `, http: ${res.status}` : ""}).`;
}

function emailNormalizado(valor) {
  return String(valor || "").trim().toLowerCase();
}

function converterValor(valorDigitado) {
  let texto = String(valorDigitado || "")
    .replace("R$", "")
    .replace(/\s/g, "")
    .trim();

  const temVirgula = texto.includes(",");
  const temPonto = texto.includes(".");

  if (temVirgula && temPonto) {
    // formato "1.500,00": ponto é milhar, vírgula é decimal
    texto = texto.replace(/\./g, "").replace(",", ".");
  } else if (temVirgula) {
    // só vírgula: ela é o separador decimal
    texto = texto.replace(",", ".");
  } else if (temPonto) {
    const partes = texto.split(".");
    const ultimaParte = partes[partes.length - 1];

    if (partes.length === 2 && ultimaParte.length === 2) {
      // ponto decimal, ex: "300.00" -> mantém como está
    } else {
      // ponto de milhar, ex: "1.500" -> remove os pontos
      texto = texto.replace(/\./g, "");
    }
  }

  return Number(texto);
}

function formatarMoeda(numero) {
  if (numero === null || numero === undefined || numero === "") return "-";

  const valor = Number(numero);

  if (Number.isNaN(valor)) return "-";

  return valor.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatarData(data) {
  if (!data) return "-";

  const texto = String(data);

  if (texto.includes("T")) {
    const d = new Date(texto);

    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }

  const partes = texto.split("-");

  if (partes.length >= 3) {
    return `${partes[2].slice(0, 2)}/${partes[1]}/${partes[0]}`;
  }

  return texto;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "-";
}

function corStatus(status) {
  if (status === "SOLICITADO_LINK" || status === "SOLICITADO") return "#f97316";
  if (status === "LINK_GERADO" || status === "LINK_PRONTO_PARA_ENVIO") return "#2563eb";
  if (status === "AGUARDANDO_COMPROVANTE") return "#0891b2";
  if (status === "LINK_ENVIADO_ALUNO" || status === "LINK_ENVIADO_AO_ALUNO") return "#0891b2";
  if (status === "AGUARDANDO_BAIXA" || status === "PAGO_AGUARDANDO_BAIXA") return "#7c3aed";
  if (status === "BAIXA_REALIZADA") return "#16a34a";
  if (status === "BAIXA_DEVOLVIDA") return "#dc2626";
  return "#475569";
}

function obterLinkPagamento(item) {
  return (
    item?.link_pagamento ||
    item?.link_url ||
    item?.url_pagamento ||
    item?.url ||
    item?.link ||
    ""
  );
}

async function garantirSessaoValida() {
  try {
    await supabase.auth.getSession();
  } catch {
    // Se falhar, deixa a chamada seguinte estourar o erro real.
  }
}

export default function LinksPagamentoAluno({
  aluno,
  alunoSelecionado,
  estudante,
  usuarioLogado,
  usuario,
  user,
  onSucesso,
  onAtualizar,
  // Quando true (operador clicou "Solicitar link" na Tabulacao), abre o
  // formulario de solicitacao ja de cara -- sem exigir um segundo clique no
  // botao interno. Quando false (ex.: aberto por retorno do ADM), mantem o
  // estado atual do link (historico/acoes), sem abrir novo pedido.
  abrirFormularioInicial = false,
}) {
  const alunoAtual = aluno || alunoSelecionado || estudante || {};
  const usuarioProp = usuarioLogado || usuario || user || {};

  const [usuarioAtual, setUsuarioAtual] = useState(usuarioProp || {});
  const [aberto, setAberto] = useState(Boolean(abrirFormularioInicial));

  const [valor, setValor] = useState("");
  const [parcelas, setParcelas] = useState(1);
  const [dataVencimento, setDataVencimento] = useState("");
  const [observacao, setObservacao] = useState("");

  // Caso retroativo: operador já tem o link de cartão gerado fora do
  // fluxo normal (fora do CRM) e só precisa anexar. Cai direto na fila
  // de baixas da Amanda, sem passar pela fila da ADM.
  const [abertoRetroativo, setAbertoRetroativo] = useState(false);
  const [valorRetroativo, setValorRetroativo] = useState("");
  const [linkRetroativo, setLinkRetroativo] = useState("");
  const [arquivoRetroativo, setArquivoRetroativo] = useState(null);
  const [observacaoRetroativo, setObservacaoRetroativo] = useState("");
  const [carregandoRetroativo, setCarregandoRetroativo] = useState(false);

  const [historico, setHistorico] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [confirmandoValorLink, setConfirmandoValorLink] = useState(false);
  const [carregandoHistorico, setCarregandoHistorico] = useState(false);
  const [erro, setErro] = useState("");

  const [arquivos, setArquivos] = useState({});
  const [observacoesComprovante, setObservacoesComprovante] = useState({});
  const [enviandoComprovanteId, setEnviandoComprovanteId] = useState(null);
  const [copiadoId, setCopiadoId] = useState(null);

  const nomeAluno =
    alunoAtual?.nome ||
    alunoAtual?.aluno_nome ||
    alunoAtual?.nome_aluno ||
    alunoAtual?.nome_completo ||
    alunoAtual?.NOME ||
    alunoAtual?.Nome ||
    "";

  const cpfAluno =
    alunoAtual?.cpf ||
    alunoAtual?.aluno_cpf ||
    alunoAtual?.documento ||
    alunoAtual?.CPF ||
    "";

  const alunoId =
    alunoAtual?.id ||
    alunoAtual?.aluno_id ||
    alunoAtual?.ID ||
    cpfAluno ||
    nomeAluno ||
    null;

  const emailUsuario = emailNormalizado(
    usuarioAtual?.email ||
      usuarioAtual?.auth?.email ||
      usuarioAtual?.user?.email ||
      usuarioProp?.email ||
      usuarioProp?.auth?.email ||
      usuarioProp?.user?.email
  );

  const nomeUsuario =
    usuarioAtual?.nome ||
    usuarioAtual?.name ||
    usuarioAtual?.perfil?.nome ||
    usuarioAtual?.user_metadata?.nome ||
    usuarioAtual?.email ||
    usuarioProp?.nome ||
    usuarioProp?.name ||
    usuarioProp?.perfil?.nome ||
    usuarioProp?.email ||
    "Operador";

  const perfilUsuario = String(
    usuarioAtual?.perfil?.perfil ||
      usuarioAtual?.perfil ||
      usuarioProp?.perfil?.perfil ||
      usuarioProp?.perfil ||
      ""
  ).toLowerCase();

  const usuarioVeTudo = useMemo(() => {
    if (["gerencia", "supervisor", "administrativo", "admin"].includes(perfilUsuario)) {
      return true;
    }

    const email = emailUsuario;

    return (
      email.includes("amanda") ||
      email.includes("fernanda") ||
      email.includes("cobranca07") ||
      email.includes("cobranca08")
    );
  }, [perfilUsuario, emailUsuario]);

  useEffect(() => {
    carregarUsuarioAtual();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    carregarHistorico();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alunoId, cpfAluno, nomeAluno, emailUsuario, usuarioVeTudo]);

  async function carregarUsuarioAtual() {
    try {
      const { data } = await supabase.auth.getUser();

      if (data?.user) {
        setUsuarioAtual((anterior) => ({
          ...anterior,
          email: anterior?.email || data.user.email,
          nome:
            anterior?.nome ||
            anterior?.name ||
            data.user.user_metadata?.nome ||
            data.user.user_metadata?.name ||
            data.user.email,
          user_metadata: data.user.user_metadata || {},
        }));
      }
    } catch {
      // Mantém usuário recebido por props.
    }
  }

  function itemPertenceAoUsuario(item) {
    const emailItem = emailNormalizado(
      item?.operador_email ||
        item?.operador_solicitante ||
        item?.solicitante_email ||
        item?.criado_por
    );

    if (!emailItem || !emailUsuario) return false;

    return emailItem === emailUsuario;
  }

  // Quem ASSUMIU validamente o atendimento (é o responsável atual do aluno em
  // exibição) pode ver/enviar o link pronto, mesmo que o link tenha sido
  // solicitado por um colega (links_pagamento.operador_email original). A RLS
  // do banco é a fonte de verdade; aqui só espelhamos para exibir os botões.
  const alunoSobMinhaResponsabilidade =
    !!emailUsuario &&
    emailNormalizado(alunoAtual?.responsavel_atual_email) === emailUsuario;

  function podeAgirNoItem(item) {
    return usuarioVeTudo || itemPertenceAoUsuario(item) || alunoSobMinhaResponsabilidade;
  }

  function podeVerItem(item) {
    if (usuarioVeTudo) return true;
    return itemPertenceAoUsuario(item) || alunoSobMinhaResponsabilidade;
  }

  async function carregarHistorico() {
    if (!alunoId && !cpfAluno && !nomeAluno) return;

    setCarregandoHistorico(true);

    let query = supabase
      .from("links_pagamento")
      .select("*")
      .order("criado_em", { ascending: false });

    if (alunoId) {
      query = query.eq("aluno_id", String(alunoId));
    } else if (cpfAluno) {
      query = query.eq("aluno_cpf", cpfAluno);
    } else {
      query = query.eq("aluno_nome", nomeAluno);
    }

    const { data, error } = await query;

    setCarregandoHistorico(false);

    if (error) {
      console.error("Erro ao carregar histórico de links:", error);
      setErro("Não foi possível carregar o histórico de links.");
      return;
    }

    const lista = data || [];

    /*
      Dentro da ficha do aluno, mostramos o histórico do aluno.
      O bloqueio para não aparecer na fila de todos será feito na fila/prioridade,
      não aqui dentro da ficha.
    */
    setHistorico(lista);
  }

  async function registrarHistorico(item, statusNovo, descricao) {
    try {
      await supabase.from("historico_links_pagamento").insert({
        link_id: item?.id || null,
        aluno_id: item?.aluno_id || (alunoId ? String(alunoId) : null),
        aluno_nome: item?.aluno_nome || nomeAluno || null,
        aluno_cpf: item?.aluno_cpf || cpfAluno || null,
        status_novo: statusNovo,
        status_anterior: item?.status || null,
        descricao,
        usuario_email: emailUsuario || null,
        usuario_nome: nomeUsuario || null,
        criado_em: new Date().toISOString(),
      });
    } catch (error) {
      console.warn("Histórico de link não registrado:", error);
    }
  }

  async function solicitarLink() {
    setErro("");
    await garantirSessaoValida();

    if (!nomeAluno) {
      setErro("Aluno não identificado na ficha.");
      return;
    }

    if (!emailUsuario) {
      setErro("Não consegui identificar o e-mail do operador logado. Saia e entre novamente no CRM.");
      return;
    }

    const valorNumerico = converterValor(valor);

    if (!valorNumerico || valorNumerico <= 0) {
      setErro("Informe o valor do link.");
      return;
    }

    if (!dataVencimento) {
      setErro("Informe a data de vencimento do link.");
      return;
    }

    // Confirmação dentro da própria tela (não usa popup nativo do
    // navegador) -- em acesso remoto, o popup nativo às vezes não aparece
    // ou fica bloqueado, e parecia que o botão "não fazia nada".
    setConfirmandoValorLink(true);
  }

  async function confirmarEEnviarLink() {
    setConfirmandoValorLink(false);
    const valorNumerico = converterValor(valor);
    setCarregando(true);

    const { error } = await supabase.rpc("solicitar_link_pagamento", {
      p_aluno_id: alunoId ? String(alunoId) : null,
      p_aluno_nome: nomeAluno,
      p_aluno_cpf: cpfAluno || null,

      /*
        Correção principal:
        aqui precisa ir o E-MAIL EXATO do operador.
        Antes poderia cair nome ou "operador", e por isso o retorno ficava amplo.
      */
      p_operador_solicitante: emailUsuario,
      p_operador_nome: nomeUsuario || emailUsuario || "Operador",

      p_valor: valorNumerico,
      p_parcelas: Number(parcelas) || 1,
      p_data_vencimento: dataVencimento,
      p_observacao: observacao || null,
    });

    setCarregando(false);

    if (error) {
      console.error("Erro ao solicitar link:", error);
      setErro(error.message || "Não foi possível solicitar o link.");
      return;
    }

    setValor("");
    setParcelas(1);
    setDataVencimento("");
    setObservacao("");
    setAberto(false);

    await carregarHistorico();

    if (onSucesso) onSucesso();
    if (onAtualizar) onAtualizar();

    alert("Link solicitado com sucesso. Foi enviado para a fila ADM/Supervisão.");
  }

  async function anexarLinkRetroativo() {
    setErro("");
    await garantirSessaoValida();

    if (!nomeAluno) {
      setErro("Aluno não identificado na ficha.");
      return;
    }

    if (!emailUsuario) {
      setErro("Não consegui identificar o e-mail do operador logado. Saia e entre novamente no CRM.");
      return;
    }

    const valorNumerico = converterValor(valorRetroativo);

    if (!valorNumerico || valorNumerico <= 0) {
      setErro("Informe o valor pago no link retroativo.");
      return;
    }

    const link = (linkRetroativo || "").trim();
    const temLink = link.length > 0;
    const temArquivo = !!arquivoRetroativo;

    if (!temLink && !temArquivo) {
      setErro("Cole o link do cartão ou anexe o comprovante (arquivo).");
      return;
    }

    if (temLink && !link.toLowerCase().startsWith("http://") && !link.toLowerCase().startsWith("https://")) {
      setErro("O link precisa começar com http:// ou https://. Se não tiver link, anexe o comprovante como arquivo.");
      return;
    }

    setCarregandoRetroativo(true);

    const agora = new Date().toISOString();

    // O comprovante e anexado APOS criar o link, via upload autorizado pelo
    // servidor (usa o id do proprio link como vinculo). Aqui so guardamos o
    // nome para exibicao.
    const comprovanteNome = temArquivo ? arquivoRetroativo.name : null;

    const { data: novoLink, error } = await supabase
      .from("links_pagamento")
      .insert({
        aluno_id: alunoId ? String(alunoId) : null,
        aluno_nome: nomeAluno,
        aluno_cpf: cpfAluno || null,
        nome_aluno: nomeAluno,
        cpf_referencia: cpfAluno || null,
        operador_solicitante: emailUsuario,
        operador_email: emailUsuario,
        operador_nome: nomeUsuario || emailUsuario || "Operador",
        tipo_pagamento: "Cartão",
        forma_pagamento: "CARTAO",
        valor: valorNumerico,
        link_gerado: temLink ? link : null,
        link_pagamento: temLink ? link : null,
        link_gerado_por: emailUsuario,
        link_gerado_em: agora,
        comprovante_url: null,
        comprovante_nome: comprovanteNome,
        comprovante_anexado_por: null,
        comprovante_anexado_em: null,
        status: "AGUARDANDO_BAIXA",
        observacao_solicitacao: "Caso retroativo — comprovante anexado diretamente pelo operador.",
        observacao_comprovante: observacaoRetroativo || null,
        criado_em: agora,
        atualizado_em: agora,
      })
      .select()
      .single();

    setCarregandoRetroativo(false);

    if (error) {
      console.error("Erro ao anexar link retroativo:", error);
      setErro(error.message || "Não foi possível anexar o link retroativo.");
      return;
    }

    // Comprovante: upload autorizado pelo servidor, vinculado ao id do link.
    if (temArquivo && novoLink?.id) {
      const resComp = await enviarComprovanteLink(novoLink.id, arquivoRetroativo);
      if (!resComp.ok) {
        setErro("Link criado, mas " + mensagemErroComprovante(resComp));
        return;
      }
      if (resComp.filaOk === false && resComp.filaCodigo === "fila_nao_criada") {
        setErro("Link criado e comprovante vinculado, mas o envio à fila ficou pendente. Reenvie para a fila (não é preciso anexar de novo).");
      }
    }

    if (alunoId) {
      await supabase
        .from("alunos")
        .update({
          status_jornada: "AGUARDANDO_BAIXA",
          status_atual: "AGUARDANDO_BAIXA",
          status_acionamento: "AGUARDANDO_BAIXA",
          proxima_acao: "AGUARDAR_BAIXA",
          registrado_por_nome: nomeUsuario,
          registrado_por_email: emailUsuario,
          registrado_em: agora,
          data_ultimo_acionamento: agora,
        })
        .eq("id", alunoId);

      await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(alunoId),
        tipo: "LINK_CARTAO_RETROATIVO_ANEXADO",
        descricao:
          observacaoRetroativo ||
          "Operador anexou comprovante de um caso retroativo. Caso foi direto pra fila de baixa da Amanda.",
        status_anterior: null,
        status_novo: "AGUARDANDO_BAIXA",
        registrado_por_nome: nomeUsuario,
        registrado_por_email: emailUsuario,
        registrado_em: agora,
      });
    }

    if (novoLink) {
      await registrarHistorico(
        novoLink,
        "AGUARDANDO_BAIXA",
        observacaoRetroativo || "Comprovante de caso retroativo anexado pelo operador."
      );
    }

    setValorRetroativo("");
    setLinkRetroativo("");
    setArquivoRetroativo(null);
    setObservacaoRetroativo("");
    setAbertoRetroativo(false);

    await carregarHistorico();

    if (onSucesso) onSucesso();
    if (onAtualizar) onAtualizar();

    alert("Link de cartão retroativo anexado. O caso foi direto pra fila de baixa da Amanda.");
  }

  async function copiarLink(item) {
    const link = obterLinkPagamento(item);

    if (!link) {
      alert("Este registro ainda não possui link para copiar.");
      return;
    }

    try {
      await navigator.clipboard.writeText(link);
      setCopiadoId(item.id);

      setTimeout(() => {
        setCopiadoId(null);
      }, 1800);
    } catch {
      alert("Não consegui copiar automaticamente. Abra o link e copie manualmente.");
    }
  }

  async function marcarLinkEnviadoAoAluno(item) {
    await garantirSessaoValida();

    const link = obterLinkPagamento(item);

    if (!link) {
      alert("Este registro ainda não possui link.");
      return;
    }

    const agora = new Date().toISOString();

    // Envio via RPC dedicada (SECURITY DEFINER): altera SOMENTE os campos de
    // envio do link e autoriza gestão, operador original OU quem assumiu o
    // atendimento. Não há UPDATE direto do cliente em links_pagamento aqui —
    // valor/URL/forma/operador_email permanecem imutáveis.
    const { data: res, error } = await supabase.rpc("marcar_link_enviado_ao_aluno", {
      p_link_id: item.id,
    });

    if (error || !res?.ok) {
      console.error("Erro ao marcar link enviado:", error || res?.erro);
      alert("Não foi possível marcar como enviado ao aluno.");
      return;
    }

    // Idempotência: se já estava enviado, não repete atualização de ficha,
    // movimentação nem histórico (evita duplicidade no segundo clique).
    if (res.ja_enviado) {
      await carregarHistorico();
      if (onAtualizar) onAtualizar();
      if (onSucesso) onSucesso();
      return;
    }

    if (item?.aluno_id) {
      await supabase
        .from("alunos")
        .update({
          status_jornada: "AGUARDANDO_COMPROVANTE",
          status_atual: "AGUARDANDO_COMPROVANTE",
          status_acionamento: "AGUARDANDO_COMPROVANTE",
          proxima_acao: "AGUARDAR_COMPROVANTE",
          registrado_por_nome: nomeUsuario,
          registrado_por_email: emailUsuario,
          registrado_em: agora,
          data_ultimo_acionamento: agora,
        })
        .eq("id", item.aluno_id);

      await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(item.aluno_id),
        tipo: "LINK_ENVIADO_AO_ALUNO",
        descricao: "Operador marcou o link como enviado ao aluno. Próximo passo: aguardar comprovante.",
        status_anterior: item.status,
        status_novo: "AGUARDANDO_COMPROVANTE",
        registrado_por_nome: nomeUsuario,
        registrado_por_email: emailUsuario,
        registrado_em: agora,
      });
    }

    await registrarHistorico(item, "LINK_ENVIADO_AO_ALUNO", "Operador marcou o link como enviado ao aluno.");

    await carregarHistorico();

    if (onAtualizar) onAtualizar();
    if (onSucesso) onSucesso();
  }

  async function anexarComprovante(item) {
    setErro("");
    await garantirSessaoValida();

    const arquivo = arquivos[item.id];

    if (!arquivo) {
      setErro("Selecione o comprovante antes de enviar para baixa.");
      return;
    }

    setEnviandoComprovanteId(item.id);

    // Upload autorizado pelo servidor (vinculo pelo id do link). O servidor
    // grava comprovante_url + anexado_por/em. Aqui so completamos status/nome/obs.
    // reconciliado/jaVinculado = sucesso (o objeto já estava no Storage e o
    // servidor concluiu o vínculo sem novo upload). Só erro real interrompe.
    const resComp = await enviarComprovanteLink(item.id, arquivo);
    if (!resComp.ok) {
      setEnviandoComprovanteId(null);
      setErro(mensagemErroComprovante(resComp));
      return;
    }
    const filaPendente = resComp.filaOk === false && resComp.filaCodigo === "fila_nao_criada";

    const observacaoComprovante = textoSeguro(observacoesComprovante[item.id]);
    const agora = new Date().toISOString();

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "AGUARDANDO_BAIXA",
        comprovante_nome: arquivo.name,
        observacao_comprovante: observacaoComprovante || null,
        atualizado_em: agora,
      })
      .eq("id", item.id);

    setEnviandoComprovanteId(null);

    if (error) {
      console.error("Erro ao salvar comprovante no link:", error);
      setErro(
        "Comprovante subiu, mas não consegui salvar no link. Se aparecer erro de coluna, me avisa que eu te mando o SQL."
      );
      return;
    }

    if (item?.aluno_id) {
      await supabase
        .from("alunos")
        .update({
          status_jornada: "AGUARDANDO_BAIXA",
          status_atual: "AGUARDANDO_BAIXA",
          status_acionamento: "AGUARDANDO_BAIXA",
          proxima_acao: "AGUARDAR_BAIXA",
          registrado_por_nome: nomeUsuario,
          registrado_por_email: emailUsuario,
          registrado_em: agora,
          data_ultimo_acionamento: agora,
        })
        .eq("id", item.aluno_id);

      await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(item.aluno_id),
        tipo: "COMPROVANTE_ENVIADO_BAIXA",
        descricao: observacaoComprovante || "Comprovante anexado pelo operador e enviado para a fila de baixa da Amanda.",
        status_anterior: item.status,
        status_novo: "AGUARDANDO_BAIXA",
        registrado_por_nome: nomeUsuario,
        registrado_por_email: emailUsuario,
        registrado_em: agora,
      });
    }

    await registrarHistorico(
      item,
      "AGUARDANDO_BAIXA",
      observacaoComprovante ||
        "Comprovante anexado pelo operador e enviado para a fila de baixa da Amanda."
    );

    setArquivos((prev) => ({
      ...prev,
      [item.id]: null,
    }));

    setObservacoesComprovante((prev) => ({
      ...prev,
      [item.id]: "",
    }));

    await carregarHistorico();

    // Comprovante vinculado, mas o envio à fila (cartão) ficou pendente.
    if (filaPendente) {
      setErro("Comprovante vinculado, mas o envio à fila ficou pendente. Reenvie para a fila (não é preciso anexar de novo).");
    }

    if (onSucesso) onSucesso();
    if (onAtualizar) onAtualizar();

    alert("Comprovante anexado e enviado para a fila de baixa da Amanda.");
  }

  const existeHistorico = historico.length > 0;

  return (
    <div style={container}>
      <div style={cabecalho}>
        <div>
          <h3 style={titulo}>Links de pagamento</h3>
          <p style={subtitulo}>
            Solicite o link, acompanhe o retorno do ADM e envie o comprovante para baixa.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={() => setAberto(!aberto)} style={botaoPrincipal}>
            {aberto ? "Fechar" : "Solicitar link"}
          </button>

          <button
            type="button"
            onClick={() => setAbertoRetroativo(!abertoRetroativo)}
            style={botaoSecundario}
          >
            {abertoRetroativo ? "Fechar" : "Anexar comprovante (caso retroativo)"}
          </button>
        </div>
      </div>

      {aberto && (
        <div style={formulario}>
          <div style={linha}>
            <div style={campo}>
              <label style={label}>Aluno</label>
              <input value={nomeAluno} readOnly style={inputBloqueado} />
            </div>

            <div style={campo}>
              <label style={label}>CPF</label>
              <input value={cpfAluno} readOnly style={inputBloqueado} />
            </div>
          </div>

          <div style={linha}>
            <div style={campo}>
              <label style={label}>Valor do link</label>
              <input
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                placeholder="Ex: 350,00 (use vírgula para os centavos)"
                style={input}
              />
              {valor.trim() !== "" && (
                <p style={previewValor}>
                  {Number.isFinite(converterValor(valor)) && converterValor(valor) > 0
                    ? `Será enviado como: ${formatarMoeda(converterValor(valor))}`
                    : "Valor inválido — use vírgula para os centavos, ex: 350,00"}
                </p>
              )}
            </div>

            <div style={campo}>
              <label style={label}>Parcelas</label>
              <input
                type="number"
                min="1"
                value={parcelas}
                onChange={(e) => setParcelas(e.target.value)}
                style={input}
              />
            </div>

            <div style={campo}>
              <label style={label}>Vencimento</label>
              <input
                type="date"
                value={dataVencimento}
                onChange={(e) => setDataVencimento(e.target.value)}
                style={input}
              />
            </div>
          </div>

          <label style={label}>Observação, se necessário</label>
          <textarea
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
            placeholder="Ex: acordo referente às mensalidades em aberto"
            style={textarea}
          />

          {erro && <div style={erroBox}>{erro}</div>}

          {confirmandoValorLink && (
            <div
              style={{
                background: "#fff7e6",
                border: "1px solid #f5c542",
                borderRadius: 10,
                padding: "12px 14px",
                marginBottom: 10,
              }}
            >
              <p style={{ margin: "0 0 10px", fontWeight: 700 }}>
                Confirma o valor do link?
              </p>
              <p style={{ margin: "0 0 12px", fontSize: 13 }}>
                Você digitou "{valor}" — será enviado como{" "}
                <strong>{formatarMoeda(converterValor(valor))}</strong>. Se estiver errado, clique em
                "Corrigir" e ajuste (use vírgula para os centavos, ex: 350,00).
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={confirmarEEnviarLink}
                  style={{ ...botaoConfirmar, padding: "8px 16px" }}
                >
                  Confirmar e enviar
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmandoValorLink(false)}
                  style={{ background: "#fff", border: "1px solid #ccc", borderRadius: 8, padding: "8px 16px", cursor: "pointer" }}
                >
                  Corrigir
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={solicitarLink}
            disabled={carregando}
            style={{
              ...botaoConfirmar,
              opacity: carregando ? 0.6 : 1,
              cursor: carregando ? "not-allowed" : "pointer",
            }}
          >
            {carregando ? "Enviando..." : "Confirmar solicitação"}
          </button>
        </div>
      )}

      {abertoRetroativo && (
        <div style={formulario}>
          <p style={subtitulo}>
            Use isso só para casos retroativos, em que o pagamento já foi tratado fora do
            fluxo normal. Anexe o comprovante (arquivo) ou cole o link do cartão — um dos
            dois é obrigatório. O caso vai direto pra fila de baixa da Amanda, sem passar
            pela fila da ADM.
          </p>

          <div style={linha}>
            <div style={campo}>
              <label style={label}>Aluno</label>
              <input value={nomeAluno} readOnly style={inputBloqueado} />
            </div>

            <div style={campo}>
              <label style={label}>CPF</label>
              <input value={cpfAluno} readOnly style={inputBloqueado} />
            </div>
          </div>

          <div style={linha}>
            <div style={campo}>
              <label style={label}>Valor pago</label>
              <input
                value={valorRetroativo}
                onChange={(e) => setValorRetroativo(e.target.value)}
                placeholder="Ex: 350,00 (use vírgula para os centavos)"
                style={input}
              />
              {valorRetroativo.trim() !== "" && (
                <p style={previewValor}>
                  {Number.isFinite(converterValor(valorRetroativo)) && converterValor(valorRetroativo) > 0
                    ? `Será enviado como: ${formatarMoeda(converterValor(valorRetroativo))}`
                    : "Valor inválido — use vírgula para os centavos, ex: 350,00"}
                </p>
              )}
            </div>
          </div>

          <div style={linha}>
            <div style={campo}>
              <label style={label}>Anexar comprovante (arquivo)</label>
              <input
                type="file"
                accept="image/*,.pdf"
                onChange={(e) => setArquivoRetroativo(e.target.files?.[0] || null)}
                style={input}
              />
              {arquivoRetroativo && (
                <p style={previewValor}>Selecionado: {arquivoRetroativo.name}</p>
              )}
            </div>

            <div style={campo}>
              <label style={label}>Ou cole o link completo do cartão</label>
              <input
                value={linkRetroativo}
                onChange={(e) => setLinkRetroativo(e.target.value)}
                placeholder="https://... (opcional se anexar arquivo)"
                style={input}
              />
            </div>
          </div>

          <label style={label}>Observação, se necessário</label>
          <textarea
            value={observacaoRetroativo}
            onChange={(e) => setObservacaoRetroativo(e.target.value)}
            placeholder="Ex: caso antigo, pagamento feito por fora antes de entrar no CRM"
            style={textarea}
          />

          {erro && <div style={erroBox}>{erro}</div>}

          <button
            type="button"
            onClick={anexarLinkRetroativo}
            disabled={carregandoRetroativo}
            style={{
              ...botaoConfirmar,
              opacity: carregandoRetroativo ? 0.6 : 1,
              cursor: carregandoRetroativo ? "not-allowed" : "pointer",
            }}
          >
            {carregandoRetroativo ? "Enviando..." : "Anexar e enviar pra fila de baixa"}
          </button>
        </div>
      )}

      {erro && !aberto && !abertoRetroativo && <div style={erroBox}>{erro}</div>}

      {carregandoHistorico && (
        <div style={avisoBox}>Carregando histórico de links...</div>
      )}

      {existeHistorico && (
        <div style={historicoBox}>
          <h4 style={tituloHistorico}>Histórico de links</h4>

          {historico.map((item) => {
            const linkPagamento = obterLinkPagamento(item);
            const podeAcionarComprovante =
              item.status !== "BAIXA_REALIZADA"; // anexar comprovante sempre, exceto quando ja baixado

            return (
              <div key={item.id} style={historicoItem}>
                <div style={linhaHistoricoTopo}>
                  <div>
                    <strong
                      style={{
                        ...badgeStatus,
                        background: corStatus(item.status),
                      }}
                    >
                      {statusLabel(item.status)}
                    </strong>

                    <p style={infoLinha}>
                      <strong>Valor:</strong> {formatarMoeda(item.valor)} |{" "}
                      <strong>Parcelas:</strong> {item.parcelas || 1} |{" "}
                      <strong>Vencimento:</strong> {formatarData(item.data_vencimento)}
                    </p>

                    <p style={infoLinha}>
                      <strong>Operador solicitante:</strong>{" "}
                      {item.operador_nome || item.operador_solicitante || item.operador_email || "-"}
                    </p>

                    {item.observacao && (
                      <p style={infoLinha}>
                        <strong>Obs. solicitação:</strong> {item.observacao}
                      </p>
                    )}

                    {item.observacao_adm && (
                      <p style={infoLinha}>
                        <strong>Obs. ADM:</strong> {item.observacao_adm}
                      </p>
                    )}

                    {item.divergencia_motivo && (
                      <p style={infoLinhaAlerta}>
                        <strong>Devolvido:</strong> {item.divergencia_motivo}
                      </p>
                    )}

                    {linkPagamento && (
                      <div style={linkBox}>
                        <strong>Link pronto:</strong>
                        <span style={linkTexto}>{linkPagamento}</span>
                      </div>
                    )}

                    {item.comprovante_url && (
                      <div style={comprovanteBox}>
                        <strong>Comprovante:</strong>{" "}
                        {item.comprovante_nome || "Arquivo anexado"}
                        <button
                          type="button"
                          style={botaoSecundario}
                          onClick={() => window.open(item.comprovante_url, "_blank", "noreferrer")}
                        >
                          Abrir comprovante
                        </button>
                      </div>
                    )}
                  </div>

                  <div style={acoesBox}>
                    {linkPagamento && (
                      <button
                        type="button"
                        style={botaoSecundario}
                        onClick={() => copiarLink(item)}
                      >
                        {copiadoId === item.id ? "Copiado" : "Copiar link"}
                      </button>
                    )}

                    {linkPagamento && ["LINK_GERADO", "LINK_PRONTO_PARA_ENVIO"].includes(item.status) && podeAgirNoItem(item) && (
                      <button
                        type="button"
                        style={botaoAzul}
                        onClick={() => marcarLinkEnviadoAoAluno(item)}
                      >
                        Marcar enviado ao aluno
                      </button>
                    )}
                  </div>
                </div>

                {podeAcionarComprovante && (
                  <div style={comprovanteForm}>
                    <label style={label}>Comprovante de pagamento</label>
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      style={input}
                      onChange={(e) =>
                        setArquivos((prev) => ({
                          ...prev,
                          [item.id]: e.target.files?.[0] || null,
                        }))
                      }
                    />

                    <label style={label}>Observação do comprovante, se necessário</label>
                    <textarea
                      value={observacoesComprovante[item.id] || ""}
                      onChange={(e) =>
                        setObservacoesComprovante((prev) => ({
                          ...prev,
                          [item.id]: e.target.value,
                        }))
                      }
                      placeholder="Ex: comprovante enviado pelo aluno via WhatsApp"
                      style={textareaMenor}
                    />

                    <button
                      type="button"
                      style={{
                        ...botaoEnviarBaixa,
                        opacity: enviandoComprovanteId === item.id ? 0.6 : 1,
                      }}
                      disabled={enviandoComprovanteId === item.id}
                      onClick={() => anexarComprovante(item)}
                    >
                      {enviandoComprovanteId === item.id
                        ? "Enviando..."
                        : "Anexar comprovante e enviar para baixa"}
                    </button>
                  </div>
                )}

                {item.status === "AGUARDANDO_BAIXA" && (
                  <div style={avisoBox}>
                    Comprovante enviado. Agora este caso deve aparecer na fila de baixa da Amanda.
                  </div>
                )}

                {item.status === "BAIXA_REALIZADA" && (
                  <div style={sucessoBox}>
                    Baixa realizada. O pagamento foi concluído.
                  </div>
                )}

                {item.status === "BAIXA_DEVOLVIDA" && (
                  <div style={erroBox}>
                    Baixa devolvida. Corrija o comprovante ou orientação e envie novamente.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!carregandoHistorico && !existeHistorico && (
        <div style={avisoBox}>
          Nenhum link de pagamento localizado para este aluno e operador.
        </div>
      )}
    </div>
  );
}

const container = {
  marginTop: "16px",
  padding: "16px",
  border: "1px solid #d1d5db",
  borderRadius: "12px",
  background: "#fff",
};

const cabecalho = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "12px",
  flexWrap: "wrap",
};

const titulo = {
  margin: 0,
  fontSize: "18px",
  color: "#0f172a",
  fontWeight: "900",
};

const subtitulo = {
  margin: "4px 0 0",
  color: "#64748b",
  fontSize: "13px",
};

const botaoPrincipal = {
  background: "#16a34a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: "900",
  cursor: "pointer",
};

const formulario = {
  marginTop: "14px",
  padding: "14px",
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  background: "#f8fafc",
};

const linha = {
  display: "flex",
  gap: "12px",
  flexWrap: "wrap",
};

const campo = {
  flex: "1 1 180px",
};

const label = {
  display: "block",
  marginBottom: "5px",
  color: "#334155",
  fontWeight: "800",
  fontSize: "13px",
};

const input = {
  width: "100%",
  padding: "10px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  marginBottom: "12px",
  boxSizing: "border-box",
};

const inputBloqueado = {
  ...input,
  background: "#e5e7eb",
  color: "#475569",
};

const previewValor = {
  margin: "-6px 0 12px",
  fontSize: "13px",
  fontWeight: "700",
  color: "#0f172a",
};

const textarea = {
  ...input,
  minHeight: "80px",
  resize: "vertical",
};

const textareaMenor = {
  ...input,
  minHeight: "64px",
  resize: "vertical",
};

const erroBox = {
  background: "#fee2e2",
  color: "#991b1b",
  padding: "10px",
  borderRadius: "8px",
  marginTop: "10px",
  marginBottom: "10px",
  fontWeight: "800",
};

const avisoBox = {
  background: "#fef3c7",
  color: "#92400e",
  padding: "10px",
  borderRadius: "8px",
  marginTop: "10px",
  marginBottom: "10px",
  fontWeight: "800",
};

const sucessoBox = {
  background: "#dcfce7",
  color: "#166534",
  padding: "10px",
  borderRadius: "8px",
  marginTop: "10px",
  marginBottom: "10px",
  fontWeight: "800",
};

const botaoConfirmar = {
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "11px 16px",
  fontWeight: "900",
  width: "100%",
};

const historicoBox = {
  marginTop: "14px",
};

const tituloHistorico = {
  margin: "0 0 8px",
  color: "#0f172a",
};

const historicoItem = {
  padding: "12px",
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  marginBottom: "10px",
  color: "#334155",
  fontSize: "13px",
  background: "#ffffff",
};

const linhaHistoricoTopo = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  flexWrap: "wrap",
};

const badgeStatus = {
  display: "inline-block",
  color: "#fff",
  padding: "5px 9px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: "900",
  marginBottom: "8px",
};

const infoLinha = {
  margin: "4px 0",
  color: "#334155",
};

const infoLinhaAlerta = {
  margin: "4px 0",
  color: "#b91c1c",
  fontWeight: "800",
};

const linkBox = {
  marginTop: "8px",
  padding: "10px",
  borderRadius: "8px",
  background: "#eff6ff",
  color: "#1e3a8a",
  border: "1px solid #bfdbfe",
};

const linkTexto = {
  display: "block",
  marginTop: "4px",
  wordBreak: "break-all",
};

const comprovanteBox = {
  marginTop: "8px",
  padding: "10px",
  borderRadius: "8px",
  background: "#f5f3ff",
  color: "#4c1d95",
  border: "1px solid #ddd6fe",
};

const acoesBox = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  minWidth: "180px",
};

const botaoSecundario = {
  background: "#e2e8f0",
  color: "#0f172a",
  border: "none",
  borderRadius: "8px",
  padding: "9px 12px",
  fontWeight: "900",
  cursor: "pointer",
};

const botaoAzul = {
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "9px 12px",
  fontWeight: "900",
  cursor: "pointer",
};

const comprovanteForm = {
  marginTop: "12px",
  padding: "12px",
  borderRadius: "10px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
};

const botaoEnviarBaixa = {
  background: "#7c3aed",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: "900",
  cursor: "pointer",
  width: "100%",
};
