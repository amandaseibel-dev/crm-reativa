// ===========================================================================
// CENTRAL ULBRA — fila de produtividade sobre o espelho da Mensageria.
//
// LÊ SÓ O POSTGRES, pela consulta `ulbra_central_operador`. O RECORTE É DO
// BANCO: quem não é gestão recebe só o próprio universo, qualquer que seja o
// filtro pedido. Nenhuma chamada à ULBRA sai daqui.
//
// REGRAS QUE ESTA TELA NÃO NEGOCIA
//   - três filas, nesta ordem: respostas aguardando ação (mais antiga
//     primeiro), sem interação válida há mais tempo, novos atendimentos;
//   - "resposta aguardando" não é "não lida" nem "sem acionamento": a conversa
//     fica na fila enquanto a última mensagem for do aluno. Marcar como lida e
//     acionar no ReATIVA aparecem como INFORMAÇÃO, nunca tiram a linha;
//   - responsável NO REATIVA e atendente NA MENSAGERIA são dois campos;
//   - "Abrir ficha" só com vínculo confirmado por CPF (`aluno_id`);
//   - a data da última coleta, a atualização manual, falha e coleta incompleta
//     ficam sempre visíveis;
//   - oferta, aceite e assumir estão INDISPONÍVEIS nesta etapa e a tela diz
//     isso: nenhum botão que pareça funcionar;
//   - função ausente no banco = "ainda não disponível", nunca fila vazia.
// ===========================================================================
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../services/supabase";
import usePolling from "../utils/polling";
import { normalizarEmail } from "../utils/ulbraRecebimento";
import {
  DESTINO,
  FAIXAS,
  LIMITE_PAGINA,
  ORDEM_FAIXAS,
  descreverColeta,
  filtrarSemInteracao,
  fmtData,
  fmtDataHora,
  fmtEspera,
  haMais,
  hrefFicha,
  juntarPaginas,
  lerFiltros,
  nomeCurto,
  paraBusca,
  salvarPosicao,
  tomarPosicao,
} from "../utils/ulbraCentral";

// Releitura do Postgres (não da ULBRA) para a aba deixada aberta.
const POLL_MS = 60_000;

const TOM = {
  verde: "border-emerald-300 bg-emerald-50 text-emerald-900",
  ambar: "border-amber-300 bg-amber-50 text-amber-900",
  vermelho: "border-red-400 bg-red-50 text-red-800",
  cinza: "border-gray-300 bg-gray-50 text-gray-700",
};
const SELO = {
  vermelho: "bg-red-100 text-red-800",
  laranja: "bg-orange-100 text-orange-800",
  ambar: "bg-amber-100 text-amber-800",
  azul: "bg-indigo-100 text-indigo-800",
  cinza: "bg-gray-100 text-gray-700",
};

