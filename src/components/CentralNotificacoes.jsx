import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";

// Central de notificações do operador (aviso de termo liberado, retorno de
// financeiro, etc.). Abre pelo sino 🔔 do cabeçalho (evento "abrir-central-notificacoes").
// Lista da mais recente para a mais antiga; some ao abrir a ficha ou marcar lido.
// Realtime + polling curto de segurança (60s). Só lê/altera as PRÓPRIAS notificações.
export default function CentralNotificacoes() {
  const [aberto, setAberto] = useState(false);
  const [email, setEmail] = useState(null);
  const [itens, setItens] = useState([]);
  const navigate = useNavigate();
  const emailRef = useRef(null);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const mail = (data?.user?.email || "").toLowerCase();
      if (ativo) { setEmail(mail); emailRef.current = mail; }
    })();
    return () => { ativo = false; };
  }, []);

  async function carregar() {
    const mail = emailRef.current;
    if (!mail) return;
    const { data } = await supabase
      .from("notificacoes")
      .select("id, tipo, titulo, mensagem, aluno_id, url_destino, criado_em, lida, lida_em")
      .eq("usuario_destino_email", mail)
      .order("criado_em", { ascending: false })
      .limit(30);
    setItens(Array.isArray(data) ? data : []);
  }

  useEffect(() => {
    if (!email) return;
    carregar();
    function abrir() { setAberto(true); carregar(); }
    window.addEventListener("abrir-central-notificacoes", abrir);
    const t = setInterval(carregar, 60000); // contenção: realtime cobre a urgência
    const canal = supabase
      .channel("central-notif-" + email)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notificacoes", filter: "usuario_destino_email=eq." + email },
        () => { carregar(); window.dispatchEvent(new Event("avisos-atualizou")); }
      )
      .subscribe();
    return () => {
      window.removeEventListener("abrir-central-notificacoes", abrir);
      clearInterval(t);
      supabase.removeChannel(canal);
    };
  }, [email]);

  async function marcarLida(id) {
    await supabase.from("notificacoes").update({ lida: true, lida_em: new Date().toISOString() }).eq("id", id);
    setItens((l) => l.map((n) => (n.id === id ? { ...n, lida: true } : n)));
    window.dispatchEvent(new Event("avisos-atualizou"));
  }

  function abrirFicha(n) {
    // Abrir a ficha marca como lida (item 4) — sem finalizar o termo nem mexer no fluxo.
    marcarLida(n.id);
    setAberto(false);
    navigate(n.url_destino || "/painel-carteira");
  }

  function dataHora(iso) {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return ""; }
  }

  if (!aberto) return null;
  const naoLidas = itens.filter((n) => !n.lida);

  return (
    <div style={S.overlay} onClick={() => setAberto(false)}>
      <div style={S.painel} onClick={(e) => e.stopPropagation()}>
        <div style={S.topo}>
          <strong style={S.tit}>🔔 Notificações</strong>
          <span style={S.contador}>{naoLidas.length} não lida{naoLidas.length === 1 ? "" : "s"}</span>
          <button style={S.fechar} onClick={() => setAberto(false)} aria-label="Fechar">×</button>
        </div>
        <div style={S.lista}>
          {itens.length === 0 && <div style={S.vazio}>Nenhuma notificação.</div>}
          {itens.map((n) => (
            <div key={n.id} style={{ ...S.card, ...(n.lida ? S.cardLido : {}) }}>
              <div style={S.cardTop}>
                <span style={S.cardTitulo}>{n.titulo || "Notificação"}</span>
                {!n.lida && <span style={S.dot} title="Não lida" />}
              </div>
              <div style={S.msg}>{n.mensagem}</div>
              <div style={S.meta}>{dataHora(n.criado_em)}</div>
              <div style={S.acoes}>
                <button style={S.btnAbrir} onClick={() => abrirFicha(n)}>Abrir ficha</button>
                {!n.lida && <button style={S.btnLer} onClick={() => marcarLida(n.id)}>Marcar como lido</button>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const S = {
  overlay: { position: "fixed", inset: 0, background: "rgba(2,6,23,0.45)", zIndex: 10000, display: "flex", justifyContent: "flex-end" },
  painel: { width: 380, maxWidth: "100%", height: "100%", background: "#0f172a", color: "#e2e8f0", boxShadow: "-14px 0 40px rgba(2,6,23,0.5)", display: "flex", flexDirection: "column" },
  topo: { display: "flex", alignItems: "center", gap: 10, padding: "16px 18px", borderBottom: "1px solid rgba(148,163,184,0.2)" },
  tit: { fontSize: 16 },
  contador: { marginLeft: "auto", background: "#1d4ed8", color: "#fff", borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700 },
  fechar: { background: "transparent", border: "none", color: "#94a3b8", fontSize: 24, cursor: "pointer", lineHeight: 1, marginLeft: 6 },
  lista: { overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 },
  vazio: { color: "#94a3b8", padding: 20, textAlign: "center" },
  card: { background: "#111c33", border: "1px solid rgba(96,165,250,0.35)", borderRadius: 12, padding: "12px 14px" },
  cardLido: { opacity: 0.55, border: "1px solid rgba(148,163,184,0.2)" },
  cardTop: { display: "flex", alignItems: "center", gap: 8 },
  cardTitulo: { fontWeight: 800, fontSize: 14 },
  dot: { width: 8, height: 8, borderRadius: 999, background: "#38bdf8", marginLeft: "auto" },
  msg: { fontSize: 13, color: "#cbd5e1", lineHeight: 1.45, marginTop: 4 },
  meta: { fontSize: 11, color: "#7c8aa3", marginTop: 6 },
  acoes: { display: "flex", gap: 8, marginTop: 10 },
  btnAbrir: { flex: 1, background: "#2563eb", color: "#fff", border: "none", borderRadius: 9, padding: "9px 12px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  btnLer: { background: "transparent", color: "#93c5fd", border: "1px solid rgba(148,163,184,0.35)", borderRadius: 9, padding: "9px 12px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
};
