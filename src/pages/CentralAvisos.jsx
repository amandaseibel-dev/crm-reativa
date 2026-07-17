import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

export default function CentralAvisos() {
  const [avisos, setAvisos] = useState([]);
  const [emoji, setEmoji] = useState("📢");
  const [titulo, setTitulo] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState("");

  const [leituras, setLeituras] = useState({});
  async function carregar() {
    const { data } = await supabase.from("avisos").select("*").order("criado_em", { ascending: false });
    setAvisos(Array.isArray(data) ? data : []);
    const { data: ls } = await supabase.from("avisos_leituras").select("aviso_id, usuario_nome, usuario_email");
    const map = {};
    (ls || []).forEach((l) => { (map[l.aviso_id] = map[l.aviso_id] || []).push(l.usuario_nome || l.usuario_email); });
    setLeituras(map);
  }
  useEffect(() => { carregar(); }, []);

  async function criar() {
    if (!titulo.trim()) { setMsg("Informe o título do aviso."); return; }
    setSalvando(true);
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("avisos").insert({
      emoji: emoji || "📢", titulo: titulo.trim(), mensagem: mensagem.trim() || null,
      ativo: true, criado_por: u?.user?.email || null,
    });
    setSalvando(false);
    if (error) { setMsg("Erro ao criar: " + error.message); return; }
    setTitulo(""); setMensagem(""); setEmoji("📢"); setMsg("Aviso criado e ativado.");
    carregar();
  }

  async function alternar(a) {
    await supabase.from("avisos").update({ ativo: !a.ativo }).eq("id", a.id);
    carregar();
  }
  async function remover(a) {
    if (!window.confirm("Remover este aviso?")) return;
    await supabase.from("avisos").delete().eq("id", a.id);
    carregar();
  }

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>Central de Avisos</h1>
      <p style={S.sub}>Crie um aviso e ligue/desligue quando quiser. Quando ativo, todos os operadores veem um pop-up (uma vez cada).</p>

      <div style={S.form}>
        <div style={S.linha}>
          <input style={S.inEmoji} value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={2} />
          <input style={S.inTitulo} placeholder="Título do aviso" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
        </div>
        <textarea style={S.inMsg} placeholder="Mensagem (opcional)" value={mensagem} onChange={(e) => setMensagem(e.target.value)} rows={3} />
        <button style={S.btnCriar} onClick={criar} disabled={salvando}>{salvando ? "Criando..." : "Criar e ativar aviso"}</button>
        {msg ? <span style={S.msg}>{msg}</span> : null}
      </div>

      <div style={S.lista}>
        {avisos.map((a) => (
          <div key={a.id} style={S.item}>
            <div style={S.itemTxt}>
              <div style={S.itemTit}>{a.emoji} {a.titulo}</div>
              {a.mensagem ? <div style={S.itemMsg}>{a.mensagem}</div> : null}
              <div style={S.viram} title={(leituras[a.id] || []).join(", ")}>
                👁 {(leituras[a.id] || []).length} viram{(leituras[a.id] || []).length > 0 ? ": " + (leituras[a.id] || []).slice(0, 6).join(", ") + ((leituras[a.id] || []).length > 6 ? "..." : "") : ""}
              </div>
            </div>
            <div style={S.itemAcoes}>
              <button style={a.ativo ? S.btnOn : S.btnOff} onClick={() => alternar(a)}>{a.ativo ? "Ativo" : "Desligado"}</button>
              <button style={S.btnDel} onClick={() => remover(a)}>Excluir</button>
            </div>
          </div>
        ))}
        {avisos.length === 0 ? <p style={S.vazio}>Nenhum aviso ainda.</p> : null}
      </div>
    </div>
  );
}

const S = {
  wrap: { padding: 24, maxWidth: 780, margin: "0 auto" },
  h1: { margin: 0, fontSize: 22, color: "#0f172a" },
  sub: { color: "#64748b", fontSize: 14, marginTop: 4 },
  form: { background: "#f8fafc", border: "1px solid #eef2f6", borderRadius: 12, padding: 16, margin: "16px 0", display: "flex", flexDirection: "column", gap: 10 },
  linha: { display: "flex", gap: 8 },
  inEmoji: { width: 56, textAlign: "center", border: "1px solid #cbd5e1", borderRadius: 8, padding: "9px", fontSize: 18 },
  inTitulo: { flex: 1, border: "1px solid #cbd5e1", borderRadius: 8, padding: "9px 11px", fontSize: 14 },
  inMsg: { border: "1px solid #cbd5e1", borderRadius: 8, padding: "9px 11px", fontSize: 14, resize: "vertical" },
  btnCriar: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 700, cursor: "pointer", alignSelf: "flex-start" },
  msg: { color: "#166534", fontSize: 13, fontWeight: 600 },
  lista: { display: "flex", flexDirection: "column", gap: 10 },
  item: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, border: "1px solid #eef2f6", borderRadius: 12, padding: 14, background: "#fff" },
  itemTxt: { flex: 1 },
  itemTit: { fontWeight: 700, color: "#0f172a" },
  itemMsg: { color: "#64748b", fontSize: 13, marginTop: 3 },
  itemAcoes: { display: "flex", gap: 8 },
  btnOn: { background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontWeight: 700, cursor: "pointer" },
  btnOff: { background: "#e2e8f0", color: "#475569", border: "none", borderRadius: 8, padding: "7px 14px", fontWeight: 700, cursor: "pointer" },
  btnDel: { background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 8, padding: "7px 12px", fontWeight: 700, cursor: "pointer" },
  viram: { color: "#2563eb", fontSize: 12, marginTop: 5, fontWeight: 600 },
  vazio: { color: "#94a3b8", fontSize: 14 },
};
