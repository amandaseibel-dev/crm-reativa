import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

// Envio em lote pelo proprio Gmail do usuario, com contador de seguranca
// diario pra nao bloquear a conta. Um aluno por vez: escolhe a arte, abre o
// Gmail ja preenchido (sai da SUA conta), registra o acionamento e avanca.

const FONTE = "'Sora', 'Inter', system-ui, sans-serif";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function proximoDiaUtil(dias) {
  const d = new Date();
  let add = 0;
  const alvo = dias || 10;
  while (add < alvo) {
    d.setDate(d.getDate() + 1);
    const w = d.getDay();
    if (w !== 0 && w !== 6) add += 1;
  }
  return d.toISOString().slice(0, 10);
}

export default function EnvioGmailLote() {
  const [operador, setOperador] = useState({ nome: "", email: "" });
  const [templates, setTemplates] = useState([]);
  const [chave, setChave] = useState("");
  const [fila, setFila] = useState([]);
  const [idx, setIdx] = useState(0);
  const [enviadosHoje, setEnviadosHoje] = useState(0);
  const [limite, setLimite] = useState(100);
  const [carregando, setCarregando] = useState(true);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      const email = u?.user?.email || "";
      const nome = u?.user?.user_metadata?.nome || (email ? email.split("@")[0] : "");
      setOperador({ nome, email });

      const { data: tpls } = await supabase
        .from("email_templates")
        .select("chave, situacao, assunto, corpo_html, corpo_texto, permite_anexo, ordem, dias_retorno")
        .eq("ativo", true)
        .order("ordem");
      setTemplates(tpls || []);
      setChave((tpls && tpls[0] && tpls[0].chave) || "");

      await contarHoje(email);
      await carregarFila();
      setCarregando(false);
    })();
  }, []);

  async function contarHoje(email) {
    const hoje = new Date().toISOString().slice(0, 10);
    const { count } = await supabase
      .from("aluno_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("registrado_por_email", email)
      .eq("tipo", "ACAO_MASSIVA_EXTERNA_EMAIL")
      .gte("registrado_em", hoje + "T00:00:00");
    setEnviadosHoje(count || 0);
  }

  async function carregarFila() {
    const { data } = await supabase.rpc("buscar_candidatos_acoes_massivas", {
      p_ano_vencimento: null,
      p_limite: 300,
      p_dias_minimo_sem_contato: null,
      p_apenas_nunca_acionado: false,
    });
    const comEmail = (data || [])
      .filter((a) => String(a.email || "").trim())
      .map((a) => ({ id: a.id, nome: a.nome || "aluno(a)", email: String(a.email).trim(), valor: Number(a.valor || 0) }));
    setFila(comEmail);
    setIdx(0);
  }

  const tpl = useMemo(() => templates.find((t) => t.chave === chave) || templates[0] || null, [templates, chave]);
  const atual = fila[idx] || null;

  const campos = useMemo(() => ({
    "{{nome}}": atual?.nome || "aluno(a)",
    "{{valor}}": moeda(atual?.valor),
    "{{operador}}": operador.nome || "Equipe ReATIVA",
    "{{operador_email}}": operador.email || "",
    "{{unidade}}": "ULBRA",
    "{{link}}": "https://reativa.app/pagar",
    "{{vencimento}}": "a combinar",
    "{{parcela}}": "",
  }), [atual, operador]);

  function merge(txt) {
    let r = String(txt || "");
    Object.entries(campos).forEach(([k, v]) => { r = r.split(k).join(v); });
    return r;
  }

  const assunto = tpl ? merge(tpl.assunto) : "";
  const html = tpl ? merge(tpl.corpo_html) : "";
  const texto = tpl ? merge(tpl.corpo_texto) : "";

  async function registrar(a) {
    const agora = new Date().toISOString();
    await supabase.from("alunos").update({
      data_retorno: proximoDiaUtil(tpl?.dias_retorno || 10),
      status_acionamento: "Ação massiva externa enviada — aguardando retorno",
      status_jornada: "RETORNAR_DEPOIS",
      status_atual: "RETORNAR_DEPOIS",
      proxima_acao: "RETORNAR",
      data_ultimo_acionamento: agora,
    }).eq("id", a.id);
    await supabase.from("aluno_movimentacoes").insert({
      aluno_id: String(a.id),
      tipo: "ACAO_MASSIVA_EXTERNA_EMAIL",
      descricao: "E-mail (" + (tpl?.situacao || chave) + ") enviado pelo Gmail de " + operador.email + " (envio em lote).",
      registrado_por_nome: operador.nome,
      registrado_por_email: operador.email,
      registrado_em: agora,
    });
  }

  async function enviar() {
    if (!atual) return;
    if (enviadosHoje >= limite) {
      setMsg("Limite diário atingido (" + limite + "). Pare por hoje pra não arriscar bloqueio da conta.");
      return;
    }
    let copiou = false;
    try {
      const b1 = new Blob([html], { type: "text/html" });
      const b2 = new Blob([texto], { type: "text/plain" });
      await navigator.clipboard.write([new window.ClipboardItem({ "text/html": b1, "text/plain": b2 })]);
      copiou = true;
    } catch (e) { copiou = false; }

    const to = encodeURIComponent(atual.email);
    const su = encodeURIComponent(assunto);
    const body = copiou ? "" : encodeURIComponent(texto);
    const CC_TERMO = "cobranca04@aelbra.com.br,cobranca07@aelbra.com.br,amanda.seibel@aelbra.com.br";
    const cc = tpl?.chave === "envio_acordo" ? "&cc=" + encodeURIComponent(CC_TERMO) : "";
    window.open("https://mail.google.com/mail/?view=cm&fs=1&to=" + to + "&su=" + su + cc + "&body=" + body, "_blank");

    await registrar(atual);
    setEnviadosHoje((n) => n + 1);
    setIdx((i) => i + 1);
    setMsg(copiou
      ? "Gmail aberto — cole a arte (Ctrl+V)" + (tpl?.permite_anexo ? ", anexe o termo" : "") + " e envie. Já avancei pro próximo."
      : "Gmail aberto com o texto pronto. Revise e envie. Já avancei pro próximo.");
  }

  function pular() { setIdx((i) => i + 1); setMsg(""); }

  const restantesFila = Math.max(fila.length - idx, 0);
  const restantesLimite = Math.max(limite - enviadosHoje, 0);
  const atingiuLimite = enviadosHoje >= limite;
  const pct = limite > 0 ? Math.min(100, Math.round((enviadosHoje / limite) * 100)) : 0;

  if (carregando) return <div style={S.container}>Carregando fila de envio...</div>;

  return (
    <div style={S.container}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>📧 Envio pelo meu Gmail</h1>
          <p style={S.subtitulo}>Envio em lote, um por vez, pela sua conta ({operador.email || "-"}). A cada envio o Gmail abre preenchido, o acionamento é registrado e avança pro próximo. O contador trava ao chegar no limite pra não bloquear sua conta.</p>
        </div>
        <button style={S.botaoSec} onClick={() => { carregarFila(); contarHoje(operador.email); }}>Atualizar fila</button>
      </div>

      <div style={S.contadorCard}>
        <div style={S.contadorTopo}>
          <span style={S.contadorLabel}>Enviados hoje</span>
          <span style={S.contadorNum}>{enviadosHoje} <span style={{ color: "#8a93a3", fontWeight: 600, fontSize: 15 }}>/ {limite}</span></span>
          <label style={S.limiteBox}>Limite diário
            <input style={S.limiteInput} type="number" min="1" max="500" value={limite} onChange={(e) => setLimite(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
          </label>
        </div>
        <div style={S.barraFundo}><div style={{ ...S.barra, width: pct + "%", background: atingiuLimite ? "#dc2626" : "#16a34a" }} /></div>
        <div style={S.contadorSub}>{restantesLimite} restantes hoje · {restantesFila} na fila de candidatos</div>
      </div>

      <div style={S.chips}>
        {templates.map((t) => (
          <button key={t.chave} onClick={() => setChave(t.chave)} style={t.chave === chave ? S.chipOn : S.chip}>{t.situacao}</button>
        ))}
      </div>

      {atingiuLimite ? (
        <div style={S.avisoLimite}>✋ Você atingiu o limite de {limite} envios hoje. Pare por aqui pra não arriscar bloqueio da sua conta Google. Amanhã o contador zera.</div>
      ) : !atual ? (
        <div style={S.vazio}>Sem candidatos na fila com e-mail. Clique em "Atualizar fila" ou ajuste os casos livres.</div>
      ) : (
        <div style={S.cardEnvio}>
          <div style={S.alunoTopo}>
            <div>
              <div style={S.alunoNome}>{atual.nome}</div>
              <div style={S.alunoMeta}>{atual.email} · Em aberto: {moeda(atual.valor)}</div>
            </div>
            <span style={S.posicao}>{idx + 1} de {fila.length}</span>
          </div>

          <div style={S.assuntoBox}><span style={S.rot}>Assunto</span><div style={S.assunto}>{assunto}</div></div>
          <div><span style={S.rot}>Pré-visualização da arte</span><div style={S.preview} dangerouslySetInnerHTML={{ __html: html }} /></div>

          <div style={S.acoes}>
            <button style={S.botaoEnviar} onClick={enviar}>Abrir no Gmail e registrar →</button>
            <button style={S.botaoPular} onClick={pular}>Pular este</button>
          </div>
          {msg ? <div style={S.msg}>{msg}</div> : null}
        </div>
      )}

      <p style={S.rodape}>Dica: envie em ritmo tranquilo (alguns por minuto), personalizado. O envio sai da sua conta Google e cada acionamento é registrado automaticamente.</p>
    </div>
  );
}

const S = {
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "#f4f6fa", minHeight: "100%", color: "#0f172a" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" },
  titulo: { margin: 0, color: "#0d1321", fontFamily: FONTE, fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "6px 0 0", color: "#8a93a3", fontSize: 13, maxWidth: 680 },
  botaoSec: { background: "#fff", color: "#334155", border: "1px solid #e2e8f0", borderRadius: 10, padding: "9px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  contadorCard: { background: "#fff", border: "1px solid #edf0f5", borderRadius: 16, padding: 18, marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 },
  contadorTopo: { display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" },
  contadorLabel: { fontSize: 12.5, fontWeight: 700, color: "#8a93a3", textTransform: "uppercase", letterSpacing: "0.06em" },
  contadorNum: { fontFamily: FONTE, fontSize: 30, fontWeight: 800, color: "#0d1321", lineHeight: 1 },
  limiteBox: { marginLeft: "auto", display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 700, color: "#475569" },
  limiteInput: { border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 8px", fontSize: 13, width: 90, background: "#fff", color: "#0f172a" },
  barraFundo: { background: "#f1f5f9", borderRadius: 999, height: 10, overflow: "hidden" },
  barra: { height: "100%", borderRadius: 999, transition: "width 0.25s ease" },
  contadorSub: { fontSize: 12.5, color: "#5b6b7a" },
  chips: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 },
  chip: { background: "#fff", border: "1px solid #e2e8f0", color: "#334155", borderRadius: 999, padding: "7px 14px", fontSize: 13, cursor: "pointer" },
  chipOn: { background: "#1d4ed8", border: "1px solid #1d4ed8", color: "#fff", borderRadius: 999, padding: "7px 14px", fontSize: 13, cursor: "pointer", fontWeight: 700 },
  avisoLimite: { background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 14, padding: 18, fontSize: 14, fontWeight: 700 },
  vazio: { background: "#fff", border: "1px solid #edf0f5", borderRadius: 14, padding: 18, color: "#8a93a3", fontSize: 14 },
  cardEnvio: { background: "#fff", border: "1px solid #edf0f5", borderRadius: 16, padding: 20, display: "flex", flexDirection: "column", gap: 14 },
  alunoTopo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" },
  alunoNome: { fontFamily: FONTE, fontSize: 19, fontWeight: 800, color: "#0d1321" },
  alunoMeta: { fontSize: 13, color: "#5b6b7a", marginTop: 3 },
  posicao: { fontSize: 12.5, fontWeight: 700, color: "#475569", background: "#f1f5f9", borderRadius: 999, padding: "3px 12px" },
  rot: { fontSize: 11, color: "#8a93a3", fontWeight: 700, textTransform: "uppercase" },
  assuntoBox: {},
  assunto: { fontSize: 15, fontWeight: 700, color: "#0f172a", marginTop: 4 },
  preview: { marginTop: 6, border: "1px solid #eef2f6", borderRadius: 10, padding: 14, background: "#fafafa", maxHeight: 320, overflowY: "auto" },
  acoes: { display: "flex", gap: 10, flexWrap: "wrap" },
  botaoEnviar: { background: "#16a34a", color: "#fff", border: "none", borderRadius: 10, padding: "12px 20px", fontWeight: 800, fontSize: 14, cursor: "pointer" },
  botaoPular: { background: "#fff", color: "#334155", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 18px", fontWeight: 700, fontSize: 14, cursor: "pointer" },
  msg: { background: "#dcfce7", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 8, fontSize: 13, fontWeight: 600 },
  rodape: { color: "#8a93a3", fontSize: 12, marginTop: 16, lineHeight: 1.5 },
};
