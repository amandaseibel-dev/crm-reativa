import { useEffect, useState } from "react";

// =============================================================================
// TV ReATIVA — DESIGN SYSTEM (Etapa 2)
// -----------------------------------------------------------------------------
// Componentes visuais reutilizáveis para exibição em Smart TV / HDMI.
// REGRA DE OURO: nenhum componente aqui consulta o banco. Todos recebem dados
// por PROPS (fatias do snapshot já carregado em memória na Etapa 1).
// Escala para Full HD e 4K via unidades de viewport + clamp; tipografia grande
// para leitura à distância; alto contraste; sem animações contínuas pesadas.
// =============================================================================

// Tokens ----------------------------------------------------------------------
export const T = {
  // Identidade ReATIVA: azul-marinho profundo + azul/verde de destaque.
  bg: "radial-gradient(circle at 18% 12%, rgba(37,99,235,0.22), transparent 42%), radial-gradient(circle at 85% 85%, rgba(34,197,94,0.14), transparent 45%), linear-gradient(140deg, #020617, #0b1224 55%, #0f172a)",
  surface: "rgba(148,163,184,0.10)",
  surfaceBorda: "rgba(148,163,184,0.22)",
  azul: "#3b82f6",
  azulClaro: "#7dd3fc",
  verde: "#4ade80",
  ambar: "#fbbf24",
  vermelho: "#f87171",
  texto: "#f8fafc",
  textoSuave: "#cbd5e1",
  textoMudo: "#93c5fd",
};

// fs(min, vw, max): fonte fluida — cresce com a resolução mas com limites.
export const fs = (min, vw, max) => `clamp(${min}px, ${vw}vw, ${max}px)`;

// Área segura: ~3% topo/base e ~4% laterais (evita corte por overscan de TV).
export const AREA_SEGURA = "clamp(14px, 3vh, 34px) clamp(24px, 4vw, 72px)";

// fsValor: fonte do NÚMERO principal, que ENCOLHE quando o valor é muito longo
// (ex.: "R$ 1.180.400") para não estourar o card / a tela.
export function fsValor(valor, grande) {
  const len = String(valor == null ? "" : valor).length;
  if (grande) {
    if (len > 12) return fs(22, 3.0, 60);
    if (len > 9) return fs(28, 3.8, 76);
    return fs(32, 4.4, 92);
  }
  if (len > 12) return fs(18, 2.2, 42);
  if (len > 9) return fs(20, 2.6, 52);
  return fs(24, 3.0, 62);
}

// Helpers de formatação (puros, sem I/O) -------------------------------------
export function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
export function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}

// Status de meta — NUNCA depende só de cor: sempre devolve um rótulo textual.
export function statusMeta(pct) {
  if (pct == null) return { label: "Meta não cadastrada", cor: T.textoSuave, tom: "neutro" };
  if (pct >= 100) return { label: "Meta atingida", cor: T.verde, tom: "bom" };
  if (pct >= 80) return { label: "Perto da meta", cor: T.ambar, tom: "atencao" };
  return { label: "Abaixo do ritmo", cor: T.vermelho, tom: "ruim" };
}

// Status de ritmo (projeção vs meta) para o Modo Fechamento.
export function statusRitmo(projetado, meta) {
  if (!meta) return { label: "Sem meta cadastrada", cor: T.textoSuave };
  if (projetado >= meta) return { label: "Acima do ritmo", cor: T.verde };
  if (projetado >= meta * 0.9) return { label: "Atenção", cor: T.ambar };
  return { label: "Abaixo do ritmo", cor: T.vermelho };
}

function fmtData(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString("pt-BR");
}
function fmtHora(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }).replace(":", "h");
}

// Marca ReATIVA ---------------------------------------------------------------
export function Marca({ tamanho = fs(22, 2.6, 60) }) {
  return (
    <span style={{ fontSize: tamanho, fontWeight: 900, letterSpacing: "0.04em", color: T.texto, textShadow: "0 0 30px rgba(59,130,246,0.55)" }}>
      Re<span style={{ color: T.azul }}>A</span>TIVA
    </span>
  );
}

