import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { podeBaixarPagamento } from "../utils/operadores";

function dinheiro(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function dataBR(valor) {
  if (!valor) return "-";
  try {
    const texto = String(valor);
    if (/^\d{4}-\d{2}-\d{2}/.test(texto)) {
      const p = texto.split("T")[0].split("-");
      return `${p[2]}/${p[1]}/${p[0]}`;
    }
    return new Date(valor).toLocaleDateString("pt-BR");
  } catch {
    return "-";
  }
}

export default function MinhaFilaQuitacao() {
  const navigate = useNavigate();

  const [usuario, setUsuario] = useState(null);
  const [baixas, setBaixas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState("PENDENTE");
  const [observacoes, setObservacoes] = useState({});

  useEffect(() => {
    carregarUsuario();
    carregarBaixas();
  }, []);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarBaixas() {
    setCarregando(true);

    const { data, error } = await supabase
      .from("baixas_importadas")
      .select("*")
      .order("criado_em", { ascending: false })
      .limit(1000);

    if (error) {
      alert("Erro ao carregar fila de quitação: " + error.message);
      setCarregando(false);
      return;
    }

    setBaixas(data || []);
    setCarregando(false);
  }

  async function registrarHistorico(baixa, tipo, observacao) {
    await supabase.from("historico_alteracoes_crm").insert({
      chave_unificacao: baixa.chave_unificacao || null,
      baixa_importada_id: baixa.id,
      caso_registro_unico: baixa.caso_registro_unico || null,
      tipo_alteracao: tipo,
      observacao,
      usuario_email: usuario?.email || "",
    });
  }

  async function aprovarQuitacao(baixa) {
    const obs = observacoes[baixa.id] || "Quitação aprovada pela Amanda.";

    const { error: baixaError } = await supabase
      .from("baixas_importadas")
      .update({
        acao_quitacao: "APROVADA",
        status_cruzamento: "QUITACAO_APROVADA",
        aprovado_por: usuario?.email || "",
        aprovado_em: new Date().toISOString(),
        observacao: obs,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", baixa.id);

    if (baixaError) {
      alert("Erro ao aprovar quitação: " + baixaError.message);
      return;
    }

    if (baixa.caso_registro_unico) {
      const { error: casoError } = await supabase
        .from("casos")
        .update({
          status_financeiro: "QUITADO_PLANILHA",
          origem_quitacao: baixa.origem_arquivo || "PLANILHA",
          quitado_em: baixa.data_pagamento || null,
          valor_quitado: baixa.valor_pago || 0,
          baixa_importada_id: baixa.id,
          observacao_financeira: obs,
        })
        .eq("registro_unico", baixa.caso_registro_unico);

      if (casoError) {
        alert("A quitação foi aprovada, mas houve erro ao marcar o caso: " + casoError.message);
        return;
      }
    }

    await registrarHistorico(baixa, "QUITACAO_APROVADA", obs);

    alert("Quitação aprovada.");
    carregarBaixas();
  }

  async function rejeitarQuitacao(baixa) {
    const motivo = observacoes[baixa.id];

    if (!motivo || !motivo.trim()) {
      alert("Informe o motivo da rejeição/revisão.");
      return;
    }

    const { error } = await supabase
      .from("baixas_importadas")
      .update({
        acao_quitacao: "REJEITADA",
        status_cruzamento: "REJEITADA",
        rejeitado_por: usuario?.email || "",
        rejeitado_em: new Date().toISOString(),
        motivo_revisao: motivo,
        observacao: motivo,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", baixa.id);

    if (error) {
      alert("Erro ao rejeitar quitação: " + error.message);
      return;
    }

    await registrarHistorico(baixa, "QUITACAO_REJEITADA", motivo);

    alert("Quitação rejeitada/marcada para revisão.");
    carregarBaixas();
  }

  const lista = useMemo(() => {
    let filtrada = [...baixas];

    if (filtro !== "TODOS") {
      filtrada = filtrada.filter((item) => String(item.acao_quitacao || "PENDENTE") === filtro);
    }

    if (busca.trim()) {
      const termo = busca.toLowerCase().trim();

      filtrada = filtrada.filter((item) =>
        [
          item.nome_aluno,
          item.nome_referencia,
          item.cpf_original,
          item.cpf_corrigido,
          item.chave_unificacao,
          item.status_cruzamento,
          item.origem_arquivo,
        ]
          .join(" ")
          .toLowerCase()
          .includes(termo)
      );
    }

    return filtrada;
  }, [baixas, filtro, busca]);

  const indicadores = useMemo(() => {
    return {
      pendentes: baixas.filter((x) => String(x.acao_quitacao || "PENDENTE") === "PENDENTE").length,
      aprovadas: baixas.filter((x) => x.acao_quitacao === "APROVADA").length,
      rejeitadas: baixas.filter((x) => x.acao_quitacao === "REJEITADA").length,
      revisar: baixas.filter((x) => String(x.status_cruzamento || "").includes("REVISAR") || String(x.status_cruzamento || "").includes("DIVERGENCIA")).length,
      valor: lista.reduce((soma, item) => soma + Number(item.valor_pago || 0), 0),
    };
  }, [baixas, lista]);

  if (carregando) {
    return <div style={styles.container}>Carregando Minha Fila de Quitação...</div>;
  }

  const emailUsuario = usuario?.email || "";
  const podeAprovarQuitacao = podeBaixarPagamento(emailUsuario);

  if (!podeAprovarQuitacao) {
    return (
      <div style={styles.container}>
        <h1 style={styles.titulo}>Minha Fila de Quitação</h1>
        <div style={styles.vazio}>
          Somente Amanda gestora pode aprovar ou rejeitar quitações.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Minha Fila de Quitação</h1>
          <p style={styles.subtitulo}>
            Revisão e aprovação das baixas importadas da planilha antes de retirar casos da cobrança.
          </p>
        </div>

        <div style={styles.nav}>
          <button style={styles.botaoEscuro} onClick={() => navigate("/minha-fila")}>Fila Operacional</button>
          <button style={styles.botaoEscuro} onClick={() => navigate("/alunos-unificados")}>Alunos Unificados</button>
          <button style={styles.botaoEscuro} onClick={carregarBaixas}>Atualizar</button>
        </div>
      </div>

      <div style={styles.indicadores}>
        <div style={styles.indicador}><strong>{indicadores.pendentes}</strong><span>Pendentes</span></div>
        <div style={styles.indicador}><strong>{indicadores.revisar}</strong><span>Revisar</span></div>
        <div style={styles.indicador}><strong>{indicadores.aprovadas}</strong><span>Aprovadas</span></div>
        <div style={styles.indicador}><strong>{indicadores.rejeitadas}</strong><span>Rejeitadas</span></div>
        <div style={styles.indicadorValor}><strong>{dinheiro(indicadores.valor)}</strong><span>Valor filtrado</span></div>
      </div>

      <div style={styles.card}>
        <div style={styles.grid}>
          <input style={styles.input} placeholder="Buscar por nome, CPF, arquivo ou chave..." value={busca} onChange={(e) => setBusca(e.target.value)} />

          <select style={styles.input} value={filtro} onChange={(e) => setFiltro(e.target.value)}>
            <option value="PENDENTE">Pendentes</option>
            <option value="APROVADA">Aprovadas</option>
            <option value="REJEITADA">Rejeitadas</option>
            <option value="TODOS">Todas</option>
          </select>
        </div>
      </div>

      {lista.length === 0 && (
        <div style={styles.vazio}>
          Nenhuma baixa encontrada neste filtro. Quando importarmos a planilha de quitados, os registros aparecerão aqui.
        </div>
      )}

      {lista.map((item) => (
        <div key={item.id} style={styles.cardBaixa}>
          <div style={styles.topoCard}>
            <div>
              <h2 style={styles.nome}>{item.nome_aluno || item.nome_referencia || "Aluno sem nome"}</h2>
              <p style={styles.info}><strong>CPF:</strong> {item.cpf_corrigido || item.cpf_original || "-"}</p>
              <p style={styles.info}><strong>Valor pago:</strong> {dinheiro(item.valor_pago)}</p>
              <p style={styles.info}><strong>Data pagamento:</strong> {dataBR(item.data_pagamento)}</p>
              <p style={styles.info}><strong>Origem:</strong> {item.origem_arquivo || "-"}</p>
              <p style={styles.info}><strong>Status cruzamento:</strong> {item.status_cruzamento || "-"}</p>
              <p style={styles.info}><strong>Chave:</strong> {item.chave_unificacao || "-"}</p>
            </div>

            <span style={styles.status}>{item.acao_quitacao || "PENDENTE"}</span>
          </div>

          {item.observacao && <div style={styles.obs}><strong>Observação:</strong> {item.observacao}</div>}

          <textarea
            style={styles.textarea}
            placeholder="Observação da aprovação ou motivo da rejeição"
            value={observacoes[item.id] || ""}
            onChange={(e) => setObservacoes({ ...observacoes, [item.id]: e.target.value })}
          />

          <div style={styles.acoes}>
            <button style={styles.botaoVerde} onClick={() => aprovarQuitacao(item)}>Aprovar quitação</button>
            <button style={styles.botaoAmarelo} onClick={() => rejeitarQuitacao(item)}>Rejeitar / revisar</button>

            {item.chave_unificacao && (
              <button
                style={styles.botaoEscuro}
                onClick={() => navigate(`/aluno-unificado/${encodeURIComponent(item.chave_unificacao)}`)}
              >
                Abrir aluno
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const styles = {
  container: { minHeight: "100%", background: "#f4f6f8", padding: "24px", fontFamily: "Arial, sans-serif" },
  cabecalho: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", marginBottom: "18px" },
  titulo: { margin: 0, color: "#111827" },
  subtitulo: { margin: "6px 0 0 0", color: "#555" },
  nav: { display: "flex", gap: "8px", flexWrap: "wrap" },
  indicadores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: "12px", marginBottom: "16px" },
  indicador: { background: "#fff", borderRadius: "14px", padding: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  indicadorValor: { background: "#111827", color: "#fff", borderRadius: "14px", padding: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  card: { background: "#fff", borderRadius: "14px", padding: "18px", marginBottom: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "10px" },
  input: { padding: "11px", borderRadius: "8px", border: "1px solid #d1d5db", fontSize: "14px" },
  vazio: { background: "#fff", padding: "18px", borderRadius: "10px" },
  cardBaixa: { background: "#fff", borderRadius: "16px", padding: "20px", marginBottom: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.08)", borderLeft: "6px solid #198754" },
  topoCard: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start" },
  nome: { margin: "0 0 8px 0", color: "#111827" },
  info: { margin: "5px 0", color: "#555" },
  status: { background: "#e5e7eb", color: "#374151", padding: "8px 12px", borderRadius: "999px", fontWeight: "bold", fontSize: "13px" },
  obs: { background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "12px", marginTop: "12px", color: "#374151" },
  textarea: { width: "100%", minHeight: "70px", marginTop: "10px", padding: "11px", borderRadius: "8px", border: "1px solid #d1d5db", boxSizing: "border-box", fontFamily: "Arial, sans-serif" },
  acoes: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" },
  botaoEscuro: { background: "#111827", color: "#fff", border: "none", padding: "10px 13px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoVerde: { background: "#198754", color: "#fff", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoAmarelo: { background: "#ffc107", color: "#111827", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
};
