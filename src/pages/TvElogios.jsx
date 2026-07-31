import { useEffect, useMemo, useState } from "react";
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
// CONSUMO MÍNIMO: a ÚNICA consulta ao banco é o tv_snapshot_ler — disparado só
// ao abrir/recarregar a página e no clique do botão manual "Atualizar" da TV.
// Sem polling, sem verificação periódica de versão, sem subscription/listener.
// O carrossel roda indefinidamente sem gerar tráfego.
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
  const [atualizando, setAtualizando] = useState(false);

  // ÚNICA consulta ao banco: uma leitura do snapshot. Acontece só ao abrir/
  // recarregar a página e quando o usuário pede atualização MANUAL (botão).
  // NÃO há polling, verificação periódica de versão, subscription ou listener.
  // Preserva o último snapshot bom (cache local) em caso de falha de conexão.
  async function carregarSnapshot() {
    setAtualizando(true);
    try {
      const { data, error } = await supabase.rpc("tv_snapshot_ler");
      if (error) throw error;
      const m = { status: data?.status, versao: data?.versao, gerado_em: data?.gerado_em, gerado_por: data?.gerado_por };
      setMeta(m);
      if (data?.payload) {
        setSnap(data.payload);
        salvarCache(data.payload, m); // guarda localmente p/ resiliência
      }
    } catch {
      // Sem conexão: mantém o snapshot em memória/cache (não apaga a tela).
    } finally {
      setCarregou(true);
      setAtualizando(false);
    }
  }

  // Carga inicial: 1 leitura ao abrir/recarregar. Só isso.
  useEffect(() => {
    carregarSnapshot();
  }, []);

  // Só as telas com regra definitiva E dado válido (estrutura das demais fica
  // no código, porém oculta na TV). Recalcula quando o snapshot muda.
  const telas = useMemo(() => telasVisiveis(snap), [snap]);
  const total = telas.length;

  // Carrossel automático — 100% EM MEMÓRIA. Nunca consulta o banco (nem ao
  // fechar um ciclo). Pausa quando a aba/TV não está visível. Reinicia ao
  // concluir a última tela e pode rodar indefinidamente sem tráfego.
  useEffect(() => {
    if (total <= 1) return; // 0 ou 1 tela: nada a girar (evita módulo por 0)
    const t = setInterval(() => {
      if (document.hidden) return; // pausa: não avança
      setIndice((i) => {
        const prox = (i + 1) % total;
        if (prox === 0) setGiro((g) => g + 1); // novo ciclo: só gira conteúdo local
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

  return (
    <div style={raiz}>
      {conteudo}
      {/* Botão manual de atualização: refaz SÓ a leitura do snapshot (1 consulta),
          sem recarregar a aplicação. É a única forma de trazer dados novos além
          de recarregar a página — não há verificação automática. */}
      <button
        type="button"
        onClick={carregarSnapshot}
        disabled={atualizando}
        title="Atualizar indicadores (busca o último snapshot)"
        aria-label="Atualizar indicadores"
        style={{ ...botaoAtualizar, opacity: atualizando ? 0.5 : 0.85 }}
      >
        {atualizando ? "Atualizando…" : "↻ Atualizar"}
      </button>
    </div>
  );
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
  position: "relative",
};

// Botão manual discreto (canto inferior direito). Some visualmente sem atrapalhar
// a TV; presente para quando a gestão quiser puxar o snapshot recém-atualizado.
const botaoAtualizar = {
  position: "absolute",
  bottom: "clamp(10px, 1.4vw, 28px)",
  right: "clamp(10px, 1.4vw, 28px)",
  background: "rgba(59,130,246,0.18)",
  color: T.texto,
  border: "1px solid rgba(59,130,246,0.4)",
  borderRadius: 999,
  padding: "clamp(6px,0.6vw,12px) clamp(12px,1vw,22px)",
  fontSize: "clamp(11px,0.9vw,20px)",
  fontWeight: 700,
  cursor: "pointer",
};
