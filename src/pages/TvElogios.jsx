import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const SEG_POR_TELA = 12;
const ATUALIZAR_DADOS = 30;

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}

function Podio({ titulo, rank }) {
  const trio = [{ o: rank[1], pos: 2 }, { o: rank[0], pos: 1 }, { o: rank[2], pos: 3 }];
  const alturas = { 1: "32vh", 2: "23vh", 3: "18vh" };
  const cores = { 1: "linear-gradient(180deg, #fde68a, #f59e0b)", 2: "linear-gradient(180deg, #e2e8f0, #94a3b8)", 3: "linear-gradient(180deg, #fdba74, #c2843f)" };
  const medalha = { 1: "🥇", 2: "🥈", 3: "🥉" };
  return (
    <div style={S.tela}>
      <div style={S.rotBig}>🏆 {titulo}</div>
      <div style={S.podio}>
        {trio.map((item, idx) => {
          const o = item.o;
          if (!o) return <div key={idx} style={{ flex: 1, maxWidth: "24vw" }} />;
          return (
            <div key={idx} style={S.podioCol}>
              <div style={{ ...S.podioMedalha, fontSize: item.pos === 1 ? "5vw" : "3.6vw" }}>{medalha[item.pos]}</div>
              <div style={{ ...S.podioNome, fontSize: item.pos === 1 ? "2.4vw" : "1.9vw" }}>{o.operador}</div>
              <div style={{ ...S.podioBase, height: alturas[item.pos], background: cores[item.pos] }}>
                <span style={S.podioPos}>{item.pos}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div style={S.rankResto}>
        {rank.slice(3, 3).map((o, i) => (
          <div key={o.operador} style={S.rankRestoItem}><span>{i + 4}. {o.operador}</span><strong style={{ color: "#7dd3fc" }}>{num(o.pagos)} pgtos</strong></div>
        ))}
      </div>
    </div>
  );
}

export default function TvElogios() {
  const [dados, setDados] = useState(null);
  const [proj, setProj] = useState(null);
  const [rank, setRank] = useState(null);
  const [elogios, setElogios] = useState([]);
  const [dicas, setDicas] = useState([]);
  const [urlElogio, setUrlElogio] = useState("");
  const [indice, setIndice] = useState(0);

  useEffect(() => {
    async function carregarRank() {
      const { data } = await supabase.rpc("acionamentos_ranking");
      setRank(data || null);
    }
    carregarRank();
    const tr = setInterval(carregarRank, 60000);
    return () => clearInterval(tr);
  }, []);

  useEffect(() => {
    carregarDados();
    carregarElogios();
    carregarDicas();
    const t1 = setInterval(carregarDados, ATUALIZAR_DADOS * 1000);
    const t2 = setInterval(carregarElogios, ATUALIZAR_DADOS * 1000);
    const t3 = setInterval(carregarDicas, ATUALIZAR_DADOS * 1000);
    // Blindagem para TV 24h: recarrega a pagina inteira a cada 10 min, para
    // se recuperar caso o navegador congele/perca o tempo real em segundo plano.
    const t4 = setInterval(() => { try { window.location.reload(); } catch (e) {} }, 10 * 60 * 1000);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); clearInterval(t4); };
  }, []);

  async function carregarDicas() {
    const { data } = await supabase
      .from("tv_dicas")
      .select("id, categoria, titulo, texto, ordem")
      .eq("ativo", true)
      .order("ordem", { ascending: true });
    setDicas(Array.isArray(data) ? data : []);
  }

  async function carregarDados() {
    const { data } = await supabase.rpc("dashboard_tv");
    setDados(data || null);
    const r = await supabase.rpc("dashboard_tv_projecao");
    setProj(r.data || null);
  }

  async function carregarElogios() {
    const { data } = await supabase
      .from("aluno_movimentacoes")
      .select("id, aluno_id, descricao, registrado_por_nome, registrado_em, elogio_print_path")
      .eq("status_novo", "ELOGIO_ATENDIMENTO")
      .eq("elogio_aprovado_tv", true)
      .order("registrado_em", { ascending: false })
      .limit(20);
    setElogios(Array.isArray(data) ? data : []);
  }

  const telas = useMemo(() => {
    const base = ["semana", "mes", "resultado", "projecao", "alunos", "maior", "topdia", "tophondia", "topmes"];
    const dcs = (dicas || []).map((x) => ({ tipo: "dica", dica: x }));
    const els = (elogios || []).map((e) => ({ tipo: "elogio", elogio: e }));
    return [...base.map((t) => ({ tipo: t })), ...dcs, ...els];
  }, [elogios, dicas]);

  useEffect(() => {
    if (telas.length === 0) return;
    const t = setInterval(() => setIndice((i) => (i + 1) % telas.length), SEG_POR_TELA * 1000);
    return () => clearInterval(t);
  }, [telas]);

  useEffect(() => {
    function onKey(e) {
      const n = telas.length || 1;
      if (e.key === "ArrowRight") setIndice((i) => (i + 1) % n);
      else if (e.key === "ArrowLeft") setIndice((i) => (i - 1 + n) % n);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [telas]);

  const atual = telas[indice % (telas.length || 1)] || { tipo: "semana" };

  useEffect(() => {
    if (atual.tipo !== "elogio" || !atual.elogio?.elogio_print_path) { setUrlElogio(""); return; }
    let ativo = true;
    supabase.storage.from("elogios-prints").createSignedUrl(atual.elogio.elogio_print_path, 3600)
      .then(({ data }) => { if (ativo) setUrlElogio(data?.signedUrl || ""); });
    return () => { ativo = false; };
  }, [atual]);

  const d = dados || {};
  const p = proj || {};
  const dpr = p.delta_proj_recuperado;
  const deltaCor = dpr == null ? "#93c5fd" : dpr > 0 ? "#4ade80" : dpr < 0 ? "#f87171" : "#93c5fd";
  const deltaTxt = dpr == null ? "comparativo com ontem começa amanhã"
    : dpr > 0 ? "▲ subiu " + moeda(dpr) + " vs ontem"
    : dpr < 0 ? "▼ caiu " + moeda(Math.abs(dpr)) + " vs ontem"
    : "= igual a ontem";

  return (
    <div style={S.tv}>
      <div style={S.topo}>
        <span style={S.marca}>Re<span style={{ color: "#3b82f6" }}>A</span>TIVA</span>
        <span style={S.topoSub}>Recuperação ULBRA · ao vivo</span>
      </div>

      {atual.tipo === "semana" && <Podio titulo="Melhores da semana" rank={d.ranking_semana || []} />}
      {atual.tipo === "mes" && <Podio titulo="Melhores do mês" rank={d.ranking_mes || []} />}

      {atual.tipo === "resultado" && (
        <div style={S.tela}>
          <div style={S.rot}>Resultado do mês</div>
          <div style={S.numGigante}>{moeda(p.recuperado_mes)}</div>
          {p.pct_meta != null ? (
            <div style={S.metaLinha}>
              <div style={S.barraFundo}><div style={{ ...S.barra, width: Math.min(100, p.pct_meta) + "%" }} /></div>
              <div style={S.metaTexto}>{p.pct_meta}% da meta ({moeda(p.meta)})</div>
            </div>
          ) : <div style={S.ultimaMeta}>Meta não cadastrada</div>}
          <div style={S.linhaCartoes}>
            <Cartao rot="Honorários" val={moeda(p.honorarios_mes)} />
            <Cartao rot="Falta p/ meta" val={p.falta != null ? moeda(p.falta) : "-"} />
            <Cartao rot={"Precisa/dia (" + (p.dias_restantes || "-") + "d)"} val={p.precisa_por_dia != null ? moeda(p.precisa_por_dia) : "-"} />
          </div>
        </div>
      )}

      {atual.tipo === "projecao" && (
        <div style={S.tela}>
          <div style={S.rot}>Projeção do mês</div>
          <div style={S.numGigante}>{moeda(p.proj_recuperado)}</div>
          <div style={{ ...S.projDelta, color: deltaCor }}>{deltaTxt}</div>
          <div style={S.ultimaMeta}>Honorários projetados: {moeda(p.proj_honorarios)}</div>
        </div>
      )}

      {atual.tipo === "alunos" && (
        <div style={S.tela}>
          <div style={S.rot}>Alunos recuperados no mês</div>
          <div style={S.numGigante}>{num(d.alunos_pagos_mes)}</div>
          <div style={S.linhaCartoes}>
            <Cartao rot="Recuperados hoje" val={num(d.alunos_pagos_dia)} />
            <Cartao rot="No mês" val={num(d.alunos_pagos_mes)} />
          </div>
        </div>
      )}

      {atual.tipo === "maior" && (
        <div style={S.tela}>
          <div style={S.rotBig}>💰 Maior pagamento do mês</div>
          {d.maior_pagamento ? (
            <>
              <div style={S.numGigante}>{moeda(d.maior_pagamento.valor)}</div>
              <div style={S.ultimaAluno}>{d.maior_pagamento.aluno}</div>
              <div style={S.ultimaMeta}>por {d.maior_pagamento.operador} · {d.maior_pagamento.quando}</div>
            </>
          ) : <div style={S.ultimaMeta}>Sem pagamentos ainda.</div>}
        </div>
      )}

      {atual.tipo === "topdia" && (
        <div style={S.tela}>
          <div style={S.rotBig}>🏆 Top 3 acionamentos — Hoje</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "2.4vh", marginTop: "3vh" }}>
            {(((rank && rank.top_dia) || []).length === 0) ? (
              <div style={S.ultimaMeta}>Sem acionamentos hoje ainda.</div>
            ) : (rank.top_dia).map((o, i) => (
              <div key={i} style={{ fontSize: "3.4vw", fontWeight: 900, color: "#fff", textShadow: "0 0 22px rgba(59,130,246,0.5)" }}>
                {(["🥇", "🥈", "🥉"][i] || "")} {o.nome}
              </div>
            ))}
          </div>
        </div>
      )}
      {atual.tipo === "tophondia" && (
        <div style={S.tela}>
          <div style={S.rotBig}>💰 Top 3 honorários — Hoje</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "2.4vh", marginTop: "3vh" }}>
            {(((rank && rank.top_hon_dia) || []).length === 0) ? (
              <div style={S.ultimaMeta}>Sem honorários registrados hoje ainda.</div>
            ) : (rank.top_hon_dia).map((o, i) => (
              <div key={i} style={{ fontSize: "3.4vw", fontWeight: 900, color: "#fff", textShadow: "0 0 22px rgba(52,211,153,0.5)" }}>
                {(["🥇", "🥈", "🥉"][i] || "")} {o.nome}
              </div>
            ))}
          </div>
        </div>
      )}

      {atual.tipo === "topmes" && (
        <div style={S.tela}>
          <div style={S.rotBig}>🏆 Top 3 acionamentos — Mês</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "2.4vh", marginTop: "3vh" }}>
            {(((rank && rank.top_mes) || []).length === 0) ? (
              <div style={S.ultimaMeta}>Sem dados ainda.</div>
            ) : (rank.top_mes).map((o, i) => (
              <div key={i} style={{ fontSize: "3.4vw", fontWeight: 900, color: "#fff", textShadow: "0 0 22px rgba(59,130,246,0.5)" }}>
                {(["🥇", "🥈", "🥉"][i] || "")} {o.nome}
              </div>
            ))}
          </div>
        </div>
      )}

      {atual.tipo === "dica" && (
        <div style={S.tela}>
          <div style={S.dicaBadge}>{atual.dica?.categoria}</div>
          <div style={S.dicaTitulo}>{atual.dica?.titulo}</div>
          <div style={S.dicaTexto}>{atual.dica?.texto}</div>
        </div>
      )}

      {atual.tipo === "elogio" && (
        <div style={S.tela}>
          <div style={S.rot}>Elogio de atendimento</div>
          {urlElogio ? <img src={urlElogio} alt="Elogio" style={S.imagem} /> : null}
          <div style={S.ultimaMeta}>{atual.elogio?.registrado_por_nome || ""}</div>
        </div>
      )}

      <div style={S.pontos}>
        <button type="button" onClick={() => setIndice((i) => (i - 1 + (telas.length || 1)) % (telas.length || 1))} style={S.navBtn} aria-label="Slide anterior">‹</button>
        {telas.map((_, i) => (
          <span key={i} onClick={() => setIndice(i)} style={{ ...S.ponto, cursor: "pointer", background: i === (indice % telas.length) ? "#3b82f6" : "#334155" }} />
        ))}
        <button type="button" onClick={() => setIndice((i) => (i + 1) % (telas.length || 1))} style={S.navBtn} aria-label="Próximo slide">›</button>
      </div>
    </div>
  );
}

