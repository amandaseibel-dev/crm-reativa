import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import {
  Cabecalho, Rodape, Palco, EstadoCarregando, EstadoSemSnapshot, EstadoErro, Marca, T, AREA_SEGURA, fs,
} from "../components/tv/tvUI";
import { telasVisiveis } from "../components/tv/tvTelas";

// Usuário técnico do telão: painel.tv@reativa.local (perfil "painel"). É o
// usuário de MENOR permissão — bloqueado de alunos/CPF/operacional por 96
// políticas eh_painel; só lê o snapshot da TV. O e-mail NÃO é segredo; a senha
// nunca fica no bundle — é digitada no telão uma vez e a sessão persiste.
const TV_EMAIL_PADRAO = "painel.tv@reativa.local";

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
  const [erroLeitura, setErroLeitura] = useState(false);
  // Sessão do telão: undefined = verificando; null = sem sessão (mostra login);
  // objeto = sessão autenticada persistente (supabase renova o token sozinho).
  const [sessao, setSessao] = useState(undefined);
  const versaoRef = useRef(Number(cache?.meta?.versao || 0));

  // Detecta/observa a sessão. persistSession + autoRefreshToken (padrão do
  // cliente) mantêm o telão logado durante o uso diário, sem senha no bundle.
  useEffect(() => {
    let vivo = true;
    supabase.auth.getSession().then(({ data }) => { if (vivo) setSessao(data?.session || null); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSessao(s || null));
    return () => { vivo = false; sub?.subscription?.unsubscribe(); };
  }, []);

  // Uma leitura do snapshot. Devolve { ok, mudou } para o feedback do botão.
  // - ok=false  → a leitura FALHOU (erro/permission/rede): NÃO dizer "atualizada".
  // - Zero, listas vazias e campos opcionais nulos são DADOS VÁLIDOS: desde que
  //   venha payload, aplicamos e removemos a mensagem de ausência.
  // Preserva o último snapshot bom (cache local) em caso de falha.
  async function carregarSnapshot() {
    setAtualizando(true);
    try {
      const { data, error } = await supabase.rpc("tv_snapshot_ler");
      if (error) throw error;
      const nova = Number(data?.versao || 0);
      const mudou = nova !== versaoRef.current;
      versaoRef.current = nova;
      const m = { status: data?.status, versao: data?.versao, gerado_em: data?.gerado_em, gerado_por: data?.gerado_por };
      setMeta(m);
      setErroLeitura(false);
      // Só aplica quando há PAYLOAD (snapshot válido). status 'vazio' = sem snapshot.
      if (data?.payload) {
        setSnap(data.payload);
        salvarCache(data.payload, m); // cache só APÓS retorno válido
      }
      return { ok: true, mudou };
    } catch (e) {
      // Falha real de leitura: mantém o último snapshot (memória/cache) e sinaliza erro.
      setErroLeitura(true);
      return { ok: false, mudou: false, erro: e?.message };
    } finally {
      setCarregou(true);
      setAtualizando(false);
    }
  }

  // Carga inicial: 1 leitura, SÓ com sessão do telão (sem sessão → tela de login).
  useEffect(() => {
    if (sessao) carregarSnapshot();
  }, [sessao]);

  // Realtime: escuta SÓ a tabela-sinal do snapshot, com a sessão do telão. Quando
  // o CRM gera um novo snapshot com sucesso, chega 1 evento e a TV faz 1 leitura.
  // Sem polling. Se o realtime falhar, o botão manual segue como alternativa.
  useEffect(() => {
    if (!sessao) return;
    const canal = supabase
      .channel("tv-sinal")
      .on("postgres_changes", { event: "*", schema: "public", table: "tv_sinal" }, (payload) => {
        const v = Number(payload?.new?.versao || 0);
        if (v > versaoRef.current) carregarSnapshot();
      })
      .subscribe();
    return () => { supabase.removeChannel(canal); };
  }, [sessao]);

  // Botão manual do telão: 1 leitura; feedback breve; sem recarregar a app nem
  // reiniciar o carrossel (o índice atual é preservado).
  async function atualizarManual() {
    const r = await carregarSnapshot();
    const msg = !r.ok
      ? "Erro ao ler os dados. Verifique a conexão."
      : r.mudou
        ? "Dados atualizados"
        : "A TV já está atualizada";
    setToast(msg);
    window.clearTimeout(atualizarManual._t);
    atualizarManual._t = window.setTimeout(() => setToast(""), 3000);
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

  // Regra da mensagem de ausência: só quando NÃO há snapshot válido.
  // Havendo payload (mesmo com indicadores zero/listas vazias), renderiza.
  const conteudo = (() => {
    if (snap && tela) {
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
    }
    if (!carregou) return <EstadoCarregando />;
    if (erroLeitura && !snap) return <EstadoErro />; // leitura falhou e sem cache
    return <EstadoSemSnapshot />;                    // status 'vazio' = nunca gerado
  })();

  // Gating de sessão: enquanto verifica, mostra carregando; sem sessão, mostra a
  // tela de login EXCLUSIVA do telão (não redireciona para o CRM).
  if (sessao === undefined) return <div style={raiz}><EstadoCarregando /></div>;
  if (sessao === null) return <TvLogin />;

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

// Tela de login EXCLUSIVA do telão. Autentica o usuário técnico e volta para a
// própria TV (não redireciona para o CRM). A senha é digitada aqui — NUNCA fica
// no código; a sessão persiste e renova sozinha depois do primeiro login.
function TvLogin() {
  const [email, setEmail] = useState(TV_EMAIL_PADRAO);
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [entrando, setEntrando] = useState(false);
  async function entrar(e) {
    e.preventDefault();
    setEntrando(true); setErro("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: senha });
    // Sucesso: onAuthStateChange no orquestrador assume e carrega a TV.
    if (error) setErro("Não foi possível entrar. Verifique e-mail e senha do telão.");
    setEntrando(false);
  }
  return (
    <div style={{ ...raiz, alignItems: "center", justifyContent: "center" }}>
      <form onSubmit={entrar} style={loginCard}>
        <Marca tamanho={fs(30, 3.4, 72)} />
        <div style={{ fontSize: fs(15, 1.5, 30), color: T.textoMudo, fontWeight: 700 }}>Acesso do telão</div>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="usuário do telão"
          autoComplete="username" style={loginInput} />
        <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} placeholder="senha do telão"
          autoComplete="current-password" style={loginInput} />
        <button type="submit" disabled={entrando} style={loginBtn}>{entrando ? "Entrando…" : "Entrar"}</button>
        {erro && <div style={{ color: T.vermelho, fontSize: fs(12, 1.2, 22), fontWeight: 600 }}>{erro}</div>}
        <div style={{ fontSize: fs(11, 1, 18), color: T.textoSuave }}>Sessão exclusiva da TV — não abre o CRM.</div>
      </form>
    </div>
  );
}

const loginCard = {
  display: "flex", flexDirection: "column", gap: "1.4vh", alignItems: "stretch",
  width: "min(90vw, 420px)", background: T.surface, border: `1px solid ${T.surfaceBorda}`,
  borderRadius: 18, padding: "4vh 3vw", boxShadow: "0 20px 60px rgba(2,6,23,0.5)", textAlign: "center",
};
const loginInput = {
  background: "rgba(15,23,42,0.7)", color: T.texto, border: "1px solid rgba(148,163,184,0.3)",
  borderRadius: 10, padding: "12px 14px", fontSize: "clamp(14px,1.1vw,20px)", outline: "none",
};
const loginBtn = {
  background: T.azul, color: "#fff", border: "none", borderRadius: 10, padding: "12px 16px",
  fontSize: "clamp(14px,1.1vw,20px)", fontWeight: 800, cursor: "pointer",
};

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
