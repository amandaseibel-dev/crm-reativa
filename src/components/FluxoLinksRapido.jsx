import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const EMAILS_MASTER = [
  "amanda.seibel@aelbra.com.br",
  "amandaseibel1706@gmail.com",
  "amandapradoseibel@gmail.com"
];

const EMAILS_ADM = [
  "cobranca07@aelbra.com.br",
  "cobranca08@aelbra.com.br",
  "fernanda@aelbra.com.br"
];

export default function FluxoLinksRapido() {
  const [usuarioAtual, setUsuarioAtual] = useState({
    email: "",
    nome: "",
    master: false,
    adm: false
  });

  const [pendentesAdm, setPendentesAdm] = useState([]);
  const [prioridades, setPrioridades] = useState([]);
  const [historico, setHistorico] = useState([]);
  const [linksDigitados, setLinksDigitados] = useState({});
  const [carregando, setCarregando] = useState(false);
  const [salvandoId, setSalvandoId] = useState(null);
  const [erro, setErro] = useState("");
  const [busca, setBusca] = useState("");

  useEffect(() => {
    iniciar();

    const intervalo = setInterval(() => {
      carregarTudo(usuarioAtual);
    }, 10000);

    return () => clearInterval(intervalo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usuarioAtual.email, usuarioAtual.master, usuarioAtual.adm]);

  async function iniciar() {
    const usuario = await identificarUsuario();
    setUsuarioAtual(usuario);
    await carregarTudo(usuario);
  }

  async function identificarUsuario() {
    // Identidade vem exclusivamente da sessão autenticada no Supabase.
    // Antes havia um fallback que varria todo o localStorage do navegador
    // atrás de qualquer e-mail/nome já salvo, o que podia pegar dados de
    // outra sessão/usuário e vazar prioridades de um operador para outro.
    let email = "";
    let nome = "";

    try {
      const { data } = await supabase.auth.getUser();

      email = data?.user?.email || "";

      nome =
        data?.user?.user_metadata?.nome ||
        data?.user?.user_metadata?.name ||
        data?.user?.user_metadata?.full_name ||
        (email ? email.split("@")[0] : "");
    } catch {
      // ignora - sem sessão válida, email/nome ficam vazios
      // e filtrarPrioridades() não mostra nada para esse usuário.
    }

    const emailLower = String(email || "").toLowerCase();
    const nomeLower = String(nome || "").toLowerCase();

    const master =
      EMAILS_MASTER.includes(emailLower) ||
      emailLower.includes("amanda") ||
      emailLower.includes("seibel") ||
      nomeLower.includes("amanda") ||
      nomeLower.includes("seibel") ||
      nomeLower.includes("master");

    const adm =
      master ||
      EMAILS_ADM.includes(emailLower) ||
      emailLower.includes("cobranca07") ||
      emailLower.includes("cobranca08") ||
      emailLower.includes("fernanda") ||
      nomeLower.includes("fernanda") ||
      nomeLower.includes("supervisor") ||
      nomeLower.includes("supervisora") ||
      nomeLower.includes("adm");

    return { email, nome, master, adm };
  }

  async function carregarTudo(usuario = usuarioAtual) {
    setCarregando(true);
    setErro("");

    const podeVerAdm = Boolean(usuario.master || usuario.adm);

    const consultaAdm = podeVerAdm
      ? supabase
          .from("vw_fila_links_adm")
          .select("*")
          .order("criado_em", { ascending: true })
      : Promise.resolve({ data: [], error: null });

    const consultaPrioridade = supabase
      .from("vw_links_prioridade_operador")
      .select("*")
      .order("respondido_em", { ascending: true });

    const consultaHistorico = podeVerAdm
      ? supabase
          .from("links_pagamento")
          .select("*")
          .neq("status", "SOLICITADO_LINK")
          .order("atualizado_em", { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [], error: null });

    const [resAdm, resPrioridade, resHistorico] = await Promise.all([
      consultaAdm,
      consultaPrioridade,
      consultaHistorico
    ]);

    setCarregando(false);

    if (resAdm.error) {
      console.error("Erro ao carregar fila ADM:", resAdm.error);
      setErro("Erro ao carregar fila ADM/Supervisão.");
      return;
    }

    if (resPrioridade.error) {
      console.error("Erro ao carregar prioridades:", resPrioridade.error);
      setErro("Erro ao carregar prioridades do operador.");
      return;
    }

    if (resHistorico.error) {
      console.error("Erro ao carregar histórico de links:", resHistorico.error);
    }

    setPendentesAdm(podeVerAdm ? resAdm.data || [] : []);
    setPrioridades(filtrarPrioridades(resPrioridade.data || [], usuario));
    setHistorico(podeVerAdm ? resHistorico.data || [] : []);
  }

  function filtrarPrioridades(lista, usuario) {
    if (usuario.master) return lista;

    const email = String(usuario.email || "").trim().toLowerCase();

    // Sem e-mail confirmado da sessão, não mostra nada (evita vazar
    // prioridades de outro operador). O filtro é por e-mail exato,
    // não mais por "includes", para não casar nomes/e-mails parecidos.
    if (!email) return [];

    return lista.filter((item) => {
      const solicitante = String(item.operador_solicitante || "").trim().toLowerCase();
      return solicitante === email;
    });
  }

  function linkCompleto(link) {
    const texto = String(link || "").trim();
    return texto.length > 0;
  }

  async function devolverLinkAoOperador(item) {
    const link = String(linksDigitados[item.id] || "").trim();

    if (!linkCompleto(link)) {
      alert("Cole o link de pagamento antes de devolver ao operador.");
      return;
    }

    setSalvandoId(item.id);
    setErro("");

    const { error } = await supabase.rpc("responder_link_pagamento", {
      p_link_id: item.id,
      p_link_pagamento: link,
      p_adm_responsavel:
        usuarioAtual.email ||
        usuarioAtual.nome ||
        "ADM/Supervisão"
    });

    setSalvandoId(null);

    if (error) {
      console.error("Erro ao devolver link:", error);
      alert(error.message || "Não foi possível devolver o link ao operador.");
      return;
    }

    setLinksDigitados((prev) => {
      const novo = { ...prev };
      delete novo[item.id];
      return novo;
    });

    await carregarTudo(usuarioAtual);

    alert("Link devolvido ao operador. Ele aparecerá no topo da fila operacional com a mensagem pronta.");
  }

  async function copiarTexto(texto) {
    try {
      await navigator.clipboard.writeText(texto || "");
      alert("Copiado com sucesso.");
    } catch {
      alert("Não foi possível copiar automaticamente. Copie manualmente.");
    }
  }

  async function marcarComoEnviado(item) {
    const confirmar = window.confirm(
      `Confirmar que o link foi enviado ao aluno ${item.aluno_nome}?`
    );

    if (!confirmar) return;

    const agora = new Date().toISOString();
    const usuarioEmail = usuarioAtual.email || "";
    const usuarioNome = usuarioAtual.nome || usuarioAtual.email || "Operador";

    // Mesma lógica já usada (e confirmada correta) dentro da ficha do aluno,
    // em vez de depender da função marcar_link_enviado_aluno do Supabase.
    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "LINK_ENVIADO_AO_ALUNO",
        enviado_operador_em: agora,
        atualizado_em: agora,
      })
      .eq("id", item.id);

    if (error) {
      console.error("Erro ao marcar enviado:", error);
      alert(error.message || "Não foi possível marcar como enviado.");
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
          registrado_por_nome: usuarioNome,
          registrado_por_email: usuarioEmail,
          registrado_em: agora,
          data_ultimo_acionamento: agora,
        })
        .eq("id", item.aluno_id);

      await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(item.aluno_id),
        tipo: "LINK_ENVIADO_AO_ALUNO",
        descricao: "Operador marcou o link como enviado ao aluno. Próximo passo: aguardar comprovante.",
        status_anterior: item.status || null,
        status_novo: "AGUARDANDO_COMPROVANTE",
        registrado_por_nome: usuarioNome,
        registrado_por_email: usuarioEmail,
        registrado_em: agora,
      });
    }

    await supabase.from("historico_links_pagamento").insert({
      link_id: item.id,
      aluno_id: item?.aluno_id || null,
      aluno_nome: item?.aluno_nome || null,
      aluno_cpf: item?.aluno_cpf || null,
      status_novo: "LINK_ENVIADO_AO_ALUNO",
      status_anterior: item.status || null,
      descricao: "Operador marcou o link como enviado ao aluno.",
      usuario_email: usuarioEmail || null,
      usuario_nome: usuarioNome || null,
      criado_em: agora,
    });

    await carregarTudo(usuarioAtual);
    alert("Link marcado como enviado ao aluno.");
  }

  function formatarMoeda(valor) {
    if (valor === null || valor === undefined || valor === "") return "-";

    return Number(valor).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL"
    });
  }

  function formatarDataHora(data) {
    if (!data) return "-";

    const d = new Date(data);
    if (Number.isNaN(d.getTime())) return "-";

    return d.toLocaleString("pt-BR");
  }

  const STATUS_LABELS_HISTORICO = {
    LINK_GERADO: "Link gerado",
    LINK_PRONTO_PARA_ENVIO: "Link pronto para envio",
    LINK_ENVIADO_ALUNO: "Link enviado ao aluno",
    AGUARDANDO_COMPROVANTE: "Aguardando comprovante",
    AGUARDANDO_BAIXA: "Aguardando baixa",
    BAIXA_REALIZADA: "Baixa realizada",
    BAIXA_DEVOLVIDA: "Baixa devolvida",
    CANCELADO: "Cancelado",
  };

  function labelHistorico(status) {
    return STATUS_LABELS_HISTORICO[status] || status || "-";
  }

  function corHistorico(status) {
    if (status === "BAIXA_REALIZADA") return "#16a34a";
    if (status === "BAIXA_DEVOLVIDA") return "#dc2626";
    if (status === "AGUARDANDO_BAIXA") return "#7c3aed";
    if (status === "AGUARDANDO_COMPROVANTE" || status === "LINK_ENVIADO_ALUNO") return "#0891b2";
    return "#2563eb";
  }

  function correspondeABusca(item, termo) {
    if (!termo) return true;

    const alvo = [
      item.aluno_nome,
      item.aluno_cpf,
      item.operador_nome,
      item.operador_solicitante
    ]
      .join(" ")
      .toLowerCase();

    return alvo.includes(termo);
  }

  const termoBusca = busca.trim().toLowerCase();

  const pendentesFiltrados = useMemo(
    () => pendentesAdm.filter((item) => correspondeABusca(item, termoBusca)),
    [pendentesAdm, termoBusca]
  );

  const historicoFiltrado = useMemo(
    () => historico.filter((item) => correspondeABusca(item, termoBusca)),
    [historico, termoBusca]
  );

  const indicadores = useMemo(() => {
    const hojeInicio = new Date();
    hojeInicio.setHours(0, 0, 0, 0);

    const valorPendente = pendentesAdm.reduce(
      (soma, item) => soma + Number(item.valor || 0),
      0
    );

    const respondidosHoje = historico.filter((item) => {
      const dataRef = item.respondido_em || item.link_gerado_em || item.atualizado_em;
      if (!dataRef) return false;
      const data = new Date(dataRef);
      return !Number.isNaN(data.getTime()) && data >= hojeInicio;
    }).length;

    return {
      pendentes: pendentesAdm.length,
      valorPendente,
      respondidosHoje,
    };
  }, [pendentesAdm, historico]);

  if (
    !carregando &&
    pendentesAdm.length === 0 &&
    prioridades.length === 0 &&
    historico.length === 0
  ) {
    return null;
  }

  return (
    <div style={wrapper}>
      <style>
        {`
          @keyframes piscarLinkReativa {
            0% { box-shadow: 0 0 0 rgba(239, 68, 68, 0.2); }
            50% { box-shadow: 0 0 20px rgba(239, 68, 68, 0.85); }
            100% { box-shadow: 0 0 0 rgba(239, 68, 68, 0.2); }
          }
        `}
      </style>

      {erro && <div style={erroBox}>{erro}</div>}

      {carregando && (
        <div style={boxInfo}>Carregando fluxo oficial de links...</div>
      )}

      {/* Indicadores/fila ADM e historico foram removidos daqui: agora
          essa parte fica so no Painel ADM e na Fila de Links, para nao
          poluir a tela operacional do dia a dia do operador. */}

      {prioridades.length > 0 && (
        <section style={boxOperador}>
          <div style={cabecalho}>
            <div>
              <h2 style={tituloOperador}>⚠️ Topo da fila operacional — Link pronto</h2>
              <p style={subtitulo}>
                O link voltou do ADM/Supervisão. Copie a mensagem pronta e envie ao aluno.
              </p>
            </div>

            <button type="button" onClick={() => carregarTudo(usuarioAtual)} style={botaoAtualizarEscuro}>
              Atualizar
            </button>
          </div>

          {prioridades.map((item) => (
            <div key={item.id} style={cardOperador}>
              <div style={linhaTopo}>
                <div>
                  <h3 style={nomeAluno}>{item.aluno_nome}</h3>
                  <p style={detalhe}>
                    CPF: {item.aluno_cpf || "-"} | Valor: {formatarMoeda(item.valor)} | Parcelas: {item.parcelas || 1}
                  </p>
                  <p style={detalhe}>
                    Respondido em: {formatarDataHora(item.respondido_em || item.atualizado_em)}
                  </p>
                </div>

                <span style={badgePrioridade}>PRIORIDADE</span>
              </div>

              <label style={label}>Link de pagamento</label>

              <div style={linhaLink}>
                <input value={item.link_pagamento || ""} readOnly style={input} />

                <button
                  type="button"
                  onClick={() => copiarTexto(item.link_pagamento)}
                  style={botaoCopiar}
                >
                  Copiar link
                </button>
              </div>

              <label style={label}>Mensagem pronta para enviar ao aluno</label>

              <textarea value={item.mensagem_pronta || ""} readOnly style={textarea} />

              <div style={linhaBotoes}>
                <button type="button" onClick={() => copiarTexto(item.mensagem_pronta)} style={botaoPrincipal}>
                  Copiar mensagem pronta
                </button>

                <button type="button" onClick={() => marcarComoEnviado(item)} style={botaoConfirmar}>
                  Marcar como enviado ao aluno
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

    </div>
  );
}

const wrapper = { marginBottom: "18px" };

const boxInfo = {
  background: "#e0f2fe",
  color: "#075985",
  padding: "12px",
  borderRadius: "10px",
  marginBottom: "12px",
  fontWeight: "700"
};

const erroBox = {
  background: "#fee2e2",
  color: "#991b1b",
  padding: "10px",
  borderRadius: "8px",
  fontWeight: "800",
  marginBottom: "10px"
};

const boxAdm = {
  padding: "16px",
  borderRadius: "14px",
  border: "2px solid #f97316",
  background: "#fff7ed",
  marginBottom: "16px",
  animation: "piscarLinkReativa 1.4s infinite"
};

const boxOperador = {
  padding: "16px",
  borderRadius: "14px",
  border: "2px solid #ef4444",
  background: "#fef2f2",
  marginBottom: "16px",
  animation: "piscarLinkReativa 1.4s infinite"
};

const cabecalho = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "12px",
  marginBottom: "12px"
};

const tituloAdm = {
  margin: 0,
  color: "#9a3412",
  fontSize: "20px",
  fontWeight: "900"
};

const tituloOperador = {
  margin: 0,
  color: "#991b1b",
  fontSize: "20px",
  fontWeight: "900"
};

const subtitulo = {
  margin: "4px 0 0",
  color: "#475569",
  fontSize: "14px"
};

const botaoAtualizar = {
  background: "#9a3412",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "9px 12px",
  fontWeight: "800",
  cursor: "pointer"
};

const botaoAtualizarEscuro = {
  background: "#991b1b",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "9px 12px",
  fontWeight: "800",
  cursor: "pointer"
};

const cardAdm = {
  background: "#ffffff",
  border: "1px solid #fdba74",
  borderRadius: "12px",
  padding: "14px",
  marginTop: "12px"
};

const cardOperador = {
  background: "#ffffff",
  border: "1px solid #fca5a5",
  borderRadius: "12px",
  padding: "14px",
  marginTop: "12px"
};

const linhaTopo = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  alignItems: "flex-start"
};

const nomeAluno = {
  margin: 0,
  color: "#0f172a",
  fontSize: "18px",
  fontWeight: "900"
};

const detalhe = {
  margin: "4px 0",
  color: "#475569",
  fontSize: "13px"
};

const badgePendente = {
  background: "#f97316",
  color: "#fff",
  borderRadius: "999px",
  padding: "6px 10px",
  fontSize: "12px",
  fontWeight: "900",
  whiteSpace: "nowrap"
};

const badgePrioridade = {
  background: "#dc2626",
  color: "#fff",
  borderRadius: "999px",
  padding: "6px 10px",
  fontSize: "12px",
  fontWeight: "900",
  whiteSpace: "nowrap"
};

const label = {
  display: "block",
  marginTop: "12px",
  marginBottom: "5px",
  color: "#334155",
  fontWeight: "800",
  fontSize: "13px"
};

const linhaLink = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap"
};

const input = {
  flex: "1 1 280px",
  width: "100%",
  padding: "10px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  fontSize: "14px",
  boxSizing: "border-box"
};

const botaoDevolver = {
  background: "#16a34a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: "900"
};

const botaoCopiar = {
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: "800",
  cursor: "pointer"
};

const textarea = {
  width: "100%",
  minHeight: "150px",
  padding: "10px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  fontSize: "14px",
  resize: "vertical",
  boxSizing: "border-box",
  whiteSpace: "pre-wrap"
};

const linhaBotoes = {
  display: "flex",
  gap: "10px",
  flexWrap: "wrap",
  marginTop: "12px"
};

const botaoPrincipal = {
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: "800",
  cursor: "pointer"
};

const botaoConfirmar = {
  background: "#16a34a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: "800",
  cursor: "pointer"
};

const boxIndicadores = {
  padding: "14px",
  borderRadius: "14px",
  border: "1px solid #e2e8f0",
  background: "#f8fafc",
  marginBottom: "16px"
};

const linhaIndicadores = {
  display: "flex",
  gap: "12px",
  flexWrap: "wrap",
  marginBottom: "12px"
};

const indicadorCard = {
  flex: "1 1 140px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  padding: "12px",
  display: "flex",
  flexDirection: "column",
  gap: "4px"
};

const inputBusca = {
  width: "100%",
  padding: "10px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  fontSize: "14px",
  boxSizing: "border-box"
};

const boxHistorico = {
  padding: "16px",
  borderRadius: "14px",
  border: "1px solid #e2e8f0",
  background: "#ffffff",
  marginBottom: "16px"
};

const tituloHistorico = {
  margin: 0,
  color: "#0f172a",
  fontSize: "20px",
  fontWeight: "900"
};

const linhaHistorico = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "12px",
  padding: "10px 0",
  borderTop: "1px solid #f1f5f9"
};

const colunaHistorico = {
  display: "flex",
  flexDirection: "column",
  gap: "2px"
};

const nomeAlunoHistorico = {
  color: "#0f172a",
  fontSize: "14px"
};

const detalheHistorico = {
  color: "#64748b",
  fontSize: "12px"
};

const badgeHistorico = {
  color: "#fff",
  borderRadius: "999px",
  padding: "5px 10px",
  fontSize: "11px",
  fontWeight: "900",
  whiteSpace: "nowrap"
};
