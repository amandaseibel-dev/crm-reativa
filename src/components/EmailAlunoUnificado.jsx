import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

// Painel de e-mail no card do aluno: operador escolhe a arte (template),
// os dados do aluno preenchem sozinhos e ele envia pela propria conta Google
// (Gmail compose). Anexos sao adicionados no proprio Gmail. Cada envio fica
// registrado como acionamento (ACAO_MASSIVA_EXTERNA_EMAIL).

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function dataBR(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleDateString("pt-BR");
}

// Sugere a arte pela situacao do caso
function sugerir(aluno) {
  const s = String(aluno?.status_atual || aluno?.status_jornada || "").toLowerCase();
  if (/atraso|vencid/.test(s)) return "acordo_em_atraso";
  if (/acordo|negocia/.test(s)) return "envio_acordo";
  if (!aluno?.data_ultimo_acionamento) return "primeira_abordagem";
  return "lembrete_pagamento";
}

function soDigitos(t) {
  let d = String(t || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length <= 11 && !d.startsWith("55")) d = "55" + d;
  return d;
}

export default function EmailAlunoUnificado({ aluno }) {
  const [templates, setTemplates] = useState([]);
  const [chave, setChave] = useState("");
  const [operador, setOperador] = useState({ nome: "", email: "" });
  const [msg, setMsg] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [emailDest, setEmailDest] = useState(aluno?.email || "");
  const [salvandoEmail, setSalvandoEmail] = useState(false);

  useEffect(() => { setEmailDest(aluno?.email || ""); }, [aluno?.id, aluno?.email]);

  async function salvarEmail() {
    if (!aluno?.id) return;
    setSalvandoEmail(true);
    try {
      const { error } = await supabase.from("alunos").update({ email: emailDest.trim() || null }).eq("id", aluno.id);
      setMsg(error ? "Erro ao salvar e-mail: " + error.message : "E-mail do aluno atualizado.");
    } finally { setSalvandoEmail(false); }
  }

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      const email = u?.user?.email || "";
      const nome = u?.user?.user_metadata?.nome || (email ? email.split("@")[0] : "");
      const { data } = await supabase
        .from("email_templates")
        .select("chave, situacao, assunto, corpo_html, corpo_texto, permite_anexo, ordem")
        .eq("ativo", true)
        .order("ordem");
      if (!ativo) return;
      setOperador({ nome, email });
      setTemplates(data || []);
      setChave(sugerir(aluno));
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, [aluno?.id]);

  const tpl = useMemo(
    () => templates.find((t) => t.chave === chave) || templates[0] || null,
    [templates, chave]
  );

  const campos = useMemo(() => ({
    "{{nome}}": aluno?.nome || "aluno(a)",
    "{{valor}}": moeda(aluno?.valor_em_aberto),
    "{{vencimento}}": dataBR(aluno?.proximo_vencimento || aluno?.data_retorno) || "a combinar",
    "{{link}}": aluno?.link_pagamento || "https://reativa.app/pagar",
    "{{unidade}}": aluno?.unidade || aluno?.estabelecimento || "ULBRA",
    "{{parcela}}": aluno?.parcela || "",
    "{{operador}}": operador.nome || "Equipe ReATIVA",
    "{{operador_email}}": operador.email || "",
  }), [aluno, operador]);

  function merge(txt) {
    let r = String(txt || "");
    Object.entries(campos).forEach(([k, v]) => { r = r.split(k).join(v); });
    return r;
  }

  const assunto = tpl ? merge(tpl.assunto) : "";
  const html = tpl ? merge(tpl.corpo_html) : "";
  const texto = tpl ? merge(tpl.corpo_texto) : "";

  async function registrarAcionamento() {
    if (!aluno?.id) return;
    try {
      await supabase.from("aluno_movimentacoes").insert({
        aluno_id: aluno.id,
        tipo: "ACAO_MASSIVA_EXTERNA_EMAIL",
        descricao: `E-mail (${tpl?.situacao || chave}) enviado por ${operador.email}`,
        registrado_por_email: operador.email,
        registrado_por_nome: operador.nome,
      });
    } catch (e) { /* silencioso */ }
  }

  function abrirGmail() {
    const to = encodeURIComponent(emailDest || "");
    const su = encodeURIComponent(assunto);
    const body = encodeURIComponent(texto);
    window.open(
      `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${su}&body=${body}`,
      "_blank"
    );
    registrarAcionamento();
    setMsg("Gmail aberto na sua conta. Cole a arte (Ctrl+V), anexe o termo se precisar e envie.");
  }

  async function registrarContato(canal) {
    if (!aluno?.id) return;
    try {
      await supabase.from("aluno_movimentacoes").insert({
        aluno_id: aluno.id,
        tipo: "CONTATO",
        descricao: `WhatsApp (${tpl?.situacao || chave}) enviado por ${operador.email}`,
        registrado_por_email: operador.email,
        registrado_por_nome: operador.nome,
      });
    } catch (e) { /* silencioso */ }
  }

  function abrirWhatsapp() {
    const tel = soDigitos(aluno?.telefone);
    if (!tel) { setMsg("Este aluno nao tem telefone cadastrado."); return; }
    window.open("https://wa.me/" + tel + "?text=" + encodeURIComponent(texto), "_blank");
    registrarContato();
    setMsg("WhatsApp aberto com a mensagem do template. Revise e envie.");
  }

  async function copiarArte() {
    try {
      const b1 = new Blob([html], { type: "text/html" });
      const b2 = new Blob([texto], { type: "text/plain" });
      await navigator.clipboard.write([new window.ClipboardItem({ "text/html": b1, "text/plain": b2 })]);
      setMsg("Arte copiada! Cole no corpo do e-mail (Ctrl+V).");
    } catch (e) {
      try { await navigator.clipboard.writeText(html); setMsg("HTML copiado."); }
      catch (e2) { setMsg("Nao consegui copiar automaticamente."); }
    }
  }

  if (carregando) return <p style={S.muted}>Carregando artes...</p>;

  return (
    <div>
      <div style={S.linhaTop}>
        <div style={{ flex: 1 }}>
          <div style={S.rot}>E-mail do aluno (editavel)</div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <input
              type="email"
              value={emailDest}
              onChange={(e) => setEmailDest(e.target.value)}
              placeholder="email@dominio.com"
              style={S.inputEmail}
            />
            <button style={S.btnSalvar} onClick={salvarEmail} disabled={salvandoEmail}>
              {salvandoEmail ? "..." : "Salvar"}
            </button>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={S.rot}>Sua conta</div>
          <div style={S.dest}>{operador.email || "-"}</div>
        </div>
      </div>

      <div style={S.chips}>
        {templates.map((t) => (
          <button
            key={t.chave}
            onClick={() => setChave(t.chave)}
            style={t.chave === chave ? S.chipOn : S.chip}
          >
            {t.situacao}
          </button>
        ))}
      </div>

      <div style={S.assuntoBox}>
        <span style={S.rot}>Assunto</span>
        <div style={S.assunto}>{assunto}</div>
      </div>

      <div style={S.previewWrap}>
        <span style={S.rot}>Pre-visualizacao da arte</span>
        <div style={S.preview} dangerouslySetInnerHTML={{ __html: html }} />
      </div>

      {tpl?.permite_anexo ? (
        <div style={S.anexoNota}>
          📎 Esta arte preve anexo (ex.: termo). Depois de abrir o Gmail, anexe o arquivo antes de enviar.
        </div>
      ) : null}

      <div style={S.acoes}>
        <button style={S.btnZap} onClick={abrirWhatsapp}>Enviar no WhatsApp</button>
        <button style={{ ...S.btnPrim, opacity: emailDest ? 1 : 0.5 }} onClick={abrirGmail} disabled={!emailDest}>Abrir no Gmail</button>
        <button style={S.btnSec} onClick={copiarArte}>Copiar arte</button>
        <button style={S.btnSec} onClick={() => { navigator.clipboard.writeText(texto); setMsg("Texto copiado."); }}>
          Copiar texto
        </button>
      </div>

      {msg ? <div style={S.msg}>{msg}</div> : null}
      <p style={S.rodape}>
        O envio sai da sua conta Google ({operador.email}). O acionamento e registrado automaticamente ao abrir o Gmail.
      </p>
    </div>
  );
}

