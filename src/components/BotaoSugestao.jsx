import { useState } from "react";
import { supabase } from "../services/supabase";

const ESTADO_INICIAL = {
  nome: "",
  area: "Sistema ReATIVA",
  tipo: "",
  prioridade: "",
  tela: "",
  descricao: "",
  visivel_equipe: true,
};

export default function BotaoSugestao() {
  const [aberto, setAberto] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const [arquivo, setArquivo] = useState(null);
  const [form, setForm] = useState(ESTADO_INICIAL);

  function atualizar(campo, valor) {
    setForm((f) => ({ ...f, [campo]: valor }));
  }

  function fechar() {
    setAberto(false);
    setTimeout(() => {
      setEnviado(false);
      setErro("");
      setArquivo(null);
      setForm(ESTADO_INICIAL);
    }, 200);
  }

  function selecionarArquivo(e) {
    const f = e.target.files?.[0] || null;
    if (f && f.size > 8 * 1024 * 1024) {
      setErro("O print deve ter no máximo 8 MB.");
      e.target.value = "";
      return;
    }
    setErro("");
    setArquivo(f);
  }

  async function enviar(e) {
    e.preventDefault();
    if (!form.area || !form.tipo || !form.descricao.trim()) {
      setErro("Preencha ao menos Área, Tipo e Descrição.");
      return;
    }
    setErro("");
    setEnviando(true);
    const { data: userData } = await supabase.auth.getUser();

    // Print do erro/tela (opcional) -- sobe pro bucket privado antes de registrar.
    let anexo = {};
    if (arquivo) {
      const nomeSeguro = arquivo.name
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const caminho = `${(userData?.user?.email || "anon").toLowerCase()}/${Date.now()}-${nomeSeguro}`;
      const { error: erroUpload } = await supabase.storage
        .from("sugestoes-prints")
        .upload(caminho, arquivo, { cacheControl: "3600", upsert: false });
      if (erroUpload) {
        setEnviando(false);
        setErro("Não foi possível anexar o print. Tente novamente ou envie sem o anexo.");
        return;
      }
      anexo = { anexo_path: caminho, anexo_nome: arquivo.name };
    }

    const { error } = await supabase.from("sugestoes").insert({
      nome: form.nome.trim() || null,
      autor_email: userData?.user?.email || null,
      area: form.area,
      tipo: form.tipo,
      prioridade: form.prioridade || null,
      tela: form.tela.trim() || (typeof window !== "undefined" ? window.location.pathname : null),
      descricao: form.descricao.trim(),
      visivel_equipe: form.tipo === "Erro" ? !!form.visivel_equipe : false,
      ...anexo,
    });
    setEnviando(false);
    if (error) {
      setErro("Não foi possível enviar agora. Tente novamente.");
      return;
    }
    setEnviado(true);
  }

  const ehErro = form.tipo === "Erro";

  return (
    <>
      <button
        type="button"
        onClick={() => setAberto(true)}
        title="Dúvidas, sugestões e erros do sistema"
        style={S.fab}
      >
        💬 Dúvidas e Sugestões
      </button>

      {aberto && (
        <div style={S.overlay} onClick={fechar}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={S.header}>
              <strong style={S.titulo}>💬 Dúvidas e Sugestões</strong>
              <button type="button" onClick={fechar} style={S.fechar}>✕</button>
            </div>

            {enviado ? (
              <div style={S.sucesso}>
                <p style={S.sucessoTxt}>✅ Enviado, obrigado! Vamos analisar.</p>
                <button type="button" onClick={fechar} style={S.botaoPrimario}>Fechar</button>
              </div>
            ) : (
              <form onSubmit={enviar} style={S.form}>
                <div style={S.aviso}>
                  ⚠️ <strong>Canal oficial.</strong> Registre erros, dúvidas e sugestões só por aqui — é assim que a demanda entra na fila e é acompanhada. Pedidos por WhatsApp, e-mail ou verbais não entram para tratativa.
                </div>
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
                    <option>Dúvida</option>
                    <option>Sugestão / Melhoria</option>
                    <option>Nova ideia</option>
                    <option>Ajuste de informação</option>
                  </select>
                </Campo>
                <Campo label="Prioridade">
                  <select style={S.input} value={form.prioridade} onChange={(e) => atualizar("prioridade", e.target.value)}>
                    <option value="">Selecione</option>
                    <option>Baixa</option>
                    <option>Média</option>
                    <option>Urgente</option>
                  </select>
                </Campo>
                <Campo label="Tela ou seção relacionada">
                  <input style={S.input} placeholder="Ex: CRM Operacional" value={form.tela} onChange={(e) => atualizar("tela", e.target.value)} />
                </Campo>
                <Campo label={ehErro ? "Descreva o erro *" : "Descrição *"}>
                  <textarea style={{ ...S.input, minHeight: 90, resize: "vertical" }} placeholder={ehErro ? "O que aconteceu? O que você estava fazendo quando o erro apareceu?" : "Descreva sua dúvida ou sugestão..."} value={form.descricao} onChange={(e) => atualizar("descricao", e.target.value)} />
                </Campo>
                <Campo label={ehErro ? "Print do erro (recomendado)" : "Print / anexo (opcional)"}>
                  <input type="file" accept="image/*" onChange={selecionarArquivo} style={S.inputFile} />
                  {arquivo && <span style={S.arquivoNome}>📎 {arquivo.name}</span>}
                  {ehErro && !arquivo && <span style={S.dica}>Anexe o print da tela onde o erro aconteceu para acelerar a análise.</span>}
                </Campo>
                {ehErro && (
                  <label style={S.checkLinha}>
                    <input type="checkbox" checked={form.visivel_equipe} onChange={(e) => atualizar("visivel_equipe", e.target.checked)} />
                    <span style={S.checkTexto}>Deixar visível para a equipe (os outros operadores veem que este erro já foi reportado)</span>
                  </label>
                )}
                <button type="submit" disabled={enviando} style={S.botaoPrimario}>
                  {enviando ? "Enviando..." : "Enviar"}
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
    left: "22px",
    bottom: "22px",
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
  inputFile: { fontSize: 12.5, fontFamily: "inherit", color: "#475569" },
  arquivoNome: { fontSize: 12, color: "#16a34a", fontWeight: 700 },
  dica: { fontSize: 11.5, color: "#b45309" },
  checkLinha: { display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" },
  checkTexto: { fontSize: 12, color: "#475569", lineHeight: 1.4 },
  aviso: { background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 10, padding: "10px 12px", fontSize: 12, lineHeight: 1.5 },
  erro: { color: "#dc2626", fontSize: 13, margin: 0 },
  botaoPrimario: { background: "#2563eb", color: "#fff", padding: "11px 18px", borderRadius: 10, fontWeight: 700, fontSize: 14, border: "none", cursor: "pointer" },
  sucesso: { padding: 24, display: "flex", flexDirection: "column", gap: 14, alignItems: "flex-start" },
  sucessoTxt: { fontSize: 15, color: "#15803d", fontWeight: 700, margin: 0 },
};
