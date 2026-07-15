import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const TIPOS_ACIONAMENTO = ["FINALIZACAO_ATENDIMENTO", "FINALIZACAO"];
const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const VERDE = "#0f9d6b";

function diasEntre(dataInicioISO, dataFimISO) {
  const inicio = new Date(dataInicioISO);
  const fim = new Date(dataFimISO);
  const diff = Math.round((fim - inicio) / (1000 * 60 * 60 * 24));
  return Math.max(diff + 1, 1);
}

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function diaLabel(iso) {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function moeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function mesAtualISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function MeuDashboard() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [nome, setNome] = useState("");
  const [dados, setDados] = useState({
    totalCasos: 0,
    totalAcionamentos: 0,
    diasComAcionamento: 0,
    mediaPorCaso: 0,
    mediaPorDia: 0,
  });
  const [evolucao, setEvolucao] = useState([]); // [{dia, qtd}]
  const [financeiro, setFinanceiro] = useState(null);
  const [aba, setAba] = useState("FINANCEIRO");

  useEffect(() => {
    carregar();
    carregarFinanceiro();
  }, []);

  async function carregarFinanceiro() {
    const { data, error } = await supabase.rpc("projecao_dashboard", { p_mes: mesAtualISO() });
    if (!error) setFinanceiro(data);
  }

  async function carregar() {
    setCarregando(true);
    setErro("");

    try {
      const { data: userData } = await supabase.auth.getUser();
      const email = userData?.user?.email || "";

      if (!email) {
        setErro("Não foi possível identificar seu usuário.");
        setCarregando(false);
        return;
      }

      setNome(userData?.user?.user_metadata?.nome || email);

      // Casos que são dele hoje (visão pessoal, não do time).
      const { count: totalCasos, error: erroCasos } = await supabase
        .from("alunos")
        .select("id", { count: "exact", head: true })
        .eq("responsavel_atual_email", email);

      if (erroCasos) throw erroCasos;

      // Acionamentos do mês atual = finalizações de atendimento registradas
      // por ele. Só a visão dele -- nunca do time ou geral.
      const hoje = hojeISO();
      const inicioMes = `${hoje.slice(0, 7)}-01T00:00:00`;

      const { data: acionamentos, error: erroAcionamentos } = await supabase
        .from("aluno_movimentacoes")
        .select("registrado_em")
        .eq("registrado_por_email", email)
        .in("tipo", TIPOS_ACIONAMENTO)
        .gte("registrado_em", inicioMes)
        .order("registrado_em", { ascending: true });

      if (erroAcionamentos) throw erroAcionamentos;

      const lista = acionamentos || [];
      const totalAcionamentos = lista.length;

      const porDia = {};
      for (const a of lista) {
        const dia = String(a.registrado_em || "").slice(0, 10);
        if (!dia) continue;
        porDia[dia] = (porDia[dia] || 0) + 1;
      }

      const diasComAcionamento = Object.keys(porDia).length;

      // Monta a série do dia 1 até hoje, com zero nos dias sem acionamento
      // (assim a evolução mostra os buracos, não só os dias trabalhados).
      const inicioMesData = `${hoje.slice(0, 7)}-01`;
      const totalDiasMes = diasEntre(inicioMesData, hoje);
      const serie = [];
      for (let i = 0; i < totalDiasMes; i++) {
        const d = new Date(inicioMesData + "T00:00:00");
        d.setDate(d.getDate() + i);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        serie.push({ dia: iso, qtd: porDia[iso] || 0 });
      }
      setEvolucao(serie);

      const mediaPorCaso = totalCasos > 0 ? totalAcionamentos / totalCasos : 0;
      const mediaPorDia = diasComAcionamento > 0 ? totalAcionamentos / diasComAcionamento : 0;

      setDados({
        totalCasos: totalCasos || 0,
        totalAcionamentos,
        diasComAcionamento,
        mediaPorCaso,
        mediaPorDia,
      });
    } catch (e) {
      console.error("Erro ao carregar meu dashboard:", e);
      setErro("Não foi possível carregar seus indicadores.");
    } finally {
      setCarregando(false);
    }
  }

  const maiorDia = Math.max(1, ...evolucao.map((e) => e.qtd));

  if (carregando) {
    return <div style={estilos.container}>Carregando seu dashboard...</div>;
  }

  return (
    <div style={estilos.container}>
      <style>{`.md-barra:hover { opacity: 0.85; }`}</style>

      <div style={estilos.cabecalho}>
        <div>
          <h1 style={estilos.titulo}>📊 Meu Dashboard</h1>
          <p style={estilos.subtitulo}>
            Visão pessoal — só os seus casos e os seus acionamentos, sem comparar com colegas.
          </p>
        </div>

        <button style={estilos.botaoAtualizar} onClick={carregar}>
          Atualizar
        </button>
      </div>

      {erro && <div style={estilos.alerta}>{erro}</div>}

      <div style={estilos.abas}>
        <button style={aba === "FINANCEIRO" ? estilos.abaAtiva : estilos.aba} onClick={() => setAba("FINANCEIRO")}>
          💰 Financeiro
        </button>
        <button style={aba === "OPERACIONAL" ? estilos.abaAtiva : estilos.aba} onClick={() => setAba("OPERACIONAL")}>
          📈 Operacional
        </button>
      </div>

      {aba === "FINANCEIRO" && financeiro && (
        <div style={estilos.blocoFinanceiro}>
          <h3 style={estilos.tituloBloco}>💰 Recuperado e projeção (mês, todos os pagamentos)</h3>
          <p style={estilos.subtituloBloco}>
            Total recuperado esse mês, incluindo todos os tipos de pagamento (não só os principais).
          </p>
          <div style={estilos.gridFinanceiro}>
            <div style={estilos.cartaoFinanceiro}>
              <span style={estilos.numeroFinanceiro}>{moeda(financeiro.acumulado_mes)}</span>
              <span style={estilos.labelFinanceiro}>Recuperado no mês (total)</span>
            </div>
            <div style={estilos.cartaoFinanceiro}>
              <span style={estilos.numeroFinanceiro}>{moeda(financeiro.honorario_mes)}</span>
              <span style={estilos.labelFinanceiro}>Honorário no mês</span>
            </div>
            <div style={{ ...estilos.cartaoFinanceiro, background: "#ecfaf3", borderColor: "#bdeed4" }}>
              <span style={{ ...estilos.numeroFinanceiro, color: "#0f7a4f" }}>
                {moeda(financeiro.projecao_honorario_individual)}
              </span>
              <span style={estilos.labelFinanceiro}>Projeção de fechamento (se continuar nesse ritmo)</span>
            </div>
            <div style={estilos.cartaoFinanceiro}>
              <span
                style={{
                  ...estilos.numeroFinanceiro,
                  color: (financeiro.percentual_projecao_individual ?? 0) >= 100 ? "#0f9d6b" : "#d97706",
                }}
              >
                {financeiro.percentual_projecao_individual ?? 0}%
              </span>
              <span style={estilos.labelFinanceiro}>% da meta que essa projeção bateria</span>
            </div>
          </div>
        </div>
      )}

      {aba === "OPERACIONAL" && (
      <>
      <div style={estilos.blocoFinanceiro}>
        <h3 style={estilos.tituloBloco}>📈 Sua atividade no mês</h3>
        <p style={estilos.subtituloBloco}>Casos, acionamentos e médias de ritmo de trabalho.</p>
        <div style={estilos.grid}>
          <div style={estilos.card}>
            <span style={estilos.numero}>{dados.totalCasos}</span>
            <span style={estilos.descricao}>Casos sob sua responsabilidade</span>
          </div>

          <div style={estilos.card}>
            <span style={estilos.numero}>{dados.totalAcionamentos}</span>
            <span style={estilos.descricao}>Acionamentos no mês</span>
          </div>

          <div style={estilos.card}>
            <span style={estilos.numero}>{dados.mediaPorCaso.toFixed(1)}</span>
            <span style={estilos.descricao}>Média de acionamentos por caso</span>
          </div>

          <div style={estilos.card}>
            <span style={estilos.numero}>{dados.mediaPorDia.toFixed(1)}</span>
            <span style={estilos.descricao}>Média por dia trabalhado</span>
          </div>
        </div>
      </div>

      <div style={estilos.blocoEvolucao}>
        <h3 style={estilos.tituloEvolucao}>📅 Sua evolução no mês</h3>
        <p style={estilos.legendaEvolucao}>
          Acionamentos por dia — {dados.diasComAcionamento} dia(s) com pelo menos 1 acionamento.
        </p>

        {evolucao.length === 0 ? (
          <p style={estilos.descricao}>Sem dados neste mês ainda.</p>
        ) : (
          <div style={estilos.barrasWrap}>
            {evolucao.map((e) => (
              <div key={e.dia} style={estilos.colunaBarra} title={`${diaLabel(e.dia)}: ${e.qtd} acionamento(s)`}>
                <div
                  className="md-barra"
                  style={{
                    ...estilos.barra,
                    height: `${Math.max((e.qtd / maiorDia) * 120, e.qtd > 0 ? 4 : 2)}px`,
                    background: e.qtd > 0 ? VERDE : "#e3e7ee",
                  }}
                />
                <span style={estilos.legendaBarra}>{diaLabel(e.dia)}</span>
              </div>
            ))}
          </div>
        )}

        <p style={estilos.rodape}>
          Cálculo: acionamentos ÷ casos sob sua responsabilidade (por caso) e acionamentos ÷{" "}
          {dados.diasComAcionamento} dia(s) em que você registrou pelo menos 1 acionamento (por dia).
        </p>
      </div>
      </>
      )}
    </div>
  );
}

