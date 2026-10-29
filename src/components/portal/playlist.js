// Regras puras da Playlist ReATIVA. Ficam fora do .jsx porque o componente so
// pode exportar componente (react-refresh/only-export-components) e porque isto
// e testavel sem montar tela.

export const LIMITE_MUSICAS = 3;

// SQLSTATE do gatilho public.portal_playlist_limite_tres(): a 4a musica ativa da
// mesma pessoa. A interface bloqueia antes, entao chegar aqui significa outra
// aba/dispositivo tendo ocupado a ultima vaga no meio do caminho.
export const ERRO_LIMITE = "PL003";

export function extrairYoutubeId(link) {
  try {
    const url = new URL(String(link || "").trim());
    if (url.hostname.includes("youtu.be")) return url.pathname.split("/").filter(Boolean)[0] || null;
    if (url.hostname.includes("youtube.com")) {
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || null;
      if (url.pathname.startsWith("/embed/")) return url.pathname.split("/")[2] || null;
      return url.searchParams.get("v");
    }
  } catch { /* link invalido cai no retorno nulo */ }
  return null;
}

export const mesmaPessoa = (a, b) =>
  !!a && !!b && String(a).toLowerCase().trim() === String(b).toLowerCase().trim();

// Mesma contagem do gatilho no banco: ativas, da pessoa, sem ligar para a caixa
// do e-mail.
export function contarAtivasDe(lista, email) {
  return (lista || []).filter((m) => m.ativo !== false && mesmaPessoa(m.adicionado_por_email, email)).length;
}

export const linkDoYoutube = (youtubeId) =>
  youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : "";
