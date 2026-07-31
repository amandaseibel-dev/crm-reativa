import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Editor da "mensagem especial" da TV ReATIVA (slide "campanha").
// Escrita restrita à gestão pela RLS de tv_mensagem_especial (Amanda/Fernanda).
// A mensagem só aparece na TV depois que o snapshot é regenerado — por isso o
// botão "Salvar e atualizar TV" salva e já dispara tv_snapshot_atualizar.
export default function TvMensagem() {
  const [id, setId] = useState(null);
  const [titulo, setTitulo] = useState("");
  const [texto, setTexto] = useState("");
  const [ativo, setAtivo] = useState(true);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState("");

  async function carregar() {
    setCarregando(true);
    const { data, error } = await supabase
      .from("tv_mensagem_especial")
      .select("id, titulo, texto, ativo")
      .order("atualizado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) {
      setId(data.id);
      setTitulo(data.titulo || "");
      setTexto(data.texto || "");
      setAtivo(data.ativo !== false);
    }
    setCarregando(false);
  }

  useEffect(() => {
    carregar();
  }, []);

  async function salvar(atualizarTv) {
    setSalvando(true);
    setMsg("");
    const payload = { titulo, texto, ativo, atualizado_em: new Date().toISOString() };
    let error;
    if (id) {
      ({ error } = await supabase.from("tv_mensagem_especial").update(payload).eq("id", id));
    } else {
      const res = await supabase.from("tv_mensagem_especial").insert(payload).select("id").single();
      error = res.error;
      if (res.data) setId(res.data.id);
    }
    if (error) {
      setMsg("Não foi possível salvar: " + error.message);
      setSalvando(false);
      return;
    }
    if (atualizarTv) {
      const { data, error: e2 } = await supabase.rpc("tv_snapshot_atualizar");
      if (e2 || data?.status === "erro") {
        setMsg("Mensagem salva, mas a TV não atualizou agora: " + (e2?.message || data?.erro_resumo || ""));
        setSalvando(false);
        return;
      }
      setMsg("Mensagem salva e TV atualizada ✅ (versão " + (data?.versao ?? "?") + ")");
    } else {
      setMsg("Mensagem salva ✅ — aparece na TV na próxima atualização da projeção.");
    }
    setSalvando(false);
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 900, color: "#0f172a", margin: "0 0 4px" }}>📺 Mensagem especial da TV</h1>
      <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 20px" }}>
        Texto exibido no slide de campanha da TV ReATIVA. As mudanças aparecem na TV após atualizar o snapshot.
      </p>

      {carregando ? (
        <div style={{ color: "#64748b" }}>Carregando…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={lbl}>Título (destaque)</span>
            <input
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder="🔥 BORA TIME! 🔥"
              maxLength={80}
              style={inp}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={lbl}>Texto (linha de apoio)</span>
            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Meta do mês: R$ 500 mil em honorários"
              maxLength={200}
              rows={3}
              style={{ ...inp, resize: "vertical" }}
            />
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#0f172a", fontWeight: 600 }}>
            <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
            Mostrar este slide na TV
          </label>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
            <button type="button" disabled={salvando} onClick={() => salvar(true)} style={btnPrimario}>
              {salvando ? "Salvando…" : "Salvar e atualizar TV"}
            </button>
            <button type="button" disabled={salvando} onClick={() => salvar(false)} style={btnSecundario}>
              Salvar sem atualizar
            </button>
          </div>

          {msg && <div style={{ fontSize: 14, color: msg.includes("não") || msg.includes("não foi") ? "#b91c1c" : "#15803d", fontWeight: 600 }}>{msg}</div>}

          <div style={{ marginTop: 8, fontSize: 13, color: "#64748b", background: "#f1f5f9", borderRadius: 10, padding: "10px 12px" }}>
            <strong>Prévia do slide:</strong>
            <div style={{ marginTop: 8, background: "linear-gradient(135deg,#6d28d9,#1d4ed8)", color: "#fff", borderRadius: 10, padding: "18px", textAlign: "center" }}>
              <div style={{ fontSize: 12, color: "#fde68a", fontWeight: 800, letterSpacing: 2 }}>✨ CAMPANHA ESPECIAL ✨</div>
              <div style={{ fontSize: 26, fontWeight: 900, margin: "6px 0" }}>{titulo || "🔥 BORA TIME! 🔥"}</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{texto || "Meta do mês: R$ 500 mil em honorários"}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const lbl = { fontSize: 13, fontWeight: 700, color: "#334155" };
const inp = { border: "1px solid #cbd5e1", borderRadius: 10, padding: "10px 12px", fontSize: 15, color: "#0f172a", outline: "none" };
const btnPrimario = { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 800, cursor: "pointer" };
const btnSecundario = { background: "#e2e8f0", color: "#0f172a", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, cursor: "pointer" };