// Cabeçalho: logo + nome da tela + data + relógio (atualizado LOCALMENTE) ------
export function Cabecalho({ tela }) {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    // Relógio local: setInterval de 1s no navegador. NÃO consulta o banco.
    const t = setInterval(() => setAgora(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <header style={s.cab}>
      <div style={{ display: "flex", alignItems: "center", gap: "1.2vw" }}>
        <Marca />
        <span style={s.cabTela}>{tela}</span>
      </div>
      <div style={{ textAlign: "right", lineHeight: 1.1 }}>
        <div style={{ fontSize: fs(16, 1.5, 34), fontWeight: 800, color: T.texto }}>
          {agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
        </div>
        <div style={{ fontSize: fs(11, 1.0, 22), color: T.textoMudo, fontWeight: 600, textTransform: "capitalize" }}>
          {agora.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}
        </div>
      </div>
    </header>
  );
}

// Rodapé: origem do dado (último snapshot) + posição no carrossel -------------
export function Rodape({ geradoEm, indice, total }) {
  return (
    <footer style={s.rod}>
      <span style={{ fontSize: fs(11, 1.0, 22), color: T.textoSuave, fontWeight: 600 }}>
        {geradoEm
          ? `Dados atualizados em ${fmtData(geradoEm)} às ${fmtHora(geradoEm)}. Correspondem à última atualização da projeção.`
          : "Aguardando a primeira atualização da projeção."}
      </span>
      <span style={{ display: "flex", gap: "0.7vw", alignItems: "center" }}>
        {Array.from({ length: total || 0 }).map((_, i) => (
          <span key={i} style={{ width: fs(6, 0.6, 14), height: fs(6, 0.6, 14), borderRadius: "50%", background: i === indice ? T.azul : "rgba(148,163,184,0.35)", transition: "background .3s" }} />
        ))}
      </span>
    </footer>
  );
}

// Layout de tela: título grande + área de conteúdo (usado por todas as telas) -
export function Tela({ titulo, icone, children, centralizado = true }) {
  return (
    <section style={s.tela}>
      {titulo && (
        <div style={s.telaTitulo}>
          {icone && <span style={{ fontSize: fs(22, 2.2, 52) }}>{icone}</span>}
          <span>{titulo}</span>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: centralizado ? "center" : "stretch", gap: "1.4vh", width: "100%" }}>
        {children}
      </div>
    </section>
  );
}

// 1) Card de indicador — número grande em destaque + rótulo + sub -------------
export function IndicadorCard({ rotulo, valor, sub, icone, tom = "azul", grande = false }) {
  const cor = { azul: T.azulClaro, verde: T.verde, ambar: T.ambar, vermelho: T.vermelho }[tom] || T.azulClaro;
  return (
    <div style={{ ...s.card, minWidth: grande ? "30vw" : "18vw", flex: grande ? "1 1 30vw" : "1 1 18vw" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6vw", color: T.textoMudo, fontSize: fs(12, 1.1, 24), fontWeight: 700 }}>
        {icone && <span>{icone}</span>}
        <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>{rotulo}</span>
      </div>
      <div style={{ fontSize: fsValor(valor, grande), fontWeight: 900, lineHeight: 1, color: cor, whiteSpace: "nowrap", textShadow: "0 0 30px rgba(34,197,94,0.25)" }}>{valor}</div>
      {sub && <div style={{ fontSize: fs(12, 1.1, 24), color: T.textoSuave, fontWeight: 600 }}>{sub}</div>}
    </div>
  );
}

// 3) Barra de progresso — com rótulo textual (não só cor) --------------------
export function BarraProgresso({ pct, tom = "azul", altura = "2.4vh" }) {
  const cor = { azul: T.azul, verde: T.verde, ambar: T.ambar, vermelho: T.vermelho }[tom] || T.azul;
  const p = Math.max(0, Math.min(100, Number(pct || 0)));
  return (
    <div style={{ background: "rgba(15,23,42,0.7)", borderRadius: 999, height: altura, overflow: "hidden", boxShadow: "inset 0 0 12px rgba(0,0,0,0.5)", width: "100%" }}>
      <div style={{ height: "100%", width: p + "%", background: `linear-gradient(90deg, ${cor}, ${T.verde})`, borderRadius: 999, transition: "width .6s ease" }} />
    </div>
  );
}

// 2) Card de meta — número principal + barra + status textual ----------------
export function MetaCard({ titulo, valor, alvo, pct, detalhe }) {
  const st = statusMeta(pct);
  return (
    <div style={{ ...s.card, alignItems: "stretch", width: "min(80vw, 1400px)", gap: "1.4vh" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1vw", flexWrap: "wrap" }}>
        <span style={{ fontSize: fs(16, 1.6, 38), fontWeight: 800, color: T.texto }}>{titulo}</span>
        <span style={{ ...s.selo, color: st.cor, borderColor: st.cor }}>{st.label}</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "1vw", flexWrap: "wrap" }}>
        <span style={{ fontSize: fs(38, 5, 120), fontWeight: 900, lineHeight: 1, color: st.cor }}>{valor}</span>
        {alvo && <span style={{ fontSize: fs(14, 1.4, 30), color: T.textoSuave, fontWeight: 600 }}>de {alvo}</span>}
        {pct != null && <span style={{ fontSize: fs(20, 2.4, 56), fontWeight: 900, color: st.cor, marginLeft: "auto" }}>{Math.round(pct)}%</span>}
      </div>
      <BarraProgresso pct={pct} tom={st.tom === "bom" ? "verde" : st.tom === "atencao" ? "ambar" : st.tom === "ruim" ? "vermelho" : "azul"} />
      {detalhe && <div style={{ fontSize: fs(13, 1.3, 28), color: T.textoSuave, fontWeight: 600 }}>{detalhe}</div>}
    </div>
  );
}

// Cor por rótulo de situação (nunca só cor: o texto acompanha sempre).
export function corSituacao(sit) {
  if (sit === "No ritmo" || sit === "Meta atingida") return T.verde;
  if (sit === "Atenção") return T.ambar;
  return T.vermelho; // Abaixo do ritmo
}

// 2b) Card de meta (Etapa 3) — andamento OU modo conquista, a partir do objeto
//     de meta já calculado no snapshot. pct nunca é limitado a 100%.
export function CardMeta({ meta }) {
  if (!meta) return null;
  const pct = meta.pct == null ? null : Number(meta.pct);
  if (meta.atingida) {
    // ---- Modo conquista (positivo, sem animação pesada) ----
    return (
      <div style={{ ...s.cardMeta, background: "linear-gradient(135deg, rgba(16,185,129,0.22), rgba(59,130,246,0.18))", border: "1px solid rgba(52,211,153,0.5)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1vw", flexWrap: "wrap" }}>
          <span style={{ fontSize: fs(15, 1.5, 34), fontWeight: 800, color: T.texto }}>{meta.nome}</span>
          <span style={{ ...s.selo, color: T.verde, borderColor: T.verde }}>🏆 Meta batida</span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: "1.2vw", flexWrap: "wrap" }}>
          <span style={{ fontSize: fsValor(moeda(meta.realizado), false), fontWeight: 900, lineHeight: 1, color: T.verde, whiteSpace: "nowrap" }}>{moeda(meta.realizado)}</span>
          <span style={{ fontSize: fs(13, 1.3, 28), color: T.textoSuave, fontWeight: 600 }}>meta {moeda(meta.alvo)}</span>
          {pct != null && <span style={{ fontSize: fs(18, 2.2, 50), fontWeight: 900, color: T.verde, marginLeft: "auto" }}>{pct}%</span>}
        </div>
        <BarraProgresso pct={100} tom="verde" altura="1.8vh" />
        <div style={{ display: "flex", gap: "2vw", flexWrap: "wrap", fontSize: fs(13, 1.3, 28), fontWeight: 700, color: T.texto }}>
          <span>Superamos em <strong style={{ color: T.verde }}>{moeda(meta.excedente)}</strong></span>
          {meta.data_atingimento && <span style={{ color: T.textoSuave }}>Atingida em {meta.data_atingimento}</span>}
        </div>
      </div>
    );
  }
  // ---- Modo andamento ----
  const cor = corSituacao(meta.situacao);
  return (
    <div style={s.cardMeta}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1vw", flexWrap: "wrap" }}>
        <span style={{ fontSize: fs(15, 1.5, 34), fontWeight: 800, color: T.texto }}>{meta.nome}</span>
        <span style={{ ...s.selo, color: cor, borderColor: cor }}>{meta.situacao}</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "1.2vw", flexWrap: "wrap" }}>
        <span style={{ fontSize: fsValor(moeda(meta.realizado), false), fontWeight: 900, lineHeight: 1, color: cor, whiteSpace: "nowrap" }}>{moeda(meta.realizado)}</span>
        <span style={{ fontSize: fs(13, 1.3, 28), color: T.textoSuave, fontWeight: 600 }}>de {moeda(meta.alvo)}</span>
        {pct != null && <span style={{ fontSize: fs(18, 2.2, 50), fontWeight: 900, color: cor, marginLeft: "auto" }}>{pct}%</span>}
      </div>
      <BarraProgresso pct={pct} tom={meta.situacao === "No ritmo" ? "verde" : meta.situacao === "Atenção" ? "ambar" : "vermelho"} altura="1.8vh" />
      <div style={{ display: "flex", gap: "2vw", flexWrap: "wrap", fontSize: fs(13, 1.3, 28), fontWeight: 700, color: T.texto }}>
        <span>Falta <strong style={{ color: cor }}>{moeda(meta.restante)}</strong></span>
        {meta.ritmo_necessario != null && <span style={{ color: T.textoSuave }}>Precisa {moeda(meta.ritmo_necessario)}/dia útil</span>}
      </div>
    </div>
  );
}

