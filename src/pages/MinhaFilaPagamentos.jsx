import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { podeBaixarPagamento } from "../utils/operadores";
import ComprovantePagamento from "../components/ComprovantePagamento";

const STATUS = {
  PAGO_AGUARDANDO_BAIXA: "Pago - aguardando baixa",
  BAIXADO: "Pagamento baixado",
  DIVERGENCIA: "Divergência",
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
  if (status === "BAIXA_REALIZADA") return { background: "#d1e7dd", color: "#0f5132", border: "1px solid #badbcc" };
  if (status === "BAIXA_DEVOLVIDA") return { background: "#fff3cd", color: "#664d03", border: "1px solid #ffecb5" };
  return { background: "#cff4fc", color: "#055160", border: "1px solid #b6effb" };
}

export default function MinhaFilaPagamentos() {
  const navigate = useNavigate();

  const [usuario, setUsuario] = useState(null);
  const [links, setLinks] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState("AGUARDANDO_BAIXA");
  const [observacoes, setObservacoes] = useState({});

  useEffect(() => {
    carregarUsuario();
    carregarPagamentos();
  }, []);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarPagamentos() {
    setCarregando(true);

    const { data, error } = await supabase
      .from("links_pagamento")
      .select("*")
      .in("status", ["AGUARDANDO_BAIXA", "BAIXA_REALIZADA", "BAIXA_DEVOLVIDA"])
      .order("pagamento_identificado_em", { ascending: false });

    if (error) {
      alert("Erro ao carregar fila de pagamentos: " + error.message);
      setCarregando(false);
      return;
    }

    setLinks(data || []);
    setCarregando(false);
  }

  async function registrarHistorico(item, novoStatus, observacao = "") {
    await supabase.from("historico_links_pagamento").insert({
      link_pagamento_id: item.id,
      status_anterior: item.status,
      status_novo: novoStatus,
      observacao,
      usuario_email: usuario?.email || "",
    });
  }

  async function baixarPagamento(item) {
    const observacao = observacoes[item.id] || "Pagamento conferido e baixado.";

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "BAIXA_REALIZADA",
        baixado_por: usuario?.email || "",
        baixado_em: new Date().toISOString(),
        observacao_adm: observacao,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao baixar pagamento: " + error.message);
      return;
    }

    // Reflete a baixa também na ficha do aluno, para que o contador de
    // "casos finalizados" do operador na fila fique correto.
    if (item?.aluno_id) {
      const agora = new Date().toISOString();

      await supabase
        .from("alunos")
        .update({
          status_jornada: "BAIXA_REALIZADA",
          status_atual: "BAIXA_REALIZADA",
          status_acionamento: "BAIXA_REALIZADA",
          registrado_em: agora,
          data_ultimo_acionamento: agora,
        })
        .eq("id", item.aluno_id);
    }

    await registrarHistorico(item, "BAIXA_REALIZADA", observacao);
    alert("Pagamento baixado.");
    carregarPagamentos();
  }

  async function marcarDivergencia(item) {
    const motivo = observacoes[item.id];

    if (!motivo || !motivo.trim()) {
      alert("Informe o motivo da divergência.");
      return;
    }

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "BAIXA_DEVOLVIDA",
        divergencia_motivo: motivo,
        divergencia_em: new Date().toISOString(),
        observacao_adm: motivo,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao marcar divergência: " + error.message);
      return;
    }

    await registrarHistorico(item, "BAIXA_DEVOLVIDA", motivo);
    alert("Divergência registrada.");
    carregarPagamentos();
  }

  const email = usuario?.email || "";
  const podeBaixar = podeBaixarPagamento(email);

  const lista = useMemo(() => {
    let filtrada = [...links];

    if (filtro !== "TODOS") {
      filtrada = filtrada.filter((item) => item.status === filtro);
    }

    if (busca.trim()) {
      const termo = busca.toLowerCase().trim();

      filtrada = filtrada.filter((item) =>
        [
          item.aluno_nome,
          item.aluno_cpf,
          item.operador_nome,
          item.operador_email,
          item.status,
        ]
          .join(" ")
          .toLowerCase()
          .includes(termo)
      );
    }

    return filtrada;
  }, [links, filtro, busca]);

  const indicadores = useMemo(() => {
    return {
      aguardando: links.filter((x) => x.status === "AGUARDANDO_BAIXA").length,
      baixados: links.filter((x) => x.status === "BAIXA_REALIZADA").length,
      divergencias: links.filter((x) => x.status === "BAIXA_DEVOLVIDA").length,
      valor: lista.reduce((soma, item) => soma + Number(item.valor || 0), 0),
    };
  }, [links, lista]);

  if (carregando) {
    return <div style={styles.container}>Carregando Minha Fila de Pagamentos...</div>;
  }

  if (!podeBaixar) {
    return (
      <div style={styles.container}>
        <h1 style={styles.titulo}>Minha Fila de Pagamentos</h1>
        <div style={styles.alerta}>Somente Amanda gestora pode baixar pagamentos nesta fila.</div>
        <p>Usuário logado: <strong>{email || "não identificado"}</strong></p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Minha Fila de Pagamentos</h1>
          <p style={styles.subtitulo}>Pagamentos identificados aguardando conferência e baixa.</p>
        </div>

        <div style={styles.nav}>
          <button style={styles.botaoEscuro} onClick={() => navigate("/controle-links-pagamento")}>Controle de Links</button>
          <button style={styles.botaoEscuro} onClick={carregarPagamentos}>Atualizar</button>
        </div>
      </div>

      <div style={styles.indicadores}>
        <div style={styles.indicador}><strong>{indicadores.aguardando}</strong><span>Aguardando baixa</span></div>
        <div style={styles.indicador}><strong>{indicadores.baixados}</strong><span>Baixados</span></div>
        <div style={styles.indicador}><strong>{indicadores.divergencias}</strong><span>Divergências</span></div>
        <div style={styles.indicadorValor}><strong>{dinheiro(indicadores.valor)}</strong><span>Valor filtrado</span></div>
      </div>

      <div style={styles.card}>
        <div style={styles.grid}>
          <input style={styles.input} placeholder="Buscar por aluno, CPF ou operador..." value={busca} onChange={(e) => setBusca(e.target.value)} />

          <select style={styles.input} value={filtro} onChange={(e) => setFiltro(e.target.value)}>
            <option value="AGUARDANDO_BAIXA">Aguardando baixa</option>
            <option value="BAIXA_REALIZADA">Baixados</option>
            <option value="BAIXA_DEVOLVIDA">Divergências</option>
            <option value="TODOS">Todos</option>
          </select>
        </div>
      </div>

      {lista.length === 0 && <div style={styles.vazio}>Nenhum pagamento encontrado neste filtro.</div>}

      {lista.map((item) => (
        <div key={item.id} style={styles.cardPagamento}>
          <div style={styles.topoCard}>
            <div>
              <h2 style={styles.nome}>{item.aluno_nome || "Aluno sem nome"}</h2>
              <p style={styles.info}><strong>CPF:</strong> {item.aluno_cpf || "-"}</p>
              <p style={styles.info}><strong>Operador:</strong> {item.operador_nome || "-"}</p>
              <p style={styles.info}><strong>Valor:</strong> {dinheiro(item.valor)} | <strong>Parcelas:</strong> {item.parcelas || "-"}</p>
              <p style={styles.info}><strong>Pagamento identificado em:</strong> {dataHora(item.pagamento_identificado_em)}</p>
              <p style={styles.info}><strong>Baixado em:</strong> {dataHora(item.baixado_em)}</p>
            </div>

            <span style={{ ...styles.status, ...corStatus(item.status) }}>{STATUS[item.status] || item.status}</span>
          </div>

          {item.link_url && (
            <div style={styles.linkBox}>
              <a href={item.link_url} target="_blank" rel="noreferrer">Abrir link de pagamento</a>
            </div>
          )}

          {(item.observacao_operador || item.observacao_adm || item.divergencia_motivo) && (
            <div style={styles.obs}>
              {item.observacao_operador && <p><strong>Obs. operador:</strong> {item.observacao_operador}</p>}
              {item.observacao_adm && <p><strong>Obs. ADM:</strong> {item.observacao_adm}</p>}
              {item.divergencia_motivo && <p><strong>Divergência:</strong> {item.divergencia_motivo}</p>}
            </div>
          )}

          <ComprovantePagamento item={item} onAtualizar={carregarPagamentos} />

          <textarea
            style={styles.textarea}
            placeholder="Observação da baixa ou motivo da divergência"
            value={observacoes[item.id] || ""}
            onChange={(e) => setObservacoes({ ...observacoes, [item.id]: e.target.value })}
          />

          <div style={styles.acoes}>
            <button style={styles.botaoVerde} onClick={() => baixarPagamento(item)}>Baixar pagamento</button>
            <button style={styles.botaoAmarelo} onClick={() => marcarDivergencia(item)}>Marcar divergência</button>
          </div>
        </div>
      ))}
    </div>
  );
}

