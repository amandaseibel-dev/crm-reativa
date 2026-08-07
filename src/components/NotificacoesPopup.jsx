import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";

// Popup em tempo real de notificacoes do operador (link pronto, termo aprovado,
// retorno do financeiro). Carga inicial na montagem + escuta em realtime
// (o realtime cobre todas as insercoes novas; sem polling recorrente).
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
      .select("id, tipo, titulo, mensagem, aluno_id, solicitacao_link_id, url_destino, criado_em")
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
    buscar(); // carga inicial: pega notificacoes nao lidas que ja existiam antes do realtime assinar
    // realtime: estoura na hora quando uma notificacao e inserida
    // (polling recorrente de 60s removido — contencao Supabase; o realtime cobre a urgencia)
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
    return () => { supabase.removeChannel(canal); };
  }, [email]);

  async function marcarLida(id) {
    await supabase.from("notificacoes").update({ lida: true, lida_em: new Date().toISOString() }).eq("id", id);
    setFila((f) => f.filter((n) => n.id !== id));
  }

  // Notificacoes de link de pagamento: alem de abrir a ficha, devem abrir a
  // secao "Link de pagamento" e destacar a solicitacao/link exato da notificacao.
  const TIPOS_LINK = new Set(["LINK_PRONTO", "LINK_GERADO", "SOLICITACAO_LINK", "LINK_DEVOLVIDO"]);

  function abrir(n) {
    marcarLida(n.id);
    // Regra: abrir SEMPRE a ficha unica do aluno pelo aluno_id da notificacao.
    // Nunca decidir o aluno por CPF/aproximacao, nunca cair na fila Base quando
    // existe vinculo. A ficha ja renderiza o bloco de Links (LINK_PRONTO_PARA_ENVIO)
    // na aba inicial, permitindo "Marcar enviado ao aluno" pelo fluxo existente.
    if (n.aluno_id) {
      try {
        localStorage.setItem("reativa_aluno_abrir_id", String(n.aluno_id));
        // Vinculo obrigatorio das notificacoes NOVAS de link: se veio o
        // solicitacao_link_id, pedimos a ficha para abrir a secao de links e
        // destacar exatamente esta solicitacao (sem procurar na fila geral).
        // A autorizacao do aluno continua sendo feita pela ficha (RLS/responsavel);
        // este id NAO concede acesso -- so escolhe qual card destacar.
        if (n.solicitacao_link_id && TIPOS_LINK.has(n.tipo)) {
          localStorage.setItem("reativa_aluno_abrir_secao", "link");
          localStorage.setItem("reativa_link_destacar_id", String(n.solicitacao_link_id));
        } else {
          localStorage.removeItem("reativa_aluno_abrir_secao");
          localStorage.removeItem("reativa_link_destacar_id");
        }
      } catch (e) {}
      navigate("/aluno?origem=notificacao");
      return;
    }
    // Sem aluno_id valido: nao abrir outro aluno por aproximacao.
    if (n.url_destino) {
      navigate(n.url_destino);
      return;
    }
    alert(
      "Esta solicitação está sem vínculo com o aluno (sem aluno_id). " +
      "Não é possível abrir a ficha automaticamente."
    );
  }

  function formatarQuando(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  if (fila.length === 0) return null;

  return (
    <div style={S.wrap}>
      {fila.slice(0, 3).map((n) => (
        <div key={n.id} style={S.card}>
          <button style={S.x} onClick={() => marcarLida(n.id)} aria-label="Fechar">×</button>
          <div style={S.titulo}>{n.titulo || "Notificação"}</div>
          <div style={S.msg}>{n.mensagem}</div>
          {n.criado_em && <div style={S.hora}>{formatarQuando(n.criado_em)}</div>}
          <div style={S.acoes}>
            <button style={S.btnAbrir} onClick={() => abrir(n)}>
              {n.aluno_id ? "Abrir aluno" : "Abrir"}
            </button>
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
  hora: { fontSize: 11, color: "#94a3b8", marginTop: 6 },
  acoes: { display: "flex", gap: 8, marginTop: 12 },
  btnAbrir: { flex: 1, background: "#2563eb", color: "#fff", border: "none", borderRadius: 9, padding: "9px 12px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  btnOk: { background: "transparent", color: "#93c5fd", border: "1px solid rgba(148,163,184,0.35)", borderRadius: 9, padding: "9px 12px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
};
