// OS DOIS GRÁFICOS DA ABA RESULTADOS.
//
// 1. Efetividade por ação — uma barra por ação, taxa de regularização por
//    ALUNOS. Série única: não leva legenda (o título já nomeia a métrica) e
//    cada barra é rotulada direto, que serve também de codificação secundária.
// 2. Efetividade por contexto e canal — um grupo por contexto, WhatsApp e
//    e-mail como séries. Duas séries: legenda SEMPRE presente, mais rótulo
//    direto em cada barra, para a identidade nunca depender só da cor.
//
// COR. O par vem de `--rv-grafico-1/2`, validado por script contra daltonismo
// e contraste nos dois temas. Azul+roxo, usado em telas antigas, reprova feio
// (dE 0.4 em deuteranopia) e NÃO é usado aqui.
//
// AUSÊNCIA DE DADO NUNCA É ZERO. Ação sem régua fica fora do gráfico e aparece
// nomeada embaixo, com o que falta. Eixo fixo em 0–100 porque a métrica é
// percentual: deixar o eixo respirar com o dado faria 3% parecer alto.
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  CartesianGrid, LabelList, Cell,
} from "recharts";
import { S } from "../../ui/estilosFila";
import { moeda } from "../../utils/preventivoFormato";
import {
  dadosPorAcao, dadosPorContextoCanal, CANAIS, CANAIS_ROTULO, CONTEXTOS_ROTULO,
} from "./graficosEfetividadeDados";

const COR_1 = "var(--rv-grafico-1)";
const COR_2 = "var(--rv-grafico-2)";
const EIXO = { fontSize: 11, fill: "var(--rv-texto-fraco)" };
const pct = (v) => `${v}%`;

const caixaTooltip = {
  background: "var(--rv-superficie)",
  border: "1px solid var(--rv-borda-suave)",
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 12.5,
  boxShadow: "0 6px 20px rgba(0,0,0,.12)",
};

function Par({ rot, val }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 14, marginTop: 3 }}>
      <span style={{ color: "var(--rv-texto-fraco)" }}>{rot}</span>
      <strong>{val}</strong>
    </div>
  );
}

function TooltipAcao({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={caixaTooltip}>
      <div style={{ fontWeight: 800, marginBottom: 6 }}>{d.nome}</div>
      <div style={{ color: "var(--rv-texto-fraco)", fontSize: 11.5, marginBottom: 6 }}>
        {CANAIS_ROTULO[d.canal] || d.canal} · {CONTEXTOS_ROTULO[d.contexto] || d.contexto}
      </div>
      <Par rot="Alunos acionados" val={d.alunos_acionados} />
      <Par rot="Alunos regularizados" val={d.alunos_regularizados} />
      <Par rot="Taxa por alunos" val={pct(d.taxa_alunos)} />
      <Par rot="Valor acionado" val={moeda(d.valor_acionado)} />
      <Par rot="Valor regularizado" val={moeda(d.valor_regularizado)} />
      <Par rot="Taxa por valor" val={d.taxa_valor === null ? "—" : pct(d.taxa_valor)} />
    </div>
  );
}

function TooltipContexto({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={caixaTooltip}>
      <div style={{ fontWeight: 800, marginBottom: 6 }}>{label}</div>
      {payload.map((p) => {
        const d = p.payload[`${p.dataKey}_dados`];
        if (!d) return null;
        return (
          <div key={p.dataKey} style={{ marginTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: p.fill }} />
              {CANAIS_ROTULO[p.dataKey] || p.dataKey} · {d.acoes} ação(ões)
            </div>
            <Par rot="Alunos acionados" val={d.acionados} />
            <Par rot="Alunos regularizados" val={d.regularizados} />
            <Par rot="Taxa por alunos" val={pct(p.value)} />
            <Par rot="Valor acionado" val={moeda(d.valor_acionado)} />
            <Par rot="Valor regularizado" val={moeda(d.valor_regularizado)} />
          </div>
        );
      })}
    </div>
  );
}

