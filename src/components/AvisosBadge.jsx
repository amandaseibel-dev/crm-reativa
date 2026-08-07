import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import usePolling from "../utils/polling";

export default function AvisosBadge() {
  const [qtd, setQtd] = useState(0);

  async function atualizar() {
    const { data } = await supabase.rpc("avisos_nao_lidos_count");
    setQtd(typeof data === "number" ? data : 0);
  }
  // Polling padrão: pausa em aba oculta e atualiza na hora ao voltar o foco.
  usePolling(atualizar, 60000, [], true);
  // Atualização imediata quando outro componente marca aviso como lido.
  useEffect(() => {
    function on() { atualizar(); }
    window.addEventListener("avisos-atualizou", on);
    return () => window.removeEventListener("avisos-atualizou", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  btn: { position: "relative", background: "transparent", border: "1px solid rgba(148,163,184,0.3)", color: "#93c5fd", borderRadius: 999, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", marginTop: 10 },
  badge: { position: "absolute", top: -6, right: -6, background: "#1d4ed8", color: "#fff", borderRadius: 999, minWidth: 18, height: 18, fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" },
};