function Cartao({ rot, val }) {
  return (
    <div style={S.cartao}>
      <div style={S.cartaoVal}>{val}</div>
      <div style={S.cartaoRot}>{rot}</div>
    </div>
  );
}

const S = {
  tv: { minHeight: "100vh", background: "radial-gradient(circle at 20% 15%, rgba(37,99,235,0.28), transparent 40%), radial-gradient(circle at 85% 80%, rgba(34,197,94,0.16), transparent 42%), linear-gradient(135deg, #020617, #0b1224 55%, #0f172a)", color: "#fff", fontFamily: "Inter, Arial, sans-serif", display: "flex", flexDirection: "column", padding: "3vh 4vw", boxSizing: "border-box" },
  topo: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "2vh" },
  marca: { fontSize: "3.2vw", fontWeight: 800, letterSpacing: "0.06em", textShadow: "0 0 30px rgba(59,130,246,0.6)" },
  topoSub: { fontSize: "1.3vw", color: "#7dd3fc", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.15em" },
  tela: { flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", gap: "2vh" },
  rot: { fontSize: "2.2vw", color: "#7dd3fc", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.14em", textShadow: "0 0 20px rgba(59,130,246,0.5)" },
  rotBig: { fontSize: "3.6vw", color: "#fbbf24", fontWeight: 900, letterSpacing: "0.04em", textShadow: "0 0 34px rgba(251,191,36,0.55)" },
  numGigante: { fontSize: "11vw", fontWeight: 900, lineHeight: 1, color: "#4ade80", textShadow: "0 0 45px rgba(34,197,94,0.65), 0 0 12px rgba(34,197,94,0.9)" },
  metaLinha: { width: "68%" },
  barraFundo: { background: "#1e293b", borderRadius: 999, height: "2.4vh", overflow: "hidden", boxShadow: "inset 0 0 12px rgba(0,0,0,0.4)" },
  barra: { height: "100%", background: "linear-gradient(90deg, #3b82f6, #22c55e)", borderRadius: 999 },
  metaTexto: { fontSize: "1.7vw", color: "#e2e8f0", marginTop: "1vh", fontWeight: 700 },
  linhaCartoes: { display: "flex", gap: "2vw", marginTop: "2vh", flexWrap: "wrap", justifyContent: "center" },
  cartao: { background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.35)", borderRadius: 18, padding: "2vh 3vw", minWidth: "16vw" },
  cartaoVal: { fontSize: "3.4vw", fontWeight: 900, color: "#fff" },
  cartaoRot: { fontSize: "1.3vw", color: "#93c5fd", marginTop: "0.5vh", fontWeight: 600 },
  podio: { display: "flex", alignItems: "flex-end", justifyContent: "center", gap: "3vw", width: "88%", marginTop: "1vh" },
  podioCol: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", maxWidth: "24vw" },
  podioMedalha: { lineHeight: 1, filter: "drop-shadow(0 0 18px rgba(251,191,36,0.5))" },
  podioNome: { fontWeight: 900, marginTop: "0.6vh" },
  podioValor: { fontWeight: 900, color: "#7dd3fc", margin: "0.4vh 0 1vh", textShadow: "0 0 22px rgba(59,130,246,0.6)" },
  podioBase: { width: "100%", borderRadius: "16px 16px 0 0", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "1.2vh", boxShadow: "0 -10px 50px rgba(59,130,246,0.5)" },
  podioPos: { fontSize: "6vw", fontWeight: 900, color: "rgba(2,6,23,0.5)" },
  rankResto: { display: "flex", flexWrap: "wrap", gap: "1vh 3vw", justifyContent: "center", marginTop: "3vh", width: "72%" },
  rankRestoItem: { display: "flex", gap: "1vw", fontSize: "1.5vw", color: "#cbd5e1", fontWeight: 600 },
  projDelta: { fontSize: "2vw", fontWeight: 800, marginTop: "0.5vh" },
  ultimaAluno: { fontSize: "3.2vw", fontWeight: 800 },
  ultimaMeta: { fontSize: "1.7vw", color: "#93c5fd", fontWeight: 600 },
  imagem: { maxWidth: "70vw", maxHeight: "58vh", borderRadius: 16, objectFit: "contain", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" },
  dicaBadge: { fontSize: "1.5vw", fontWeight: 800, color: "#0b1224", background: "linear-gradient(90deg, #60a5fa, #22c55e)", padding: "0.8vh 2.2vw", borderRadius: 999, textTransform: "uppercase", letterSpacing: "0.14em", boxShadow: "0 0 30px rgba(59,130,246,0.5)" },
  dicaTitulo: { fontSize: "4.4vw", fontWeight: 900, color: "#fff", textShadow: "0 0 30px rgba(59,130,246,0.5)", lineHeight: 1.05 },
  dicaTexto: { fontSize: "2.4vw", fontWeight: 600, color: "#dbeafe", maxWidth: "78vw", lineHeight: 1.4 },
  pontos: { display: "flex", gap: "0.8vw", justifyContent: "center", marginTop: "2vh" },
  ponto: { width: "1vw", height: "1vw", borderRadius: "50%", display: "inline-block" },
  navBtn: { background: "rgba(59,130,246,0.2)", color: "#fff", border: "1px solid rgba(59,130,246,0.45)", borderRadius: 10, width: "3.4vw", height: "3.4vw", fontSize: "2.2vw", cursor: "pointer", lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", margin: "0 1.5vw" },
};
