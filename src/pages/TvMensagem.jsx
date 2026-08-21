import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { telasParaAdmin, PREFIXO_IMG } from "../components/tv/tvTelas";

// =============================================================================
// Painel da TV ReATIVA — controle dos slides + mensagem/avisos
// -----------------------------------------------------------------------------
// A gestão controla AQUI, sem editar código:
//   • quais slides aparecem (mostrar/ocultar) e em que ORDEM;
//   • textos extras por slide (subtítulo no topo / observação no rodapé);
//   • a mensagem/aviso que gira no slide de Avisos;
//   • imagens prontas (arte/cartaz) que entram no rodízio como slides.
// Persistência:
//   - slides  -> public.tv_config (chave='telas_config'); mesclado no payload
//     por tv_snapshot_atualizar (ver migration 20260813120000).
//   - mensagem -> public.tv_mensagem_especial (alimenta o slide de Avisos).
//   - imagens  -> arquivo no bucket 'tv-imagens' + lista em tv_config
//     (chave='imagens'); visibilidade/ordem em telas_config sob 'img:<id>'.
// Escrita restrita à gestão (Amanda/Fernanda) pela RLS das duas tabelas.
// As mudanças só aparecem na TV depois de regenerar o snapshot — por isso o
// botão "Salvar e atualizar TV" salva tudo e dispara tv_snapshot_atualizar.
// =============================================================================

const CHAVE_CFG = "telas_config";
const CHAVE_IMG = "imagens";
const BUCKET_IMG = "tv-imagens";
const MAX_IMG_BYTES = 5 * 1024 * 1024;

const GRUPO_ROTULO = {
  operacao: "Operação",
  pessoas: "Pessoas",
  comunicacao: "Comunicação",
  construcao: "Em construção",
  imagem: "Imagem",
};

