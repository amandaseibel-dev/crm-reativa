import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const SEG_POR_TELA = 12;
const ATUALIZAR_DADOS = 60;

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}

export default function TvElogios() {
  const [dados, setDados] = useState(null);
  const [elogios, setElogios] = useState([]);
  const [urlElogio, setUrlElogio] = useState("");
  const [indice, setIndice] = useState(0);

  useEffect(() => {
    carregarDados();
    carregarElogios();
    const t1 = setInterval(carregarDados, ATUALIZAR_DADOS * 1000);
    const t2 = setInterval(carregarElogios, ATUALIZAR_DADOS * 1000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, []);

  async function carregarDados() {
    const { data } = await supabase.rpc("dashboard_tv");
    setDados(data || null);
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
    const base = ["meta", "ranking", "ultima"];
    const els = (elogios || []).map((e) => ({ tipo: "elogio", elogio: e }));
    return [...base.map((t) => ({ tipo: t })), ...els];
  }, [elogios]);

  useEffect(() => {
    if (telas.length === 0) return;
    const t = setInterval(() => setIndice((i) => (i + 1) % telas.length), SEG_POR_TELA * 1000);
    return () => clearInterval(t);
  }, [telas]);

  const atual = telas[indice % (telas.length || 1)] || { tipo: "meta" };

  useEffect(() => {
    if (atual.tipo !== "elogio" || !atual.elogio?.elogio_print_path) { setUrlElogio(""); return; }
    let ativo = true;
    supabase.storage.from("elogios-prints").createSignedUrl(atual.elogio.elogio_print_path, 3600)
      .then(({ data }) => { if (ativo) setUrlElogio(data?.signedUrl || ""); });
    return () => { ativo = false; };
  }, [atual]);

  const d = dados || {};
  const meta = Number(d.meta_mes) || 0;
  const pctMeta = meta > 0 ? Math.min(100, Math.round((Number(d.recuperado_mes) / meta) * 100)) : 0;
  const rank = d.ranking_semana || [];
  const maxRank = Math.max(1, ...rank.map((x) => Number(x.recuperado) || 0));

  return (
    <div style={S.tv}>
      <div style={S.topo}>
        <span style={S.marca}>Re<span style={{ color: "#3b82f6" }}>A</span>TIVA</span>
        <span style={S.topoSub}>Recuperacao ULBRA · ao vivo</span>
      </div>

      {atual.tipo === "meta" && (
        <div style={S.tela}>
          <div style={S.rot}>Recuperado no mes</div>
          <div style={S.numGigante}>{moeda(d.recuperado_mes)}</div>
          <div style={S.metaLinha}>
            <div style={S.barraFundo}><div style={{ ...S.barra, width: pctMeta + "%" }} /></div>
            <div style={S.metaTexto}>{meta ? pctMeta + "% da meta (" + moeda(meta) + ")" : "Meta nao cadastrada"}</div>
          </div>
          <div style={S.linhaCartoes}>
            <Cartao rot="Hoje" val={moeda(d.recuperado_dia)} />
            <Cartao rot="Alunos pagos (mes)" val={num(d.alunos_pagos_mes)} />
            <Cartao rot="Alunos pagos (hoje)" val={num(d.alunos_pagos_dia)} />
          </div>
        </div>
      )}

      {atual.tipo === "ranking" && (
        <div style={S.tela}>
          <div style={S.rotBig}>🏆 Melhores da semana</div>
          <div style={S.podio}>
            {[{ o: rank[1], pos: 2 }, { o: rank[0], pos: 1 }, { o: rank[2], pos: 3 }].map((item, idx) => {
              const o = item.o;
              if (!o) return <div key={idx} style={{ flex: 1, maxWidth: "22vw" }} />;
              const alturas = { 1: "32vh", 2: "23vh", 3: "18vh" };
              const cores = { 1: "linear-gradient(180deg, #fde68a, #f59e0b)", 2: "linear-gradient(180deg, #e2e8f0, #94a3b8)", 3: "linear-gradient(180deg, #fdba74, #c2843f)" };
              const medalha = { 1: "🥇", 2: "🥈", 3: "🥉" };
              return (
                <div key={idx} style={S.podioCol}>
                  <div style={{ ...S.podioMedalha, fontSize: item.pos === 1 ? "5vw" : "3.6vw" }}>{medalha[item.pos]}</div>
                  <div style={{ ...S.podioNome, fontSize: item.pos === 1 ? "2.4vw" : "1.9vw" }}>{o.operador}</div>
                  <div style={{ ...S.podioValor, fontSize: item.pos === 1 ? "2.8vw" : "2.2vw" }}>{moeda(o.recuperado)}</div>
                  <div style={{ ...S.podioBase, height: alturas[item.pos], background: cores[item.pos] }}>
                    <span style={S.podioPos}>{item.pos}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={S.rankResto}>
            {rank.slice(3).map((o, i) => (
              <div key={o.operador} style={S.rankRestoItem}><span>{i + 4}. {o.operador}</span><strong style={{ color: "#22c55e" }}>{moeda(o.recuperado)}</strong></div>
            ))}
          </div>
        </div>
      )}

      {atual.tipo === "ultima" && (
        <div style={S.tela}>
          <div style={S.rot}>Ultima recuperacao</div>
          {d.ultima_recuperacao ? (
            <>
              <div style={S.numGigante}>{moeda(d.ultima_recuperacao.valor)}</div>
              <div style={S.ultimaAluno}>{d.ultima_recuperacao.aluno}</div>
              <div style={S.ultimaMeta}>por {d.ultima_recuperacao.operador} · {d.ultima_recuperacao.quando}</div>
            </>
          ) : <div style={S.ultimaMeta}>Nenhuma recuperacao ainda.</div>}
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
        {telas.map((_, i) => (
          <span key={i} style={{ ...S.ponto, background: i === (indice % telas.length) ? "#3b82f6" : "#334155" }} />
        ))}
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
  tv: { minHeight: "100vh", background: "radial-gradient(circle at 20% 15%, rgba(37,99,235,0.28), transparent 40%), radial-gradient(circle at 85% 80%, rgba(34,197,94,0.18), transparent 42%), linear-gradient(135deg, #020617, #0b1224 55%, #0f172a)", color: "#fff", fontFamily: "Inter, Arial, sans-serif", display: "flex", flexDirection: "column", padding: "3vh 4vw", boxSizing: "border-box" },
  topo: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "2vh" },
  marca: { fontSize: "3.2vw", fontWeight: 800, letterSpacing: "0.06em", textShadow: "0 0 30px rgba(59,130,246,0.6)" },
  topoSub: { fontSize: "1.3vw", color: "#7dd3fc", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.15em" },
  tela: { flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", gap: "2vh" },
  rot: { fontSize: "2.2vw", color: "#7dd3fc", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.14em", textShadow: "0 0 20px rgba(59,130,246,0.5)" },
  rotBig: { fontSize: "3.4vw", color: "#fbbf24", fontWeight: 900, letterSpacing: "0.04em", textShadow: "0 0 34px rgba(251,191,36,0.55)" },
  numGigante: { fontSize: "10vw", fontWeight: 900, lineHeight: 1, color: "#4ade80", textShadow: "0 0 45px rgba(34,197,94,0.65), 0 0 12px rgba(34,197,94,0.9)" },
  metaLinha: { width: "70%" },
  barraFundo: { background: "#1e293b", borderRadius: 999, height: "2.2vh", overflow: "hidden" },
  barra: { height: "100%", background: "linear-gradient(90deg, #3b82f6, #2563eb)", borderRadius: 999 },
  metaTexto: { fontSize: "1.6vw", color: "#cbd5e1", marginTop: "1vh" },
  linhaCartoes: { display: "flex", gap: "2vw", marginTop: "2vh" },
  cartao: { background: "rgba(255,255,255,0.05)", borderRadius: 16, padding: "2vh 2.5vw", minWidth: "14vw" },
  cartaoVal: { fontSize: "3vw", fontWeight: 800 },
  cartaoRot: { fontSize: "1.2vw", color: "#94a3b8", marginTop: "0.5vh" },
  podio: { display: "flex", alignItems: "flex-end", justifyContent: "center", gap: "3vw", width: "88%", marginTop: "1vh" },
  podioCol: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", maxWidth: "24vw" },
  podioMedalha: { lineHeight: 1, filter: "drop-shadow(0 0 18px rgba(251,191,36,0.5))" },
  podioNome: { fontWeight: 900, marginTop: "0.6vh" },
  podioValor: { fontWeight: 900, color: "#4ade80", margin: "0.4vh 0 1vh", textShadow: "0 0 24px rgba(34,197,94,0.6)" },
  podioBase: { width: "100%", borderRadius: "16px 16px 0 0", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "1.2vh", boxShadow: "0 -10px 50px rgba(59,130,246,0.5)" },
  podioPos: { fontSize: "6vw", fontWeight: 900, color: "rgba(2,6,23,0.5)" },
  rankResto: { display: "flex", flexWrap: "wrap", gap: "1vh 3vw", justifyContent: "center", marginTop: "3vh", width: "72%" },
  rankRestoItem: { display: "flex", gap: "1vw", fontSize: "1.5vw", color: "#cbd5e1", fontWeight: 600 },
  ultimaAluno: { fontSize: "3vw", fontWeight: 700 },
  ultimaMeta: { fontSize: "1.6vw", color: "#94a3b8" },
  imagem: { maxWidth: "70vw", maxHeight: "58vh", borderRadius: 16, objectFit: "contain", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" },
  pontos: { display: "flex", gap: "0.8vw", justifyContent: "center", marginTop: "2vh" },
  ponto: { width: "1vw", height: "1vw", borderRadius: "50%", display: "inline-block" },
};
