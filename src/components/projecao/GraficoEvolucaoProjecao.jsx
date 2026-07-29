import { useMemo, useState } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine,
} from "recharts";

function moeda(v) {
  const n = Number(v);
  return Number.isNaN(n) ? "R$ 0,00" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function diaCurto(iso) {
  if (!iso) return "-";
  const [, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}`;
}

const AZUL = "#2563eb";
const VERDE = "#0f9d6b";

// Extrai a data (YYYY-MM-DD) de um clique no gráfico, de forma robusta a como o
// recharts entrega o argumento. NB: recharts v3 mudou o onClick do gráfico e
// NÃO passa mais `activePayload` como na v2 — por isso lemos o clique também no
// próprio Bar/Line (o argumento vem como o datum {dia,...} ou {payload:{dia}}).
// Aceita: {dia}, {payload:{dia}}, {activePayload:[{payload:{dia}}]}.
export function diaDoCliqueGrafico(arg) {
  if (!arg) return null;
  if (arg.dia) return arg.dia;
  if (arg.payload && arg.payload.dia) return arg.payload.dia;
  const ap = arg.activePayload;
  if (Array.isArray(ap) && ap[0] && ap[0].payload && ap[0].payload.dia) return ap[0].payload.dia;
  return null;
}

// Gráfico mensal da Projeção. Lê SOMENTE o historico_dia_a_dia do snapshot.
// Seletores: Honorários/Recuperado e Diário/Acumulado. Tooltip com qtd de
// pagamentos. Marca os dias de mudança de faixa. Clique num dia -> onClickDia.
export default function GraficoEvolucaoProjecao({ historico = [], onClickDia, clicavel = false }) {
  const [metrica, setMetrica] = useState("honorario"); // honorario | recuperado
  const [modo, setModo] = useState("diario"); // diario | acumulado

  const dados = useMemo(() => {
    return (historico || []).map((d) => ({
      dia: d.dia,
      label: diaCurto(d.dia),
      qtd: Number(d.qtd_pagamentos_dia ?? 0),
      faixa: d.faixa || null,
      valor:
        metrica === "honorario"
          ? modo === "acumulado"
            ? Number(d.honorario_acumulado ?? 0)
            : Number(d.honorario_dia ?? d.valor_honorario ?? 0)
          : modo === "acumulado"
            ? Number(d.recuperado_acumulado ?? 0)
            : Number(d.recuperado_dia ?? d.valor_recuperado ?? 0),
    }));
  }, [historico, metrica, modo]);

  // Dias em que a faixa mudou vs o dia anterior (linha vertical de referência).
  const mudancasFaixa = useMemo(() => {
    const out = [];
    let anterior = null;
    for (const d of historico || []) {
      if (d.faixa && anterior && d.faixa !== anterior) out.push({ dia: d.dia, faixa: d.faixa });
      if (d.faixa) anterior = d.faixa;
    }
    return out;
  }, [historico]);

  const cor = metrica === "honorario" ? AZUL : VERDE;
  const rotuloMetrica = metrica === "honorario" ? "Honorários" : "Recuperado";

  // Handler único de clique num dia. Robusto a recharts v3 (Bar/Line entregam o
  // datum; o gráfico pode não passar activePayload). diaDoCliqueGrafico normaliza.
  function aoClicarDia(arg) {
    if (!clicavel || !onClickDia) return;
    const dia = diaDoCliqueGrafico(arg);
    if (dia) onClickDia(dia);
  }

  function BotaoTgl({ ativo, onClick, children }) {
    return (
      <button
        onClick={onClick}
        style={{
          padding: "6px 12px", borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
          border: `1px solid ${ativo ? cor : "#e3e7ee"}`,
          background: ativo ? cor : "#fff", color: ativo ? "#fff" : "#475569",
        }}
      >
        {children}
      </button>
    );
  }

  function TooltipCustom({ active, payload }) {
    if (!active || !payload || !payload.length) return null;
    const p = payload[0].payload;
    return (
      <div style={{ background: "#fff", border: "1px solid #e3e7ee", borderRadius: 10, padding: "10px 12px", boxShadow: "0 4px 14px rgba(15,23,42,0.12)", fontSize: 12.5 }}>
        <div style={{ fontWeight: 800, color: "#0d1321", marginBottom: 4 }}>{diaCurto(p.dia)}</div>
        <div>{rotuloMetrica} {modo === "acumulado" ? "(acum.)" : "(dia)"}: <strong>{moeda(p.valor)}</strong></div>
        <div>Pagamentos no dia: <strong>{p.qtd}</strong></div>
        {p.faixa && <div style={{ color: cor }}>Faixa: <strong>{p.faixa}</strong></div>}
        {clicavel && <div style={{ opacity: 0.6, marginTop: 4 }}>Clique para conferir os pagamentos</div>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <BotaoTgl ativo={metrica === "honorario"} onClick={() => setMetrica("honorario")}>Honorários</BotaoTgl>
          <BotaoTgl ativo={metrica === "recuperado"} onClick={() => setMetrica("recuperado")}>Recuperado</BotaoTgl>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <BotaoTgl ativo={modo === "diario"} onClick={() => setModo("diario")}>Diário</BotaoTgl>
          <BotaoTgl ativo={modo === "acumulado"} onClick={() => setModo("acumulado")}>Acumulado</BotaoTgl>
        </div>
      </div>

      {dados.length === 0 ? (
        <p style={{ opacity: 0.7 }}>Nenhum pagamento neste mês ainda.</p>
      ) : (
        <div style={{ width: "100%", height: 320 }}>
          <ResponsiveContainer>
            <ComposedChart
              data={dados}
              margin={{ top: 24, right: 12, left: 4, bottom: 4 }}
              onClick={aoClicarDia}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#98a2b3" }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11, fill: "#98a2b3" }} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} width={44} />
              <Tooltip content={<TooltipCustom />} cursor={{ fill: "rgba(37,99,235,0.06)" }} />
              {mudancasFaixa.map((m) => (
                <ReferenceLine
                  key={m.dia}
                  x={diaCurto(m.dia)}
                  stroke="#f59e0b"
                  strokeDasharray="4 3"
                  label={{ value: `↑ ${String(m.faixa).replace(/\s*\(.*\)/, "")}`, position: "top", fontSize: 10, fill: "#b45309" }}
                />
              ))}
              {modo === "acumulado" ? (
                <Line
                  type="monotone" dataKey="valor" stroke={cor} strokeWidth={2.5}
                  dot={{ r: 2.5, cursor: clicavel ? "pointer" : "default" }}
                  activeDot={{ r: 5, cursor: clicavel ? "pointer" : "default", onClick: (_e, d) => aoClicarDia(d) }}
                  onClick={aoClicarDia}
                />
              ) : (
                <Bar
                  dataKey="valor" fill={cor} radius={[4, 4, 0, 0]} maxBarSize={26}
                  cursor={clicavel ? "pointer" : "default"}
                  onClick={aoClicarDia}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      {clicavel && dados.length > 0 && (
        <p style={{ opacity: 0.6, fontSize: 12, marginTop: 6 }}>Clique num dia para conferir os pagamentos que o compõem. As linhas laranja marcam mudança de faixa.</p>
      )}
    </div>
  );
}
