import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const STATUS_LABELS = {
  SOLICITADO_LINK: "Link solicitado",
  SOLICITADO: "Link solicitado",
  LINK_GERADO: "Link gerado",
  LINK_PRONTO_PARA_ENVIO: "Link pronto para envio",
  AGUARDANDO_COMPROVANTE: "Aguardando comprovante",
  LINK_ENVIADO_ALUNO: "Link enviado ao aluno",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  PAGO_AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_REALIZADA: "Baixa realizada",
  BAIXA_DEVOLVIDA: "Baixa devolvida",
  CANCELADO: "Cancelado",
};

function textoSeguro(valor) {
  return String(valor || "").trim();
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
  if (status === "LINK_ENVIADO_ALUNO") return "#0891b2";
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

export default function LinksPagamentoAluno({
  aluno,
  alunoSelecionado,
  estudante,
  usuarioLogado,
  usuario,
  user,
  onSucesso,
  onAtualizar,
}) {
  const alunoAtual = aluno || alunoSelecionado || estudante || {};
  const usuarioProp = usuarioLogado || usuario || user || {};

  const [usuarioAtual, setUsuarioAtual] = useState(usuarioProp || {});
  const [aberto, setAberto] = useState(false);

  const [valor, setValor] = useState("");
  const [parcelas, setParcelas] = useState(1);
  const [dataVencimento, setDataVencimento] = useState("");
  const [observacao, setObservacao] = useState("");

  const [historico, setHistorico] = useState([]);
  const [carregando, setCarregando] = useState(false);
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

  function podeVerItem(item) {
    if (usuarioVeTudo) return true;
    return itemPertenceAoUsuario(item);
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
    const link = obterLinkPagamento(item);

    if (!link) {
      alert("Este registro ainda não possui link.");
      return;
    }

    const agora = new Date().toISOString();

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "LINK_ENVIADO_ALUNO",
        enviado_operador_em: agora,
        atualizado_em: agora,
      })
      .eq("id", item.id);

    if (error) {
      console.error("Erro ao marcar link enviado:", error);
      alert("Não foi possível marcar como enviado ao aluno.");
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

    await registrarHistorico(item, "LINK_ENVIADO_ALUNO", "Operador marcou o link como enviado ao aluno.");

    await carregarHistorico();

    if (onAtualizar) onAtualizar();
    if (onSucesso) onSucesso();
  }

  async function anexarComprovante(item) {
    setErro("");

    if (!itemPertenceAoUsuario(item) && !usuarioVeTudo) {
      setErro("Somente o operador que solicitou este link pode anexar o comprovante.");
      return;
    }

    const arquivo = arquivos[item.id];

    if (!arquivo) {
      setErro("Selecione o comprovante antes de enviar para baixa.");
      return;
    }

    setEnviandoComprovanteId(item.id);

    const extensao = arquivo.name.includes(".")
      ? arquivo.name.split(".").pop()
      : "arquivo";

    const nomeArquivo = `${item.id}-${Date.now()}.${extensao}`;
    const caminho = `links-pagamento/${nomeArquivo}`;

    const { error: erroUpload } = await supabase.storage
      .from("comprovantes-pagamento")
      .upload(caminho, arquivo, {
        upsert: true,
        contentType: arquivo.type || "application/octet-stream",
      });

    if (erroUpload) {
      console.error("Erro ao anexar comprovante:", erroUpload);
      setEnviandoComprovanteId(null);
      setErro("Erro ao anexar comprovante: " + erroUpload.message);
      return;
    }

    const { data: publicUrlData } = supabase.storage
      .from("comprovantes-pagamento")
      .getPublicUrl(caminho);

    const comprovanteUrl = publicUrlData?.publicUrl || "";

    const observacaoComprovante = textoSeguro(observacoesComprovante[item.id]);

    const agora = new Date().toISOString();

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "AGUARDANDO_BAIXA",
        comprovante_url: comprovanteUrl,
        comprovante_nome: arquivo.name,
        comprovante_anexado_por: emailUsuario || null,
        comprovante_anexado_em: agora,
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

        <button type="button" onClick={() => setAberto(!aberto)} style={botaoPrincipal}>
          {aberto ? "Fechar" : "Solicitar link"}
        </button>
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
                placeholder="Ex: 350,00"
                style={input}
              />
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

      {erro && !aberto && <div style={erroBox}>{erro}</div>}

      {carregandoHistorico && (
        <div style={avisoBox}>Carregando histórico de links...</div>
      )}

      {existeHistorico && (
        <div style={historicoBox}>
          <h4 style={tituloHistorico}>Histórico de links</h4>

          {historico.map((item) => {
            const linkPagamento = obterLinkPagamento(item);
            const operadorDoItem = itemPertenceAoUsuario(item);
            const podeAcionarComprovante =
              ["LINK_GERADO", "LINK_PRONTO_PARA_ENVIO", "LINK_ENVIADO_ALUNO", "AGUARDANDO_COMPROVANTE", "BAIXA_DEVOLVIDA"].includes(item.status);

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

                    {linkPagamento && ["LINK_GERADO", "LINK_PRONTO_PARA_ENVIO"].includes(item.status) && (operadorDoItem || usuarioVeTudo) && (
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
