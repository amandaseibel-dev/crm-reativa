import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import {
  Cabecalho, Rodape, Palco, EstadoCarregando, EstadoSemSnapshot, T, AREA_SEGURA,
} from "../components/tv/tvUI";
import { telasVisiveis } from "../components/tv/tvTelas";

// =============================================================================
// TV ReATIVA — ORQUESTRADOR
// -----------------------------------------------------------------------------
// Snapshot (Etapa 1): a TV lê UM snapshot leve (tv_snapshot_ler) e NÃO calcula
// nada ao vivo. A troca de tela é 100% em memória (zero consulta).
//
// CONSUMO MÍNIMO — a TV consulta o banco APENAS quando:
//   (a) abre/recarrega a página;
//   (b) recebe UM evento realtime de tv_sinal (novo snapshot gerado no CRM);
//   (c) o usuário clica no botão manual "↻ Atualizar" do telão.
// NÃO há polling, verificação periódica de versão nem escuta de outras tabelas.
// O realtime acompanha SÓ a tabela-sinal do snapshot; cada evento gera 1 leitura.
// Em falha de conexão, mantém o último snapshot salvo localmente (sem tela branca).
// =============================================================================

// >>> Tempo de exibição de cada tela (segundos). Ajuste AQUI (faixa 15–20). <<<
const SEG_POR_TELA = 18;

// v3: invalida caches antigos (ex.: mensagem "BORA TIME" removida).
const CACHE_KEY = "tv_reativa_snapshot_v3";

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
  const cache = lerCache();
  const [snap, setSnap] = useState(cache?.payload || null);
  const [meta, setMeta] = useState(cache?.meta || null); // { status, versao, gerado_em }
  const [carregou, setCarregou] = useState(false);
  const [indice, setIndice] = useState(0);
  const [giro, setGiro] = useState(0);
  const [elogioUrl, setElogioUrl] = useState("");
  const [atualizando, setAtualizando] = useState(false);
  const [toast, setToast] = useState("");
  const versaoRef = useRef(Number(cache?.meta?.versao || 0));

  // Uma leitura do snapshot. Devolve se a versão mudou (para o feedback do botão).
  // Preserva o último snapshot bom (cache local) em caso de falha de conexão.
  async function carregarSnapshot() {
    setAtualizando(true);
    let mudou = false;
    try {
      const { data, error } = await supabase.rpc("tv_snapshot_ler");
      if (error) throw error;
      const nova = Number(data?.versao || 0);
      mudou = nova !== versaoRef.current;
      versaoRef.current = nova;
      const m = { status: data?.status, versao: data?.versao, gerado_em: data?.gerado_em, gerado_por: data?.gerado_por };
      setMeta(m);
      if (data?.payload) {
        setSnap(data.payload);
        salvarCache(data.payload, m);
      }
    } catch {
      mudou = false; // sem conexão: mantém o snapshot em memória/cache
    } finally {
      setCarregou(true);
      setAtualizando(false);
    }
    return mudou;
  }

  // Carga inicial: 1 leitura ao abrir/recarregar.
  useEffect(() => {
    carregarSnapshot();
  }, []);

  // Realtime: escuta SÓ a tabela-sinal do snapshot. Quando o CRM gera um novo
  // snapshot com sucesso, chega 1 evento e a TV faz 1 leitura. Sem polling.
  // Se o realtime falhar, o botão manual continua disponível como alternativa.
  useEffect(() => {
    const canal = supabase
      .channel("tv-sinal")
      .on("postgres_changes", { event: "*", schema: "public", table: "tv_sinal" }, (payload) => {
        const v = Number(payload?.new?.versao || 0);
        if (v > versaoRef.current) carregarSnapshot();
      })
      .subscribe();
    return () => { supabase.removeChannel(canal); };
  }, []);

  // Botão manual do telão: 1 leitura; feedback breve; sem recarregar a app nem
  // reiniciar o carrossel (o índice atual é preservado).
  async function atualizarManual() {
    const mudou = await carregarSnapshot();
    setToast(mudou ? "Dados atualizados" : "A TV já está atualizada");
    window.clearTimeout(atualizarManual._t);
    atualizarManual._t = window.setTimeout(() => setToast(""), 2600);
  }

  const telas = useMemo(() => telasVisiveis(snap), [snap]);
  const total = telas.length;

  // Carrossel automático — 100% EM MEMÓRIA. Nunca consulta o banco. Pausa em
  // aba/TV oculta. Reinicia ao concluir a última tela; roda indefinidamente.
  useEffect(() => {
    if (total <= 1) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      setIndice((i) => {
        const prox = (i + 1) % total;
        if (prox === 0) setGiro((g) => g + 1);
        return prox;
      });
    }, SEG_POR_TELA * 1000);
    return () => clearInterval(t);
  }, [total]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "ArrowRight") setIndice((i) => (i + 1) % total);
      else if (e.key === "ArrowLeft") setIndice((i) => (i - 1 + total) % total);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  const tela = total > 0 ? telas[indice % total] : null;

  // URL pública da imagem do elogio (Storage) — string LOCAL, sem consulta.
  useEffect(() => {
    if (tela?.id !== "reconhecimento") { setElogioUrl(""); return; }
    const elogios = snap?.elogios || [];
    const e = elogios[giro % (elogios.length || 1)];
    if (!e?.elogio_print_path) { setElogioUrl(""); return; }
    const { data } = supabase.storage.from("elogios-prints").getPublicUrl(e.elogio_print_path);
    setElogioUrl(data?.publicUrl || "");
  }, [tela, snap, giro]);

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

      {toast && <div style={estiloToast}>{toast}</div>}

      {/* Botão manual do telão: alternativa ao evento realtime. Refaz SÓ a
          leitura do snapshot (1 consulta), sem recarregar a aplicação. */}
      <button
        type="button"
        onClick={atualizarManual}
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

// Raiz: 100vh EXATO, sem rolagem. A ÁREA SEGURA (padding) afasta o conteúdo das
// bordas (~4% laterais, ~3% topo/base) contra overscan de TV.
const raiz = {
  height: "100vh",
  width: "100vw",
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

const estiloToast = {
  position: "absolute",
  bottom: "clamp(46px, 5vh, 84px)",
  right: "clamp(10px, 1.4vw, 28px)",
  background: "rgba(15,23,42,0.92)",
  color: T.texto,
  border: "1px solid rgba(59,130,246,0.5)",
  borderRadius: 12,
  padding: "clamp(6px,0.7vh,12px) clamp(12px,1.1vw,22px)",
  fontSize: "clamp(12px,1vw,22px)",
  fontWeight: 700,
  boxShadow: "0 10px 30px rgba(2,6,23,0.5)",
};

const botaoAtualizar = {
  position: "absolute",
  bottom: "clamp(8px, 1vh, 20px)",
  right: "clamp(10px, 1.4vw, 28px)",
  background: "rgba(59,130,246,0.18)",
  color: T.texto,
  border: "1px solid rgba(59,130,246,0.4)",
  borderRadius: 999,
  padding: "clamp(5px,0.5vh,10px) clamp(12px,1vw,22px)",
  fontSize: "clamp(11px,0.9vw,18px)",
  fontWeight: 700,
  cursor: "pointer",
};