function Selo({ tom = "cinza", children }) {
  return <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${SELO[tom]}`}>{children}</span>;
}

function Responsaveis({ reativa, ulbra }) {
  return (
    <>
      <span data-campo="responsavel-reativa">
        responsável no ReATIVA: <strong>{nomeCurto(reativa) || "ninguém"}</strong>
      </span>
      <span data-campo="atendente-mensageria">
        atendente na Mensageria: <strong>{ulbra || "não informado"}</strong>
      </span>
    </>
  );
}

function Cartao({ n, total, rotulo, nota }) {
  return (
    <div className={`bg-white border rounded-lg px-4 py-3 ${n > 0 ? "border-amber-400" : "border-gray-200"}`}>
      <div className="text-3xl font-bold tabular-nums leading-tight">{n}</div>
      <div className="text-sm text-gray-700 mt-1">{rotulo}</div>
      <div className="text-xs text-gray-500">
        {total > n ? `mostrando ${n} de ${total} · ` : ""}
        {nota}
      </div>
    </div>
  );
}

export default function CentralUlbra({ usuario }) {
  const email = normalizarEmail(usuario?.perfil?.email || usuario?.auth?.email);
  const [params, setParams] = useSearchParams();
  const busca = params.toString() ? `?${params.toString()}` : "";
  const filtros = useMemo(() => lerFiltros(busca), [busca]);

  // Posição guardada ao abrir uma ficha: lida UMA vez, na montagem.
  const [posicao] = useState(() => tomarPosicao(paraBusca(lerFiltros(window.location.search))));
  const [paginas, setPaginas] = useState(posicao?.paginas || 1);
  const [dados, setDados] = useState(null);
  const [situacao, setSituacao] = useState("carregando"); // carregando | pronto | negado | indisponivel | erro
  const [erro, setErro] = useState(null);
  const [recado, setRecado] = useState(null);
  const raizRef = useRef(null);
  const rolagemPendente = useRef(posicao?.rolagem ?? null);

  const buscar = useCallback(async () => {
    const lidas = [];
    for (let pg = 0; pg < paginas; pg += 1) {
      const { data, error } = await supabase.rpc("ulbra_central_operador", {
        p_operador: filtros.operador || null,
        p_limite: LIMITE_PAGINA,
        p_pagina: pg,
      });
      if (error) {
        // 42883 / PGRST202 = função inexistente: a migration não foi aplicada.
        if (error.code === "42883" || error.code === "PGRST202" || /ulbra_central_operador/.test(error.message || "")) {
          setSituacao("indisponivel");
        } else {
          setErro(error.message || "falha ao ler a Central");
          setSituacao("erro");
        }
        return;
      }
      if (!data?.ok) {
        setSituacao(data?.motivo === "ACESSO_NEGADO" ? "negado" : "erro");
        if (data?.motivo && data.motivo !== "ACESSO_NEGADO") setErro(data.motivo);
        return;
      }
      lidas.push(data);
      if (!haMais(data.totais, juntarPaginas(lidas))) break;
    }
    const ultima = lidas[lidas.length - 1];
    setDados({ ...ultima, ...juntarPaginas(lidas) });
    setSituacao("pronto");
  }, [filtros.operador, paginas]);

  const atualizarAgora = usePolling(buscar, POLL_MS, [email, filtros.operador, paginas], Boolean(email));

  // Volta da ficha: devolve a rolagem depois que a lista existe na tela.
  useLayoutEffect(() => {
    if (situacao !== "pronto" || rolagemPendente.current === null) return;
    const y = rolagemPendente.current;
    rolagemPendente.current = null;
    const alvo = contedorDeRolagem(raizRef.current);
    if (alvo === window) window.scrollTo(0, y);
    else alvo.scrollTop = y;
  }, [situacao, dados]);

  useEffect(() => {
    if (!recado) return undefined;
    const t = setTimeout(() => setRecado(null), 4000);
    return () => clearTimeout(t);
  }, [recado]);

  function mudarFiltro(campo, valor) {
    const novo = { ...filtros, [campo]: valor };
    setParams(new URLSearchParams(paraBusca(novo).replace(/^\?/, "")), { replace: true });
    if (campo === "operador") setPaginas(1);
  }

  function aoAbrirFicha() {
    const alvo = contedorDeRolagem(raizRef.current);
    salvarPosicao({
      busca: paraBusca(filtros),
      rolagem: alvo === window ? window.scrollY : alvo.scrollTop,
      paginas,
    });
  }

  async function marcarLida(conversa) {
    const { error } = await supabase.rpc("ulbra_conversa_marcar_lida", { p_id: conversa.conversa_id });
    setRecado(error ? "não foi possível marcar como lida agora" : "marcada como lida — continua na fila até haver resposta ao aluno");
    await atualizarAgora();
  }

  if (!email || situacao === "negado") {
    return <div className="p-6 text-sm">Você não tem acesso à Central ULBRA.</div>;
  }
  if (situacao === "indisponivel") {
    return (
      <div className="p-6 max-w-2xl" data-testid="central-indisponivel">
        <h1 className="text-xl font-bold">Central ULBRA</h1>
        <div className={`mt-3 border rounded-lg p-3 text-sm ${TOM.cinza}`}>
          <strong>A Central ainda não está disponível.</strong> A consulta do banco que alimenta esta tela não foi
          aplicada. Isto não significa fila vazia: nenhum dado foi lido.
        </div>
      </div>
    );
  }
  if (situacao === "erro") {
    return (
      <div className="p-6 max-w-2xl">
        <h1 className="text-xl font-bold">Central ULBRA</h1>
        <div className={`mt-3 border rounded-lg p-3 text-sm ${TOM.vermelho}`}>
          Não foi possível ler a Central: {erro || "erro desconhecido"}.{" "}
          <button type="button" className="underline" onClick={() => atualizarAgora()}>Tentar de novo</button>
        </div>
      </div>
    );
  }
  if (situacao === "carregando" || !dados) {
    return <div className="p-6 text-sm text-gray-500">Carregando a Central ULBRA…</div>;
  }

  const coleta = descreverColeta(dados.coleta);
  const totais = dados.totais || {};
  const semInteracao = filtrarSemInteracao(dados.sem_interacao, filtros.faixa);
  const faltam = haMais(totais, dados);
  const Ficha = ({ alunoId }) =>
    alunoId ? (
      <Link className="text-sm text-blue-600 hover:underline" to={hrefFicha(alunoId)} onClick={aoAbrirFicha}>
        Abrir ficha
      </Link>
    ) : (
      <span className="text-xs text-gray-400">sem vínculo confirmado por CPF — ficha não abre</span>
    );

  return (
    <div ref={raizRef} className="p-4 pb-10 max-w-5xl mx-auto text-gray-900" data-testid="central-ulbra">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold">Central ULBRA</h1>
        <span className="text-xs text-gray-500" data-testid="recorte">
          {dados.eh_gestao
            ? dados.operador ? `fila de ${nomeCurto(dados.operador)}` : "todas as carteiras"
            : `sua fila · ${nomeCurto(dados.operador)}`}
        </span>
      </div>

      <div className={`mt-2 border rounded-lg px-3 py-2 text-sm ${TOM[coleta.tom]}`} data-testid="faixa-coleta" data-estado={dados.coleta?.estado}>
        <strong>{coleta.titulo}</strong> · {coleta.texto}
        {coleta.detalhe ? <div className="mt-1" data-testid="coleta-detalhe">{coleta.detalhe}</div> : null}
        <div className="mt-1 text-xs opacity-80">
          Responder ao aluno é na Mensageria ULBRA. Aqui você vê a fila, abre a ficha e registra.{" "}
          <button type="button" className="underline" onClick={() => atualizarAgora()}>Atualizar lista</button>
          {" "}(relê os dados já coletados; não consulta a ULBRA)
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm" data-testid="filtros">
        {dados.eh_gestao ? (
          <select
            aria-label="Operador"
            className="border border-gray-300 rounded px-2 py-1 bg-white"
            value={filtros.operador}
            onChange={(e) => mudarFiltro("operador", e.target.value)}
          >
            <option value="">todos os operadores</option>
            {(dados.operadores || []).map((o) => <option key={o} value={o}>{nomeCurto(o)}</option>)}
          </select>
        ) : null}
        <select
          aria-label="Faixa de prazo"
          className="border border-gray-300 rounded px-2 py-1 bg-white"
          value={filtros.faixa}
          onChange={(e) => mudarFiltro("faixa", e.target.value)}
        >
          <option value="">todas as faixas de prazo</option>
          {ORDEM_FAIXAS.map((f) => <option key={f} value={f}>{FAIXAS[f].rotulo}</option>)}
        </select>
      </div>

      {recado ? <div className="mt-2 text-xs text-gray-700 bg-gray-100 border rounded px-2 py-1" role="status">{recado}</div> : null}

      <div className="mt-3 grid gap-3 grid-cols-1 sm:grid-cols-3" data-testid="cartoes">
        <Cartao n={dados.respostas.length} total={totais.respostas} rotulo="respostas aguardando ação" nota="mais antiga primeiro" />
        <Cartao n={semInteracao.length} total={filtros.faixa ? semInteracao.length : totais.sem_interacao} rotulo="sem interação válida" nota="fora do prazo de 7 dias, mais tempo primeiro" />
        <Cartao n={dados.novos.length} total={totais.novos} rotulo="novos atendimentos" nota="destinados ao operador, mais antigos primeiro" />
      </div>

      <section className="mt-4 bg-white border border-gray-200 rounded-lg px-4 py-3" data-testid="fila-respostas">
        <h2 className="text-[15px] font-semibold">1. Respostas aguardando ação <Selo>{dados.respostas.length}</Selo></h2>
        <p className="text-xs text-gray-500 mt-0.5">
          A última mensagem da conversa é do aluno. A linha só sai quando a Mensageria mostrar resposta ao aluno:
          marcar como lida ou registrar acionamento não comprova resposta e não a retira.
        </p>
        {dados.respostas.length === 0 ? (
          <div className="text-sm text-gray-400 py-2">nenhuma resposta aguardando</div>
        ) : dados.respostas.map((r) => (
          <div key={r.conversa_id} className="py-2.5 border-t border-gray-100 mt-2" data-linha="resposta">
            <div className="flex justify-between gap-3">
              <span className="text-sm font-semibold">{r.nome || "sem nome"}</span>
              <span className="text-xs text-gray-700 text-right whitespace-nowrap">
                aguardando há <strong>{fmtEspera(r.espera_min)}</strong>
                <br /><span className="text-gray-400">{fmtDataHora(r.mensagem_em)}</span>
              </span>
            </div>
            {r.previa ? <div className="text-sm text-gray-700">“{r.previa}”</div> : null}
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
              <Selo tom="vermelho">resposta do aluno sem retorno na Mensageria</Selo>
              <Responsaveis reativa={r.responsavel_reativa} ulbra={r.atendente_ulbra} />
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500" data-campo="informacoes">
              <span>
                {r.acionamento_posterior
                  ? `acionamento no ReATIVA em ${fmtData(r.ultimo_acionamento)} — não comprova resposta à mensagem`
                  : `último acionamento no ReATIVA: ${fmtData(r.ultimo_acionamento)}`}
              </span>
              <span>{r.lida ? "você marcou como lida — segue aguardando resposta" : "não lida por você"}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-4 items-center">
              <Ficha alunoId={r.aluno_id} />
              {!r.lida ? (
                <button type="button" className="text-sm text-gray-600 hover:underline" onClick={() => marcarLida(r)}>
                  marcar como lida
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </section>

      <section className="mt-4 bg-white border border-gray-200 rounded-lg px-4 py-3" data-testid="fila-sem-interacao">
        <h2 className="text-[15px] font-semibold">2. Sem interação válida há mais tempo <Selo>{semInteracao.length}</Selo></h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Alunos com conversa ou atendimento na Mensageria, pela regra de prazo da carteira: dias desde o último
          acionamento registrado no ReATIVA.
        </p>
        {semInteracao.length === 0 ? (
          <div className="text-sm text-gray-400 py-2">{filtros.faixa ? "ninguém nesta faixa" : "todos dentro do prazo"}</div>
        ) : semInteracao.map((x) => (
          <div key={x.aluno_id} className="py-2.5 border-t border-gray-100 mt-2" data-linha="sem-interacao">
            <div className="flex justify-between gap-3">
              <span className="text-sm font-semibold">{x.nome || "sem nome"}</span>
              <span className="text-xs text-gray-700 text-right whitespace-nowrap">
                {x.dias_sem_acionamento === null || x.dias_sem_acionamento === undefined
                  ? <strong>nunca acionado</strong>
                  : <><strong>{x.dias_sem_acionamento} dias</strong> sem acionamento</>}
                <br /><span className="text-gray-400">último: {fmtData(x.ultimo_acionamento)}</span>
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
              <Selo tom={FAIXAS[x.faixa]?.tom}>{FAIXAS[x.faixa]?.rotulo || x.faixa}</Selo>
              <Responsaveis reativa={x.responsavel_reativa} ulbra={x.atendente_ulbra} />
              <span>origem: {x.origem}</span>
            </div>
            <div className="mt-1"><Ficha alunoId={x.aluno_id} /></div>
          </div>
        ))}
      </section>

      <section className="mt-4 bg-white border border-gray-200 rounded-lg px-4 py-3" data-testid="fila-novos">
        <h2 className="text-[15px] font-semibold">3. Novos atendimentos destinados ao operador <Selo>{dados.novos.length}</Selo></h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Entraram em espera na Mensageria com CPF confirmado e ninguém assumiu no ReATIVA. Não são respostas: ficam
          separados.
        </p>
        {dados.novos.length === 0 ? (
          <div className="text-sm text-gray-400 py-2">nenhum atendimento novo</div>
        ) : dados.novos.map((a) => (
          <div key={a.atendimento_id} className="py-2.5 border-t border-gray-100 mt-2" data-linha="novo">
            <div className="flex justify-between gap-3">
              <span className="text-sm font-semibold">{a.nome || "sem nome"}</span>
              <span className="text-xs text-gray-700 text-right whitespace-nowrap">
                em espera há <strong>{fmtEspera(a.espera_min)}</strong>
                <br /><span className="text-gray-400">{fmtDataHora(a.entrou_em)}</span>
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
              <Selo tom="azul">{DESTINO[a.destino_motivo] || a.destino_motivo}</Selo>
              <span>destino sugerido: <strong>{nomeCurto(a.destino_email) || "ninguém"}</strong></span>
              <Responsaveis reativa={null} ulbra={null} />
            </div>
            <div className="mt-1 flex flex-wrap gap-4 items-center">
              <Ficha alunoId={a.aluno_id} />
              <span className="text-xs text-gray-400">assumir — indisponível nesta etapa</span>
            </div>
          </div>
        ))}
      </section>

      {faltam ? (
        <div className="mt-3 text-center">
          <button type="button" className="text-sm border border-gray-300 rounded px-3 py-1.5 bg-white hover:bg-gray-50" onClick={() => setPaginas((p) => p + 1)}>
            Carregar mais
          </button>
          <div className="text-xs text-gray-500 mt-1">há linhas no banco que ainda não estão na tela</div>
        </div>
      ) : null}

      <section className="mt-4 border border-dashed border-gray-300 rounded-lg px-4 py-3 bg-gray-50 text-sm text-gray-600" data-testid="oferta-indisponivel">
        <strong>Oferta e aceite de atendimentos livres: indisponível nesta etapa.</strong> Nenhum atendimento está
        sendo ofertado, e não há botão de aceitar. Quando a gestão ativar, a ação será “Aceitar e abrir ficha”, e a
        ficha só abrirá depois que o banco confirmar o aceite para uma única pessoa.
      </section>

      <p className="mt-3 text-xs text-gray-500">
        Identidade nunca é presumida por nome ou telefone: o que não tem CPF confirmado fica na conferência da gestão e
        não entra nesta fila.
      </p>
    </div>
  );
}

/** O ancestral que de fato rola (o layout do CRM pode rolar num contêiner). */
function contedorDeRolagem(no) {
  let el = no?.parentElement || null;
  while (el && el !== document.body) {
    const estilo = window.getComputedStyle(el);
    if (/(auto|scroll)/.test(estilo.overflowY) && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return window;
}
