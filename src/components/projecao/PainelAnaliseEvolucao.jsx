import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../services/supabase";

// Painel de ANÁLISE dentro de "Evolução & Ranking" (gestão). Três números-chave
// grandes (recuperado, honorário, projeção), a recuperação de cada dia bem
// visível comparada contra a MÉDIA dos dias do mês (acima/abaixo do normal), e
// o movimento da PROJEÇÃO vs ontem (a partir do 2º dia gravado no histórico).

const AZUL = "#2563eb";
const VERDE = "#16a34a";
const VERM = "#dc2626";
const BORDA = "#e5e7eb";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function ddmm(dataISO) {
  if (!dataISO) return "-";
  const [, m, d] = String(dataISO).slice(0, 10).split("-");
  return `${d}/${m}`;
}
// PREMISSA (2026-08-17): ritmo só com DIA FECHADO. O dia corrente ainda está
// incompleto -- boleto e parte dos cartões só caem no dia seguinte; no próprio
// dia entra basicamente PIX --, então ele aparece no gráfico mas NÃO entra na
// média (senão puxa a média pra baixo e o dia sempre parece ruim).
export function hojeISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
// Média diária: só dias FECHADOS e só dias que tiveram recuperação (dia sem
// lançamento não puxa a média pra baixo artificialmente).
export function mediaDiasFechados(dias, hoje) {
  const fechados = (dias || []).filter(
    (d) => String(d.dia).slice(0, 10) !== hoje && Number(d.valor_recuperado) > 0
  );
  if (!fechados.length) return 0;
  return fechados.reduce((s, d) => s + Number(d.valor_recuperado || 0), 0) / fechados.length;
}

