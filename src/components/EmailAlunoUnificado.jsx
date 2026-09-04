import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { rotuloStatus } from "../utils/rotulosStatus";
import { carregarTabulacoes, desfechoDaTabulacao, descreverPrazo, dataBRDeISO } from "../utils/tabulacoes";

// Painel de e-mail no card do aluno: operador escolhe a arte (template),
// os dados do aluno preenchem sozinhos e ele envia pela propria conta Google
// (Gmail compose). Anexos sao adicionados no proprio Gmail. Cada envio fica
// registrado como acionamento (ACAO_MASSIVA_EXTERNA_EMAIL) e TABULA o caso
// como "Mensagem enviada" -- a mesma tabulacao do botao rapido da Minha
// Carteira (Amanda, 04/09/2026). Quem monta este painel recebe `onTabulado`
// para refletir o status novo na propria tela (select, retorno, lista).

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
  if (!aluno?.data_ultimo_acionamento) return "aviso_mensalidades_aberto";
  return "lembrete_pagamento";
}

// Status em que o caso NAO esta na mao do operador (pago aguardando baixa,
// encerrado pela gestao, sem saldo). Mandar e-mail nesses casos registra o
// contato, mas nao muda a tabulacao -- senao "Aguardando baixa" viraria
// "Mensagem enviada" e o caso sairia da fila de confirmacao. Mesma lista dos
// nao acionaveis da Minha Carteira.
const STATUS_FORA_DA_MAO = [
  "AGUARDANDO_BAIXA",
  "JURIDICO",
  "CANCELAMENTO_COBRANCA",
  "SUSPENSAO_COBRANCA",
  "SEM_SALDO_EM_ABERTO",
  "SALDO_ZERO_CONFIRMADO",
];
function foraDaMaoDoOperador(aluno) {
  const s = String(aluno?.status_atual || aluno?.status_jornada || "").toUpperCase();
  if (s.startsWith("QUITAD") || STATUS_FORA_DA_MAO.includes(s)) return true;
  // "Aguardando confirmacao de pagamento" chega como texto humano em
  // status_jornada (card Confirmar pagamento) -- mesma leitura da Carteira.
  const sj = String(aluno?.status_jornada || "").toUpperCase();
  return sj.includes("AGUARDANDO CONFIRMA");
}

function soDigitos(t) {
  let d = String(t || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length <= 11 && !d.startsWith("55")) d = "55" + d;
  return d;
}

