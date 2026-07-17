import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

export default function AvisoTemplateNovo() {
  const [novos, setNovos] = useState([]);
  const [mostrar, setMostrar] = useState(false);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data } = await supabase
        .from("email_templates")
        .select("chave, situacao")
        .eq("ativo", true)
        .eq("novo", true)
        .order("ordem");
      if (!ativo) return;
      const lista = Array.isArray(data) ? data : [];
      setNovos(lista);
      if (lista.length > 0) {
        const chave = "aviso_pop_templates_" + lista.map((t) => t.chave).sort().join("_");
        let jaViu = false;
        try { jaViu = window.localStorage.getItem(chave) === "1"; } catch (e) {}
        if (!jaViu) setMostrar(true);
      }
    })();
    return () => { ativo = false; };
  }, []);

  if (!mostrar || novos.length === 0) return null;

  function fechar() {
    try {
      const chave = "aviso_pop_templates_" + novos.map((t) => t.chave).sort().join("_");
      window.localStorage.setItem(chave, "1");
    } catch (e) {}
    setMostrar(false);
  }

  return (
    <div style={S.overlay} onClick={fechar}>
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <div style={S.emoji}>✨</div>
        <h2 style={S.titulo}>Novo template disponível</h2>
        <p style={S.texto}>
          Já está no ar a arte de e-mail:
        </p>
        <div style={S.lista}>
          {novos.map((t) => (
            <span key={t.chave} style={S.chip}>{t.situacao}</span>
          ))}
        </div>
        <p style={S.dica}>Abra a ficha do aluno, aba <strong>E-mail</strong>, e selecione nos chips.</p>
        <button style={S.botao} onClick={fechar}>Entendi</button>
      </div>
    </div>
  );
}

const S = {
  overlay: { position: "fixed", inset: 0, background: "rgba(2,6,23,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20 },
  card: { background: "#fff", borderRadius: 16, padding: "26px 28px", maxWidth: 420, width: "100%", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" },
  emoji: { fontSize: 40 },
  titulo: { margin: "8px 0 6px", fontSize: 20, color: "#0f172a" },
  texto: { margin: 0, color: "#475569", fontSize: 14 },
  lista: { display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", margin: "12px 0" },
  chip: { background: "#dbeafe", color: "#1e40af", borderRadius: 999, padding: "6px 14px", fontSize: 13, fontWeight: 700 },
  dica: { margin: "6px 0 18px", color: "#64748b", fontSize: 13 },
  botao: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 10, padding: "11px 22px", fontWeight: 700, fontSize: 15, cursor: "pointer" },
};
