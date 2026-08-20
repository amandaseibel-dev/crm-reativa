// Anexo de uma mensagem do WhatsApp na Central.
//
// COMO O ARQUIVO É ACESSADO, e por que assim:
//
// O bucket é PRIVADO. No banco guardamos só o caminho — nunca uma URL, nem
// pública nem assinada. A URL é pedida ao Supabase e vale poucos minutos.
//
// Isso resolve dois problemas de uma vez: recarregar a página não quebra nada
// (pede outra URL), e um link que vaze por engano morre sozinho. Guardar URL
// assinada no banco daria o efeito contrário — link eterno em texto puro.
//
// QUANDO a URL é pedida — o defeito de 20/08/2026:
//
// A versão anterior assinava TUDO na montagem do componente, e o `href` do
// documento congelava naquela URL. Ela vale 300s. Passados cinco minutos com a
// conversa aberta, todo anexo virava link morto: o clique levava o operador a
// uma página de JSON crua do Supabase — `400 InvalidJWT: "exp" claim timestamp
// check failed` — sem explicação nenhuma. Recarregar a página "consertava" por
// mais cinco minutos, o que fazia o defeito parecer intermitente.
//
// Agora:
//   - DOCUMENTO só assina NO CLIQUE. É link: não precisa de URL antes de
//     alguém querer abrir, e assinar antes é justamente o que apodrecia.
//   - IMAGEM e ÁUDIO continuam assinando na montagem, porque precisam da URL
//     para APARECER. Sem ela o operador não vê o comprovante que o aluno
//     mandou — e ver o anexo é o ponto da Central. O `<img>` baixa o arquivo na
//     hora e o mantém; a expiração depois disso não afeta o que já está na
//     tela. Mas o clique para AMPLIAR também assina de novo, porque aí vale a
//     mesma regra do documento.
//
// A ABA NASCE ANTES DO `await`, e isto não é estilo:
//
// `window.open` só escapa do bloqueador de popup enquanto o gesto do usuário
// está "quente". Depois de um `await`, o navegador já não considera a abertura
// como consequência do clique e bloqueia. Este projeto já pagou por isso uma
// vez, no download da planilha de Ações Massivas. Então: abre a aba vazia
// imediatamente, e só depois aponta o endereço.
import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const BUCKET = "whatsapp-midia";
const VALIDADE_SEG = 300;

