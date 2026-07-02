import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";

const OPERADORES_REATIVA = [
  { nome: "Fernanda Supervisora", email: "cobranca04@aelbra.com.br" },
  { nome: "Luana", email: "cobranca05@aelbra.com.br" },
  { nome: "Rafaella", email: "cobranca12@aelbra.com.br" },
  { nome: "Amanda ADM", email: "cobranca07@aelbra.com.br" },
  { nome: "Allan", email: "cobranca11@aelbra.com.br" },
  { nome: "Maurício", email: "cobranca06@aelbra.com.br" },
  { nome: "Olga", email: "cobranca03@aelbra.com.br" },
  { nome: "João", email: "cobranca10@aelbra.com.br" },
  { nome: "Diego", email: "cobranca13@aelbra.com.br" },
  { nome: "Natali", email: "cobranca08@aelbra.com.br" },
  { nome: "Amanda Seibel", email: "amanda.seibel@aelbra.com.br" },
];

const STATUS_LABELS_LINKS = {
  SOLICITADO_LINK: "Solicitado",
  LINK_EM_ATENDIMENTO: "Em atendimento",
  LINK_PRONTO_PARA_ENVIO: "Respondido",
  LINK_ENVIADO_AO_ALUNO: "Enviado ao aluno",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_REALIZADA: "Baixa realizada",
  BAIXA_DEVOLVIDA: "Baixa devolvida",
  CANCELADO: "Cancelado",
  DIVERGENCIA: "Divergência",
};

const STATUS_AGUARDANDO_LINKS = ["SOLICITADO_LINK", "LINK_EM_ATENDIMENTO"];

const STATUS_LABELS_FINANCEIRO = {
  AGUARDANDO_ENVIO_FINANCEIRO: "Aguardando envio",
  ENVIADO_FINANCEIRO: "Enviado ao financeiro",
};

const STATUS_LABELS_TERMOS = {
  TERMO_ENVIADO_ADM: "Termo enviado ADM",
  TERMO_RECEBIDO_LIBERADO: "Termo recebido - liberado",
  TERMO_REJEITADO: "Termo rejeitado",
  TERMO_LIBERADO_AUTOMATICO_GOV: "Liberado automático (gov.br)",
};

const LIMITE_ATRASO_MIN = 60;

const ABAS = [
  { valor: "LINKS", label: "🔗 Links de pagamento" },
  { valor: "FINANCEIRO", label: "🏦 Financeiro" },
  { valor: "TERMOS", label: "📎 Termos ADM" },
];

function corBadge(status) {
  const pendentes = [
    "SOLICITADO_LINK",
    "LINK_EM_ATENDIMENTO",
    "AGUARDANDO_ENVIO_FINANCEIRO",
    "TERMO_ENVIADO_ADM",
  ];
  const positivos = [
    "LINK_PRONTO_PARA_ENVIO",
    "LINK_ENVIADO_AO_ALUNO",
    "AGUARDANDO_BAIXA",
    "BAIXA_REALIZADA",
    "ENVIADO_FINANCEIRO",
    "TERMO_RECEBIDO_LIBERADO",
    "TERMO_LIBERADO_AUTOMATICO_GOV",
  ];
  const negativos = ["CANCELADO", "DIVERGENCIA", "BAIXA_DEVOLVIDA", "TERMO_REJEITADO"];

  if (pendentes.includes(status)) return { bg: "#fef3c7", texto: "#92400e" };
  if (positivos.includes(status)) return { bg: "#dcfce7", texto: "#166534" };
  if (negativos.includes(status)) return { bg: "#fee2e2", texto: "#991b1b" };
  return { bg: "#e0f2fe", texto: "#075985" };
}

function inicioPeriodo(periodo) {
  const agora = new Date();

  if (periodo === "HOJE") {
    agora.setHours(0, 0, 0, 0);
    return agora;
  }

  if (periodo === "SEMANA") {
    const diaSemana = agora.getDay();
    agora.setDate(agora.getDate() - diaSemana);
    agora.setHours(0, 0, 0, 0);
    return agora;
  }

  if (periodo === "MES") {
    agora.setDate(1);
    agora.setHours(0, 0, 0, 0);
    return agora;
  }

  return null;
}