// 4) Ranking — lista ou pódio ------------------------------------------------
export function Ranking({ titulo, itens = [], podio = false }) {
  const medalha = ["🥇", "🥈", "🥉"];
  if (podio) {
    const trio = [{ o: itens[1], pos: 2 }, { o: itens[0], pos: 1 }, { o: itens[2], pos: 3 }];
    const alturas = { 1: "18vh", 2: "13vh", 3: "10vh" };
    const cores = { 1: "linear-gradient(180deg,#fde68a,#f59e0b)", 2: "linear-gradient(180deg,#e2e8f0,#94a3b8)", 3: "linear-gradient(180deg,#fdba74,#c2843f)" };
    return (
      <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "1vh" }}>
        {titulo && <div style={s.subTitulo}>{titulo}</div>}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: "3vw", width: "90%", marginTop: "1vh" }}>
          {trio.map((it, i) => {
            if (!it.o) return <div key={i} style={{ flex: 1, maxWidth: "24vw" }} />;
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", maxWidth: "24vw" }}>
                <div style={{ fontSize: it.pos === 1 ? fs(28, 3.4, 84) : fs(22, 2.6, 64), lineHeight: 1, filter: "drop-shadow(0 0 16px rgba(251,191,36,0.5))" }}>{medalha[it.pos - 1]}</div>
                <div style={{ fontSize: it.pos === 1 ? fs(18, 2, 48) : fs(15, 1.6, 40), fontWeight: 900, color: T.texto, marginTop: "0.3vh", textAlign: "center" }}>{it.o.nome || it.o.operador}</div>
                {it.o.valor != null && <div style={{ fontSize: fs(13, 1.3, 30), fontWeight: 800, color: T.azulClaro }}>{it.o.valor}</div>}
                <div style={{ width: "100%", borderRadius: "14px 14px 0 0", height: alturas[it.pos], background: cores[it.pos], display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "0.8vh", marginTop: "0.8vh", boxShadow: "0 -8px 40px rgba(59,130,246,0.45)" }}>
                  <span style={{ fontSize: fs(22, 3.4, 84), fontWeight: 900, color: "rgba(2,6,23,0.5)" }}>{it.pos}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <div style={{ ...s.card, width: "min(70vw, 1200px)", alignItems: "stretch", gap: "1vh" }}>
      {titulo && <div style={s.subTitulo}>{titulo}</div>}
      {itens.length === 0 ? (
        <div style={s.vazio}>Sem dados nesta atualização.</div>
      ) : itens.slice(0, 8).map((o, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: "1vw", fontSize: fs(16, 1.7, 40), fontWeight: 700, color: T.texto, padding: "0.6vh 0", borderBottom: i < itens.length - 1 ? "1px solid rgba(148,163,184,0.15)" : "none" }}>
          <span style={{ width: fs(26, 2.6, 64), color: T.textoMudo, fontWeight: 900 }}>{medalha[i] || `${i + 1}.`}</span>
          <span style={{ flex: 1 }}>{o.nome || o.operador}</span>
          {o.valor != null && <strong style={{ color: T.azulClaro }}>{o.valor}</strong>}
        </div>
      ))}
    </div>
  );
}