const S = {
  muted: { color: "#64748b", fontSize: 13 },
  aviso: { background: "#fff3cd", border: "1px solid #ffe69c", color: "#664d03", padding: 14, borderRadius: 10, fontSize: 13 },
  linhaTop: { display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 12 },
  rot: { fontSize: 11, color: "#8a93a3", fontWeight: 700, textTransform: "uppercase" },
  inputEmail: { flex: 1, minWidth: 180, border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 10px", fontSize: 14 },
  btnSalvar: { background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer", color: "#334155" },
  dest: { fontSize: 14, color: "#0f172a", fontWeight: 600 },
  chips: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 },
  chip: { background: "#f1f5f9", border: "1px solid #e2e8f0", color: "#334155", borderRadius: 999, padding: "7px 14px", fontSize: 13, cursor: "pointer" },
  chipOn: { background: "#1d4ed8", border: "1px solid #1d4ed8", color: "#fff", borderRadius: 999, padding: "7px 14px", fontSize: 13, cursor: "pointer", fontWeight: 700 },
  assuntoBox: { marginBottom: 12 },
  assunto: { fontSize: 15, fontWeight: 700, color: "#0f172a", marginTop: 4 },
  previewWrap: { marginBottom: 12 },
  preview: { marginTop: 6, border: "1px solid #eef2f6", borderRadius: 10, padding: 14, background: "#fafafa", maxHeight: 360, overflowY: "auto" },
  anexoNota: { background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af", padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 12 },
  acoes: { display: "flex", gap: 10, flexWrap: "wrap" },
  btnZap: { background: "#25D366", color: "#fff", border: "none", borderRadius: 8, padding: "11px 18px", fontWeight: 700, cursor: "pointer" },
  btnPrim: { background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, padding: "11px 18px", fontWeight: 700, cursor: "pointer" },
  btnSec: { background: "#fff", color: "#1d4ed8", border: "1px solid #1d4ed8", borderRadius: 8, padding: "11px 16px", fontWeight: 700, cursor: "pointer" },
  msg: { marginTop: 12, background: "#dcfce7", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 8, fontSize: 13, fontWeight: 600 },
  rodape: { color: "#8a93a3", fontSize: 12, marginTop: 10, lineHeight: 1.5 },
};
