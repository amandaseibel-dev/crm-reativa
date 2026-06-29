import { useState } from "react";
import { supabase } from "../services/supabase";

/* ================= BASE ================= */

const OPERADORES = [
  "OLGA",
  "ALLAN",
  "DIEGO",
  "RAFAELLA",
  "MAURICIO",
  "LUANA",
  "NATALY",
  "AMANDA",
  "DANIELE",
];

const FILTROS_STATUS = [
  "Todos",
  "Críticos",
  "Urgentes",
  "Atenção",
  "Normal",
  "Sem acionamento",
  "Retornos hoje",
  "Aguardando pagamento",
];

const RESULTADOS = [
  "WhatsApp enviado",
  "Ligação realizada",
  "Sem contato",
  "Acordo fechado",
  "Número inválido",
  "Retorno agendado",
];

/* ================= COMPONENTE ================= */

export default function CRM() {
  const [operador, setOperador] = useState("OLGA");
  const [filtroStatus, setFiltroStatus] = useState("Todos");
  const [grupos, setGrupos] = useState([]);
  const [observacoes, setObservacoes] = useState({});
  const [aberto, setAberto] = useState(null);
  const [erro, setErro] = useState("");
  const [sucesso, setSucesso] = useState("");
  const [carregando, setCarregando] = useState(false);

/* ================= UTIL ================= */

function normalizarCriticidade(texto) {
  const t = String(texto || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (t.includes("CRIT")) return "CRITICO";
  if (t.includes("URG")) return "URGENTE";
  if (t.includes("ATEN")) return "ATENCAO";
  if (t.includes("SEM")) return "SEM_ACIONAMENTO";
  return "NORMAL";
}

function formatarData(d) {
  if (!d) return "-";
  const dt = new Date(d);
  return isNaN(dt) ? d : dt.toLocaleDateString("pt-BR");
}

/* ================= DATAS (CORREÇÃO PRINCIPAL) ================= */

function pegarDataRetorno(c) {
  return (
    c.data_retorno_nova ||
    c.data_retorno ||
    c.retorno_data ||
    c.data_retorno_agendada ||
    null
  );
}

function pegarUltimaTabulacao(c) {
  return (
    c.ultima_tabulacao_em ||
    c.updated_at ||
    c.data_finalizacao ||
    c.ultima_acao ||
    null
  );
}

/* ================= FILTRO ================= */

function passaFiltro(c) {
  const crit = normalizarCriticidade(c.criticidade);

  if (filtroStatus === "Todos") return true;
  if (filtroStatus === "Críticos") return crit === "CRITICO";
  if (filtroStatus === "Urgentes") return crit === "URGENTE";
  if (filtroStatus === "Atenção") return crit === "ATENCAO";
  if (filtroStatus === "Normal") return crit === "NORMAL";
  if (filtroStatus === "Sem acionamento") return crit === "SEM_ACIONAMENTO";
  return true;
}

/* ================= BUSCA ================= */

async function buscar() {
  setCarregando(true);

  const { data, error } = await supabase
    .from("casos")
    .select("*")
    .ilike("operador_base", `%${operador}%`);

  if (error) {
    setErro("Erro ao carregar dados");
    setCarregando(false);
    return;
  }

  setGrupos((data || []).filter(passaFiltro));
  setCarregando(false);
}

/* ================= TABULAR ================= */

async function salvarTabulacao(caso, resultado) {
  const { error } = await supabase
    .from("casos")
    .update({
      status_acionamento: resultado,
      ultima_tabulacao_em: new Date().toISOString(),
    })
    .eq("id", caso.id);

  if (error) {
    setErro("Erro ao salvar tabulação");
    return;
  }

  setSucesso("Atualizado com sucesso");
  buscar();
}

/* ================= FILA ================= */

async function moverFila(casoId, destino) {
  await supabase
    .from("casos")
    .update({
      fila_responsavel: destino,
      status_acionamento: "TRANSFERIDO_FILA",
    })
    .eq("id", casoId);

  buscar();
}

/* ================= UI ================= */

return (
  <div style={{ padding: 24, background: "#0b001a", minHeight: "100vh", color: "#fff" }}>

    <h2 style={{ color: "#a855f7" }}>📞 CRM Operacional</h2>

    {/* FILTROS */}
    <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
      <select value={operador} onChange={(e) => setOperador(e.target.value)}>
        {OPERADORES.map(o => <option key={o}>{o}</option>)}
      </select>

      <select value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}>
        {FILTROS_STATUS.map(f => <option key={f}>{f}</option>)}
      </select>

      <button onClick={buscar}>Buscar</button>
    </div>

    {erro && <p style={{ color: "red" }}>{erro}</p>}
    {sucesso && <p style={{ color: "#22c55e" }}>{sucesso}</p>}

    {/* CARDS */}
    {grupos.map((c) => (
      <div key={c.id} style={{
        background: "#120024",
        border: "1px solid #3b0764",
        borderRadius: 12,
        padding: 14,
        marginBottom: 10
      }}>

        {/* RESUMO */}
        <div
          onClick={() => setAberto(aberto === c.id ? null : c.id)}
          style={{ cursor: "pointer" }}
        >
          <strong>{c.nome}</strong>

          <p>{c.status_acionamento}</p>

          <p style={{ fontSize: 12, opacity: 0.7 }}>
            Retorno: {formatarData(pegarDataRetorno(c))}
          </p>

          <p style={{ fontSize: 12, opacity: 0.7 }}>
            Última ação: {formatarData(pegarUltimaTabulacao(c))}
          </p>
        </div>

        {/* DETALHE */}
        {aberto === c.id && (
          <div style={{
            marginTop: 10,
            background: "#0a0014",
            padding: 12,
            borderRadius: 10
          }}>

            <textarea
              placeholder="Observação"
              value={observacoes[c.id] || ""}
              onChange={(e) =>
                setObservacoes((p) => ({
                  ...p,
                  [c.id]: e.target.value
                }))
              }
              style={{ width: "100%", marginTop: 10 }}
            />

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>

              {RESULTADOS.map((r) => (
                <button key={r} onClick={() => salvarTabulacao(c, r)}>
                  {r}
                </button>
              ))}

              <button onClick={() => moverFila(c.id, "AMANDA_ADM")}>
                📤 Amanda
              </button>

              <button onClick={() => moverFila(c.id, "FERNANDA")}>
                📤 Fernanda
              </button>

              <button onClick={() => moverFila(c.id, "GERENCIA")}>
                📤 Você
              </button>

            </div>

          </div>
        )}

      </div>
    ))}
  </div>
);
}