const styles = {
  container: { minHeight: "100vh", background: "#f4f6f8", padding: "24px", fontFamily: "Arial, sans-serif" },
  cabecalho: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", marginBottom: "18px" },
  titulo: { margin: 0, color: "#111827" },
  subtitulo: { margin: "6px 0 0 0", color: "#555" },
  nav: { display: "flex", gap: "8px", flexWrap: "wrap" },
  indicadores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px", marginBottom: "16px" },
  indicador: { background: "#fff", borderRadius: "14px", padding: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  indicadorValor: { background: "#111827", color: "#fff", borderRadius: "14px", padding: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  card: { background: "#fff", borderRadius: "14px", padding: "18px", marginBottom: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "10px" },
  input: { padding: "11px", borderRadius: "8px", border: "1px solid #d1d5db", fontSize: "14px" },
  cardPagamento: { background: "#fff", borderRadius: "16px", padding: "20px", marginBottom: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.08)", borderLeft: "6px solid #198754" },
  topoCard: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start" },
  nome: { margin: "0 0 8px 0", color: "#111827" },
  info: { margin: "5px 0", color: "#555" },
  status: { padding: "8px 12px", borderRadius: "999px", fontWeight: "bold", fontSize: "13px", whiteSpace: "nowrap" },
  linkBox: { background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "12px", marginTop: "14px" },
  obs: { background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "12px", marginTop: "14px", color: "#374151" },
  textarea: { width: "100%", minHeight: "70px", marginTop: "10px", padding: "11px", borderRadius: "8px", border: "1px solid #d1d5db", boxSizing: "border-box", fontFamily: "Arial, sans-serif" },
  acoes: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" },
  botaoEscuro: { background: "#111827", color: "#fff", border: "none", padding: "10px 13px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoVerde: { background: "#198754", color: "#fff", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoAmarelo: { background: "#ffc107", color: "#111827", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  alerta: { background: "#fff3cd", border: "1px solid #ffe69c", color: "#664d03", padding: "14px", borderRadius: "8px", marginTop: "14px" },
  vazio: { background: "#fff", padding: "18px", borderRadius: "10px" },
};
