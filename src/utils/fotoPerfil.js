// Entrega privada das fotos de perfil (cache + assinatura + hook).
// -----------------------------------------------------------------------------
// O bucket `fotos-perfil` é PRIVADO e não é legível pelo cliente. As URLs são
// assinadas no servidor pela Edge Function `foto-perfil-url` (service role),
// de curta duração. Aqui há apenas: cache em memória com expiração, dedupe de
// chamadas em voo e o hook React. O componente visual fica em
// ../components/AvatarFoto.jsx.
//
// Nunca persiste URL assinada no banco. Nunca loga caminho, e-mail ou URL.
import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// TTL do servidor é 300s; renovamos antes disso para evitar imagem quebrada.
const TTL_MS = 4 * 60 * 1000;

const cache = new Map(); // path -> { url, exp }
const emVoo = new Map(); // path -> Promise<string|null>

function doCache(path) {
  const c = path && cache.get(path);
  return c && c.exp > Date.now() ? c.url : null;
}

async function assinar(path) {
  if (!path) return null;
  const cacheado = doCache(path);
  if (cacheado) return cacheado;
  if (emVoo.has(path)) return emVoo.get(path);

  const p = (async () => {
    try {
      const { data, error } = await supabase.functions.invoke("foto-perfil-url", {
        body: { paths: [path] },
      });
      const url = (!error && data && data.urls && data.urls[path]) || null;
      if (url) cache.set(path, { url, exp: Date.now() + TTL_MS });
      return url;
    } catch {
      return null; // fallback visual no componente
    } finally {
      emVoo.delete(path);
    }
  })();

  emVoo.set(path, p);
  return p;
}

// Hook: recebe o CAMINHO INTERNO do objeto (usuarios.foto_path) e devolve uma
// URL assinada válida (ou null enquanto carrega / em falha).
export function useFotoPerfil(path) {
  // Inicializa com o cache (render imediato quando já assinado, sem "flash").
  const [url, setUrl] = useState(() => doCache(path));

  useEffect(() => {
    let vivo = true;
    // assinar() já resolve o cache/deduplicação; a atualização de estado ocorre
    // só no callback assíncrono (evita setState síncrono no corpo do efeito).
    assinar(path).then((u) => {
      if (vivo) setUrl(u);
    });
    return () => {
      vivo = false;
    };
  }, [path]);

  return url;
}