function diffMinutos(inicio, fim) {
  if (!inicio || !fim) return null;
  const ms = new Date(fim).getTime() - new Date(inicio).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

function formatarDuracao(minutos) {
  if (minutos === null || minutos === undefined) return "-";
  if (minutos < 60) return `${minutos}min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto > 0 ? `${horas}h ${resto}min` : `${horas}h`;
}

function formatarMoeda(valor) {
  if (valor === null || valor === undefined || valor === "") return "-";
  const numero = Number(valor);
  if (Number.isNaN(numero)) return "-";
  return numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarData(data) {
  if (!data) return "-";

  try {
    return new Date(data).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

async function garantirSessaoValida() {
  try {
    await supabase.auth.getSession();
  } catch {
    // Se falhar, deixa o erro real da próxima chamada aparecer.
  }
}

export default function PainelAdm() {
  const [usuario, setUsuario] = useState(null);
  const [aba, setAba] = useState("LINKS");

  const [periodo, setPeriodo] = useState("HOJE");
  const [busca, setBusca] = useState("");

  // ---- Links de pagamento ----
  const [links, setLinks] = useState([]);
  const [aguardandoGeral, setAguardandoGeral] = useState(0);
  const [carregandoLinks, setCarregandoLinks] = useState(true);
  const [erroLinks, setErroLinks] = useState("");
  const [operadorFiltro, setOperadorFiltro] = useState("TODOS");
  const [statusFiltroLinks, setStatusFiltroLinks] = useState("TODOS");
  const [linksEditados, setLinksEditados] = useState({});
  const [obsLinks, setObsLinks] = useState({});

  // ---- Financeiro ----
  const [financeiro, setFinanceiro] = useState([]);
  const [carregandoFinanceiro, setCarregandoFinanceiro] = useState(true);
  const [statusFiltroFinanceiro, setStatusFiltroFinanceiro] = useState("TODOS");
  const [obsFinanceiro, setObsFinanceiro] = useState({});

  // ---- Termos ADM ----
  const [termos, setTermos] = useState([]);
  const [carregandoTermos, setCarregandoTermos] = useState(true);
  const [statusFiltroTermos, setStatusFiltroTermos] = useState("TODOS");
  const [obsTermos, setObsTermos] = useState({});
  const [motivosTermos, setMotivosTermos] = useState({});

  useEffect(() => {
    carregarUsuario();
  }, []);

  useEffect(() => {
    if (aba === "LINKS") carregarLinks();
    if (aba === "FINANCEIRO") carregarFinanceiro();
    if (aba === "TERMOS") carregarTermos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba, periodo]);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarLinks() {
    setCarregandoLinks(true);
    setErroLinks("");

    try {
      const desde = inicioPeriodo(periodo);

      let query = supabase
        .from("links_pagamento")
        .select("*")
        .order("criado_em", { ascending: false })
        .limit(2000);

      if (desde) {
        query = query.gte("criado_em", desde.toISOString());
      }

      const { data, error } = await query;

      if (error) {
        console.error("Erro ao carregar links:", error);
        setErroLinks("Não foi possível carregar os links de pagamento.");
        setCarregandoLinks(false);
        return;
      }

      setLinks(data || []);

      const { count, error: erroAguardando } = await supabase
        .from("links_pagamento")
        .select("id", { count: "exact", head: true })
        .in("status", STATUS_AGUARDANDO_LINKS);

      if (!erroAguardando) {
        setAguardandoGeral(count || 0);
      }
    } finally {
      setCarregandoLinks(false);
    }
  }

  async function carregarFinanceiro() {
    setCarregandoFinanceiro(true);

    const desde = inicioPeriodo(periodo);

    let query = supabase
      .from("solicitacoes_financeiro")
      .select("*")
      .order("criado_em", { ascending: false })
      .limit(2000);

    if (desde) {
      query = query.gte("criado_em", desde.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      alert("Erro ao carregar fila do financeiro: " + error.message);
      setCarregandoFinanceiro(false);
      return;
    }

    setFinanceiro(data || []);
    setCarregandoFinanceiro(false);
  }

  async function carregarTermos() {
    setCarregandoTermos(true);

    const desde = inicioPeriodo(periodo);

    let query = supabase
      .from("termos_acordo")
      .select("*")
      .order("criado_em", { ascending: false })
      .limit(2000);

    if (desde) {
      query = query.gte("criado_em", desde.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      alert("Erro ao carregar fila de termos: " + error.message);
      setCarregandoTermos(false);
      return;
    }

    setTermos(data || []);
    setCarregandoTermos(false);
  }

  // ===================== AÇÕES: LINKS =====================

  async function historicoLink(item, statusNovo, observacao) {
    await supabase.from("historico_links_pagamento").insert({
      link_pagamento_id: item.id,
      chave_unificacao: item.chave_unificacao,
      nome_aluno: item.nome_aluno || item.aluno_nome,
      cpf_referencia: item.cpf_referencia || item.aluno_cpf,
      status_anterior: item.status,
      status_novo: statusNovo,
      observacao,
      usuario_nome: usuario?.email || "",
      usuario_email: usuario?.email || "",
    });
  }

  async function salvarLinkPainel(item) {
    await garantirSessaoValida();

    const link = linksEditados[item.id] ?? item.link_gerado ?? "";

    if (!link || !link.trim()) {
      alert("Cole o link de pagamento.");
      return;
    }

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        link_gerado: link.trim(),
        status: "LINK_PRONTO_PARA_ENVIO",
        link_gerado_por: usuario?.email || "",
        link_gerado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao salvar link: " + error.message);
      return;
    }

    if (item.aluno_id) {
      await supabase
        .from("alunos")
        .update({
          nivel_criticidade: "URGENTE",
          status_acionamento: "Link pronto para envio",
        })
        .eq("id", item.aluno_id);
    }

    await historicoLink(item, "LINK_PRONTO_PARA_ENVIO", "Link gerado/colado pela ADM.");
    alert("Link salvo. O operador será sinalizado como link pronto e o caso vai pro topo da fila dele.");
    carregarLinks();
  }

  async function concluirBaixaPainel(item) {
    const obs = obsLinks[item.id] || "";

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "BAIXA_REALIZADA",
        baixa_realizada_por: usuario?.email || "",
        baixa_realizada_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao concluir baixa: " + error.message);
      return;
    }

    await historicoLink(item, "BAIXA_REALIZADA", obs || "Baixa concluída pela ADM.");
    alert("Baixa concluída. O operador será sinalizado.");
    carregarLinks();
  }

  async function marcarDivergenciaPainel(item) {
    const motivo = obsLinks[item.id] || "";

    if (!motivo.trim()) {
      alert("Escreva o motivo da divergência no campo de observação antes de marcar.");
      return;
    }

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "DIVERGENCIA",
        motivo_divergencia: motivo,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao registrar divergência: " + error.message);
      return;
    }

    await historicoLink(item, "DIVERGENCIA", motivo);
    alert("Divergência registrada. O operador será sinalizado.");
    carregarLinks();
  }

  async function copiarLinkPainel(link) {
    if (!link) {
      alert("Este registro ainda não possui link.");
      return;
    }

    try {
      await navigator.clipboard.writeText(link);
      alert("Link copiado.");
    } catch {
      alert("Não consegui copiar automaticamente. Abra e copie manualmente.");
    }
  }

  // ===================== AÇÕES: FINANCEIRO =====================

  async function agendarRetornoAlunoFinanceiro(alunoId) {
    if (!alunoId) return;

    const daquiA7Dias = new Date();
    daquiA7Dias.setDate(daquiA7Dias.getDate() + 7);

    await supabase
      .from("alunos")
      .update({
        data_retorno: daquiA7Dias.toISOString(),
        status_jornada: "Enviado ao financeiro",
        status_atual: "Enviado ao financeiro",
        status_acionamento: "Enviado ao financeiro",
        proxima_acao: "RETORNAR",
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", alunoId);
  }

  async function marcarComoEnviadoFinanceiro(solicitacao) {
    await garantirSessaoValida();

    const observacaoAdm = obsFinanceiro[solicitacao.id] || "";

    const { error } = await supabase
      .from("solicitacoes_financeiro")
      .update({
        status: "ENVIADO_FINANCEIRO",
        observacao_adm: observacaoAdm,
        enviado_por: usuario?.email || "ADM",
        enviado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", solicitacao.id);

    if (error) {
      alert("Erro ao confirmar envio: " + error.message);
      return;
    }

    await agendarRetornoAlunoFinanceiro(solicitacao.aluno_id);
    alert("Envio confirmado. Retorno deste aluno já foi agendado para daqui a 7 dias.");
    carregarFinanceiro();
  }

  // ===================== AÇÕES: TERMOS =====================

  async function atualizarStatusAlunoTermo(alunoId, novoStatus, statusAcionamento) {
    if (!alunoId) return;

    await supabase
      .from("alunos")
      .update({
        status_jornada: novoStatus,
        nivel_criticidade: "URGENTE",
        status_acionamento: statusAcionamento || novoStatus,
      })
      .eq("id", alunoId);
  }

  async function aprovarTermoPainel(termo) {
    await garantirSessaoValida();

    const observacaoAdm = obsTermos[termo.id] || "Termo conferido e liberado pela ADM.";

    const { error } = await supabase
      .from("termos_acordo")
      .update({
        status: "TERMO_RECEBIDO_LIBERADO",
        observacao_adm: observacaoAdm,
        validado_por: usuario?.email || "ADM",
        validado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", termo.id);

    if (error) {
      alert("Erro ao aprovar termo: " + error.message);
      return;
    }

    await atualizarStatusAlunoTermo(termo.aluno_id, "Termo recebido - liberado", "Termo aprovado pela ADM");
    alert("Termo aprovado e liberado para operação. O caso vai pro topo da fila do operador.");
    carregarTermos();
  }

  async function rejeitarTermoPainel(termo) {
    await garantirSessaoValida();

    const motivo = motivosTermos[termo.id];

    if (!motivo || motivo.trim() === "") {
      alert("Informe o motivo da rejeição.");
      return;
    }

    const { error } = await supabase
      .from("termos_acordo")
      .update({
        status: "TERMO_REJEITADO",
        observacao_adm: motivo,
        validado_por: usuario?.email || "ADM",
        validado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", termo.id);

    if (error) {
      alert("Erro ao rejeitar termo: " + error.message);
      return;
    }

    await atualizarStatusAlunoTermo(termo.aluno_id, "Termo rejeitado", "Termo rejeitado pela ADM");
    alert("Termo rejeitado e devolvido para operação. O caso vai pro topo da fila do operador.");
    carregarTermos();
  }

  // ===================== INDICADORES E FILTROS =====================

  const indicadoresLinks = useMemo(() => {
    const respondidos = links.filter((l) => l.respondido_em);

    const temposResposta = respondidos
      .map((l) => diffMinutos(l.criado_em, l.respondido_em))
      .filter((v) => v !== null);

    const tempoMedio =
      temposResposta.length > 0
        ? Math.round(temposResposta.reduce((a, b) => a + b, 0) / temposResposta.length)
        : null;

    return {
      solicitados: links.length,
      respondidos: respondidos.length,
      tempoMedio,
    };
  }, [links]);

  const porOperador = useMemo(() => {
    const mapa = {};

    links.forEach((l) => {
      if (!l.respondido_em) return;

      const nome = l.operador_nome || l.operador_solicitante || l.operador_email || "Sem operador";
      const minutos = diffMinutos(l.criado_em, l.respondido_em);
      if (minutos === null) return;

      if (!mapa[nome]) mapa[nome] = { nome, total: 0, soma: 0 };
      mapa[nome].total += 1;
      mapa[nome].soma += minutos;
    });

    return Object.values(mapa)
      .map((item) => ({ nome: item.nome, media: Math.round(item.soma / item.total) }))
      .sort((a, b) => b.media - a.media)
      .slice(0, 8);
  }, [links]);

  const maiorMedia = useMemo(() => Math.max(1, ...porOperador.map((o) => o.media)), [porOperador]);

  const linksFiltrados = useMemo(() => {
    let lista = [...links];

    if (operadorFiltro !== "TODOS") {
      lista = lista.filter(
        (l) => String(l.operador_email || "").toLowerCase() === operadorFiltro.toLowerCase()
      );
    }

    if (statusFiltroLinks === "AGUARDANDO") {
      lista = lista.filter((l) => STATUS_AGUARDANDO_LINKS.includes(l.status));
    } else if (statusFiltroLinks !== "TODOS") {
      lista = lista.filter((l) => l.status === statusFiltroLinks);
    }

    if (busca.trim()) {
      const termo = busca.trim().toLowerCase();
      lista = lista.filter((l) =>
        [l.aluno_nome, l.nome_aluno, l.operador_nome, l.operador_solicitante]
          .join(" ")
          .toLowerCase()
          .includes(termo)
      );
    }

    return lista;
  }, [links, operadorFiltro, statusFiltroLinks, busca]);

  const indicadoresFinanceiro = useMemo(() => {
    return {
      pendentes: financeiro.filter((s) => s.status === "AGUARDANDO_ENVIO_FINANCEIRO").length,
      enviados: financeiro.filter((s) => s.status === "ENVIADO_FINANCEIRO").length,
      todos: financeiro.length,
    };
  }, [financeiro]);

  const financeiroFiltrado = useMemo(() => {
    let lista = [...financeiro];

    if (statusFiltroFinanceiro !== "TODOS") {
      lista = lista.filter((s) => s.status === statusFiltroFinanceiro);
    }

    if (busca.trim()) {
      const termo = busca.trim().toLowerCase();
      lista = lista.filter((s) =>
        [s.aluno_nome, s.aluno_cpf, s.operador_nome, s.operador_email]
          .join(" ")
          .toLowerCase()
          .includes(termo)
      );
    }

    return lista;
  }, [financeiro, statusFiltroFinanceiro, busca]);

  const indicadoresTermos = useMemo(() => {
    return {
      pendentes: termos.filter((t) => t.status === "TERMO_ENVIADO_ADM").length,
      liberados: termos.filter((t) => t.status === "TERMO_RECEBIDO_LIBERADO").length,
      rejeitados: termos.filter((t) => t.status === "TERMO_REJEITADO").length,
      todos: termos.length,
    };
  }, [termos]);

  const termosFiltrados = useMemo(() => {
    let lista = [...termos];

    if (statusFiltroTermos !== "TODOS") {
      lista = lista.filter((t) => t.status === statusFiltroTermos);
    }

    if (busca.trim()) {
      const termo = busca.trim().toLowerCase();
      lista = lista.filter((t) =>
        [t.aluno_nome, t.aluno_cpf, t.operador_nome, t.operador_email]
          .join(" ")
          .toLowerCase()
          .includes(termo)
      );
    }

    return lista;
  }, [termos, statusFiltroTermos, busca]);

  if (usuario && !podeVerTudo(usuario.email)) {
    return (
      <div style={estilos.pagina}>
        <p>Você não tem permissão para ver este painel.</p>
      </div>
    );
  }

  function atualizarAbaAtual() {
    if (aba === "LINKS") carregarLinks();
    if (aba === "FINANCEIRO") carregarFinanceiro();
    if (aba === "TERMOS") carregarTermos();
  }

  return (
    <div style={estilos.pagina}>
      <div style={estilos.tabs}>
        {ABAS.map((item) => (
          <button
            key={item.valor}
            type="button"
            onClick={() => setAba(item.valor)}
            style={aba === item.valor ? estilos.tabAtiva : estilos.tab}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div style={estilos.filtros}>
        <select value={periodo} onChange={(e) => setPeriodo(e.target.value)} style={estilos.select}>
          <option value="HOJE">Hoje</option>
          <option value="SEMANA">Esta semana</option>
          <option value="MES">Este mês</option>
          <option value="TODOS">Tudo</option>
        </select>

        {aba === "LINKS" && (
          <select
            value={operadorFiltro}
            onChange={(e) => setOperadorFiltro(e.target.value)}
            style={estilos.select}
          >
            <option value="TODOS">Todos os operadores</option>
            {OPERADORES_REATIVA.map((op) => (
              <option key={op.email} value={op.email}>
                {op.nome}
              </option>
            ))}
          </select>
        )}

        {aba === "LINKS" && (
          <select
            value={statusFiltroLinks}
            onChange={(e) => setStatusFiltroLinks(e.target.value)}
            style={estilos.select}
          >
            <option value="TODOS">Todos os status</option>
            <option value="AGUARDANDO">Aguardando resposta</option>
            {Object.entries(STATUS_LABELS_LINKS).map(([valor, label]) => (
              <option key={valor} value={valor}>
                {label}
              </option>
            ))}
          </select>
        )}

        {aba === "FINANCEIRO" && (
          <select
            value={statusFiltroFinanceiro}
            onChange={(e) => setStatusFiltroFinanceiro(e.target.value)}
            style={estilos.select}
          >
            <option value="TODOS">Todos os status</option>
            {Object.entries(STATUS_LABELS_FINANCEIRO).map(([valor, label]) => (
              <option key={valor} value={valor}>
                {label}
              </option>
            ))}
          </select>
        )}

        {aba === "TERMOS" && (
          <select
            value={statusFiltroTermos}
            onChange={(e) => setStatusFiltroTermos(e.target.value)}
            style={estilos.select}
          >
            <option value="TODOS">Todos os status</option>
            {Object.entries(STATUS_LABELS_TERMOS).map(([valor, label]) => (
              <option key={valor} value={valor}>
                {label}
              </option>
            ))}
          </select>
        )}

        <input
          type="text"
          placeholder="Buscar aluno, CPF ou operador"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          style={estilos.busca}
        />

        <button type="button" onClick={atualizarAbaAtual} style={estilos.botaoAtualizar}>
          Atualizar
        </button>
      </div>

      {aba === "LINKS" && (
        <>
          {erroLinks && <div style={estilos.erro}>{erroLinks}</div>}

          <div style={estilos.grid}>
            <div style={estilos.cartao}>
              <p style={estilos.rotuloCartao}>Solicitados no período</p>
              <p style={estilos.valorCartao}>{indicadoresLinks.solicitados}</p>
            </div>

            <div style={{ ...estilos.cartao, background: "#fef3c7" }}>
              <p style={{ ...estilos.rotuloCartao, color: "#92400e" }}>Aguardando resposta agora</p>
              <p style={{ ...estilos.valorCartao, color: "#92400e" }}>{aguardandoGeral}</p>
            </div>

            <div style={{ ...estilos.cartao, background: "#dcfce7" }}>
              <p style={{ ...estilos.rotuloCartao, color: "#166534" }}>Respondidos no período</p>
              <p style={{ ...estilos.valorCartao, color: "#166534" }}>{indicadoresLinks.respondidos}</p>
            </div>

            <div style={estilos.cartao}>
              <p style={estilos.rotuloCartao}>Tempo médio de resposta</p>
              <p style={estilos.valorCartao}>{formatarDuracao(indicadoresLinks.tempoMedio)}</p>
            </div>
          </div>

          {porOperador.length > 0 && (
            <div style={estilos.cartaoGrafico}>
              <p style={estilos.rotuloGrafico}>Tempo médio de resposta por operador (no período)</p>

              {porOperador.map((op) => (
                <div key={op.nome} style={estilos.linhaGrafico}>
                  <span style={estilos.nomeGrafico}>{op.nome}</span>
                  <div style={estilos.barraFundo}>
                    <div
                      style={{
                        ...estilos.barraPreenchida,
                        width: `${Math.max(6, (op.media / maiorMedia) * 100)}%`,
                        background: op.media > LIMITE_ATRASO_MIN ? "#d97706" : "#0f6e56",
                      }}
                    />
                  </div>
                  <span style={estilos.valorGrafico}>{formatarDuracao(op.media)}</span>
                </div>
              ))}
            </div>
          )}

          <div style={estilos.tabelaContainer}>
            {carregandoLinks ? (
              <p style={estilos.textoAuxiliar}>Carregando...</p>
            ) : linksFiltrados.length === 0 ? (
              <p style={estilos.textoAuxiliar}>Nenhum link encontrado para esse filtro.</p>
            ) : (
              <table style={estilos.tabela}>
                <thead>
                  <tr>
                    <th style={estilos.th}>Aluno</th>
                    <th style={estilos.th}>Operador</th>
                    <th style={estilos.th}>Valor</th>
                    <th style={estilos.th}>Status</th>
                    <th style={estilos.th}>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {linksFiltrados.map((item) => {
                    const cores = corBadge(item.status);
                    const aguardando = STATUS_AGUARDANDO_LINKS.includes(item.status);
                    const minutosResposta = item.respondido_em
                      ? diffMinutos(item.criado_em, item.respondido_em)
                      : aguardando
                      ? diffMinutos(item.criado_em, new Date().toISOString())
                      : null;

                    const atrasado = aguardando && minutosResposta !== null && minutosResposta > LIMITE_ATRASO_MIN;
                    const linkAtual = linksEditados[item.id] ?? item.link_gerado ?? "";

                    return (
                      <tr key={item.id} style={estilos.tr}>
                        <td style={estilos.td}>{item.aluno_nome || item.nome_aluno || "-"}</td>
                        <td style={{ ...estilos.td, color: "#475569" }}>
                          {item.operador_nome || item.operador_solicitante || "-"}
                        </td>
                        <td style={estilos.td}>{formatarMoeda(item.valor)}</td>
                        <td style={estilos.td}>
                          <span style={{ ...estilos.badge, background: cores.bg, color: cores.texto }}>
                            {STATUS_LABELS_LINKS[item.status] || item.status}
                          </span>
                          <div style={{ fontSize: "11px", color: atrasado ? "#b91c1c" : "#94a3b8", marginTop: "4px" }}>
                            {minutosResposta === null
                              ? ""
                              : item.respondido_em
                              ? `${formatarDuracao(minutosResposta)} p/ responder`
                              : `${atrasado ? "atrasado há " : "aguardando há "}${formatarDuracao(minutosResposta)}`}
                          </div>
                        </td>
                        <td style={estilos.td}>
                          {(item.status === "SOLICITADO_LINK" || item.status === "LINK_EM_ATENDIMENTO") && (
                            <div style={estilos.acaoColuna}>
                              <input
                                style={estilos.inputAcao}
                                placeholder="Colar link completo"
                                value={linkAtual}
                                onChange={(e) =>
                                  setLinksEditados({ ...linksEditados, [item.id]: e.target.value })
                                }
                              />
                              <button style={estilos.botaoAzul} onClick={() => salvarLinkPainel(item)}>
                                Salvar link
                              </button>
                            </div>
                          )}

                          {(item.status === "LINK_PRONTO_PARA_ENVIO" || item.status === "LINK_ENVIADO_AO_ALUNO") && (
                            <div style={estilos.acaoColuna}>
                              <button style={estilos.botaoCinza} onClick={() => copiarLinkPainel(item.link_gerado)}>
                                Copiar link
                              </button>
                            </div>
                          )}

                          {item.status === "AGUARDANDO_BAIXA" && (
                            <div style={estilos.acaoColuna}>
                              {item.comprovante_url && (
                                <a href={item.comprovante_url} target="_blank" rel="noreferrer" style={estilos.linkComprovante}>
                                  Ver comprovante
                                </a>
                              )}
                              <input
                                style={estilos.inputAcao}
                                placeholder="Observação (obrigatória p/ divergência)"
                                value={obsLinks[item.id] || ""}
                                onChange={(e) => setObsLinks({ ...obsLinks, [item.id]: e.target.value })}
                              />
                              <div style={{ display: "flex", gap: "6px" }}>
                                <button style={estilos.botaoAzul} onClick={() => concluirBaixaPainel(item)}>
                                  Baixa concluída
                                </button>
                                <button style={estilos.botaoAmarelo} onClick={() => marcarDivergenciaPainel(item)}>
                                  Divergência
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {aba === "FINANCEIRO" && (
        <>
          <div style={estilos.grid}>
            <div style={estilos.cartao}>
              <p style={estilos.rotuloCartao}>Aguardando envio</p>
              <p style={estilos.valorCartao}>{indicadoresFinanceiro.pendentes}</p>
            </div>
            <div style={{ ...estilos.cartao, background: "#dcfce7" }}>
              <p style={{ ...estilos.rotuloCartao, color: "#166534" }}>Enviados</p>
              <p style={{ ...estilos.valorCartao, color: "#166534" }}>{indicadoresFinanceiro.enviados}</p>
            </div>
            <div style={estilos.cartao}>
              <p style={estilos.rotuloCartao}>Total</p>
              <p style={estilos.valorCartao}>{indicadoresFinanceiro.todos}</p>
            </div>
          </div>

          {carregandoFinanceiro ? (
            <p style={estilos.textoAuxiliar}>Carregando...</p>
          ) : financeiroFiltrado.length === 0 ? (
            <p style={estilos.textoAuxiliar}>Nenhuma solicitação encontrada para esse filtro.</p>
          ) : (
            financeiroFiltrado.map((s) => {
              const pendente = s.status === "AGUARDANDO_ENVIO_FINANCEIRO";
              const cores = corBadge(s.status);

              return (
                <div key={s.id} style={estilos.card}>
                  <div style={estilos.topoCard}>
                    <div>
                      <h3 style={estilos.nomeCard}>{s.aluno_nome || "Aluno sem nome"}</h3>
                      <p style={estilos.infoCard}><strong>CPF:</strong> {s.aluno_cpf || "Não informado"}</p>
                      <p style={estilos.infoCard}>
                        <strong>Operador:</strong> {s.operador_nome || s.operador_email || "Não informado"}
                      </p>
                      <p style={estilos.infoCard}><strong>Solicitado em:</strong> {formatarData(s.criado_em)}</p>
                    </div>
                    <span style={{ ...estilos.badge, background: cores.bg, color: cores.texto }}>
                      {STATUS_LABELS_FINANCEIRO[s.status] || s.status}
                    </span>
                  </div>

                  <div style={estilos.blocoCard}>
                    <strong>Motivo:</strong>
                    <p style={estilos.paragrafoCard}>{s.motivo || "Sem motivo informado."}</p>
                  </div>

                  {s.observacao_adm && (
                    <div style={estilos.blocoRetorno}>
                      <strong>Observação ao enviar:</strong>
                      <p style={estilos.paragrafoCard}>{s.observacao_adm}</p>
                      <p style={estilos.infoCard}><strong>Enviado por:</strong> {s.enviado_por || "-"}</p>
                      <p style={estilos.infoCard}><strong>Enviado em:</strong> {formatarData(s.enviado_em)}</p>
                    </div>
                  )}

                  {pendente && (
                    <>
                      <div style={estilos.blocoCard}>
                        <label style={estilos.labelCard}>Observação (opcional)</label>
                        <textarea
                          style={estilos.textareaCard}
                          placeholder="Exemplo: enviado por e-mail ao financeiro em 01/07."
                          value={obsFinanceiro[s.id] || ""}
                          onChange={(e) => setObsFinanceiro({ ...obsFinanceiro, [s.id]: e.target.value })}
                        />
                      </div>

                      <div style={estilos.acoesCard}>
                        <button style={estilos.botaoConfirmarCard} onClick={() => marcarComoEnviadoFinanceiro(s)}>
                          Marcar como enviado ao financeiro
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </>
      )}

      {aba === "TERMOS" && (
        <>
          <div style={estilos.grid}>
            <div style={estilos.cartao}>
              <p style={estilos.rotuloCartao}>Pendentes</p>
              <p style={estilos.valorCartao}>{indicadoresTermos.pendentes}</p>
            </div>
            <div style={{ ...estilos.cartao, background: "#dcfce7" }}>
              <p style={{ ...estilos.rotuloCartao, color: "#166534" }}>Liberados</p>
              <p style={{ ...estilos.valorCartao, color: "#166534" }}>{indicadoresTermos.liberados}</p>
            </div>
            <div style={{ ...estilos.cartao, background: "#fee2e2" }}>
              <p style={{ ...estilos.rotuloCartao, color: "#991b1b" }}>Rejeitados</p>
              <p style={{ ...estilos.valorCartao, color: "#991b1b" }}>{indicadoresTermos.rejeitados}</p>
            </div>
            <div style={estilos.cartao}>
              <p style={estilos.rotuloCartao}>Total</p>
              <p style={estilos.valorCartao}>{indicadoresTermos.todos}</p>
            </div>
          </div>

          {carregandoTermos ? (
            <p style={estilos.textoAuxiliar}>Carregando...</p>
          ) : termosFiltrados.length === 0 ? (
            <p style={estilos.textoAuxiliar}>Nenhum termo encontrado para esse filtro.</p>
          ) : (
            termosFiltrados.map((termo) => {
              const pendente = termo.status === "TERMO_ENVIADO_ADM";
              const cores = corBadge(termo.status);

              return (
                <div key={termo.id} style={estilos.card}>
                  <div style={estilos.topoCard}>
                    <div>
                      <h3 style={estilos.nomeCard}>{termo.aluno_nome || "Aluno sem nome"}</h3>
                      <p style={estilos.infoCard}><strong>CPF:</strong> {termo.aluno_cpf || "Não informado"}</p>
                      <p style={estilos.infoCard}>
                        <strong>Operador:</strong> {termo.operador_nome || termo.operador_email || "Não informado"}
                      </p>
                      <p style={estilos.infoCard}><strong>Enviado em:</strong> {formatarData(termo.criado_em)}</p>
                    </div>
                    <span style={{ ...estilos.badge, background: cores.bg, color: cores.texto }}>
                      {STATUS_LABELS_TERMOS[termo.status] || termo.status}
                    </span>
                  </div>

                  <div style={estilos.blocoCard}>
                    <strong>Observação da operação:</strong>
                    <p style={estilos.paragrafoCard}>{termo.observacao_operador || "Sem observação."}</p>
                  </div>

                  {termo.arquivo_url ? (
                    <div style={estilos.blocoCard}>
                      <a href={termo.arquivo_url} target="_blank" rel="noreferrer" style={estilos.linkComprovante}>
                        Abrir termo de acordo
                      </a>
                    </div>
                  ) : (
                    <div style={estilos.erro}>Este termo foi enviado sem anexo localizado.</div>
                  )}

                  {termo.observacao_adm && (
                    <div style={estilos.blocoRetorno}>
                      <strong>Retorno ADM:</strong>
                      <p style={estilos.paragrafoCard}>{termo.observacao_adm}</p>
                      <p style={estilos.infoCard}><strong>Validado por:</strong> {termo.validado_por || "-"}</p>
                      <p style={estilos.infoCard}><strong>Validado em:</strong> {formatarData(termo.validado_em)}</p>
                    </div>
                  )}

                  {pendente && (
                    <>
                      <div style={estilos.blocoCard}>
                        <label style={estilos.labelCard}>Observação ADM para aprovação</label>
                        <textarea
                          style={estilos.textareaCard}
                          placeholder="Exemplo: termo conferido, dados compatíveis e acordo liberado."
                          value={obsTermos[termo.id] || ""}
                          onChange={(e) => setObsTermos({ ...obsTermos, [termo.id]: e.target.value })}
                        />
                      </div>

                      <div style={estilos.blocoCard}>
                        <label style={estilos.labelCard}>Motivo da rejeição</label>
                        <textarea
                          style={estilos.textareaCard}
                          placeholder="Obrigatório apenas se for rejeitar. Exemplo: termo ilegível, falta assinatura, dados divergentes..."
                          value={motivosTermos[termo.id] || ""}
                          onChange={(e) => setMotivosTermos({ ...motivosTermos, [termo.id]: e.target.value })}
                        />
                      </div>

                      <div style={estilos.acoesCard}>
                        <button style={estilos.botaoConfirmarCard} onClick={() => aprovarTermoPainel(termo)}>
                          Aprovar e liberar para operação
                        </button>
                        <button style={estilos.botaoRejeitarCard} onClick={() => rejeitarTermoPainel(termo)}>
                          Rejeitar e devolver com motivo
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}

const estilos = {
  pagina: {
    padding: "24px",
  },
  tabs: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
    marginBottom: "16px",
  },
  tab: {
    padding: "10px 16px",
    borderRadius: "999px",
    border: "1px solid #cbd5e1",
    background: "#fff",
    color: "#0f172a",
    fontWeight: "700",
    cursor: "pointer",
    fontSize: "14px",
  },
  tabAtiva: {
    padding: "10px 16px",
    borderRadius: "999px",
    border: "1px solid #0f172a",
    background: "#0f172a",
    color: "#fff",
    fontWeight: "700",
    cursor: "pointer",
    fontSize: "14px",
  },
  filtros: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    alignItems: "center",
    marginBottom: "20px",
  },
  select: {
    padding: "9px 10px",
    border: "1px solid #cbd5e1",
    borderRadius: "8px",
    fontSize: "14px",
    background: "#fff",
  },
  busca: {
    padding: "9px 10px",
    border: "1px solid #cbd5e1",
    borderRadius: "8px",
    fontSize: "14px",
    flex: "1",
    minWidth: "180px",
  },
  botaoAtualizar: {
    padding: "9px 14px",
    border: "1px solid #cbd5e1",
    borderRadius: "8px",
    background: "#0f172a",
    color: "#fff",
    fontWeight: "700",
    cursor: "pointer",
  },
  erro: {
    background: "#fee2e2",
    color: "#991b1b",
    padding: "10px 14px",
    borderRadius: "8px",
    marginBottom: "16px",
    fontWeight: "700",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "12px",
    marginBottom: "20px",
  },
  cartao: {
    background: "#f1f5f9",
    borderRadius: "12px",
    padding: "16px",
  },
  rotuloCartao: {
    margin: "0 0 6px",
    fontSize: "13px",
    color: "#475569",
  },
  valorCartao: {
    margin: 0,
    fontSize: "26px",
    fontWeight: "800",
    color: "#0f172a",
  },
  cartaoGrafico: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "12px",
    padding: "16px 18px",
    marginBottom: "20px",
  },
  rotuloGrafico: {
    margin: "0 0 14px",
    fontSize: "13px",
    color: "#475569",
    fontWeight: "700",
  },
  linhaGrafico: {
    display: "grid",
    gridTemplateColumns: "130px 1fr 80px",
    alignItems: "center",
    gap: "10px",
    marginBottom: "10px",
  },
  nomeGrafico: {
    fontSize: "13px",
    color: "#0f172a",
    fontWeight: "700",
  },
  barraFundo: {
    background: "#f1f5f9",
    borderRadius: "6px",
    height: "10px",
    overflow: "hidden",
  },
  barraPreenchida: {
    height: "100%",
    borderRadius: "6px",
  },
  valorGrafico: {
    fontSize: "12px",
    color: "#475569",
    textAlign: "right",
  },
  tabelaContainer: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "12px",
    overflow: "hidden",
  },
  tabela: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "13px",
  },
  th: {
    textAlign: "left",
    padding: "12px 14px",
    color: "#475569",
    fontWeight: "700",
    borderBottom: "1px solid #e2e8f0",
    background: "#f8fafc",
  },
  tr: {
    borderBottom: "1px solid #f1f5f9",
  },
  td: {
    padding: "10px 14px",
    color: "#0f172a",
    verticalAlign: "top",
  },
  badge: {
    fontSize: "12px",
    fontWeight: "700",
    padding: "3px 10px",
    borderRadius: "999px",
  },
  textoAuxiliar: {
    padding: "24px",
    textAlign: "center",
    color: "#64748b",
  },
  acaoColuna: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    minWidth: "200px",
  },
  inputAcao: {
    padding: "7px 9px",
    border: "1px solid #cbd5e1",
    borderRadius: "6px",
    fontSize: "12px",
  },
  linkComprovante: {
    fontSize: "12px",
    color: "#0d6efd",
    fontWeight: "700",
  },
  botaoAzul: {
    background: "#0d6efd",
    color: "#fff",
    border: "none",
    padding: "7px 10px",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "700",
    fontSize: "12px",
  },
  botaoAmarelo: {
    background: "#ffc107",
    color: "#111827",
    border: "none",
    padding: "7px 10px",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "700",
    fontSize: "12px",
  },
  botaoCinza: {
    background: "#e5e7eb",
    color: "#111827",
    border: "none",
    padding: "7px 10px",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "700",
    fontSize: "12px",
  },
  card: {
    background: "#fff",
    borderRadius: "14px",
    padding: "20px",
    marginBottom: "14px",
    boxShadow: "0 2px 10px rgba(0,0,0,0.06)",
  },
  topoCard: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
    marginBottom: "10px",
  },
  nomeCard: {
    margin: "0 0 6px",
    color: "#111827",
  },
  infoCard: {
    margin: "4px 0",
    color: "#374151",
    fontSize: "14px",
  },
  blocoCard: {
    marginTop: "12px",
  },
  blocoRetorno: {
    marginTop: "12px",
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "12px",
  },
  paragrafoCard: {
    margin: "6px 0",
    color: "#374151",
    lineHeight: 1.4,
  },
  labelCard: {
    display: "block",
    fontWeight: "bold",
    marginBottom: "6px",
    color: "#111827",
    fontSize: "13px",
  },
  textareaCard: {
    width: "100%",
    minHeight: "60px",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    resize: "vertical",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
  },
  acoesCard: {
    marginTop: "12px",
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  },
  botaoConfirmarCard: {
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "12px 18px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoRejeitarCard: {
    background: "#dc3545",
    color: "#fff",
    border: "none",
    padding: "12px 18px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
};