export default function EmailAlunoUnificado({ aluno, onTabulado }) {
  const [templates, setTemplates] = useState([]);
  const [chave, setChave] = useState("");
  const [operador, setOperador] = useState({ nome: "", email: "" });
  const [msg, setMsg] = useState("");
  const [msgErro, setMsgErro] = useState(false);
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
        .select("chave, situacao, assunto, corpo_html, corpo_texto, permite_anexo, ordem, dias_retorno, novo")
        .eq("ativo", true)
        .order("ordem");
      if (!ativo) return;
      const lista = data || [];
      const sugerida = sugerir(aluno);
      setOperador({ nome, email });
      setTemplates(lista);
      // a arte sugerida pode estar fora do ar; nesse caso cai na primeira disponivel
      setChave(lista.some((t) => t.chave === sugerida) ? sugerida : lista[0]?.chave || "");
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

  // Enviar e-mail JA E a tabulacao "Mensagem enviada" -- a mesma do botao
  // rapido. Antes gravava "Retornar depois" em silencio, o modal da Carteira
  // nao ficava sabendo, e o "Finalizar atendimento" seguinte gravava o status
  // velho ("A contatar", retorno hoje) por cima. Devolve o que foi gravado
  // para a tela-mae se atualizar; lanca erro quando o banco recusa.
  async function tabularEnvioEmail() {
    if (!aluno?.id) return null;
    const agora = new Date().toISOString();
    const statusAntigo = aluno.status_atual || aluno.status_jornada || null;
    const situacao = tpl?.situacao || chave;
    const base = { data_ultimo_acionamento: agora, ultimo_contato: agora };

    if (foraDaMaoDoOperador(aluno)) {
      const { error } = await supabase.from("alunos").update(base).eq("id", aluno.id);
      if (error) throw error;
      return { status: statusAntigo, statusAntigo, dataRetorno: null, mantido: true, agora };
    }

    // Prazo do catalogo de tabulacoes (a mesma regra do botao rapido, do
    // modal e da ficha) -- nao mais o `dias_retorno` da arte. Data futura que
    // o operador ja marcou fica.
    const catalogo = await carregarTabulacoes();
    const desfecho = desfechoDaTabulacao(catalogo, "MENSAGEM_ENVIADA", {
      retornoAtual: { data: aluno.data_retorno, origem: aluno.retorno_origem },
    });
    const campos = {
      ...base,
      status_jornada: "MENSAGEM_ENVIADA",
      status_atual: "MENSAGEM_ENVIADA",
      status_acionamento: "E-mail enviado - " + situacao,
      proxima_acao: desfecho.proxima_acao,
    };
    if (desfecho.data_retorno) {
      campos.data_retorno = desfecho.data_retorno;
      campos.retorno_origem = desfecho.retorno_origem;
    }
    const { error } = await supabase.from("alunos").update(campos).eq("id", aluno.id);
    if (error) throw error;
    return {
      status: "MENSAGEM_ENVIADA",
      statusAntigo,
      dataRetorno: desfecho.data_retorno || null,
      prazo: desfecho.motivo === "MANTIDA" ? "data que você já tinha marcado" : descreverPrazo(catalogo, "MENSAGEM_ENVIADA"),
      mantido: false,
      agora,
    };
  }

  // Historico do aluno: o e-mail e, junto, a tabulacao que ele gravou (ou o
  // motivo de nao ter gravado). `info` nulo = o status nao foi salvo.
  async function registrarAcionamento(info) {
    if (!aluno?.id) return;
    const situacao = tpl?.situacao || chave;
    let desfecho = " — sem tabular (erro ao gravar o status).";
    if (info?.mantido) desfecho = ` — tabulação "${rotuloStatus(info.status)}" mantida.`;
    else if (info) desfecho = ` — tabulado como "Mensagem enviada"${info.dataRetorno ? `, retorno ${dataBRDeISO(info.dataRetorno)} (${info.prazo})` : ""}.`;
    const linha = {
      aluno_id: String(aluno.id),
      tipo: "ACAO_MASSIVA_EXTERNA_EMAIL",
      descricao: `E-mail (${situacao}) enviado por ${operador.email}${desfecho}`,
      registrado_por_email: operador.email,
      registrado_por_nome: operador.nome,
      registrado_em: info?.agora || new Date().toISOString(),
    };
    if (info) {
      linha.status_anterior = info.statusAntigo;
      linha.status_novo = info.status;
    }
    try {
      await supabase.from("aluno_movimentacoes").insert(linha);
    } catch (e) { /* silencioso: o historico nao pode travar o envio */ }
  }

  async function abrirGmail() {
    // Copia a arte formatada ANTES de abrir. Se copiar, abre o corpo VAZIO
    // pra colar limpo (Ctrl+V); se falhar, cai no texto pre-preenchido.
    let arteCopiada = false;
    try {
      const b1 = new Blob([html], { type: "text/html" });
      const b2 = new Blob([texto], { type: "text/plain" });
      await navigator.clipboard.write([new window.ClipboardItem({ "text/html": b1, "text/plain": b2 })]);
      arteCopiada = true;
    } catch (e) { arteCopiada = false; }
    const to = encodeURIComponent(emailDest || "");
    const su = encodeURIComponent(assunto);
    const body = arteCopiada ? "" : encodeURIComponent(texto);
    // Envio de termo de acordo vai com copia (CC) fixa: Fernanda, Amanda ADM e Amanda
    // (a operacao valida os recebimentos).
    const CC_TERMO = "cobranca04@aelbra.com.br,cobranca07@aelbra.com.br,amanda.seibel@aelbra.com.br";
    const cc = tpl?.chave === "envio_acordo" ? "&cc=" + encodeURIComponent(CC_TERMO) : "";
    window.open(
      `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${su}${cc}&body=${body}`,
      "_blank"
    );

    // Primeiro a ficha (status + retorno + data do acionamento), depois o
    // historico: o gatilho da movimentacao recalcula a situacao e, com o
    // acionamento de hoje ja gravado, preserva o retorno que acabou de entrar.
    let info = null;
    let erroTabulacao = null;
    try {
      info = await tabularEnvioEmail();
    } catch (e) {
      erroTabulacao = e;
    }
    await registrarAcionamento(info);
    if (info && typeof onTabulado === "function") {
      try { await onTabulado(info); } catch (e) { /* a tela-mae trata o proprio erro */ }
    }

    const abertura = arteCopiada
      ? "Gmail aberto! Clique no corpo do e-mail e cole a arte com Ctrl+V" + (tpl?.permite_anexo ? ", anexe o termo" : "") + " e envie."
      : "Gmail aberto com o texto pronto. Revise e envie.";
    if (erroTabulacao) {
      setMsgErro(true);
      setMsg(`${abertura} NÃO consegui tabular "Mensagem enviada" (${erroTabulacao?.message || "erro desconhecido"}). Tabule na aba Tabulação.`);
    } else if (info?.mantido) {
      setMsgErro(false);
      setMsg(`${abertura} A tabulação "${rotuloStatus(info.status)}" foi mantida (caso fora da fila do operador); o e-mail ficou no histórico.`);
    } else {
      setMsgErro(false);
      setMsg(`${abertura} Tabulado como "Mensagem enviada"${info?.dataRetorno ? ` — retorno em ${dataBRDeISO(info.dataRetorno)} (${info.prazo})` : ""}.`);
    }
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
    if (!tel) { setMsg("Este aluno não tem telefone cadastrado."); return; }
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
          <div style={S.rot}>E-mails do aluno (separe por vírgula)</div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <input
              type="email"
              value={emailDest}
              onChange={(e) => setEmailDest(e.target.value)}
              placeholder="email1@dominio.com, email2@dominio.com"
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
        <button style={{ ...S.btnPrim, opacity: emailDest ? 1 : 0.5 }} onClick={abrirGmail} disabled={!emailDest}>Abrir no Gmail (arte copiada)</button>
        <button style={S.btnSec} onClick={copiarArte}>Copiar arte</button>
        <button style={S.btnSec} onClick={() => { navigator.clipboard.writeText(texto); setMsg("Texto copiado."); }}>
          Copiar texto
        </button>
      </div>

      {msg ? <div style={msgErro ? S.msgErro : S.msg}>{msg}</div> : null}
      <p style={S.rodape}>
        O envio sai da sua conta Google ({operador.email}). Ao abrir o Gmail o caso e tabulado como
        &quot;Mensagem enviada&quot; (a mesma tabulacao do botao rapido) e o retorno segue a regra dessa tabulacao.
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
  msg: { marginTop: 12, background: "#dcfce7", border: "1px solid #bfdbfe", color: "#166534", padding: 10, borderRadius: 8, fontSize: 13, fontWeight: 600 },
  msgErro: { marginTop: 12, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 8, fontSize: 13, fontWeight: 600 },
  rodape: { color: "#8a93a3", fontSize: 12, marginTop: 10, lineHeight: 1.5 },
};
