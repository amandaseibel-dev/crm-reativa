// Entrega privada das fotos de perfil (cache + assinatura + hook).
// -----------------------------------------------------------------------------
// O bucket `fotos-perfil` é PRIVADO. O cliente NÃO conhece nem envia o caminho
// do objeto: solicita a foto por USUARIO_ID à Edge Function `foto-perfil-url`,
// que resolve o caminho no servidor e devolve uma URL assinada de curta duração.
//
// Aqui há apenas: cache em memória com expiração (chave = usuario_id), dedupe de
// chamadas em voo e o hook React. O componente visual fica em
// ../components/AvatarFoto.jsx.
//
// Nunca persiste URL assinada. Nunca loga usuario_id, caminho ou URL.
import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// TTL do servidor é 300s; renovamos antes disso para evitar imagem quebrada.
const TTL_MS = 4 * 60 * 1000;

const cache = new Map(); // usuarioId -> { url, exp }
const emVoo = new Map(); // usuarioId -> Promise<string|null>

function doCache(usuarioId) {
  const c = usuarioId && cache.get(usuarioId);
  return c && c.exp > Date.now() ? c.url : null;
}

async function assinar(usuarioId) {
  if (!usuarioId) return null;
  const cacheado = doCache(usuarioId);
  if (cacheado) return cacheado;
  if (emVoo.has(usuarioId)) return emVoo.get(usuarioId);

  const p = (async () => {
    try {
      const { data, error } = await supabase.functions.invoke("foto-perfil-url", {
        body: { usuario_ids: [usuarioId] },
      });
      const url = (!error && data && data.urls && data.urls[usuarioId]) || null;
      if (url) cache.set(usuarioId, { url, exp: Date.now() + TTL_MS });
      return url;
    } catch {
      return null; // fallback visual no componente
    } finally {
      emVoo.delete(usuarioId);
    }
  })();

  emVoo.set(usuarioId, p);
  return p;
}

// Hook: recebe o USUARIO_ID (usuarios.id) e devolve uma URL assinada válida
// (ou null enquanto carrega / em falha / sem foto).
export function useFotoPerfil(usuarioId) {
  // Inicializa com o cache (render imediato quando já assinado, sem "flash").
  const [url, setUrl] = useState(() => doCache(usuarioId));

  useEffect(() => {
    let vivo = true;
    // assinar() já resolve o cache/deduplicação; a atualização de estado ocorre
    // só no callback assíncrono (evita setState síncrono no corpo do efeito).
    assinar(usuarioId).then((u) => {
      if (vivo) setUrl(u);
    });
    return () => {
      vivo = false;
    };
  }, [usuarioId]);

  return url;
}
