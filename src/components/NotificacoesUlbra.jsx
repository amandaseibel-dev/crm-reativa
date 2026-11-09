// ===========================================================================
// SINO DA MENSAGERIA ULBRA — resposta do aluno e novo atendimento, no CRM.
//
// LÊ POSTGRES, NÃO A ULBRA. A versão anterior deste arquivo chamava a Edge
// Function `ulbra-leads-pendentes` a cada 60s, na aba de cada operador — 1.440
// chamadas por dia POR PESSOA contra um teto medido de 500/dia para a
// credencial inteira. Ela nunca foi montada em tela nenhuma, e é por isso que
// o orçamento nunca estourou. Agora quem fala com a ULBRA é uma função só, por
// cron (`ulbra-sincronizar`), e esta tela lê o espelho no banco: Realtime, com
// um poll lento de reserva. Custo na Mensageria: zero, por operador.
//
// O QUE ESTE COMPONENTE NÃO FAZ
//   - não assume nada sozinho: quem assume é o operador, no clique, e a
//     decisão final é do banco (UPDATE condicional);
//   - não mostra caso de identidade não confirmada ao operador — isso é
//     conferência da gestão;
//   - não mostra conteúdo de conversa, só o trecho que a lista já traz.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import usePolling from "../utils/polling";
import { buscarTudo } from "../utils/paginado";
import {
  RECUSA_EM_PORTUGUES,
  contarNovidades,
  marcarNaoLidas,
  lerPrefs,
  normalizarEmail,
  ordenarPorRecencia,
  podeAssumir,
  salvarPrefs,
} from "../utils/ulbraRecebimento";
import { podeVerCentralUlbra } from "../utils/ulbraCentral";

// Reserva, não relógio principal: o Realtime é quem avisa. 45s só cobre o
// caso de o socket cair sem avisar. É Postgres nosso, não a Mensageria.
const POLL_RESERVA_MS = 45_000;