function tamanhoLegivel(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function AnexoWhatsApp({ mensagem }) {
  // URL só para o que precisa aparecer sozinho (imagem e áudio). Documento
  // não entra aqui de propósito.
  const [urlEmbutida, setUrlEmbutida] = useState(null);
  const [erro, setErro] = useState("");
  const [abrindo, setAbrindo] = useState(false);

  const caminho = mensagem?.midia_path;
  const mime = mensagem?.midia_mime || "";
  const ehImagem = mime.startsWith("image/");
  const ehAudio = mime.startsWith("audio/");
  const precisaAparecerSozinho = ehImagem || ehAudio;

  useEffect(() => {
    if (!caminho || !precisaAparecerSozinho) return undefined;
    let vivo = true;
    supabase.storage
      .from(BUCKET)
      .createSignedUrl(caminho, VALIDADE_SEG)
      .then(({ data, error }) => {
        if (!vivo) return;
        if (error) setErro("não foi possível carregar o anexo agora");
        else setUrlEmbutida(data?.signedUrl || null);
      })
      .catch(() => { if (vivo) setErro("não foi possível carregar o anexo agora"); });
    return () => { vivo = false; };
  }, [caminho, precisaAparecerSozinho]);

  async function abrir(evento) {
    evento?.preventDefault?.();
    if (abrindo || !caminho) return; // trava o clique duplo
    setAbrindo(true);
    setErro("");

    // Sem `noopener` na chamada: com ele o `window.open` devolve `null` e não
    // há como apontar a aba depois. O vínculo é cortado logo abaixo, que dá o
    // mesmo efeito de segurança sem perder a referência.
    const aba = window.open("", "_blank");
    if (aba) {
      try { aba.opener = null; } catch { /* navegador já isolou */ }
    }

    try {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(caminho, VALIDADE_SEG);
      if (error || !data?.signedUrl) throw new Error(error?.message || "sem URL");

      if (aba) {
        // `replace` para o endereço vazio não virar uma entrada no histórico.
        aba.location.replace(data.signedUrl);
      } else {
        setErro("o navegador bloqueou a nova aba. Libere popups para este site e tente de novo.");
      }
    } catch {
      // A aba vazia não pode ficar órfã na cara do operador.
      if (aba) { try { aba.close(); } catch { /* já fechada */ } }
      setErro("não foi possível abrir o anexo agora. Tente de novo.");
    } finally {
      setAbrindo(false);
    }
  }

  // O anexo não pôde ser baixado. A mensagem continua na Central com o aviso —
  // o operador precisa SABER que veio algo, mesmo sem o arquivo.
  if (mensagem?.midia_erro && !caminho) {
    return (
      <div style={S.aviso}>
        📎 Anexo não recuperado — {mensagem.midia_erro}
        <div style={S.avisoDica}>Consulte no celular se for necessário.</div>
      </div>
    );
  }

  if (!caminho) return null;

  const avisoErro = erro ? <div style={S.aviso}>📎 {erro}</div> : null;

  if (ehImagem) {
    if (!urlEmbutida && !erro) return <div style={S.carregando}>carregando anexo…</div>;
    return (
      <>
        {avisoErro}
        {urlEmbutida ? (
          <a
            href="#abrir-anexo"
            onClick={abrir}
            aria-busy={abrindo}
            style={S.linkImagem}
            title="Abrir em nova aba"
          >
            <img src={urlEmbutida} alt={mensagem.texto || "imagem recebida"} style={S.imagem} />
          </a>
        ) : null}
      </>
    );
  }

  if (ehAudio) {
    if (!urlEmbutida && !erro) return <div style={S.carregando}>carregando anexo…</div>;
    return (
      <>
        {avisoErro}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        {urlEmbutida ? <audio controls src={urlEmbutida} style={S.audio} /> : null}
      </>
    );
  }

  // Documento: nenhuma chamada ao Storage até alguém clicar.
  return (
    <>
      {avisoErro}
      <a
        href="#abrir-anexo"
        onClick={abrir}
        aria-busy={abrindo}
        aria-disabled={abrindo}
        style={{ ...S.documento, ...(abrindo ? S.documentoAbrindo : null) }}
      >
        📄 {mensagem.midia_nome || "documento"}
        <span style={S.documentoInfo}>
          {abrindo ? "abrindo…" : (mime.split("/")[1] || "arquivo")}
          {mensagem.midia_tamanho ? ` · ${tamanhoLegivel(mensagem.midia_tamanho)}` : ""}
        </span>
      </a>
    </>
  );
}

const S = {
  imagem: { maxWidth: 260, maxHeight: 260, borderRadius: 10, display: "block", cursor: "zoom-in" },
  linkImagem: { display: "block", marginBottom: 6 },
  audio: { width: 240, marginBottom: 6 },
  documento: {
    display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", marginBottom: 6,
    background: "rgba(0,0,0,.05)", borderRadius: 9, fontSize: 13, color: "inherit",
    textDecoration: "none", cursor: "pointer",
  },
  documentoAbrindo: { opacity: 0.6, cursor: "progress" },
  documentoInfo: { fontSize: 11, opacity: 0.7 },
  aviso: {
    fontSize: 12, lineHeight: 1.5, color: "#92400e", background: "#fffbeb",
    border: "1px solid #fde68a", borderRadius: 8, padding: "7px 9px", marginBottom: 6,
  },
  avisoDica: { fontSize: 11, opacity: 0.8, marginTop: 2 },
  carregando: { fontSize: 12, opacity: 0.6, marginBottom: 6 },
};
