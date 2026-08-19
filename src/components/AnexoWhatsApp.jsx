// Anexo de uma mensagem do WhatsApp na Central.
//
// COMO O ARQUIVO É ACESSADO, e por que assim:
//
// O bucket é PRIVADO. No banco guardamos só o caminho — nunca uma URL, nem
// pública nem assinada. A URL é pedida ao Supabase no momento em que o anexo
// aparece na tela e vale poucos minutos.
//
// Isso resolve dois problemas de uma vez: recarregar a página não quebra nada
// (pede outra URL), e um link que vaze por engano morre sozinho. Guardar URL
// assinada no banco daria o efeito contrário — link eterno em texto puro.
//
// Quem consegue gerar essa URL é só quem a policy do bucket deixa: usuário
// autenticado e ativo no CRM. Não há caminho anônimo.
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
  const [url, setUrl] = useState(null);
  const [erro, setErro] = useState("");
  const caminho = mensagem?.midia_path;
  const mime = mensagem?.midia_mime || "";

  useEffect(() => {
    if (!caminho) return undefined;
    let vivo = true;
    supabase.storage
      .from(BUCKET)
      .createSignedUrl(caminho, VALIDADE_SEG)
      .then(({ data, error }) => {
        if (!vivo) return;
        if (error) setErro("não foi possível abrir o anexo agora");
        else setUrl(data?.signedUrl || null);
      })
      .catch(() => { if (vivo) setErro("não foi possível abrir o anexo agora"); });
    return () => { vivo = false; };
  }, [caminho]);

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
  if (erro) return <div style={S.aviso}>📎 {erro}</div>;
  if (!url) return <div style={S.carregando}>carregando anexo…</div>;

  if (mime.startsWith("image/")) {
    return (
      <a href={url} target="_blank" rel="noreferrer" style={S.linkImagem}>
        <img src={url} alt={mensagem.texto || "imagem recebida"} style={S.imagem} />
      </a>
    );
  }

  if (mime.startsWith("audio/")) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio controls src={url} style={S.audio} />;
  }

  return (
    <a href={url} target="_blank" rel="noreferrer" style={S.documento}>
      📄 {mensagem.midia_nome || "documento"}
      <span style={S.documentoInfo}>
        {mime.split("/")[1] || "arquivo"}
        {mensagem.midia_tamanho ? ` · ${tamanhoLegivel(mensagem.midia_tamanho)}` : ""}
      </span>
    </a>
  );
}

const S = {
  imagem: { maxWidth: 260, maxHeight: 260, borderRadius: 10, display: "block", cursor: "zoom-in" },
  linkImagem: { display: "block", marginBottom: 6 },
  audio: { width: 240, marginBottom: 6 },
  documento: {
    display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", marginBottom: 6,
    background: "rgba(0,0,0,.05)", borderRadius: 9, fontSize: 13, color: "inherit",
    textDecoration: "none",
  },
  documentoInfo: { fontSize: 11, opacity: 0.7 },
  aviso: {
    fontSize: 12, lineHeight: 1.5, color: "#92400e", background: "#fffbeb",
    border: "1px solid #fde68a", borderRadius: 8, padding: "7px 9px", marginBottom: 6,
  },
  avisoDica: { fontSize: 11, opacity: 0.8, marginTop: 2 },
  carregando: { fontSize: 12, opacity: 0.6, marginBottom: 6 },
};