function horaCurta(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function NotificacoesUlbra({ usuario }) {
  const email = normalizarEmail(usuario?.perfil?.email || usuario?.auth?.email);
  const [conversasBrutas, setConversasBrutas] = useState([]);
  const [leituras, setLeituras] = useState(() => new Map());
  const [atendimentos, setAtendimentos] = useState([]);
  const [ehGestao, setEhGestao] = useState(false);
  const [alunosDoOperador, setAlunosDoOperador] = useState(null);
  const [carregado, setCarregado] = useState(false);
  const [aberto, setAberto] = useState(false);
  // Preferência é lida do armazenamento a cada mudança de operador ou de
  // versão. Sem setState em efeito: a versão só muda por clique do usuário.
  const [versaoPrefs, setVersaoPrefs] = useState(0);
  const prefs = useMemo(() => {
    void versaoPrefs; // gatilho de releitura após clique em "som"
    return lerPrefs(email);
  }, [email, versaoPrefs]);
  const [recado, setRecado] = useState(null);
  const ctxRef = useRef(null);
  const totalAnteriorRef = useRef(null);
  const emAcaoRef = useRef(false);

  // Bip curto, igual ao da Central WhatsApp. Só com a preferência ligada.
  const tocar = useCallback(() => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = ctxRef.current || (ctxRef.current = new Ctx());
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.frequency.value = 760;
      ganho.gain.setValueAtTime(0.06, ctx.currentTime);
      ganho.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.connect(ganho);
      ganho.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch {
      // som bloqueado pelo navegador — a notificação visual continua
    }
  }, []);

  const buscar = useCallback(async () => {
    const [{ data: conv }, { data: atend }] = await Promise.all([
      supabase
        .from("ulbra_conversas")
        .select(
          "ulbra_conversa_id, ulbra_cliente_id, cliente_nome, situacao, responsavel_ulbra, ultima_mensagem_em, ultima_mensagem_quem, ultima_mensagem_previa, ultima_mensagem_cliente_em, aluno_id, aluno_status",
        )
        .not("ultima_mensagem_cliente_em", "is", null)
        .order("ultima_mensagem_em", { ascending: false })
        .limit(200),
      supabase
        .from("ulbra_atendimentos")
        .select(
          "ulbra_atendimento_id, cliente_nome, situacao, entrou_em, aluno_id, aluno_status, destino_email, destino_motivo, responsavel_email, dispensado_em",
        )
        .is("dispensado_em", null)
        .order("entrou_em", { ascending: false })
        .limit(200),
    ]);
    // Leitura: SO a linha deste usuario (RLS ja restringe; o filtro e explicito)
    const { data: lidos } = await supabase
      .from("ulbra_leitura_usuario")
      .select("ulbra_conversa_id, lido_ate")
      .eq("usuario_email", email);
    setConversasBrutas(conv || []);
    setLeituras(new Map((lidos || []).map((l) => [l.ulbra_conversa_id, l.lido_ate])));
    setAtendimentos(atend || []);
    setCarregado(true);
  }, [email]);

  // Quem é da gestão e quais alunos são do operador: uma vez por sessão.
  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data: gestao } = await supabase.rpc("usuario_e_gestao");
      if (!ativo) return;
      setEhGestao(gestao === true);
      if (gestao === true || !email) return;
      // buscarTudo: a API entrega no máximo 1000 por requisição, sem erro.
      // Desempate por id para a paginação não repetir nem perder linha.
      const casos = await buscarTudo((de, ate) =>
        supabase
          .from("casos")
          .select("id, aluno_id")
          .eq("operador_email", email)
          .order("id", { ascending: true })
          .range(de, ate)
      );
      if (!ativo) return;
      setAlunosDoOperador(new Set(casos.map((c) => c.aluno_id).filter(Boolean)));
    })();
    return () => {
      ativo = false;
    };
  }, [email]);

  // Leitura inicial e poll de reserva: o hook do CRM pausa com a aba oculta,
  // não sobrepõe chamadas e cancela ao desmontar.
  const atualizarAgora = usePolling(buscar, POLL_RESERVA_MS, [email], Boolean(email));

  // Realtime avisa na hora; a leitura continua sendo a do banco.
  useEffect(() => {
    if (!email) return undefined;
    const aviso = () => atualizarAgora();
    const canal = supabase
      .channel("ulbra_recebimento")
      .on("postgres_changes", { event: "*", schema: "public", table: "ulbra_conversas" }, aviso)
      .on("postgres_changes", { event: "*", schema: "public", table: "ulbra_atendimentos" }, aviso)
      .subscribe();
    return () => {
      supabase.removeChannel(canal);
    };
  }, [email, atualizarAgora]);

  const novidades = useMemo(
    () =>
      contarNovidades({
        conversas: marcarNaoLidas(conversasBrutas, leituras),
        atendimentos,
        email,
        ehGestao,
        alunosDoOperador,
      }),
    [conversasBrutas, leituras, atendimentos, email, ehGestao, alunosDoOperador],
  );

  // Som só quando o número SOBE. Primeira carga nunca toca: chegar numa fila
  // que já estava cheia não é mensagem nova.
  //
  // `carregado` existe por causa disso: sem ele, a linha-base era o zero da
  // tela ANTES de os dados chegarem, e a primeira carga sempre tocava — era
  // "subiu de 0 para 3". A linha-base só vale depois do primeiro resultado.
  useEffect(() => {
    if (!carregado) return;
    const anterior = totalAnteriorRef.current;
    totalAnteriorRef.current = novidades.total;
    if (anterior === null) return;
    if (novidades.total > anterior && prefs.som) tocar();
  }, [carregado, novidades.total, prefs.som, tocar]);

  async function assumir(atendimento) {
    if (emAcaoRef.current) return;
    emAcaoRef.current = true;
    try {
      const { data, error } = await supabase.rpc("ulbra_atendimento_assumir", {
        p_id: atendimento.ulbra_atendimento_id,
      });
      if (error) setRecado("não foi possível assumir agora");
      else if (data?.ok) setRecado(`atendimento de ${atendimento.cliente_nome || "cliente"} é seu`);
      else setRecado(RECUSA_EM_PORTUGUES[data?.motivo] || "não foi possível assumir");
      await atualizarAgora();
    } finally {
      emAcaoRef.current = false;
    }
  }

  async function marcarLida(conversa) {
    await supabase.rpc("ulbra_conversa_marcar_lida", { p_id: conversa.ulbra_conversa_id });
    await atualizarAgora();
  }

  function alternarSom() {
    salvarPrefs(email, { ...prefs, som: !prefs.som });
    setVersaoPrefs((v) => v + 1);
  }

  if (!email) return null;
  if (novidades.total === 0 && !aberto) return null;

  return (
    <div className="notificacoes-ulbra" style={{ position: "fixed", right: 16, bottom: 92, zIndex: 60 }}>
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="text-sm font-medium text-white bg-emerald-700 hover:bg-emerald-800 px-3 py-1 rounded shadow"
        aria-label="Mensageria ULBRA"
      >
        Mensageria ULBRA
        {novidades.total > 0 ? (
          <span className="ml-1 bg-red-500 text-white text-xs rounded-full px-1.5">
            {novidades.total}
          </span>
        ) : null}
      </button>

      {aberto ? (
        <div className="mt-1 w-80 bg-white border rounded shadow-lg max-h-96 overflow-auto">
          <div className="p-2 flex items-center justify-between border-b">
            <span className="text-xs font-semibold text-gray-500">Mensageria ULBRA</span>
            <button type="button" onClick={alternarSom} className="text-xs text-blue-600 hover:underline">
              som {prefs.som ? "ligado" : "desligado"}
            </button>
          </div>

          {podeVerCentralUlbra(email) ? (
            <a href="/central-ulbra" className="block p-2 text-xs text-blue-600 hover:underline border-b">
              abrir Central ULBRA (fila completa)
            </a>
          ) : null}

          {recado ? <div className="p-2 text-xs text-gray-700 bg-gray-50 border-b">{recado}</div> : null}

          <div className="p-2 text-xs font-semibold text-gray-500">
            Conversas com resposta não lida ({novidades.nao_lidas})
          </div>
          {novidades.respostas.length === 0 ? (
            <div className="px-2 pb-2 text-xs text-gray-400">nada esperando</div>
          ) : (
            ordenarPorRecencia(novidades.respostas, "ultima_mensagem_em").map((c) => (
              <div key={c.ulbra_conversa_id} className="p-2 border-t hover:bg-gray-50">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm truncate">{c.cliente_nome || "sem nome"}</span>
                  <span className="text-xs text-gray-400">{horaCurta(c.ultima_mensagem_em)}</span>
                </div>
                <div className="text-xs text-gray-600 truncate">{c.ultima_mensagem_previa}</div>
                <div className="mt-1 flex gap-3">
                  {c.aluno_id ? (
                    <a
                      className="text-xs text-blue-600 hover:underline"
                      href={`/aluno?alunoId=${encodeURIComponent(c.aluno_id)}&origem=ulbra`}
                    >
                      abrir ficha
                    </a>
                  ) : (
                    <span className="text-xs text-amber-700">identidade não confirmada</span>
                  )}
                  <button
                    type="button"
                    onClick={() => marcarLida(c)}
                    className="text-xs text-gray-500 hover:underline"
                  >
                    marcar como lida
                  </button>
                </div>
              </div>
            ))
          )}

          <div className="p-2 text-xs font-semibold text-gray-500 border-t">
            Novos atendimentos ({novidades.leads.length})
          </div>
          {novidades.leads.length === 0 ? (
            <div className="px-2 pb-2 text-xs text-gray-400">nada esperando</div>
          ) : (
            ordenarPorRecencia(novidades.leads, "entrou_em").map((a) => {
              const julgado = podeAssumir(a, email, ehGestao);
              return (
                <div key={a.ulbra_atendimento_id} className="p-2 border-t hover:bg-gray-50">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm truncate">{a.cliente_nome || "sem nome"}</span>
                    <span className="text-xs text-gray-400">{horaCurta(a.entrou_em)}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {a.destino_motivo === "CARTEIRA" ? "da sua carteira" : "rodízio do receptivo"}
                  </div>
                  {julgado.pode ? (
                    <button
                      type="button"
                      onClick={() => assumir(a)}
                      className="mt-1 text-xs text-blue-600 hover:underline"
                    >
                      Assumir
                    </button>
                  ) : (
                    <span className="mt-1 block text-xs text-gray-400">
                      {RECUSA_EM_PORTUGUES[julgado.motivo] || "indisponível"}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