// 5) Destaque de operador -----------------------------------------------------
export function DestaqueOperador({ rotulo, nome, valor, icone = "⭐" }) {
  return (
    <div style={{ ...s.card, minWidth: "20vw", flex: "1 1 0", alignItems: "center", textAlign: "center", gap: "0.3vh" }}>
      <div style={{ fontSize: fs(18, 2, 46) }}>{icone}</div>
      <div style={{ fontSize: fs(11, 1.05, 22), color: T.textoMudo, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>{rotulo}</div>
      <div style={{ fontSize: fs(18, 2, 48), fontWeight: 900, color: T.texto, whiteSpace: "nowrap" }}>{nome || "—"}</div>
      {valor && <div style={{ fontSize: fs(14, 1.5, 34), fontWeight: 800, color: T.verde }}>{valor}</div>}
    </div>
  );
}

// 6) Mensagem institucional ---------------------------------------------------
export function MensagemInstitucional({ badge, titulo, texto }) {
  return (
    <div style={{ ...s.card, alignItems: "center", textAlign: "center", gap: "1.2vh", background: "linear-gradient(135deg, rgba(109,40,217,0.35), rgba(29,78,216,0.35))", border: "1px solid rgba(96,165,250,0.4)", padding: "2.4vh 3vw", width: "min(80vw,1400px)", flex: "0 0 auto" }}>
      {badge && <div style={s.selo}>{badge}</div>}
      <div style={{ fontSize: fs(26, 3.4, 78), fontWeight: 900, color: T.texto, lineHeight: 1.06 }}>{titulo}</div>
      {texto && <div style={{ fontSize: fs(16, 1.8, 44), fontWeight: 600, color: T.textoSuave, maxWidth: "72vw", lineHeight: 1.3 }}>{texto}</div>}
    </div>
  );
}

// 7) Aviso — MESMO sistema visual dos demais cards (sem cor exclusiva de fundo).
//    A prioridade é indicada por um detalhe DISCRETO: uma borda-esquerda fina e
//    um selo pequeno. Fundo, tipografia, bordas e sombra são os padrão da TV.
export function Aviso({ nivel = "info", titulo, texto }) {
  const cfg = {
    info: { cor: T.azulClaro, rot: "Aviso" },
    atencao: { cor: T.ambar, rot: "Prioridade" },
    critico: { cor: T.vermelho, rot: "Importante" },
  }[nivel] || { cor: T.azulClaro, rot: "Aviso" };
  return (
    <div style={{ ...s.card, width: "min(78vw,1300px)", alignItems: "stretch", gap: "1.2vh", borderLeft: `5px solid ${cfg.cor}` }}>
      <span style={{ ...s.selo, alignSelf: "flex-start", color: cfg.cor, borderColor: cfg.cor }}>{cfg.rot}</span>
      <div style={{ fontSize: fs(22, 2.6, 60), fontWeight: 900, color: T.texto, lineHeight: 1.1 }}>{titulo}</div>
      {texto && <div style={{ fontSize: fs(16, 1.7, 42), fontWeight: 600, color: T.textoSuave, lineHeight: 1.35 }}>{texto}</div>}
    </div>
  );
}

// 8) Conteúdo de treinamento --------------------------------------------------
export function Treinamento({ categoria, titulo, texto }) {
  return (
    <div style={{ ...s.card, alignItems: "center", textAlign: "center", gap: "2vh", width: "min(80vw,1400px)", padding: "4vh 4vw" }}>
      {categoria && <div style={{ ...s.selo, background: "linear-gradient(90deg,#60a5fa,#22c55e)", color: "#0b1224", borderColor: "transparent" }}>{categoria}</div>}
      <div style={{ fontSize: fs(30, 3.8, 96), fontWeight: 900, color: T.texto, lineHeight: 1.08 }}>{titulo}</div>
      {texto && <div style={{ fontSize: fs(18, 2, 52), fontWeight: 600, color: T.textoSuave, maxWidth: "72vw", lineHeight: 1.4 }}>{texto}</div>}
    </div>
  );
}

// 9) Conquista (Hall da Fama / Reconhecimento) -------------------------------
export function Conquista({ titulo, subtitulo, valor, imagemUrl, icone = "🏆" }) {
  return (
    <div style={{ ...s.card, alignItems: "center", textAlign: "center", gap: "1.6vh", minWidth: "30vw" }}>
      {imagemUrl ? (
        <img src={imagemUrl} alt="" style={{ maxWidth: "60vw", maxHeight: "48vh", borderRadius: 16, objectFit: "contain", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }} />
      ) : (
        <div style={{ fontSize: fs(40, 5, 140) }}>{icone}</div>
      )}
      <div style={{ fontSize: fs(22, 2.6, 66), fontWeight: 900, color: T.texto }}>{titulo}</div>
      {valor && <div style={{ fontSize: fs(28, 3.4, 90), fontWeight: 900, color: T.verde }}>{valor}</div>}
      {subtitulo && <div style={{ fontSize: fs(14, 1.4, 32), color: T.textoSuave, fontWeight: 600 }}>{subtitulo}</div>}
    </div>
  );
}

// Estado: carregando ----------------------------------------------------------
export function EstadoCarregando() {
  return (
    <div style={s.estado}>
      <style>{`@keyframes tvpulse{0%,100%{opacity:.55}50%{opacity:1}}`}</style>
      <Marca tamanho={fs(40, 5, 120)} />
      <div style={{ fontSize: fs(18, 1.8, 44), color: T.textoMudo, fontWeight: 700, animation: "tvpulse 1.6s ease-in-out infinite" }}>
        Carregando os indicadores da operação.
      </div>
    </div>
  );
}

// Estado: sem snapshot (institucional) ---------------------------------------
export function EstadoSemSnapshot() {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={s.estado}>
      <Marca tamanho={fs(40, 5, 120)} />
      <div style={{ fontSize: fs(20, 2.2, 56), color: T.texto, fontWeight: 800, maxWidth: "72vw", lineHeight: 1.35 }}>
        Os indicadores serão exibidos após a atualização da projeção.
      </div>
      <div style={{ fontSize: fs(14, 1.4, 30), color: T.textoMudo, fontWeight: 600 }}>
        {agora.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}
        {" · "}
        {agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
      </div>
    </div>
  );
}

// Palco: envelope com transição suave (fade + leve subida) por troca de tela --
export function Palco({ chave, children }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative", width: "100%", display: "flex" }}>
      <style>{`@keyframes tvfade{from{opacity:0;transform:translateY(1.2vh)}to{opacity:1;transform:none}}`}</style>
      <div key={chave} style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", animation: "tvfade .5s ease" }}>
        {children}
      </div>
    </div>
  );
}

// Estilos ---------------------------------------------------------------------
const s = {
  cab: { display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: "1.6vh", borderBottom: "1px solid rgba(148,163,184,0.18)" },
  cabTela: { fontSize: fs(14, 1.5, 34), color: T.azulClaro, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.14em", paddingLeft: "1vw", borderLeft: "2px solid rgba(148,163,184,0.3)" },
  rod: { display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: "1.4vh", borderTop: "1px solid rgba(148,163,184,0.18)", gap: "2vw" },
  tela: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", width: "100%", padding: "0.8vh 0" },
  telaTitulo: { display: "flex", alignItems: "center", gap: "1vw", fontSize: fs(20, 2.3, 54), fontWeight: 900, color: T.ambar, textShadow: "0 0 28px rgba(251,191,36,0.45)", marginBottom: "0.6vh", flex: "0 0 auto" },
  subTitulo: { fontSize: fs(14, 1.5, 34), color: T.azulClaro, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em" },
  card: { background: T.surface, border: `1px solid ${T.surfaceBorda}`, borderRadius: 18, padding: "1.6vh 1.8vw", display: "flex", flexDirection: "column", gap: "0.6vh", boxShadow: "0 10px 40px rgba(2,6,23,0.35)", boxSizing: "border-box" },
  // Card de meta: largura fixa e não-crescente para caber 3 na vertical.
  cardMeta: { background: T.surface, border: `1px solid ${T.surfaceBorda}`, borderRadius: 18, padding: "1.4vh 1.8vw", display: "flex", flexDirection: "column", gap: "0.8vh", boxShadow: "0 10px 40px rgba(2,6,23,0.35)", boxSizing: "border-box", width: "min(80vw,1400px)", flex: "0 0 auto", alignItems: "stretch" },
  selo: { fontSize: fs(11, 1.1, 24), fontWeight: 800, padding: "0.4vh 1vw", borderRadius: 999, border: "1px solid currentColor", color: "#fff", background: "rgba(15,23,42,0.4)", whiteSpace: "nowrap" },
  vazio: { fontSize: fs(14, 1.5, 34), color: T.textoMudo, fontWeight: 600, textAlign: "center", padding: "2vh 0" },
  estado: { flex: 1, minHeight: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", gap: "2.4vh" },
  linhaCards: { display: "flex", gap: "1.6vw", flexWrap: "wrap", justifyContent: "center", width: "100%" },
};

export const layout = s;
