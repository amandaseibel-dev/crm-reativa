import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail, podeVerTudo, podeBaixarPagamento } from "../utils/operadores";
import ComprovantePagamento from "../components/ComprovantePagamento";

const STATUS = {
  SOLICITADO: "Solicitado",
  LINK_GERADO: "Link gerado",
  LINK_ENVIADO: "Link enviado",
  PAGO_AGUARDANDO_BAIXA: "Pago - aguardando baixa",
  BAIXADO: "Pagamento baixado",
  CANCELADO: "Cancelado",
  DIVERGENCIA: "Divergência",
};

function dinheiro(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function numeroMoeda(valor) {
  const texto = String(valor || "")
    .replace("R$", "")
    .replace(/\./g, "")
    .replace(",", ".")
    .trim();

  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : 0;
}

function dataHora(valor) {
  if (!valor) return "-";
  try {
    return new Date(valor).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

function dataSimples(valor) {
  if (!valor) return "-";

  const partes = String(valor).split("T")[0].split("-");
  if (partes.length === 3) return `${partes[2]}/${partes[1]}/${partes[0]}`;

  try {
    return new Date(valor).toLocaleDateString("pt-BR");
  } catch {
    return "-";
  }
}

function corStatus(status) {
  if (status === "BAIXADO") return { background: "#d1e7dd", color: "#0f5132", border: "1px solid #badbcc" };
  if (status === "PAGO_AGUARDANDO_BAIXA") return { background: "#cff4fc", color: "#055160", border: "1px solid #b6effb" };
  if (status === "DIVERGENCIA") return { background: "#fff3cd", color: "#664d03", border: "1px solid #ffecb5" };
  if (status === "CANCELADO") return { background: "#f8d7da", color: "#842029", border: "1px solid #f5c2c7" };
  if (status === "LINK_GERADO") return { background: "#e0f2fe", color: "#075985", border: "1px solid #bae6fd" };
  if (status === "LINK_ENVIADO") return { background: "#ede9fe", color: "#5b21b6", border: "1px solid #ddd6fe" };
  return { background: "#e5e7eb", color: "#374151", border: "1px solid #d1d5db" };
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

  const [novo, setNovo] = useState({
    aluno_nome: "",
    aluno_cpf: "",
    tipo_pagamento: "Cartão",
    parcelas: "1",
    valor: "",
    vencimento: "",
    observacao_operador: "",
  });

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
      .order("solicitado_em", { ascending: false });

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
      status_anterior: item.status,
      status_novo: novoStatus,
      observacao,
      usuario_email: usuario?.email || "",
    });
  }

  async function solicitarLink() {
    if (!novo.aluno_nome.trim()) {
      alert("Informe o nome do aluno.");
      return;
    }

    if (!novo.aluno_cpf.trim()) {
      alert("Informe o CPF do aluno.");
      return;
    }

    if (!novo.valor) {
      alert("Informe o valor.");
      return;
    }

    const email = usuario?.email || "";
    const operadorNome = nomeOperadorPorEmail(email);

    const { error } = await supabase.from("links_pagamento").insert({
      aluno_nome: novo.aluno_nome,
      aluno_cpf: novo.aluno_cpf,
      operador_nome: operadorNome,
      operador_email: email,
      tipo_pagamento: novo.tipo_pagamento,
      parcelas: Number(novo.parcelas || 1),
      valor: numeroMoeda(novo.valor),
      vencimento: novo.vencimento || null,
      status: "SOLICITADO",
      observacao_operador: novo.observacao_operador,
      solicitado_por: email,
      solicitado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    });

    if (error) {
      alert("Erro ao solicitar link: " + error.message);
      return;
    }

    alert("Solicitação enviada para geração do link.");

    setNovo({
      aluno_nome: "",
      aluno_cpf: "",
      tipo_pagamento: "Cartão",
      parcelas: "1",
      valor: "",
      vencimento: "",
      observacao_operador: "",
    });

    carregarLinks();
  }

  async function salvarLink(item) {
    const link = linksEditados[item.id];

    if (!link || !link.trim()) {
      alert("Cole o link de pagamento.");
      return;
    }

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        link_url: link,
        status: "LINK_GERADO",
        gerado_por: usuario?.email || "",
        gerado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao salvar link: " + error.message);
      return;
    }

    await historico(item, "LINK_GERADO", "Link gerado/colado pela ADM.");
    alert("Link salvo.");
    carregarLinks();
  }

  async function marcarEnviado(item) {
    const linkAtual = linksEditados[item.id] || item.link_url;

    if (!linkAtual) {
      alert("Antes de marcar como enviado, o link precisa estar salvo.");
      return;
    }

    const obs = observacoes[item.id] || "";

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "LINK_ENVIADO",
        enviado_em: new Date().toISOString(),
        observacao_adm: obs || item.observacao_adm,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao marcar enviado: " + error.message);
      return;
    }

    await historico(item, "LINK_ENVIADO", obs || "Link enviado ao aluno.");
    alert("Marcado como enviado.");
    carregarLinks();
  }

  async function marcarPagoAguardandoBaixa(item) {
    const obs = observacoes[item.id] || "";

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "PAGO_AGUARDANDO_BAIXA",
        pagamento_identificado_por: usuario?.email || "",
        pagamento_identificado_em: new Date().toISOString(),
        observacao_adm: obs || item.observacao_adm,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao enviar para fila de pagamentos: " + error.message);
      return;
    }

    await historico(item, "PAGO_AGUARDANDO_BAIXA", obs || "Pagamento identificado e enviado para baixa.");
    alert("Enviado para Minha Fila de Pagamentos da Amanda.");
    carregarLinks();
  }

  async function cancelar(item) {
    const obs = observacoes[item.id] || "";

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "CANCELADO",
        cancelado_em: new Date().toISOString(),
        observacao_adm: obs || item.observacao_adm,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao cancelar: " + error.message);
      return;
    }

    await historico(item, "CANCELADO", obs || "Cancelado.");
    alert("Cancelado.");
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

  const emailUsuario = usuario?.email || "";
  const nomeUsuario = nomeOperadorPorEmail(emailUsuario);
  const adm = podeVerTudo(emailUsuario);
  const amandaBaixa = podeBaixarPagamento(emailUsuario);

  const listaFiltrada = useMemo(() => {
    let lista = [...links];

    if (!adm && !amandaBaixa) {
      lista = lista.filter(
        (item) =>
          String(item.operador_email || "").toLowerCase() === emailUsuario.toLowerCase() ||
          String(item.solicitado_por || "").toLowerCase() === emailUsuario.toLowerCase()
      );
    }

    if (filtroStatus !== "TODOS") {
      lista = lista.filter((item) => item.status === filtroStatus);
    }

    if (busca.trim()) {
      const termo = busca.toLowerCase().trim();
      lista = lista.filter((item) =>
        [
          item.aluno_nome,
          item.aluno_cpf,
          item.operador_nome,
          item.operador_email,
          item.status,
          item.tipo_pagamento,
        ]
          .join(" ")
          .toLowerCase()
          .includes(termo)
      );
    }

    lista.sort((a, b) => {
      if (ordenacao === "VALOR_DESC") return Number(b.valor || 0) - Number(a.valor || 0);
      if (ordenacao === "VALOR_ASC") return Number(a.valor || 0) - Number(b.valor || 0);
      if (ordenacao === "ALUNO") return String(a.aluno_nome || "").localeCompare(String(b.aluno_nome || ""));
      return new Date(b.solicitado_em || 0) - new Date(a.solicitado_em || 0);
    });

    return lista;
  }, [links, adm, amandaBaixa, emailUsuario, filtroStatus, busca, ordenacao]);

  const indicadores = useMemo(() => {
    return {
      total: listaFiltrada.length,
      solicitado: listaFiltrada.filter((x) => x.status === "SOLICITADO").length,
      gerado: listaFiltrada.filter((x) => x.status === "LINK_GERADO").length,
      enviado: listaFiltrada.filter((x) => x.status === "LINK_ENVIADO").length,
      aguardando: listaFiltrada.filter((x) => x.status === "PAGO_AGUARDANDO_BAIXA").length,
      baixado: listaFiltrada.filter((x) => x.status === "BAIXADO").length,
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
          <h1 style={styles.titulo}>Controle de Links de Pagamento</h1>
          <p style={styles.subtitulo}>
            Operador solicita, ADM gera o link, operador envia, e pagamento identificado vai para a fila da Amanda baixar.
          </p>
          <p style={styles.usuario}>Usuário logado: <strong>{nomeUsuario}</strong></p>
        </div>

        <div style={styles.nav}>
          <button style={styles.botaoEscuro} onClick={() => navigate("/minha-fila")}>Fila Operacional</button>
          <button style={styles.botaoEscuro} onClick={() => navigate("/minha-fila-pagamentos")}>Minha Fila de Pagamentos</button>
          <button style={styles.botaoEscuro} onClick={carregarLinks}>Atualizar</button>
        </div>
      </div>

      <div style={styles.indicadores}>
        <div style={styles.indicador}><strong>{indicadores.total}</strong><span>Total</span></div>
        <div style={styles.indicador}><strong>{indicadores.solicitado}</strong><span>Solicitados</span></div>
        <div style={styles.indicador}><strong>{indicadores.gerado}</strong><span>Gerados</span></div>
        <div style={styles.indicador}><strong>{indicadores.enviado}</strong><span>Enviados</span></div>
        <div style={styles.indicador}><strong>{indicadores.aguardando}</strong><span>Aguardando baixa</span></div>
        <div style={styles.indicadorValor}><strong>{dinheiro(indicadores.valor)}</strong><span>Valor filtrado</span></div>
      </div>

      <div style={styles.card}>
        <h2 style={styles.subtituloCard}>Solicitar novo link</h2>

        <div style={styles.grid}>
          <input style={styles.input} placeholder="Nome do aluno" value={novo.aluno_nome} onChange={(e) => setNovo({ ...novo, aluno_nome: e.target.value })} />
          <input style={styles.input} placeholder="CPF do aluno" value={novo.aluno_cpf} onChange={(e) => setNovo({ ...novo, aluno_cpf: e.target.value })} />

          <select style={styles.input} value={novo.tipo_pagamento} onChange={(e) => setNovo({ ...novo, tipo_pagamento: e.target.value })}>
            <option value="Cartão">Cartão</option>
            <option value="Pix">Pix</option>
            <option value="Boleto">Boleto</option>
            <option value="Outro">Outro</option>
          </select>

          <input style={styles.input} type="number" min="1" placeholder="Parcelas" value={novo.parcelas} onChange={(e) => setNovo({ ...novo, parcelas: e.target.value })} />
          <input style={styles.input} placeholder="Valor. Ex.: 1200,50" value={novo.valor} onChange={(e) => setNovo({ ...novo, valor: e.target.value })} />
          <input style={styles.input} type="date" value={novo.vencimento} onChange={(e) => setNovo({ ...novo, vencimento: e.target.value })} />
        </div>

        <textarea style={styles.textarea} placeholder="Observação do operador para o ADM" value={novo.observacao_operador} onChange={(e) => setNovo({ ...novo, observacao_operador: e.target.value })} />

        <button style={styles.botaoAzul} onClick={solicitarLink}>Solicitar link de pagamento</button>
      </div>

      <div style={styles.card}>
        <h2 style={styles.subtituloCard}>Filtros</h2>

        <div style={styles.grid}>
          <input style={styles.input} placeholder="Buscar por aluno, CPF, operador..." value={busca} onChange={(e) => setBusca(e.target.value)} />

          <select style={styles.input} value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}>
            <option value="TODOS">Todos os status</option>
            <option value="SOLICITADO">Solicitado</option>
            <option value="LINK_GERADO">Link gerado</option>
            <option value="LINK_ENVIADO">Link enviado</option>
            <option value="PAGO_AGUARDANDO_BAIXA">Pago - aguardando baixa</option>
            <option value="BAIXADO">Pagamento baixado</option>
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
        const podeGerar = adm || amandaBaixa;
        const podeEnviar = adm || amandaBaixa || String(item.operador_email || "").toLowerCase() === emailUsuario.toLowerCase();
        const linkAtual = linksEditados[item.id] ?? item.link_url ?? "";

        return (
          <div key={item.id} style={styles.cardLink}>
            <div style={styles.topoCard}>
              <div>
                <h2 style={styles.nome}>{item.aluno_nome || "Aluno sem nome"}</h2>
                <p style={styles.info}><strong>CPF:</strong> {item.aluno_cpf || "-"}</p>
                <p style={styles.info}><strong>Operador:</strong> {item.operador_nome || "-"}</p>
                <p style={styles.info}><strong>Valor:</strong> {dinheiro(item.valor)} | <strong>Parcelas:</strong> {item.parcelas || "-"} | <strong>Tipo:</strong> {item.tipo_pagamento || "-"}</p>
                <p style={styles.info}><strong>Vencimento:</strong> {dataSimples(item.vencimento)}</p>
                <p style={styles.info}><strong>Solicitado em:</strong> {dataHora(item.solicitado_em)}</p>
              </div>

              <span style={{ ...styles.status, ...corStatus(item.status) }}>{STATUS[item.status] || item.status}</span>
            </div>

            {(item.observacao_operador || item.observacao_adm) && (
              <div style={styles.obs}>
                {item.observacao_operador && <p><strong>Obs. operador:</strong> {item.observacao_operador}</p>}
                {item.observacao_adm && <p><strong>Obs. ADM:</strong> {item.observacao_adm}</p>}
              </div>
            )}

            <ComprovantePagamento item={item} onAtualizar={carregarLinks} />

            <div style={styles.gridLink}>
              <input
                style={styles.input}
                placeholder="Link de pagamento"
                value={linkAtual}
                disabled={!podeGerar}
                onChange={(e) => setLinksEditados({ ...linksEditados, [item.id]: e.target.value })}
              />

              {podeGerar && <button style={styles.botaoAzul} onClick={() => salvarLink(item)}>Salvar link</button>}
              <button style={styles.botaoCinza} onClick={() => copiar(linkAtual)}>Copiar</button>
              <button style={styles.botaoCinza} onClick={() => linkAtual ? window.open(linkAtual, "_blank", "noreferrer") : alert("Sem link.")}>Abrir</button>
            </div>

            <textarea
              style={styles.textarea}
              placeholder="Observação para movimentação"
              value={observacoes[item.id] || ""}
              onChange={(e) => setObservacoes({ ...observacoes, [item.id]: e.target.value })}
            />

            <div style={styles.acoes}>
              {podeEnviar && <button style={styles.botaoRoxo} onClick={() => marcarEnviado(item)}>Marcar link enviado</button>}
              {podeGerar && <button style={styles.botaoAzul} onClick={() => marcarPagoAguardandoBaixa(item)}>Pagamento identificado</button>}
              {podeGerar && <button style={styles.botaoVermelho} onClick={() => cancelar(item)}>Cancelar</button>}
            </div>

            <div style={styles.datas}>
              <span>Gerado: {dataHora(item.gerado_em)}</span>
              <span>Enviado: {dataHora(item.enviado_em)}</span>
              <span>Pagamento identificado: {dataHora(item.pagamento_identificado_em)}</span>
              <span>Baixado: {dataHora(item.baixado_em)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  container: { minHeight: "100vh", background: "#f4f6f8", padding: "24px", fontFamily: "Arial, sans-serif" },
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
  acoes: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" },
  datas: { display: "flex", flexWrap: "wrap", gap: "12px", color: "#6b7280", fontSize: "12px", marginTop: "12px" },
  botaoEscuro: { background: "#111827", color: "#fff", border: "none", padding: "10px 13px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoAzul: { background: "#0d6efd", color: "#fff", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoRoxo: { background: "#6f42c1", color: "#fff", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoVermelho: { background: "#dc3545", color: "#fff", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoCinza: { background: "#e5e7eb", color: "#111827", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  vazio: { background: "#fff", padding: "18px", borderRadius: "10px" },
};
