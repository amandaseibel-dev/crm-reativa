import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import {
  Cabecalho, Rodape, Palco, EstadoCarregando, EstadoSemSnapshot, T, AREA_SEGURA,
} from "../components/tv/tvUI";
import { telasVisiveis } from "../components/tv/tvTelas";

// =============================================================================
// TV ReATIVA — ORQUESTRADOR (Etapas 1 + 2)
// -----------------------------------------------------------------------------
// Arquitetura de snapshot (Etapa 1): a TV lê UM snapshot leve (tv_snapshot_ler)
// e NÃO calcula nada ao vivo. A troca de tela é 100% em memória (zero consulta).
// A única verificação de novidade é leve (tv_snapshot_versao) e roda só ao
// reiniciar um ciclo completo do carrossel.
//
// Camada visual (Etapa 2): design system em src/components/tv. Carrossel
// automático (15–20s por tela), transições suaves, cabeçalho com relógio local,
// rodapé com a origem do dado, estados de carregando/sem-snapshot e resiliência
// (mantém o último snapshot salvo LOCALMENTE em caso de falha de conexão).
// =============================================================================

// >>> Tempo de exibição de cada tela (segundos). Ajuste AQUI (faixa 15–20). <<<
const SEG_POR_TELA = 18;

const CACHE_KEY = "tv_reativa_snapshot_v2";

// Persistência local do último snapshot bom (sobrevive a reload/queda). ------
function lerCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function salvarCache(payload, meta) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ payload, meta }));
  } catch {
    /* quota/indisponível: segue sem cache persistente */
  }
}

export default function TvElogios() {
  // Hidrata do cache local no primeiro render → sem tela branca, sem consulta.
  const cache = lerCache();
  const [snap, setSnap] = useState(cache?.payload || null);
  const [meta, setMeta] = useState(cache?.meta || null); // { status, versao, gerado_em }
  const [carregou, setCarregou] = useState(false);
  const [indice, setIndice] = useState(0);
  const [giro, setGiro] = useState(0); // conta ciclos completos (gira treinamento/elogio)
  const [elogioUrl, setElogioUrl] = useState("");
  const versaoRef = useRef(Number(cache?.meta?.versao || 0));

  // Uma leitura do snapshot. Preserva o último snapshot bom em caso de falha.
  async function carregarSnapshot() {
    try {
      const { data, error } = await supabase.rpc("tv_snapshot_ler");
      if (error) throw error;
      const m = { status: data?.status, versao: data?.versao, gerado_em: data?.gerado_em, gerado_por: data?.gerado_por };
      versaoRef.current = Number(data?.versao || 0);
      setMeta(m);
      if (data?.payload) {
        setSnap(data.payload);
        salvarCache(data.payload, m); // guarda localmente p/ resiliência
      }
    } catch {
      // Sem conexão: mantém o snapshot em memória/cache (não apaga a tela).
    } finally {
      setCarregou(true);
    }
  }

  useEffect(() => {
    carregarSnapshot();
  }, []);

  // Verificação LEVE: só o número da versão. Busca o snapshot novo se mudou.
  async function verificarNovaVersao() {
    try {
      const { data, error } = await supabase.rpc("tv_snapshot_versao");
      if (error) throw error;
      if (Number(data?.versao || 0) > versaoRef.current) await carregarSnapshot();
    } catch {
      /* indisponível: mantém o snapshot atual */
    }
  }

  // Só as telas com regra definitiva E dado válido (estrutura das demais fica
  // no código, porém oculta na TV). Recalcula quando o snapshot muda.
  const telas = useMemo(() => telasVisiveis(snap), [snap]);
  const total = telas.length;

  // Carrossel automático. Pausa quando a aba/TV não está visível (economia e
  // zero consulta em segundo plano). Reinicia ao concluir a última tela.
  useEffect(() => {
    if (total <= 1) return; // 0 ou 1 tela: nada a girar (evita módulo por 0)
    const t = setInterval(() => {
      if (document.hidden) return; // pausa: não avança nem consulta
      setIndice((i) => {
        const prox = (i + 1) % total;
        if (prox === 0) {
          setGiro((g) => g + 1);
          verificarNovaVersao(); // 1 verificação leve por ciclo completo
        }
        return prox;
      });
    }, SEG_POR_TELA * 1000);
    return () => clearInterval(t);
  }, [total]);

  // Navegação por teclado (útil em testes / operação manual).
  useEffect(() => {
    function onKey(e) {
      if (e.key === "ArrowRight") setIndice((i) => (i + 1) % total);
      else if (e.key === "ArrowLeft") setIndice((i) => (i - 1 + total) % total);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  const tela = total > 0 ? telas[indice % total] : null;

  // URL pública da imagem do elogio (Storage) — construção LOCAL de string,
  // sem consulta ao banco. Só quando a tela de Reconhecimento está ativa.
  useEffect(() => {
    if (tela?.id !== "reconhecimento") { setElogioUrl(""); return; }
    const elogios = snap?.elogios || [];
    const e = elogios[giro % (elogios.length || 1)];
    if (!e?.elogio_print_path) { setElogioUrl(""); return; }
    const { data } = supabase.storage.from("elogios-prints").getPublicUrl(e.elogio_print_path);
    setElogioUrl(data?.publicUrl || "");
  }, [tela, snap, giro]);

  // Estados especiais (dentro da identidade visual, nunca tela branca).
  const conteudo = (() => {
    if (!snap && !carregou) return <EstadoCarregando />;
    if (!snap || !tela) return <EstadoSemSnapshot />;
    const Comp = tela.Comp;
    return (
      <>
        <Cabecalho tela={tela.nome} />
        <Palco chave={`${tela.id}-${giro}`}>
          <Comp snap={snap} indiceGiro={giro} elogioUrl={elogioUrl} />
        </Palco>
        <Rodape geradoEm={meta?.gerado_em} indice={indice % total} total={total} />
      </>
    );
  })();

  return <div style={raiz}>{conteudo}</div>;
}

// Raiz: identidade ReATIVA + ÁREA SEGURA (afasta das bordas p/ overscan de TV).
const raiz = {
  minHeight: "100vh",
  background: T.bg,
  color: T.texto,
  fontFamily: "Inter, system-ui, Arial, sans-serif",
  display: "flex",
  flexDirection: "column",
  padding: AREA_SEGURA,
  boxSizing: "border-box",
  overflow: "hidden",
};
