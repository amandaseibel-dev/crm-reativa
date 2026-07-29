import { useCallback, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import usePolling from "../utils/polling";

// ============================================================================
// TV ReATIVA — CARD ÚNICO "RESULTADO DO MÊS"
// ----------------------------------------------------------------------------
// Substitui o antigo carrossel (pódios, rankings, elogios, dicas) por um único
// card central, grande e legível à distância, para exibição em Smart TV / HDMI.
//
// FONTE DE DADOS (leve e segura, a mesma da nova Projeção):
//   supabase.rpc("projecao_snapshot_ler", { p_mes })
//   -> lê o último snapshot pré-computado (1 SELECT por PK no backend).
//   NÃO usa projecao_dashboard, dashboard_tv nem consultas pesadas.
//   NÃO usa service_role (client anon padrão). Sem polling agressivo.
//
// VALOR EXIBIDO: honorário consolidado do mês da filial (payload.honorario_mes_filial),
//   o mesmo número que a campanha da Projeção mede contra a meta de R$ 500 mil.
//
// META: fixa em R$ 500.000,00 (definida em código — ver META).
//
// ATUALIZAÇÃO: no máximo a cada 5 minutos (usePolling pausa em aba oculta e
//   dispara ao voltar o foco). Em caso de erro, mantém o último valor válido em
//   tela e mostra discretamente "Atualização pendente" (sem stack trace, sem
//   tela branca, sem expor resposta da RPC).
// ============================================================================

const META = 500000; // Meta fixa do mês, em reais.
const ATUALIZAR_MS = 5 * 60 * 1000; // 5 minutos.

function mesAtualISO() {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
}

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function dataHora(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function TvElogios() {
  // Último valor VÁLIDO exibido. Preservado entre atualizações e em falhas.
  const [valor, setValor] = useState(null); // number | null
  const [atualizadoEm, setAtualizadoEm] = useState(null); // ISO | null
  const [pendente, setPendente] = useState(false); // true = última leitura falhou
  const jaCarregouRef = useRef(false);

  const carregar = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("projecao_snapshot_ler", {
        p_mes: mesAtualISO(),
      });
      if (error) throw error;
      const payload = data?.dados;
      const bruto =
        payload?.honorario_mes_filial ??
        payload?.honorario_mes ??
        null;
      if (bruto == null || isNaN(Number(bruto))) {
        // Snapshot ainda sem número utilizável: preserva o que já está em tela.
        if (!jaCarregouRef.current) setPendente(true);
        return;
      }
      setValor(Number(bruto));
      setAtualizadoEm(data?.atualizado_em || null);
      setPendente(false);
      jaCarregouRef.current = true;
    } catch {
      // Falha de rede / RPC: mantém o último valor válido; sinaliza pendência.
      setPendente(true);
    }
  }, []);

  // Uma leitura leve a cada 5 min (pausa em aba oculta, dispara ao voltar foco).
  usePolling(carregar, ATUALIZAR_MS, [], true);

  const pct = useMemo(() => {
    if (valor == null) return null;
    return (valor / META) * 100;
  }, [valor]);

  const superada = valor != null && valor >= META;
  const restante = valor == null ? null : Math.max(0, META - valor);
  const larguraBarra = superada ? 100 : Math.max(0, Math.min(100, pct || 0));
  const pctTexto = pct == null ? "—" : `${pct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

  return (
    <div style={S.tv}>
      <style>{ANIM}</style>

      <div style={S.card}>
        <div style={S.brilho} aria-hidden />

        <div style={S.titulo}>RESULTADO DO MÊS</div>

        <div style={S.blocoValor}>
          <div style={S.rotuloGrande}>HONORÁRIO</div>
          <div style={S.valorGigante}>{valor == null ? "—" : moeda(valor)}</div>
        </div>

        <div style={S.metaLinha}>
          <span style={S.metaLabel}>META</span>
          <span style={S.metaValor}>{moeda(META)}</span>
        </div>

        <div style={S.barraFundo}>
          <div style={{ ...S.barraPreench, width: `${larguraBarra}%` }} />
        </div>

        <div style={S.linhaInferior}>
          {superada ? (
            <span style={S.selo}>META SUPERADA</span>
          ) : (
            <span style={S.pct}>{pctTexto} da meta</span>
          )}
          <span style={S.restante}>
            {superada
              ? "🎉 acima da meta"
              : restante == null
              ? "—"
              : `Faltam ${moeda(restante)}`}
          </span>
        </div>

        {superada && <div style={S.pctSuperado}>{pctTexto} da meta</div>}

        <div style={S.rodape}>
          <span>Atualizado em {dataHora(atualizadoEm)}</span>
          {pendente && <span style={S.pendente}>· Atualização pendente</span>}
        </div>
      </div>
    </div>
  );
}

const ANIM = `@keyframes barraBrilho{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}`;

const S = {
  tv: {
    minHeight: "100vh",
    width: "100%",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "5vh 5vw",
    background:
      "radial-gradient(circle at 18% 12%, rgba(37,99,235,0.30), transparent 42%), radial-gradient(circle at 85% 85%, rgba(34,197,94,0.18), transparent 45%), linear-gradient(135deg, #020617, #0b1224 55%, #0f172a)",
    color: "#fff",
    fontFamily: "Inter, Arial, sans-serif",
  },
  card: {
    position: "relative",
    width: "100%",
    maxWidth: "1500px",
    background: "linear-gradient(160deg, rgba(15,23,42,0.92), rgba(2,6,23,0.92))",
    border: "1px solid rgba(59,130,246,0.28)",
    borderRadius: "34px",
    padding: "6vh 5vw",
    boxShadow:
      "0 40px 120px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    overflow: "hidden",
  },
  brilho: {
    position: "absolute",
    top: "-40%",
    left: "-10%",
    width: "60%",
    height: "180%",
    background:
      "radial-gradient(closest-side, rgba(59,130,246,0.16), transparent)",
    pointerEvents: "none",
  },
  titulo: {
    fontSize: "2vw",
    fontWeight: 800,
    color: "#7dd3fc",
    letterSpacing: "0.28em",
    textTransform: "uppercase",
    marginBottom: "1.5vh",
  },
  blocoValor: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.6vh",
    margin: "1vh 0 3vh",
  },
  rotuloGrande: {
    fontSize: "1.9vw",
    fontWeight: 800,
    color: "#93c5fd",
    letterSpacing: "0.22em",
    textTransform: "uppercase",
  },
  valorGigante: {
    fontSize: "11vw",
    fontWeight: 900,
    lineHeight: 1,
    color: "#4ade80",
    textShadow:
      "0 0 55px rgba(34,197,94,0.55), 0 0 14px rgba(34,197,94,0.85)",
    whiteSpace: "nowrap",
  },
  metaLinha: {
    display: "flex",
    alignItems: "baseline",
    gap: "1.2vw",
    marginBottom: "2.6vh",
  },
  metaLabel: {
    fontSize: "1.4vw",
    fontWeight: 800,
    color: "#64748b",
    letterSpacing: "0.24em",
  },
  metaValor: {
    fontSize: "2.6vw",
    fontWeight: 800,
    color: "#e2e8f0",
  },
  barraFundo: {
    width: "100%",
    height: "4vh",
    background: "rgba(148,163,184,0.16)",
    borderRadius: "999px",
    overflow: "hidden",
    boxShadow: "inset 0 0 22px rgba(0,0,0,0.45)",
  },
  barraPreench: {
    height: "100%",
    background: "linear-gradient(90deg, #3b82f6, #22c55e)",
    borderRadius: "999px",
    boxShadow: "0 0 34px rgba(52,211,153,0.75)",
    transition: "width 900ms cubic-bezier(0.16,1,0.3,1)",
  },
  linhaInferior: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: "2.4vh",
    gap: "2vw",
  },
  pct: {
    fontSize: "2.4vw",
    fontWeight: 900,
    color: "#fff",
  },
  pctSuperado: {
    fontSize: "2.2vw",
    fontWeight: 900,
    color: "#fbbf24",
    marginTop: "1.6vh",
  },
  selo: {
    fontSize: "2vw",
    fontWeight: 900,
    color: "#052e16",
    background: "linear-gradient(90deg, #fbbf24, #f59e0b)",
    padding: "1vh 2.4vw",
    borderRadius: "999px",
    letterSpacing: "0.14em",
    boxShadow: "0 0 40px rgba(251,191,36,0.5)",
  },
  restante: {
    fontSize: "1.9vw",
    fontWeight: 700,
    color: "#93c5fd",
  },
  rodape: {
    marginTop: "4vh",
    fontSize: "1.1vw",
    color: "#64748b",
    fontWeight: 600,
    display: "flex",
    gap: "0.6vw",
    alignItems: "center",
  },
  pendente: {
    color: "#fbbf24",
  },
};
