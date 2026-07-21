import { useState } from "react";
import { supabase } from "../services/supabase";

export default function BotaoSugestao() {
  const [aberto, setAberto] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const [form, setForm] = useState({
    nome: "",
    area: "Sistema ReATIVA",
    tipo: "",
    prioridade: "",
    tela: "",
    descricao: "",
  });

  function atualizar(campo, valor) {
    setForm((f) => ({ ...f, [campo]: valor }));
  }

  function fechar() {
    setAberto(false);
    setTimeout(() => {
      setEnviado(false);
      setErro("");
      setForm({ nome: "", area: "Sistema ReATIVA", tipo: "", prioridade: "", tela: "", descricao: "" });
    }, 200);
  }

  async function enviar(e) {
    e.preventDefault();
    if (!form.area || !form.tipo || !form.descricao.trim()) {
      setErro("Preencha ao menos Area, Tipo e Descricao.");
      return;
    }
    setErro("");
    setEnviando(true);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("sugestoes").insert({
      nome: form.nome.trim() || null,
      autor_email: userData?.user?.email || null,
      area: form.area,
      tipo: form.tipo,
      prioridade: form.prioridade || null,
      tela: form.tela.trim() || (typeof window !== "undefined" ? window.location.pathname : null),
      descricao: form.descricao.trim(),
    });
    setEnviando(false);
    if (error) {
      setErro("Nao foi possivel enviar agora. Tente novamente.");
      return;
    }
    setEnviado(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAberto(true)}
        title="Enviar sugestao ou reportar um problema"
        style={S.fab}
      >
        💡 Sugestão
      </button>

      {aberto && (
        <div style={S.overlay} onClick={fechar}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={S.header}>
              <strong style={S.titulo}>💡 Enviar sugestão</strong>
              <button type="button" onClick={fechar} style={S.fechar}>✕</button>
            </div>

            {enviado ? (
              <div style={S.sucesso}>
                <p style={S.sucessoTxt}>✅ Sugestão enviada, obrigado!</p>
                <button type="button" onClick={fechar} style={S.botaoPrimario}>Fechar</button>
              </div>
            ) : (
              <form onSubmit={enviar} style={S.form}>
                {erro && <p style={S.erro}>{erro}</p>}
                <Campo label="Nome">
                  <input style={S.input} placeholder="Seu nome" value={form.nome} onChange={(e) => atualizar("nome", e.target.value)} />
                </Campo>
                <Campo label="Área *">
                  <select style={S.input} value={form.area} onChange={(e) => atualizar("area", e.target.value)}>
                    <option>Sistema ReATIVA</option>
                    <option>CRM Mensageria</option>
                    <option>Portal Reativa</option>
                  </select>
                </Campo>
                <Campo label="Tipo *">
                  <select style={S.input} value={form.tipo} onChange={(e) => atualizar("tipo", e.target.value)}>
                    <option value="">Selecione</option>
                    <option>Erro</option>
                    <option>Melhoria</option>
                    <option>Nova ideia</option>
                    <option>Ajuste de informação</option>
                    <option>Dúvida</option>
                  </select>
                </Campo>
                <Campo label="Prioridade">
                  <select style={S.input} value={form.prioridade} onChange={(e) => atualizar("prioridade", e.target.value)}>
                    <option value="">Selecione</option>
                    <option>Baixa</option>
                    <option>Média</option>
                    <option>Alta</option>
                  </select>
                </Campo>
                <Campo label="Tela ou seção relacionada">
                  <input style={S.input} placeholder="Ex: CRM Operacional" value={form.tela} onChange={(e) => atualizar("tela", e.target.value)} />
                </Campo>
                <Campo label="Descrição da sugestão *">
                  <textarea style={{ ...S.input, minHeight: 90, resize: "vertical" }} placeholder="Descreva sua sugestão..." value={form.descricao} onChange={(e) => atualizar("descricao", e.target.value)} />
                </Campo>
                <button type="submit" disabled={enviando} style={S.botaoPrimario}>
                  {enviando ? "Enviando..." : "Enviar sugestão"}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Campo({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={S.labelCampo}>{label}</span>
      {children}
    </label>
  );
}

const S = {
  fab: {
    position: "fixed",
    right: "22px",
    bottom: "78px",
    zIndex: 999999,
    background: "#2563eb",
    color: "#ffffff",
    border: "2px solid #ffffff",
    borderRadius: "999px",
    padding: "14px 20px",
    fontWeight: "bold",
    fontSize: "14px",
    cursor: "pointer",
    boxShadow: "0 10px 25px rgba(0,0,0,0.35)",
  },
  overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", zIndex: 1000000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  modal: { background: "#fff", borderRadius: 16, width: "100%", maxWidth: 440, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 50px rgba(0,0,0,0.35)", fontFamily: "Inter, system-ui, sans-serif" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e6eaf0" },
  titulo: { fontSize: 16, color: "#0d1321" },
  fechar: { background: "transparent", border: "none", fontSize: 18, cursor: "pointer", color: "#64748b" },
  form: { display: "flex", flexDirection: "column", gap: 12, padding: 20 },
  input: { padding: "9px 12px", borderRadius: 10, border: "1px solid #e6eaf0", fontSize: 13.5, fontFamily: "inherit" },
  labelCampo: { fontSize: 12.5, fontWeight: 700, color: "#475569" },
  erro: { color: "#dc2626", fontSize: 13, margin: 0 },
  botaoPrimario: { background: "#2563eb", color: "#fff", padding: "11px 18px", borderRadius: 10, fontWeight: 700, fontSize: 14, border: "none", cursor: "pointer" },
  sucesso: { padding: 24, display: "flex", flexDirection: "column", gap: 14, alignItems: "flex-start" },
  sucessoTxt: { fontSize: 15, color: "#15803d", fontWeight: 700, margin: 0 },
};