function Aguardando({ itens }) {
  if (!itens.length) return null;
  return (
    <div style={{ ...S.muted, marginTop: 10, fontSize: 11.5 }}>
      Fora do gráfico, porque ainda não há o que medir — e ausência de medição não
      é 0%:
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {itens.map((a) => (
          <li key={a.id || `${a.contexto}-${a.canal}`}>
            <strong>{a.nome}</strong> — {a.motivo}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Vazio({ texto }) {
  return (
    <div style={{ ...S.muted, padding: "22px 0", textAlign: "center", fontSize: 12.5 }}>
      {texto}
    </div>
  );
}

export function GraficoPorAcao({ linhas }) {
  const { medidas, aguardando } = dadosPorAcao(linhas);

  return (
    <div style={{ ...S.card, padding: 20, marginTop: 18 }}>
      <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>
        Efetividade por ação — taxa de regularização por alunos
      </h2>
      {medidas.length === 0 ? (
        <Vazio texto="Nenhuma ação com régua ainda: a efetividade conta da remessa válida seguinte ao envio confirmado." />
      ) : (
        <div style={{ height: Math.max(220, 56 + medidas.length * 46), marginTop: 12 }}>
          <ResponsiveContainer>
            <BarChart data={medidas} layout="vertical"
                      margin={{ top: 4, right: 56, left: 8, bottom: 4 }}>
              <CartesianGrid horizontal={false} stroke="var(--rv-borda-suave)" strokeDasharray="3 3" />
              <XAxis type="number" domain={[0, 100]} tickFormatter={pct} tick={EIXO} />
              <YAxis type="category" dataKey="nome" width={190} tick={EIXO} />
              <Tooltip content={<TooltipAcao />} cursor={{ fill: "var(--rv-borda-suave)", opacity: 0.35 }} />
              <Bar dataKey="taxa_alunos" radius={[0, 4, 4, 0]} barSize={22} fill={COR_1}>
                <LabelList dataKey="taxa_alunos" position="right"
                           formatter={pct} style={{ fontSize: 11.5, fill: "var(--rv-tinta)" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <Aguardando itens={aguardando} />
    </div>
  );
}

export function GraficoPorContextoCanal({ linhas }) {
  const { grupos } = dadosPorContextoCanal(linhas);
  const canaisPresentes = CANAIS.filter((c) => grupos.some((g) => g[c] !== undefined));

  return (
    <div style={{ ...S.card, padding: 20, marginTop: 18 }}>
      <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>
        Efetividade por contexto e canal — taxa por alunos
      </h2>
      <p style={{ ...S.muted, marginTop: 6, fontSize: 12.5 }}>
        A taxa do canal soma os alunos de todas as ações dele e divide no fim —
        não é média das taxas, para uma ação pequena não pesar como uma grande.
      </p>
      {grupos.length === 0 ? (
        <Vazio texto="Sem comparação possível ainda: nenhuma ação medida." />
      ) : (
        <div style={{ height: 300, marginTop: 12 }}>
          <ResponsiveContainer>
            <BarChart data={grupos} margin={{ top: 16, right: 12, left: 0, bottom: 4 }}
                      barGap={2}>
              <CartesianGrid vertical={false} stroke="var(--rv-borda-suave)" strokeDasharray="3 3" />
              <XAxis dataKey="rotulo" tick={EIXO} />
              <YAxis domain={[0, 100]} tickFormatter={pct} tick={EIXO} />
              <Tooltip content={<TooltipContexto />} cursor={{ fill: "var(--rv-borda-suave)", opacity: 0.35 }} />
              <Legend wrapperStyle={{ fontSize: 12 }}
                      formatter={(v) => CANAIS_ROTULO[v] || v} />
              {canaisPresentes.map((canal, i) => (
                <Bar key={canal} dataKey={canal} name={canal} barSize={34}
                     radius={[4, 4, 0, 0]} fill={i === 0 ? COR_1 : COR_2}>
                  <LabelList dataKey={canal} position="top" formatter={pct}
                             style={{ fontSize: 11.5, fill: "var(--rv-tinta)" }} />
                  {grupos.map((g) => <Cell key={g.contexto} />)}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