const estilos = {
  abas: { display: "flex", gap: 8, marginBottom: 18 },
  aba: {
    background: "#fff",
    border: "1px solid #e3e7ee",
    borderRadius: 10,
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 700,
    color: "#475569",
    cursor: "pointer",
  },
  abaAtiva: {
    background: "#0f9d6b",
    border: "1px solid #0f9d6b",
    borderRadius: 10,
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 800,
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(15,157,107,0.35)",
  },
  blocoFinanceiro: {
    background: "#fff",
    borderRadius: 16,
    padding: "20px 22px",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)",
    border: "1px solid #edf0f5",
    marginBottom: 18,
  },
  tituloBloco: { margin: 0, fontFamily: FONTE_TITULO, fontSize: 16, fontWeight: 800, color: "#0d1321" },
  subtituloBloco: { margin: "4px 0 14px", fontSize: 12.5, color: "#8a93a3" },
  gridFinanceiro: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 12,
  },
  cartaoFinanceiro: {
    background: "#f8fafc",
    border: "1px solid #edf0f5",
    borderRadius: 12,
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  numeroFinanceiro: { fontFamily: FONTE_TITULO, fontSize: 20, fontWeight: 800, color: "#0d1321" },
  labelFinanceiro: { fontSize: 11.5, color: "#8a93a3", fontWeight: 600 },
  container: {
    padding: "28px 30px 40px",
    fontFamily: "'Inter', system-ui, sans-serif",
    background: "#f4f6fa",
    minHeight: "100%",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "16px",
    marginBottom: "22px",
    flexWrap: "wrap",
  },
  titulo: {
    margin: 0,
    color: "#0d1321",
    fontFamily: FONTE_TITULO,
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: "-0.03em",
  },
  subtitulo: {
    margin: "5px 0 0",
    color: "#8a93a3",
    fontSize: 13.5,
  },
  botaoAtualizar: {
    background: VERDE,
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 18px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "12px",
  },
  card: {
    background: "#f8fafc",
    borderRadius: 12,
    padding: "14px 16px",
    border: "1px solid #edf0f5",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  numero: {
    fontSize: 26,
    fontWeight: 800,
    color: "#0d1321",
    fontFamily: FONTE_TITULO,
  },
  descricao: {
    fontSize: 12.5,
    color: "#8a93a3",
    fontWeight: 600,
  },
  blocoEvolucao: {
    background: "#fff",
    borderRadius: 16,
    padding: "20px 22px",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)",
    border: "1px solid #edf0f5",
    marginBottom: "18px",
  },
  tituloEvolucao: {
    margin: 0,
    fontFamily: FONTE_TITULO,
    fontSize: 15,
    fontWeight: 700,
    color: "#0d1321",
  },
  legendaEvolucao: {
    margin: "4px 0 16px",
    fontSize: 12.5,
    color: "#8a93a3",
  },
  barrasWrap: {
    display: "flex",
    gap: "6px",
    alignItems: "flex-end",
    height: "150px",
    overflowX: "auto",
    padding: "0 2px",
  },
  colunaBarra: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "6px",
    minWidth: "22px",
    justifyContent: "flex-end",
    height: "100%",
  },
  barra: {
    width: "16px",
    borderRadius: "4px 4px 0 0",
    transition: "opacity 0.12s ease",
  },
  legendaBarra: {
    fontSize: "9px",
    color: "#98a2b3",
    whiteSpace: "nowrap",
  },
  alerta: {
    background: "#fff3cd",
    color: "#664d03",
    border: "1px solid #ffecb5",
    borderRadius: 10,
    padding: "14px",
    marginBottom: "16px",
  },
  rodape: {
    fontSize: 12,
    color: "#9ca3af",
  },
};
