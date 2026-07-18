import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function soDigitos(t) {
  let d = String(t || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length <= 11 && !d.startsWith("55")) d = "55" + d;
  return d;
}

export default function TelefonesAluno({ aluno }) {
  const [f, setF] = useState({
    telefone: "", nome_resp1: "", telefone_resp1: "", nome_resp2: "", telefone_resp2: "",
  });
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setF({
      telefone: aluno?.telefone || "",
      nome_resp1: aluno?.nome_resp1 || "",
      telefone_resp1: aluno?.telefone_resp1 || "",
      nome_resp2: aluno?.nome_resp2 || "",
      telefone_resp2: aluno?.telefone_resp2 || "",
    });
  }, [aluno?.id]);

  async function salvar() {
    if (!aluno?.id) return;
    setSalvando(true);
    try {
      const { error } = await supabase.from("alunos").update({
        telefone: f.telefone.trim() || null,
        nome_resp1: f.nome_resp1.trim() || null,
        telefone_resp1: f.telefone_resp1.trim() || null,
        nome_resp2: f.nome_resp2.trim() || null,
        telefone_resp2: f.telefone_resp2.trim() || null,
      }).eq("id", aluno.id);
      setMsg(error ? "Erro ao salvar: " + error.message : "Telefones salvos.");
    } finally { setSalvando(false); }
  }

  function zap(tel) {
    const d = soDigitos(tel);
    if (!d) { setMsg("Numero vazio ou invalido."); return; }
    window.open("https://wa.me/" + d, "_blank");
  }

  function Linha({ rot, campoNome, campoTel }) {
    return (
      <div style={S.linha}>
        <span style={S.rot}>{rot}</span>
        <div style={S.inputs}>
          {campoNome ? (
            <input
              style={S.inNome}
              placeholder="Nome"
              value={f[campoNome]}
              onChange={(e) => setF((v) => ({ ...v, [campoNome]: e.target.value }))}
            />
          ) : null}
          <input
            style={S.inTel}
            placeholder="(DDD) numero"
            value={f[campoTel]}
            onChange={(e) => setF((v) => ({ ...v, [campoTel]: e.target.value }))}
          />
          <button style={S.zap} onClick={() => zap(f[campoTel])} title="Abrir WhatsApp">WhatsApp</button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.wrap}>
      <div style={S.head}>Telefones</div>
      <Linha rot="Aluno" campoNome={null} campoTel="telefone" />
      <Linha rot="Responsavel 1" campoNome="nome_resp1" campoTel="telefone_resp1" />
      <Linha rot="Responsavel 2" campoNome="nome_resp2" campoTel="telefone_resp2" />
      <div style={S.acoes}>
        <button style={S.salvar} onClick={salvar} disabled={salvando}>
          {salvando ? "Salvando..." : "Salvar telefones"}
        </button>
        {msg ? <span style={S.msg}>{msg}</span> : null}
      </div>
    </div>
  );
}

const S = {
  wrap: { border: "1px solid #eef2f6", borderRadius: 12, padding: 14, marginTop: 12, background: "#fff" },
  head: { fontSize: 13, fontWeight: 700, color: "#0f172a", marginBottom: 10 },
  linha: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" },
  rot: { fontSize: 12, color: "#64748b", fontWeight: 700, minWidth: 96 },
  inputs: { display: "flex", gap: 6, flexWrap: "wrap", flex: 1 },
  inNome: { border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 13, minWidth: 120 },
  inTel: { border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 13, minWidth: 130 },
  zap: { background: "#25D366", color: "#fff", border: "none", borderRadius: 8, padding: "7px 12px", fontWeight: 700, cursor: "pointer", fontSize: 12 },
  acoes: { display: "flex", alignItems: "center", gap: 12, marginTop: 6 },
  salvar: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 8, padding: "9px 14px", fontWeight: 700, cursor: "pointer" },
  msg: { fontSize: 12, color: "#166534", fontWeight: 600 },
};
