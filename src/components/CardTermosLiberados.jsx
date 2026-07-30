import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";

// Card de destaque no painel inicial do operador (item 4): mostra os termos
// liberados pela ADM ainda NÃO lidos. Some ao abrir a ficha ou marcar como lido.
// Só lê/altera as próprias notificações (RLS garante no backend).
export default function CardTermosLiberados() {
  const [itens, setItens] = useState([]);
  const navigate = useNavigate();
  const emailRef = useRef(null);

  async function carregar() {
    const mail = emailRef.current;
    if (!mail) return;
    const { data } = await supabase
      .from("notificacoes")
      .select("id, titulo, mensagem, url_destino, criado_em, tipo")
      .eq("usuario_destino_email", mail)
      .eq("lida", false)
      .in("tipo", ["TERMO_LIBERADO", "TERMO_LIBERADO_SEM_RESP"])
      .order("criado_em", { ascending: false })
      .limit(10);
    setItens(Array.isArray(data) ? data : []);
  }

  useEffect(() => {
    let ativo = true;
    let canal = null;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const mail = (data?.user?.email || "").toLowerCase();
      emailRef.current = mail;
      if (!ativo) return;
      carregar();
      if (mail) {
        canal = supabase
          .channel("card-termo-" + mail)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "notificacoes", filter: "usuario_destino_email=eq." + mail },
            () => carregar()
          )
          .subscribe();
      }
    })();
    const t = setInterval(carregar, 60000);
    return () => { ativo = false; clearInterval(t); if (canal) supabase.removeChannel(canal); };
  }, []);

  async function marcarLida(id) {
    await supabase.from("notificacoes").update({ lida: true, lida_em: new Date().toISOString() }).eq("id", id);
    setItens((l) => l.filter((n) => n.id !== id));
    window.dispatchEvent(new Event("avisos-atualizou"));
  }

  function abrir(n) {
    marcarLida(n.id);
    navigate(n.url_destino || "/painel-carteira");
  }

  if (itens.length === 0) return null;

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <span style={S.tit}>📄 Termos liberados para continuidade</span>
        <span style={S.badge}>{itens.length}</span>
      </div>
      <div style={S.lista}>
        {itens.map((n) => (
          <div key={n.id} style={S.item}>
            <div style={S.itemTxt}>
              <div style={S.itemTit}>{n.titulo}</div>
              <div style={S.itemMsg}>{n.mensagem}</div>
            </div>
            <div style={S.itemAcoes}>
              <button style={S.btnAbrir} onClick={() => abrir(n)}>Abrir ficha</button>
              <button style={S.btnLer} onClick={() => marcarLida(n.id)}>Marcar lido</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const S = {
  wrap: { background: "linear-gradient(135deg,#0b2545,#12386b)", color: "#e2e8f0", borderRadius: 14, padding: "16px 18px", marginBottom: 16, border: "1px solid rgba(96,165,250,0.4)" },
  topo: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  tit: { fontWeight: 800, fontSize: 15 },
  badge: { background: "#1d4ed8", color: "#fff", borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 800 },
  lista: { display: "flex", flexDirection: "column", gap: 8 },
  item: { display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", background: "rgba(15,23,42,0.55)", borderRadius: 10, padding: "10px 12px", flexWrap: "wrap" },
  itemTxt: { flex: 1, minWidth: 200 },
  itemTit: { fontWeight: 700, fontSize: 13 },
  itemMsg: { fontSize: 12, color: "#cbd5e1", marginTop: 2, lineHeight: 1.4 },
  itemAcoes: { display: "flex", gap: 8 },
  btnAbrir: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "8px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" },
  btnLer: { background: "transparent", color: "#93c5fd", border: "1px solid rgba(148,163,184,0.35)", borderRadius: 8, padding: "8px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" },
};
