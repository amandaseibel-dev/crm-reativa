import { useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";
import { supabase } from "../supabaseClient";

const BRL = (v) =>
  (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const NUM = (v) => (Number(v) || 0).toLocaleString("pt-BR");

// Gráfico ÚNICO: mensalidades originais de 2026/1 (jan-jun) ainda sem negociação.
// Fonte: RPC read-only relatorio_mensalidades_2026_1_sem_negociacao(). Não altera dados.
export default function MensalidadesSemNegociacao() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    (async () => {
      setCarregando(true);
      const { data, error } = await supabase.rpc(
        "relatorio_mensalidades_2026_1_sem_negociacao"
      );
      if (error) {
        setErro(error.message || "Erro ao carregar o relatório.");
      } else {
        setDados(data);
      }
      setCarregando(false);
    })();
  }, []);

  if (carregando) return <div style={{ padding: 24 }}>Carregando…</div>;
  if (erro) return <div style={{ padding: 24, color: "#b91c1c" }}>{erro}</div>;
  if (!dados) return null;

  const meses = (dados.meses || []).map((m) => ({
    ...m,
    label: m.mes_nome,
    qtd: Number(m.alunos_unicos) || 0,
  }));

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const m = payload[0].payload;
    return (
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, fontSize: 13 }}>
        <strong>{m.mes_nome}</strong>
        <div>Alunos únicos: {NUM(m.alunos_unicos)}</div>
        <div>Mensalidades abertas: {NUM(m.mensalidades_sem_negociacao)}</div>
        <div>Saldo do mês: {BRL(m.saldo_sem_negociacao)}</div>
      </div>
    );
  };

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
        Alunos com mensalidades vencidas entre janeiro e junho de 2026 ainda sem negociação
      </h1>
      <p style={{ color: "#6b7280", marginTop: 0, marginBottom: 20 }}>
        Visão baseada na data de vencimento registrada na Base Reativa. Pode incluir mensalidades
        ou matrículas antecipadas referentes a 2026/2. Não contempla o status de matrícula ou
        rematrícula registrado no Prime.
      </p>

      <div style={{ marginBottom: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <Tot label="Alunos únicos sem negociação" val={NUM(dados.alunos_unicos_semestre)} accent />
        <Tot label="Mensalidades sem negociação" val={NUM(dados.mensalidades_total)} />
        <Tot label="Saldo total sem negociação" val={BRL(dados.saldo_total)} />
      </div>

      <div style={{ width: "100%", height: 360 }}>
        <ResponsiveContainer>
          <BarChart data={meses} margin={{ top: 10, right: 16, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" />
            <YAxis allowDecimals={false} label={{ value: "Quantidade de alunos", angle: -90, position: "insideLeft", style: { fontSize: 12 } }} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="qtd" radius={[4, 4, 0, 0]}>
              {meses.map((_, i) => (<Cell key={i} fill="#2563eb" />))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p style={{ marginTop: 16, color: "#6b7280", fontSize: 13 }}>
        O relatório considera a data de vencimento dos títulos. Por esse motivo, pode incluir
        mensalidades ou matrículas antecipadas referentes ao período acadêmico 2026/2. No total
        consolidado, cada aluno é contado uma única vez.
      </p>
    </div>
  );
}

function Tot({ label, val, accent }) {
  return (
    <div style={{
      border: accent ? "1px solid transparent" : "1px solid #e5e7eb",
      background: accent ? "#e8eef6" : "transparent",
      borderRadius: 10, padding: "12px 14px",
    }}>
      <div style={{ fontSize: 12, color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{val}</div>
    </div>
  );
}
