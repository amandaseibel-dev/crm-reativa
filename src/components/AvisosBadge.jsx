import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

export default function AvisosBadge() {
  const [qtd, setQtd] = useState(0);

  async function atualizar() {
    const { data } = await supabase.rpc("avisos_nao_lidos_count");
    setQtd(typeof data === "number" ? data : 0);
  }
  useEffect(() => {
    atualizar();
    function on() { atualizar(); }
    window.addEventListener("avisos-atualizou", on);
    const t = setInterval(atualizar, 60000);
    return () => { window.removeEventListener("avisos-atualizou", on); clearInterval(t); };
  }, []);

  return (
    <button
      style={S.btn}
      title="Avisos"
      onClick={() => window.dispatchEvent(new Event("abrir-avisos"))}
    >
      🔔 Avisos
      {qtd > 0 ? <span style={S.badge}>{qtd}</span> : null}
    </button>
  );
}

const S = {
  btn: { position: "relative", background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.35)", color: "#dbeafe", borderRadius: 999, padding: "6px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", marginTop: 10 },
  badge: { position: "absolute", top: -6, right: -6, background: "#ef4444", color: "#fff", borderRadius: 999, minWidth: 18, height: 18, fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" },
};
