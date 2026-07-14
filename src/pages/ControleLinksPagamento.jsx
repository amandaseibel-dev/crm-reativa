import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail, podeVerTudo, podeBaixarPagamento } from "../utils/operadores";

const STATUS = {
  SOLICITADO_LINK: "Solicitado link",
  LINK_GERADO: "Link gerado",
  LINK_PRONTO_PARA_ENVIO: "Link gerado",
  LINK_ENVIADO_ALUNO: "Link enviado ao aluno",
  LINK_ENVIADO_AO_ALUNO: "Link enviado ao aluno",
  COMPROVANTE_ANEXADO: "Comprovante anexado",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_CONCLUIDA: "Baixa concluída",
  BAIXA_REALIZADA: "Baixa concluída",
  DIVERGENCIA: "Divergência",
  CANCELADO: "Cancelado",

  SOLICITADO: "Solicitado link",
  LINK_ENVIADO: "Link enviado",
  PAGO_AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXADO: "Baixa concluída",
};

function dinheiro(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function dataHora(valor) {
  if (!valor) return "-";
  try {
    return new Date(valor).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

function corStatus(status) {
  if (status === "BAIXA_CONCLUIDA" || status === "BAIXA_REALIZADA" || status === "BAIXADO") {
    return { background: "#d1e7dd", color: "#0f5132", border: "1px solid #badbcc" };
  }

  if (status === "AGUARDANDO_BAIXA" || status === "PAGO_AGUARDANDO_BAIXA") {
    return { background: "#cff4fc", color: "#055160", border: "1px solid #b6effb" };
  }

  if (status === "DIVERGENCIA") {
    return { background: "#fff3cd", color: "#664d03", border: "1px solid #ffecb5" };
  }

  if (status === "CANCELADO") {
    return { background: "#f8d7da", color: "#842029", border: "1px solid #f5c2c7" };
  }

  if (status === "LINK_GERADO" || status === "LINK_PRONTO_PARA_ENVIO") {
    return { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  }

  if (status === "LINK_ENVIADO_ALUNO" || status === "LINK_ENVIADO_AO_ALUNO" || status === "LINK_ENVIADO") {
    return { background: "#ede9fe", color: "#5b21b6", border: "1px solid #ddd6fe" };
  }

  if (status === "SOLICITADO_LINK" || status === "SOLICITADO") {
    return { background: "#e0f2fe", color: "#075985", border: "1px solid #bae6fd" };
  }

  return { background: "#e5e7eb", color: "#374151", border: "1px solid #d1d5db" };
}

function podeGerarLink(email) {
  const e = String(email || "").toLowerCase();

  return (
    podeVerTudo(e) ||
    e === "cobranca04@aelbra.com.br" ||
    e === "amanda.seibel@aelbra.com.br" ||
    e === "cobranca07@aelbra.com.br"
  );
}

function podeFazerBaixa(email) {
  const e = String(email || "").toLowerCase();

  return (
    podeBaixarPagamento(e) ||
    e === "amanda.seibel@aelbra.com.br" ||
    e === "cobranca07@aelbra.com.br"
  );
}

export default function ControleLinksPagamento() {
  const navigate = useNavigate();

  const [usuario, setUsuario] = useState(null);
  const [links, setLinks] = useState([]);
  const [carregando, setCarregando] = useState(true);

  const [busca, setBusca] = useState("");
  const [filtroStatus, setFiltroStatus] = useState("TODOS");
  const [ordenacao, setOrdenacao] = useState("RECENTE");

  const [linksEditados, setLinksEditados] = useState({});
  const [observacoes, setObservacoes] = useState({});

  useEffect(() => {
    carregarUsuario();
    carregarLinks();
  }, []);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarLinks() {
    setCarregando(true);

    const { data, error } = await supabase
      .from("links_pagamento")
      .select("*")
      .order("criado_em", { ascending: false });

    if (error) {
      alert("Erro ao carregar links: " + error.message);
      setCarregando(false);
      return;
    }

    setLinks(data || []);
    setCarregando(false);
  }

  async function historico(item, novoStatus, observacao = "") {
    await supabase.from("historico_links_pagamento").insert({
      link_pagamento_id: item.id,
      chave_unificacao: item.chave_unificacao,
      nome_aluno: item.nome_aluno,
      cpf_referencia: item.cpf_referencia,
      status_anterior: item.status,
      status_novo: novoStatus,
      observacao,
      usuario_nome: nomeUsuario,
      usuario_email: emailUsuario,
    });
  }

  async function salvarLink(item) {
    // Se a aba ficou muito tempo parada, o token pode ter expirado sem o
    // refresh automático rodar a tempo -- isso gerava "row-level security
    // policy" em vez do erro real. Forçar checagem antes de escrever.
    try {
      await supabase.auth.getSession();
    } catch {
      // Segue e deixa o erro real aparecer, se houver.
    }

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
        link_gerado_por: emailUsuario,
        link_gerado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao salvar link: " + error.message);
      return;
    }

    // Link pronto volta pro operador com prioridade máxima -- a Fila
    // Operacional bota nivel_criticidade "URGENTE" sempre no topo, na
    // frente até da ordenação normal por tempo sem acionamento.
    if (item.aluno_id) {
      await supabase
        .from("alunos")
        .update({
          nivel_criticidade: "URGENTE",
          status_acionamento: "Link pronto para envio",
        })
        .eq("id", item.aluno_id);
    }

    await historico(item, "LINK_PRONTO_PARA_ENVIO", "Link gerado/colado pela Fernanda/ADM.");
    alert("Link salvo. O operador será sinalizado como link pronto e o caso vai pro topo da fila dele.");
    carregarLinks();
  }

  async function concluirBaixa(item) {
    const obs = observacoes[item.id] || "";

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "BAIXA_REALIZADA",
        baixa_realizada_por: emailUsuario,
        baixa_realizada_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao concluir baixa: " + error.message);
      return;
    }

    await historico(item, "BAIXA_REALIZADA", obs || "Baixa concluída pela Amanda ADM.");
    alert("Baixa concluída. O operador será sinalizado.");
    carregarLinks();
  }

  async function marcarDivergencia(item) {
    const motivo = observacoes[item.id] || "";

    if (!motivo.trim()) {
      alert("Informe o motivo da divergência no campo de observação.");
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

    await historico(item, "DIVERGENCIA", motivo);
    alert("Divergência registrada. O operador será sinalizado.");
    carregarLinks();
  }

  async function cancelar(item) {
    const confirmar = window.confirm("Deseja cancelar esta solicitação?");
    if (!confirmar) return;

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "CANCELADO",
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao cancelar: " + error.message);
      return;
    }

    await historico(item, "CANCELADO", "Solicitação cancelada.");
    alert("Solicitação cancelada.");
    carregarLinks();
  }

  async function copiar(link) {
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

  function abrirCadastroAluno(item) {
    const alunoSelecionado = {
      chave_unificacao: item.chave_unificacao || "",
      nome: item.nome_aluno || "Aluno sem nome",
      nome_aluno: item.nome_aluno || "Aluno sem nome",
      cpf: item.cpf_referencia || "",
      cpf_mascarado: item.cpf_referencia || "",
      valor_em_aberto: item.valor || 0,
      valor_total: item.valor || 0,
      operador: item.operador_nome || "",
      operador_nome: item.operador_nome || "",
      operador_email: item.operador_email || "",
      status_atual: item.status || "",
      observacao_operacional: item.observacao_solicitacao || "",
    };

    localStorage.setItem("alunoSelecionado", JSON.stringify(alunoSelecionado));
    window.location.href = "/aluno";
  }

  const emailUsuario = usuario?.email || "";
  const nomeUsuario = nomeOperadorPorEmail(emailUsuario);
  const adm = podeVerTudo(emailUsuario);
  const usuarioGeraLink = podeGerarLink(emailUsuario);
  const usuarioBaixa = podeFazerBaixa(emailUsuario);

  const listaFiltrada = useMemo(() => {
    let lista = [...links];

    if (!adm && !usuarioGeraLink && !usuarioBaixa) {
      lista = lista.filter(
        (item) => String(item.operador_email || "").toLowerCase() === emailUsuario.toLowerCase()
      );
    }

    if (filtroStatus !== "TODOS") {
      lista = lista.filter((item) => item.status === filtroStatus);
    }

    if (busca.trim()) {
      const termo = busca.toLowerCase().trim();

      lista = lista.filter((item) =>
        [
          item.nome_aluno,
          item.aluno_nome,
          item.cpf_referencia,
          item.aluno_cpf,
          item.operador_nome,
          item.operador_email,
          item.status,
          item.forma_pagamento,
          item.observacao_solicitacao,
          item.motivo_divergencia,
        ]
          .join(" ")
          .toLowerCase()
          .includes(termo)
      );
    }

    lista.sort((a, b) => {
      if (ordenacao === "VALOR_DESC") return Number(b.valor || 0) - Number(a.valor || 0);
      if (ordenacao === "VALOR_ASC") return Number(a.valor || 0) - Number(b.valor || 0);
      if (ordenacao === "ALUNO") return String(a.nome_aluno || "").localeCompare(String(b.nome_aluno || ""));
      return new Date(b.criado_em || 0) - new Date(a.criado_em || 0);
    });

    return lista;
  }, [links, adm, usuarioGeraLink, usuarioBaixa, emailUsuario, filtroStatus, busca, ordenacao]);

  const indicadores = useMemo(() => {
    return {
      total: listaFiltrada.length,
      solicitados: listaFiltrada.filter((x) => x.status === "SOLICITADO_LINK").length,
      gerados: listaFiltrada.filter((x) => x.status === "LINK_GERADO" || x.status === "LINK_PRONTO_PARA_ENVIO").length,
      aguardandoBaixa: listaFiltrada.filter((x) => x.status === "AGUARDANDO_BAIXA").length,
      concluidas: listaFiltrada.filter((x) => x.status === "BAIXA_CONCLUIDA" || x.status === "BAIXA_REALIZADA").length,
      divergencias: listaFiltrada.filter((x) => x.status === "DIVERGENCIA").length,
      valor: listaFiltrada.reduce((soma, item) => soma + Number(item.valor || 0), 0),
    };
  }, [listaFiltrada]);

  if (carregando) {
    return <div style={styles.container}>Carregando links de pagamento...</div>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Fila de Links de Pagamento</h1>
          <p style={styles.subtitulo}>
            Fernanda gera links solicitados. Amanda ADM acompanha comprovantes em aguardando baixa.
          </p>
          <p style={styles.usuario}>
            Usuário logado: <strong>{nomeUsuario}</strong> — {emailUsuario}
          </p>
        </div>

        <div style={styles.nav}>
          <button style={styles.botaoEscuro} onClick={() => navigate("/minha-fila")}>
            Fila Operacional
          </button>
          <button style={styles.botaoEscuro} onClick={carregarLinks}>
            Atualizar
          </button>
        </div>
      </div>

      <div style={styles.indicadores}>
        <div style={styles.indicador}><strong>{indicadores.total}</strong><span>Total filtrado</span></div>
        <div style={styles.indicador}><strong>{indicadores.solicitados}</strong><span>Solicitados</span></div>
        <div style={styles.indicador}><strong>{indicadores.gerados}</strong><span>Links gerados</span></div>
        <div style={styles.indicador}><strong>{indicadores.aguardandoBaixa}</strong><span>Aguardando baixa</span></div>
        <div style={styles.indicador}><strong>{indicadores.concluidas}</strong><span>Baixas concluídas</span></div>
        <div style={styles.indicador}><strong>{indicadores.divergencias}</strong><span>Divergências</span></div>
        <div style={styles.indicadorValor}><strong>{dinheiro(indicadores.valor)}</strong><span>Valor filtrado</span></div>
      </div>

      <div style={styles.card}>
        <h2 style={styles.subtituloCard}>Filtros</h2>

        <div style={styles.grid}>
          <input
            style={styles.input}
            placeholder="Buscar por aluno, CPF, operador, status ou observação..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />

          <select style={styles.input} value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}>
            <option value="TODOS">Todos os status</option>
            <option value="SOLICITADO_LINK">Solicitados para gerar link</option>
            <option value="LINK_PRONTO_PARA_ENVIO">Link gerado</option>
            <option value="LINK_ENVIADO_AO_ALUNO">Link enviado ao aluno</option>
            <option value="AGUARDANDO_BAIXA">Aguardando baixa</option>
            <option value="BAIXA_REALIZADA">Baixa concluída</option>
            <option value="DIVERGENCIA">Divergência</option>
            <option value="CANCELADO">Cancelado</option>
          </select>

          <select style={styles.input} value={ordenacao} onChange={(e) => setOrdenacao(e.target.value)}>
            <option value="RECENTE">Mais recentes</option>
            <option value="VALOR_DESC">Maior valor primeiro</option>
            <option value="VALOR_ASC">Menor valor primeiro</option>
            <option value="ALUNO">Aluno A-Z</option>
          </select>
        </div>
      </div>

      {listaFiltrada.length === 0 && <div style={styles.vazio}>Nenhum link encontrado.</div>}

      {listaFiltrada.map((item) => {
        const linkAtual = linksEditados[item.id] ?? item.link_gerado ?? "";
        const podeSalvarLink = usuarioGeraLink;
        const podeBaixar = usuarioBaixa;

        return (
          <div key={item.id} style={styles.cardLink}>
            <div style={styles.topoCard}>
              <div>
                <h2 style={styles.nome}>{item.nome_aluno || item.aluno_nome || "Aluno sem nome"}</h2>
                <p style={styles.info}><strong>CPF:</strong> {item.cpf_referencia || item.aluno_cpf || "-"}</p>
                <p style={styles.info}><strong>Operador solicitante:</strong> {item.operador_nome || "-"} | {item.operador_email || "-"}</p>
                <p style={styles.info}>
                  <strong>Valor:</strong> {dinheiro(item.valor)} |{" "}
                  <strong>Parcelas:</strong> {item.parcelas || "-"} |{" "}
                  <strong>Forma:</strong> {item.forma_pagamento || item.tipo_pagamento || "-"}
                </p>
                <p style={styles.info}><strong>Solicitado em:</strong> {dataHora(item.criado_em || item.solicitado_em)}</p>
              </div>

              <span style={{ ...styles.status, ...corStatus(item.status) }}>
                {STATUS[item.status] || item.status}
              </span>
            </div>

            {(item.observacao_solicitacao || item.motivo_divergencia) && (
              <div style={styles.obs}>
                {item.observacao_solicitacao && (
                  <p><strong>Obs. solicitação:</strong> {item.observacao_solicitacao}</p>
                )}

                {item.motivo_divergencia && (
                  <p><strong>Divergência:</strong> {item.motivo_divergencia}</p>
                )}
              </div>
            )}

            <div style={styles.gridLink}>
              <input
                style={styles.input}
                placeholder="Campo da Fernanda: cole aqui o link gerado"
                value={linkAtual}
                disabled={!podeSalvarLink}
                onChange={(e) => setLinksEditados({ ...linksEditados, [item.id]: e.target.value })}
              />

              {podeSalvarLink && (
                <button style={styles.botaoAzul} onClick={() => salvarLink(item)}>
                  Salvar link
                </button>
              )}

              <button style={styles.botaoCinza} onClick={() => copiar(linkAtual)}>
                Copiar
              </button>

              <button
                style={styles.botaoCinza}
                onClick={() =>
                  linkAtual ? window.open(linkAtual, "_blank", "noreferrer") : alert("Sem link.")
                }
              >
                Abrir link
              </button>
            </div>

            {item.comprovante_url && (
              <div style={styles.comprovanteBox}>
                <div>
                  <strong>Comprovante anexado:</strong>{" "}
                  {item.comprovante_nome || "Arquivo"}
                  <br />
                  <span>Enviado em: {dataHora(item.comprovante_anexado_em)}</span>
                </div>

                <button
                  style={styles.botaoCinza}
                  onClick={() => window.open(item.comprovante_url, "_blank", "noreferrer")}
                >
                  Abrir comprovante
                </button>
              </div>
            )}

            <textarea
              style={styles.textarea}
              placeholder="Observação para baixa, divergência ou movimentação"
              value={observacoes[item.id] || ""}
              onChange={(e) => setObservacoes({ ...observacoes, [item.id]: e.target.value })}
            />

            <div style={styles.acoes}>
              <button style={styles.botaoEscuro} onClick={() => abrirCadastroAluno(item)}>
                Abrir cadastro do aluno
              </button>

              {podeBaixar && (
                <>
                  <button style={styles.botaoAzul} onClick={() => concluirBaixa(item)}>
                    Baixa concluída
                  </button>

                  <button style={styles.botaoAmarelo} onClick={() => marcarDivergencia(item)}>
                    Divergência
                  </button>
                </>
              )}

              {podeSalvarLink && (
                <button style={styles.botaoVermelho} onClick={() => cancelar(item)}>
                  Cancelar
                </button>
              )}
            </div>

            <div style={styles.datas}>
              <span>Link gerado: {dataHora(item.link_gerado_em)}</span>
              <span>Enviado ao aluno: {dataHora(item.enviado_ao_aluno_em)}</span>
              <span>Comprovante: {dataHora(item.comprovante_anexado_em)}</span>
              <span>Baixa: {dataHora(item.baixa_realizada_em)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  container: { minHeight: "100%", background: "#f4f6f8", padding: "24px", fontFamily: "Arial, sans-serif" },
  cabecalho: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", marginBottom: "18px" },
  titulo: { margin: 0, color: "#111827" },
  subtitulo: { margin: "6px 0 0 0", color: "#555" },
  usuario: { margin: "8px 0 0 0", color: "#374151" },
  nav: { display: "flex", gap: "8px", flexWrap: "wrap" },
  indicadores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px", marginBottom: "16px" },
  indicador: { background: "#fff", borderRadius: "14px", padding: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  indicadorValor: { background: "#111827", color: "#fff", borderRadius: "14px", padding: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  card: { background: "#fff", borderRadius: "14px", padding: "18px", marginBottom: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  cardLink: { background: "#fff", borderRadius: "16px", padding: "20px", marginBottom: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.08)", borderLeft: "6px solid #111827" },
  subtituloCard: { margin: "0 0 12px 0", color: "#111827" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" },
  gridLink: { display: "grid", gridTemplateColumns: "minmax(250px, 1fr) repeat(3, auto)", gap: "8px", alignItems: "center", marginTop: "14px" },
  input: { padding: "11px", borderRadius: "8px", border: "1px solid #d1d5db", fontSize: "14px" },
  textarea: { width: "100%", minHeight: "70px", marginTop: "10px", padding: "11px", borderRadius: "8px", border: "1px solid #d1d5db", boxSizing: "border-box", fontFamily: "Arial, sans-serif" },
  topoCard: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start" },
  nome: { margin: "0 0 8px 0", color: "#111827" },
  info: { margin: "5px 0", color: "#555" },
  status: { padding: "8px 12px", borderRadius: "999px", fontWeight: "bold", fontSize: "13px", whiteSpace: "nowrap" },
  obs: { background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "12px", marginTop: "14px", color: "#374151" },
  comprovanteBox: { background: "#ecfdf5", border: "1px solid #bbf7d0", borderRadius: "10px", padding: "12px", marginTop: "14px", display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", flexWrap: "wrap" },
  acoes: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" },
  datas: { display: "flex", flexWrap: "wrap", gap: "12px", color: "#6b7280", fontSize: "12px", marginTop: "12px" },
  botaoEscuro: { background: "#111827", color: "#fff", border: "none", padding: "10px 13px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoAzul: { background: "#0d6efd", color: "#fff", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoAmarelo: { background: "#ffc107", color: "#111827", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoVermelho: { background: "#dc3545", color: "#fff", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoCinza: { background: "#e5e7eb", color: "#111827", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  vazio: { background: "#fff", padding: "18px", borderRadius: "10px" },
};