export default function TvMensagem() {
  // --- Slides ---
  const [reais, setReais] = useState([]);          // slides reais, na ordem de exibição (reordenável)
  const [placeholders, setPlaceholders] = useState([]); // slides "em breve" (desabilitados)
  const [temSnapshot, setTemSnapshot] = useState(false);
  const [imagens, setImagens] = useState([]);      // itens de tv_config.imagens
  const [enviando, setEnviando] = useState(false);

  // --- Mensagem / aviso ---
  const [msgId, setMsgId] = useState(null);
  const [titulo, setTitulo] = useState("");
  const [texto, setTexto] = useState("");
  const [msgAtivo, setMsgAtivo] = useState(true);

  // --- UI ---
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState("");

  async function carregar() {
    setCarregando(true);
    // Config atual dos slides + último snapshot (para saber quais têm conteúdo agora).
    const [cfgRes, snapRes, msgRes, imgRes] = await Promise.all([
      supabase.from("tv_config").select("valor").eq("chave", CHAVE_CFG).maybeSingle(),
      supabase.rpc("tv_snapshot_ler"),
      supabase.from("tv_mensagem_especial").select("id, titulo, texto, ativo")
        .order("atualizado_em", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("tv_config").select("valor").eq("chave", CHAVE_IMG).maybeSingle(),
    ]);

    const cfg = cfgRes?.data?.valor || {};
    const snap = snapRes?.data?.payload || null;
    setTemSnapshot(!!snap);

    const itensImg = Array.isArray(imgRes?.data?.valor?.itens) ? imgRes.data.valor.itens : [];
    setImagens(itensImg);

    const todas = telasParaAdmin(snap, cfg, itensImg);
    setReais(todas.filter((t) => !t.placeholder));
    setPlaceholders(todas.filter((t) => t.placeholder));

    if (msgRes?.data) {
      setMsgId(msgRes.data.id);
      setTitulo(msgRes.data.titulo || "");
      setTexto(msgRes.data.texto || "");
      setMsgAtivo(msgRes.data.ativo !== false);
    }
    setCarregando(false);
  }

  useEffect(() => { carregar(); }, []);

  // --- Edição dos slides reais ---
  function patchReal(i, patch) {
    setReais((arr) => arr.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  }
  function mover(i, delta) {
    setReais((arr) => {
      const j = i + delta;
      if (j < 0 || j >= arr.length) return arr;
      const novo = arr.slice();
      [novo[i], novo[j]] = [novo[j], novo[i]];
      return novo;
    });
  }

  // --- Imagens prontas ---
  // Sobe o arquivo no bucket e acrescenta o slide no fim da lista (ligado).
  // A lista só é persistida em tv_config ao clicar em Salvar.
  async function enviarImagens(files) {
    const lista = Array.from(files || []);
    if (lista.length === 0) return;
    setEnviando(true);
    setAviso("");
    const novos = [];
    for (const file of lista) {
      if (!file.type.startsWith("image/")) { setAviso(`"${file.name}" não é imagem.`); continue; }
      if (file.size > MAX_IMG_BYTES) { setAviso(`"${file.name}" passa de 5 MB.`); continue; }
      const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
      const path = `${id}.${ext}`;
      const { error } = await supabase.storage.from(BUCKET_IMG).upload(path, file, { contentType: file.type, upsert: false });
      if (error) { setAviso(`Não foi possível enviar "${file.name}": ` + error.message); continue; }
      const { data } = supabase.storage.from(BUCKET_IMG).getPublicUrl(path);
      novos.push({ id, path, url: data?.publicUrl || "", nome: file.name, legenda: "" });
    }
    if (novos.length > 0) {
      setImagens((arr) => [...arr, ...novos]);
      setReais((arr) => [
        ...arr,
        ...novos.map((im) => ({
          id: PREFIXO_IMG + im.id, nome: im.nome, descricao: im.nome, grupo: "imagem", placeholder: false,
          imagem: im, visivel: true, ordem: arr.length + 1, subtitulo: "", observacao: "", temConteudoAgora: true,
        })),
      ]);
      if (!aviso) setAviso(`${novos.length} imagem(ns) adicionada(s) — clique em Salvar para ir para a TV.`);
    }
    setEnviando(false);
  }

  // Apaga o arquivo do bucket e tira o slide da lista (já grava a lista nova,
  // senão o arquivo some e a TV ficaria com um slide quebrado até o próximo Salvar).
  async function removerImagem(tela) {
    const im = tela.imagem;
    if (!im || !window.confirm(`Remover a imagem "${im.legenda || im.nome}" da TV?`)) return;
    setSalvando(true);
    const { error: eRm } = await supabase.storage.from(BUCKET_IMG).remove([im.path]);
    if (eRm) { setAviso("Não foi possível remover o arquivo: " + eRm.message); setSalvando(false); return; }
    const restantes = imagens.filter((x) => x.id !== im.id);
    const { error: eCfg } = await supabase.from("tv_config")
      .upsert({ chave: CHAVE_IMG, ativo: true, valor: { itens: restantes }, atualizado_em: new Date().toISOString() },
        { onConflict: "chave" });
    if (eCfg) { setAviso("Arquivo removido, mas a lista não foi salva: " + eCfg.message); setSalvando(false); return; }
    setImagens(restantes);
    setReais((arr) => arr.filter((t) => t.id !== tela.id));
    setAviso("Imagem removida — clique em Salvar e atualizar TV para refletir no telão.");
    setSalvando(false);
  }

  function patchLegenda(i, legenda) {
    const tela = reais[i];
    if (!tela?.imagem) return;
    setImagens((arr) => arr.map((im) => (im.id === tela.imagem.id ? { ...im, legenda } : im)));
    patchReal(i, { imagem: { ...tela.imagem, legenda }, nome: legenda || tela.imagem.nome });
  }

  // Monta o mapa de config (reais na ordem atual + placeholders sempre no fim, ocultos).
  function montarMapa() {
    const mapa = {};
    reais.forEach((t, i) => {
      mapa[t.id] = {
        visivel: !!t.visivel,
        ordem: i + 1,
        subtitulo: (t.subtitulo || "").trim(),
        observacao: (t.observacao || "").trim(),
      };
    });
    placeholders.forEach((t, i) => {
      mapa[t.id] = { visivel: false, ordem: reais.length + i + 1, subtitulo: "", observacao: "" };
    });
    return mapa;
  }

  async function salvar(atualizarTv) {
    setSalvando(true);
    setAviso("");

    // 1) Config dos slides
    const { error: eCfg } = await supabase.from("tv_config")
      .upsert({ chave: CHAVE_CFG, ativo: true, valor: montarMapa(), atualizado_em: new Date().toISOString() },
        { onConflict: "chave" });
    if (eCfg) { setAviso("Não foi possível salvar os slides: " + eCfg.message); setSalvando(false); return; }

    // 1b) Lista de imagens prontas (legendas e itens)
    const { error: eImg } = await supabase.from("tv_config")
      .upsert({ chave: CHAVE_IMG, ativo: true, valor: { itens: imagens }, atualizado_em: new Date().toISOString() },
        { onConflict: "chave" });
    if (eImg) { setAviso("Slides salvos, mas as imagens não: " + eImg.message); setSalvando(false); return; }

    // 2) Mensagem / aviso
    const payloadMsg = { titulo, texto, ativo: msgAtivo, atualizado_em: new Date().toISOString() };
    let eMsg;
    if (msgId) {
      ({ error: eMsg } = await supabase.from("tv_mensagem_especial").update(payloadMsg).eq("id", msgId));
    } else if (titulo.trim() || texto.trim()) {
      const res = await supabase.from("tv_mensagem_especial").insert(payloadMsg).select("id").single();
      eMsg = res.error;
      if (res.data) setMsgId(res.data.id);
    }
    if (eMsg) { setAviso("Slides salvos, mas a mensagem não: " + eMsg.message); setSalvando(false); return; }

    // 3) Regenerar snapshot (aplica na TV agora)
    if (atualizarTv) {
      const { data, error: e2 } = await supabase.rpc("tv_snapshot_atualizar");
      if (e2 || data?.status === "erro") {
        setAviso("Salvo, mas a TV não atualizou agora: " + (e2?.message || data?.erro_resumo || ""));
        setSalvando(false);
        return;
      }
      setAviso("Tudo salvo e TV atualizada ✅ (versão " + (data?.versao ?? "?") + ")");
    } else {
      setAviso("Tudo salvo ✅ — aparece na TV na próxima atualização da projeção.");
    }
    setSalvando(false);
  }

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px 64px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 900, color: "#0f172a", margin: "0 0 4px" }}>📺 Painel da TV ReATIVA</h1>
      <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 20px" }}>
        Controle quais slides aparecem, a ordem do rodízio e os textos de cada tela.
        As mudanças vão para a TV ao clicar em <strong>Salvar e atualizar TV</strong>.
      </p>

      {carregando ? (
        <div style={{ color: "#64748b" }}>Carregando…</div>
      ) : (
        <>
          {/* ================= SEÇÃO A — SLIDES ================= */}
          <SecaoTitulo icone="🎞️" titulo="Slides da TV"
            sub="Ligue/desligue cada slide, reordene e adicione textos extras. Slides sem conteúdo no momento não aparecem, mesmo ligados." />

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {reais.map((t, i) => (
              <SlideCard
                key={t.id}
                tela={t}
                primeiro={i === 0}
                ultimo={i === reais.length - 1}
                onToggle={() => patchReal(i, { visivel: !t.visivel })}
                onCima={() => mover(i, -1)}
                onBaixo={() => mover(i, +1)}
                onSubtitulo={(v) => patchReal(i, { subtitulo: v })}
                onObservacao={(v) => patchReal(i, { observacao: v })}
                onLegenda={(v) => patchLegenda(i, v)}
                onRemover={() => removerImagem(t)}
              />
            ))}
          </div>

          {/* ================= IMAGENS PRONTAS ================= */}
          <div style={{ marginTop: 18, background: "#fff", border: "1px dashed #94a3b8", borderRadius: 14, padding: 16 }}>
            <SecaoTitulo icone="🖼️" titulo="Adicionar imagem pronta ao rodízio"
              sub="PNG, JPG, WEBP ou GIF até 5 MB. Cada imagem vira um slide acima — ligue/desligue, reordene e dê uma legenda como nos outros." />
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, ...btnSecundario, opacity: enviando ? 0.6 : 1 }}>
              {enviando ? "Enviando…" : "📎 Escolher imagens"}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={enviando}
                onChange={(e) => { enviarImagens(e.target.files); e.target.value = ""; }} style={{ display: "none" }} />
            </label>
          </div>

          {placeholders.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1, margin: "18px 0 8px" }}>
                Em construção (indisponíveis)
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {placeholders.map((t) => (
                  <div key={t.id} style={{ ...cartaoSlide, opacity: 0.6 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: "#475569" }}>{t.nome}</div>
                        <div style={{ fontSize: 12, color: "#94a3b8" }}>{t.descricao}</div>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 800, color: "#94a3b8", border: "1px solid #e2e8f0", borderRadius: 999, padding: "4px 10px" }}>
                        em breve
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ================= SEÇÃO B — MENSAGEM / AVISO ================= */}
          <div style={{ marginTop: 28 }}>
            <SecaoTitulo icone="📣" titulo="Mensagem / Aviso"
              sub="Texto que gira no slide de Avisos da TV. Deixe em branco (ou desmarque) para não exibir." />
            <div style={{ display: "flex", flexDirection: "column", gap: 14, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 16 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={lbl}>Título (destaque)</span>
                <input value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Título da mensagem" style={inp} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={lbl}>Texto (linha de apoio)</span>
                <textarea value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Texto de apoio da mensagem" rows={4} style={{ ...inp, resize: "vertical" }} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#0f172a", fontWeight: 600 }}>
                <input type="checkbox" checked={msgAtivo} onChange={(e) => setMsgAtivo(e.target.checked)} />
                Exibir esta mensagem na TV
              </label>
            </div>
          </div>

          {/* ================= AÇÕES ================= */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22, position: "sticky", bottom: 0, background: "linear-gradient(180deg, rgba(248,250,252,0), #f8fafc 40%)", padding: "12px 0" }}>
            <button type="button" disabled={salvando} onClick={() => salvar(true)} style={btnPrimario}>
              {salvando ? "Salvando…" : "Salvar e atualizar TV"}
            </button>
            <button type="button" disabled={salvando} onClick={() => salvar(false)} style={btnSecundario}>
              Salvar sem atualizar
            </button>
            <button type="button" disabled={salvando} onClick={carregar} style={btnLink}>
              Descartar e recarregar
            </button>
          </div>

          {aviso && (
            <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4, color: aviso.startsWith("Tudo salvo") || aviso.includes("atualizada") ? "#15803d" : "#b91c1c" }}>
              {aviso}
            </div>
          )}
          {!temSnapshot && (
            <div style={{ fontSize: 13, color: "#92400e", background: "#fef3c7", borderRadius: 10, padding: "10px 12px", marginTop: 12 }}>
              Ainda não há um snapshot gerado. Gere a projeção (ou clique em “Salvar e atualizar TV”) para a TV começar a exibir.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- Cartão de um slide real (toggle + reordenar + textos extras) ------------
function SlideCard({ tela, primeiro, ultimo, onToggle, onCima, onBaixo, onSubtitulo, onObservacao, onLegenda, onRemover }) {
  const ligadoSemConteudo = tela.visivel && tela.temConteudoAgora === false;
  const ehImagem = !!tela.imagem;
  return (
    <div style={{ ...cartaoSlide, borderColor: tela.visivel ? "#bbf7d0" : "#e2e8f0", background: tela.visivel ? "#f0fdf4" : "#fff" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        {/* Reordenar */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 2 }}>
          <button type="button" onClick={onCima} disabled={primeiro} title="Mover para cima" style={{ ...btnMover, opacity: primeiro ? 0.3 : 1 }}>▲</button>
          <button type="button" onClick={onBaixo} disabled={ultimo} title="Mover para baixo" style={{ ...btnMover, opacity: ultimo ? 0.3 : 1 }}>▼</button>
        </div>

        {ehImagem && (
          <img src={tela.imagem.url} alt="" style={{ width: 96, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid #e2e8f0", background: "#0f172a", flexShrink: 0 }} />
        )}

        {/* Identidade + estado */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>{tela.nome}</span>
            <span style={chip}>{GRUPO_ROTULO[tela.grupo] || tela.grupo}</span>
            {ligadoSemConteudo && (
              <span style={{ ...chip, color: "#92400e", background: "#fef3c7", borderColor: "#fde68a" }}>ligado, sem conteúdo agora</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{tela.descricao}</div>

          {ehImagem && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
              <span style={lblMini}>Legenda (título no topo do slide — opcional)</span>
              <input value={tela.imagem.legenda || ""} onChange={(e) => onLegenda(e.target.value)} placeholder="sem legenda: só a imagem" style={inpMini} />
            </label>
          )}

          {/* Textos extras (só quando o slide está ligado) */}
          {tela.visivel && !ehImagem && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={lblMini}>Subtítulo (aparece no topo do slide)</span>
                <input value={tela.subtitulo} onChange={(e) => onSubtitulo(e.target.value)} placeholder="opcional" maxLength={90} style={inpMini} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={lblMini}>Observação (faixa no rodapé do slide)</span>
                <input value={tela.observacao} onChange={(e) => onObservacao(e.target.value)} placeholder="opcional" maxLength={120} style={inpMini} />
              </label>
            </div>
          )}
        </div>

        {/* Mostrar / ocultar (+ remover, só imagem) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
          <button type="button" onClick={onToggle} style={{ ...btnToggle, ...(tela.visivel ? togOn : togOff) }}>
            {tela.visivel ? "Mostrando" : "Oculto"}
          </button>
          {ehImagem && (
            <button type="button" onClick={onRemover} title="Apagar a imagem" style={{ ...btnToggle, background: "#fee2e2", color: "#b91c1c", padding: "6px 12px" }}>
              Remover
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SecaoTitulo({ icone, titulo, sub }) {
  return (
    <div style={{ margin: "0 0 12px" }}>
      <div style={{ fontSize: 16, fontWeight: 900, color: "#0f172a", display: "flex", alignItems: "center", gap: 8 }}>
        <span>{icone}</span>{titulo}
      </div>
      {sub && <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// Estilos ---------------------------------------------------------------------
const lbl = { fontSize: 13, fontWeight: 700, color: "#334155" };
const lblMini = { fontSize: 11, fontWeight: 700, color: "#64748b" };
const inp = { border: "1px solid #cbd5e1", borderRadius: 10, padding: "10px 12px", fontSize: 15, color: "#0f172a", outline: "none" };
const inpMini = { border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 10px", fontSize: 13, color: "#0f172a", outline: "none" };
const cartaoSlide = { border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px", background: "#fff" };
const chip = { fontSize: 11, fontWeight: 700, color: "#475569", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 999, padding: "2px 8px" };
const btnMover = { width: 26, height: 22, border: "1px solid #cbd5e1", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 11, color: "#475569", lineHeight: 1, padding: 0 };
const btnToggle = { border: "none", borderRadius: 999, padding: "8px 14px", fontWeight: 800, cursor: "pointer", fontSize: 13, whiteSpace: "nowrap", alignSelf: "flex-start" };
const togOn = { background: "#16a34a", color: "#fff" };
const togOff = { background: "#e2e8f0", color: "#475569" };
const btnPrimario = { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 800, cursor: "pointer" };
const btnSecundario = { background: "#e2e8f0", color: "#0f172a", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, cursor: "pointer" };
const btnLink = { background: "transparent", color: "#64748b", border: "none", borderRadius: 10, padding: "10px 12px", fontWeight: 700, cursor: "pointer", textDecoration: "underline" };
