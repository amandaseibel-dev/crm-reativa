import { useEffect, useRef, useState } from "react";
import { supabase } from "../services/supabase";

// Sino unificado do cabeçalho. Conta:
//  (a) comunicados globais não lidos (RPC avisos_nao_lidos_count), e
//  (b) notificações direcionadas não lidas do operador (tabela notificacoes),
//      incluindo o aviso de "Termo liberado para continuidade".
// Clicar abre a Central de Notificações (evento) e também reabre os comunicados.
// Atualiza em tempo real (realtime em notificacoes) + polling de segurança (60s).
export default function AvisosBadge() {
  const [qtdBroadcast, setQtdBroadcast] = useState(0);
  const [qtdNotif, setQtdNotif] = useState(0);
  const emailRef = useRef(null);

  async function contarBroadcast() {
    const { data } = await supabase.rpc("avisos_nao_lidos_count");
    setQtdBroadcast(typeof data === "number" ? data : 0);
  }

  async function contarNotif() {
    const mail = emailRef.current;
    if (!mail) { setQtdNotif(0); return; }
    const { count } = await supabase
      .from("notificacoes")
      .select("id", { count: "exact", head: true })
      .eq("usuario_destino_email", mail)
      .eq("lida", false);
    setQtdNotif(typeof count === "number" ? count : 0);
  }

  function atualizar() { contarBroadcast(); contarNotif(); }

  useEffect(() => {
    let ativo = true;
    let canal = null;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const mail = (data?.user?.email || "").toLowerCase();
      emailRef.current = mail;
      if (!ativo) return;
      atualizar();
      if (mail) {
        // realtime: contador do operador atualiza sem recarregar a página (item 10)
        canal = supabase
          .channel("badge-notif-" + mail)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "notificacoes", filter: "usuario_destino_email=eq." + mail },
            () => contarNotif()
          )
          .subscribe();
      }
    })();

    function on() { atualizar(); }
    window.addEventListener("avisos-atualizou", on);
    const t = setInterval(atualizar, 60000);

    return () => {
      ativo = false;
      window.removeEventListener("avisos-atualizou", on);
      clearInterval(t);
      if (canal) supabase.removeChannel(canal);
    };
  }, []);

  const qtd = qtdBroadcast + qtdNotif;

  function abrir() {
    window.dispatchEvent(new Event("abrir-central-notificacoes"));
    window.dispatchEvent(new Event("abrir-avisos"));
  }

  return (
    <button style={S.btn} title="Avisos e notificações" onClick={abrir}>
      🔔 Avisos
      {qtd > 0 ? <span style={S.badge}>{qtd}</span> : null}
    </button>
  );
}

const S = {
  btn: { position: "relative", background: "transparent", border: "1px solid rgba(148,163,184,0.3)", color: "#93c5fd", borderRadius: 999, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", marginTop: 10 },
  badge: { position: "absolute", top: -6, right: -6, background: "#1d4ed8", color: "#fff", borderRadius: 999, minWidth: 18, height: 18, fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" },
};
