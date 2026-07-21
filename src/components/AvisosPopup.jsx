import { useEffect, useRef, useState } from "react";
import { supabase } from "../services/supabase";

export default function AvisosPopup() {
  const [fila, setFila] = useState([]);
  const [idx, setIdx] = useState(0);
  const [aberto, setAberto] = useState(false);
  const [user, setUser] = useState(null);
  const abertoRef = useRef(false);

  async function carregar(forcarTodos) {
    const { data: u } = await supabase.auth.getUser();
    const email = u?.user?.email || "";
    const nome = u?.user?.user_metadata?.nome || (email ? email.split("@")[0] : "");
    setUser({ email, nome });
    if (!email) return;
    const { data: avisos } = await supabase
      .from("avisos").select("id, emoji, titulo, mensagem")
      .eq("ativo", true).order("criado_em", { ascending: false });
    const { data: lidos } = await supabase
      .from("avisos_leituras").select("aviso_id").eq("usuario_email", email);
    const setLidos = new Set((lidos || []).map((l) => l.aviso_id));
    const lista = (avisos || []).filter((a) => forcarTodos || !setLidos.has(a.id));
    setFila(lista); setIdx(0); setAberto(lista.length > 0);
  }

  useEffect(() => { abertoRef.current = aberto; }, [aberto]);

  useEffect(() => {
    carregar(false);
    function reabrir() { carregar(true); }
    window.addEventListener("abrir-avisos", reabrir);
    const t = setInterval(() => { if (!abertoRef.current) carregar(false); }, 20000);
    return () => { window.removeEventListener("abrir-avisos", reabrir); clearInterval(t); };
  }, []);

  if (!aberto || idx >= fila.length) return null;
  const a = fila[idx];
  if (!a) return null;

  async function fechar() {
    try {
      if (user?.email) {
        await supabase.from("avisos_leituras")
          .upsert({ aviso_id: a.id, usuario_email: user.email, usuario_nome: user.nome, visto_em: new Date().toISOString() },
                  { onConflict: "aviso_id,usuario_email" });
      }
    } catch (e) {}
    window.dispatchEvent(new Event("avisos-atualizou"));
    if (idx + 1 >= fila.length) setAberto(false); else setIdx((i) => i + 1);
  }

  return (
    <div style={S.overlay} onClick={fechar}>
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <div style={S.emoji}>{a.emoji || "📢"}</div>
        <h2 style={S.titulo}>{a.titulo}</h2>
        {a.mensagem ? <p style={S.texto}>{a.mensagem}</p> : null}
        <button style={S.botao} onClick={fechar}>Entendi</button>
        {fila.length > 1 ? <div style={S.contador}>{idx + 1} de {fila.length}</div> : null}
      </div>
    </div>
  );
}

const S = {
  overlay: { position: "fixed", inset: 0, background: "rgba(2,6,23,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20 },
  card: { background: "#fff", borderRadius: 16, padding: "26px 28px", maxWidth: 440, width: "100%", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" },
  emoji: { fontSize: 40 },
  titulo: { margin: "8px 0 8px", fontSize: 20, color: "#0f172a" },
  texto: { margin: "0 0 18px", color: "#475569", fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" },
  botao: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 10, padding: "11px 24px", fontWeight: 700, fontSize: 15, cursor: "pointer" },
  contador: { marginTop: 12, color: "#94a3b8", fontSize: 12 },
};