export default function PainelAnaliseEvolucao({ dados, mes }) {
  const [hist, setHist] = useState(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const { data, error } = await supabase.rpc("projecao_historico_diario_ler", { p_mes: mes });
      if (vivo && !error && data?.autorizado !== false) setHist(data);
    })();
    return () => { vivo = false; };
  }, [mes]);

  const recuperado = Number(dados?.recuperado_reativa_mes ?? 0) || 0;
  const honorario = Number(dados?.honorario_mes_filial ?? 0) || 0;
  const projecao = Number(dados?.projecao_honorario_filial ?? 0) || 0;
  const pctMeta = Number(dados?.percentual_meta_filial ?? 0) || 0;
  const pctProj = Number(dados?.percentual_projecao_filial ?? 0) || 0;

  const diasHist = useMemo(() => dados?.historico_dia_a_dia || [], [dados]);
  const hoje = hojeISO();
  // Média diária considera só os dias que tiveram recuperação (dias sem
  // lançamento não puxam a média pra baixo artificialmente) E só dias FECHADOS
  // (o dia corrente ainda está entrando -- ver hojeISO acima).
  const media = useMemo(() => mediaDiasFechados(diasHist, hoje), [diasHist, hoje]);
  const maxDia = useMemo(
    () => Math.max(1, ...diasHist.map((d) => Number(d.valor_recuperado) || 0)),
    [diasHist]
  );

  const deltaProj = hist?.delta_projecao;
  const temVsOntem = deltaProj != null && hist?.projecao_ontem != null;

  return (
    <div>
      {/* TRÊS NÚMEROS-CHAVE — grandes e bem visíveis. */}
      <div style={estilos.heroRow}>
        <div style={estilos.heroCard}>
          <div style={estilos.heroRot}>Recuperado no mês</div>
          <div style={estilos.heroNum}>{moeda(recuperado)}</div>
        </div>
        <div style={estilos.heroCard}>
          <div style={estilos.heroRot}>Honorário no mês</div>
          <div style={estilos.heroNum}>{moeda(honorario)}</div>
          <div style={estilos.heroNota}>{pctMeta}% da meta</div>
        </div>
        <div style={{ ...estilos.heroCard, ...estilos.heroCardProj }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ ...estilos.heroRot, color: "#1e40af" }}>Projeção de fechamento</span>
            {temVsOntem ? (
              <span style={{ ...estilos.pill, background: deltaProj >= 0 ? "#dcfce7" : "#fee2e2", color: deltaProj >= 0 ? "#166534" : "#991b1b" }}>
                {deltaProj >= 0 ? "▲ +" : "▼ "}{deltaProj}% vs ontem
              </span>
            ) : (
              <span style={{ ...estilos.pill, background: "#eef2f7", color: "#64748b" }}>vs ontem: amanhã</span>
            )}
          </div>
          <div style={{ ...estilos.heroNum, color: "#1e40af" }}>{moeda(projecao)}</div>
          <div style={{ ...estilos.heroNota, color: "#1e40af" }}>
            {pctProj}% da meta{temVsOntem ? ` · ontem projetava ${moeda(hist.projecao_ontem)}` : ""}
          </div>
        </div>
      </div>

      {/* RECUPERAÇÃO POR DIA — cada dia vs a média do mês (acima/abaixo). */}
      <div style={estilos.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>📅 Recuperação por dia</h3>
          <span style={{ fontSize: 12.5, color: "#64748b" }}>
            Média diária do mês (só dias fechados): <strong style={{ color: "#0d1321" }}>{moeda(media)}</strong> · verde acima, vermelho abaixo
          </span>
        </div>
        {diasHist.length === 0 ? (
          <p style={{ opacity: 0.7, marginTop: 10 }}>Sem lançamentos no mês ainda.</p>
        ) : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 200, borderBottom: `1px solid ${BORDA}`, overflowX: "auto", paddingTop: 20, marginTop: 12 }}>
            {diasHist.map((d) => {
              const v = Number(d.valor_recuperado) || 0;
              // Dia corrente = ainda ABERTO: mostra o valor, mas sem comparar
              // com a média (o dinheiro do dia só fecha amanhã).
              const aberto = String(d.dia).slice(0, 10) === hoje;
              const acima = v >= media;
              const h = Math.max((v / maxDia) * 150, v > 0 ? 3 : 0);
              const difPct = media > 0 ? Math.round(((v - media) / media) * 100) : 0;
              return (
                <div key={d.dia} style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", minWidth: 46, height: "100%" }} title={aberto ? `${ddmm(d.dia)}: ${moeda(v)} — dia em aberto, fora da média` : `${ddmm(d.dia)}: ${moeda(v)} (${difPct >= 0 ? "+" : ""}${difPct}% vs média)`}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: aberto ? "#94a3b8" : acima ? VERDE : VERM, height: 14 }}>
                    {aberto ? "em aberto" : v > 0 ? (acima ? "▲" : "▼") + (difPct >= 0 ? "+" : "") + difPct + "%" : ""}
                  </div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: "#0d1321", marginBottom: 4 }}>
                    {v >= 1000 ? "R$" + (v / 1000).toFixed(0) + "k" : v > 0 ? "R$" + v.toFixed(0) : "—"}
                  </div>
                  <div style={{ width: 26, height: h, background: aberto ? "#cbd5e1" : acima ? AZUL : "#f59e0b", borderRadius: "4px 4px 0 0" }} />
                  <div style={{ fontSize: 11, color: "#64748b", marginTop: 5 }}>{ddmm(d.dia)}</div>
                </div>
              );
            })}
          </div>
        )}
        <p style={{ color: "#8a93a3", fontSize: 12, marginTop: 10 }}>
          Barras azuis = dias acima da média do mês; laranja = abaixo. A seta mostra o quanto o dia ficou acima/abaixo do normal.
          A barra cinza é o dia de hoje: como boleto e parte dos cartões só entram no dia seguinte, o dia em aberto fica fora da média.
        </p>
      </div>

      {/* PROJEÇÃO AO LONGO DO MÊS — série do histórico diário (quando houver). */}
      {hist?.serie && hist.serie.length >= 2 && (
        <div style={estilos.card}>
          <h3 style={{ margin: "0 0 4px" }}>📈 Projeção de fechamento — evolução no mês</h3>
          <p style={{ opacity: 0.6, fontSize: 12.5, margin: "0 0 12px" }}>
            Como a projeção do honorário mudou a cada atualização. Subir = ritmo melhorando; cair = ritmo desacelerando.
          </p>
          {(() => {
            const serie = hist.serie.filter((s) => Number(s.projecao_honorario) > 0);
            const maxP = Math.max(1, ...serie.map((s) => Number(s.projecao_honorario) || 0));
            const meta = Number(serie[serie.length - 1]?.meta_honorario) || 0;
            return (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 150, borderBottom: `1px solid ${BORDA}`, overflowX: "auto" }}>
                {serie.map((s, i) => {
                  const v = Number(s.projecao_honorario) || 0;
                  const prev = i > 0 ? Number(serie[i - 1].projecao_honorario) || 0 : null;
                  const subiu = prev == null ? true : v >= prev;
                  const h = Math.max((v / maxP) * 120, 3);
                  return (
                    <div key={s.dia} style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", minWidth: 54, height: "100%" }} title={`${ddmm(s.dia)}: ${moeda(v)}${meta ? ` (${Math.round((v / meta) * 100)}% da meta)` : ""}`}>
                      <div style={{ fontSize: 10.5, fontWeight: 700, color: subiu ? VERDE : VERM }}>{prev == null ? "" : subiu ? "▲" : "▼"}</div>
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: "#0d1321", marginBottom: 4 }}>{"R$" + (v / 1000).toFixed(0) + "k"}</div>
                      <div style={{ width: 28, height: h, background: subiu ? "#1e40af" : "#f59e0b", borderRadius: "4px 4px 0 0" }} />
                      <div style={{ fontSize: 11, color: "#64748b", marginTop: 5 }}>{ddmm(s.dia)}</div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

const estilos = {
  heroRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 },
  heroCard: { background: "#fff", border: `1px solid ${BORDA}`, borderRadius: 14, padding: "18px 20px" },
  heroCardProj: { background: "#eff6ff", border: "2px solid #2563eb" },
  heroRot: { fontSize: 13, color: "#64748b", fontWeight: 600, marginBottom: 8 },
  heroNum: { fontSize: 34, fontWeight: 800, color: "#0d1321", lineHeight: 1, letterSpacing: "-0.02em" },
  heroNota: { fontSize: 12.5, color: "#94a3b8", marginTop: 8 },
  pill: { fontSize: 12, fontWeight: 700, padding: "2px 10px", borderRadius: 999, whiteSpace: "nowrap" },
  card: { background: "#fff", border: `1px solid ${BORDA}`, borderRadius: 12, padding: "16px 18px", marginBottom: 14 },
};
