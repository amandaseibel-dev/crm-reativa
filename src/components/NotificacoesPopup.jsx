import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";

// Popup em tempo real de notificacoes do operador (link pronto, termo aprovado,
// retorno do financeiro). Faz polling curto e tambem escuta em realtime.
export default function NotificacoesPopup() {
  const [email, setEmail] = useState(null);
  const [fila, setFila] = useState([]); // notificacoes ainda nao exibidas
  const vistasRef = useRef(new Set());
  const navigate = useNavigate();

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const mail = (data?.user?.email || "").toLowerCase();
      if (ativo) setEmail(mail);
    })();
    return () => { ativo = false; };
  }, []);

  async function buscar() {
    if (!email) return;
    const { data } = await supabase
      .from("notificacoes")
      .select("id, tipo, titulo, mensagem, aluno_id, url_destino, criado_em")
      .eq("usuario_destino_email", email)
      .eq("lida", false)
      .order("criado_em", { ascending: true })
      .limit(8);
    if (!data) return;
    const novas = data.filter((n) => !vistasRef.current.has(n.id));
    if (novas.length === 0) return;
    novas.forEach((n) => vistasRef.current.add(n.id));
    setFila((f) => [...f, ...novas]);
  }

  useEffect(() => {
    if (!email) return;
    buscar();
    const t = setInterval(buscar, 12000);
    // realtime: estoura na hora quando uma notificacao e inserida
    const canal = supabase
      .channel("notif-" + email)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notificacoes", filter: "usuario_destino_email=eq." + email },
        (payload) => {
          const n = payload.new;
          if (!n || n.lida || vistasRef.current.has(n.id)) return;
          vistasRef.current.add(n.id);
          setFila((f) => [...f, n]);
        }
      )
      .subscribe();
    return () => { clearInterval(t); supabase.removeChannel(canal); };
  }, [email]);

  async function marcarLida(id) {
    await supabase.from("notificacoes").update({ lida: true, lida_em: new Date().toISOString() }).eq("id", id);
    setFila((f) => f.filter((n) => n.id !== id));
  }

  function abrir(n) {
    if (n.aluno_id) {
      try { localStorage.setItem("alunoSelecionado", JSON.stringify({ id: n.aluno_id })); } catch (e) {}
    }
    marcarLida(n.id);
    navigate(n.url_destino || "/painel-carteira");
  }

  if (fila.length === 0) return null;

  return (
    <div style={S.wrap}>
      {fila.slice(0, 3).map((n) => (
        <div key={n.id} style={S.card}>
          <button style={S.x} onClick={() => marcarLida(n.id)} aria-label="Fechar">×</button>
          <div style={S.titulo}>{n.titulo || "Notificação"}</div>
          <div style={S.msg}>{n.mensagem}</div>
          <div style={S.acoes}>
            <button style={S.btnAbrir} onClick={() => abrir(n)}>Abrir</button>
            <button style={S.btnOk} onClick={() => marcarLida(n.id)}>Ok, ciente</button>
          </div>
        </div>
      ))}
    </div>
  );
}

const S = {
  wrap: { position: "fixed", right: 20, bottom: 90, zIndex: 9999, display: "flex", flexDirection: "column", gap: 12, maxWidth: 360 },
  card: { position: "relative", background: "#0f172a", color: "#fff", borderRadius: 14, padding: "14px 16px 14px", boxShadow: "0 14px 40px rgba(2,6,23,0.45)", border: "1px solid rgba(96,165,250,0.4)", animation: "none" },
  x: { position: "absolute", top: 8, right: 10, background: "transparent", border: "none", color: "#94a3b8", fontSize: 20, cursor: "pointer", lineHeight: 1 },
  titulo: { fontSize: 15, fontWeight: 800, marginBottom: 4, paddingRight: 18 },
  msg: { fontSize: 13, color: "#cbd5e1", lineHeight: 1.45 },
  acoes: { display: "flex", gap: 8, marginTop: 12 },
  btnAbrir: { flex: 1, background: "#2563eb", color: "#fff", border: "none", borderRadius: 9, padding: "9px 12px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  btnOk: { background: "transparent", color: "#93c5fd", border: "1px solid rgba(148,163,184,0.35)", borderRadius: 9, padding: "9px 12px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
};
