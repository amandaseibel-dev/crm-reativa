import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const APROVADORES = ["amanda.seibel" + "@" + "aelbra.com.br", "cobranca04" + "@" + "aelbra.com.br", "cobranca07" + "@" + "aelbra.com.br"];

export default function LiberacoesAcesso() {
  const [email, setEmail] = useState("");
  const [pendentes, setPendentes] = useState([]);
  const [aberto, setAberto] = useState(true);

  useEffect(() => { (async () => {
    const { data } = await supabase.auth.getUser();
    setEmail((data?.user?.email || "").toLowerCase());
  })(); }, []);

  async function carregar() {
    const { data } = await supabase.rpc("solicitacoes_acesso_pendentes");
    setPendentes(Array.isArray(data) ? data : []);
  }

  useEffect(() => {
    if (!APROVADORES.includes(email)) return;
    carregar();
    const t = setInterval(carregar, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  async function liberar(em) {
    await supabase.rpc("liberar_acesso", { p_email: em });
    carregar();
  }

  if (!APROVADORES.includes(email) || pendentes.length === 0) return null;

  return (
    <div style={S.wrap}>
      <button style={S.badge} onClick={() => setAberto(!aberto)}>🔔 {pendentes.length} pedido(s) de acesso</button>
      {aberto && (
        <div style={S.painel}>
          <div style={S.tit}>Pedidos de liberação de acesso (hoje)</div>
          {pendentes.map((p) => (
            <div key={p.id} style={S.item}>
              <div>
                <strong>{p.nome || p.email}</strong>
                <div style={S.sub}>{p.email}</div>
              </div>
              <button style={S.btn} onClick={() => liberar(p.email)}>Liberar hoje</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const S = {
  wrap: { position: "fixed", right: 18, bottom: 18, zIndex: 1200, fontFamily: "Inter, Arial, sans-serif" },
  badge: { background: "#ef4444", color: "#fff", border: "none", borderRadius: 999, padding: "10px 16px", fontWeight: 800, cursor: "pointer", boxShadow: "0 8px 24px rgba(0,0,0,0.35)" },
  painel: { marginTop: 10, width: 320, background: "#0f172a", border: "1px solid #334155", borderRadius: 14, padding: 14, boxShadow: "0 20px 50px rgba(0,0,0,0.5)", color: "#fff" },
  tit: { fontWeight: 800, fontSize: 13, color: "#93c5fd", marginBottom: 10 },
  item: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid #1e293b" },
  sub: { fontSize: 11, color: "#94a3b8" },
  btn: { background: "#22c55e", color: "#04240f", border: "none", borderRadius: 8, padding: "8px 12px", fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" },
};
