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
import "./ulbra.css";
import CentralConversas from "../components/CentralConversas";
import MensageriaPeriodo from "../components/MensageriaPeriodo";
import { supabase } from "../services/supabase";
import { buscarFilaCarteira } from "../utils/filaCarteiraServidor";
import {
  conexaoDesconectar, conexaoEstado, conexaoIniciar, envioConfirmar, envioPrevia, lerHistorico, mapearHistorico, resumirPrevia,
} from "../utils/ulbraConversaCliente";
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
  listaPrioridade,
  lerFiltros,
  nomeCurto,
  paraBusca,
  salvarPosicao,
  tomarPosicao,
} from "../utils/ulbraCentral";

// Releitura do Postgres (não da ULBRA) para a aba deixada aberta.
const POLL_MS = 60_000;

const TOM = {
  verde: "ulbra-aviso--verde",
  ambar: "ulbra-aviso--ambar",
  vermelho: "ulbra-aviso--vermelho",
  cinza: "ulbra-aviso--cinza",
};

function Selo({ tom = "cinza", children }) {
  return <span className={`ulbra-etiqueta ulbra-etiqueta--${tom || "cinza"}`}>{children}</span>;
}

function RotuloResponsabilidade({ item }) {
  const r = item?.responsabilidade;
  if (r === "A_DEFINIR") {
    return (
      <span data-campo="responsabilidade" style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Selo tom="ambar">Responsabilidade a definir pela gestão</Selo>
        <span className="ulbra-texto-desativado">mais de um operador tem caso deste aluno — fora do rodízio, sem aviso individual</span>
      </span>
    );
  }
  if (item?.minha) {
    return <span data-campo="responsabilidade"><Selo tom="verde">responsabilidade sua</Selo></span>;
  }
  if (item?.responsavel_e_outro) {
    return (
      <span data-campo="responsabilidade" style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Selo tom="cinza">responsável: outro operador</Selo>
        <span className="ulbra-texto-desativado">você pode ver este atendimento, mas não responde por ele</span>
      </span>
    );
  }
  return null;
}

function Responsaveis({ item, reativa, ulbra }) {
  return (
    <>
      <RotuloResponsabilidade item={item} />
      {item?.divergencia ? (
        <span data-campo="divergencia" style={{ color: "var(--rv-ambar-texto)" }}>
          este aluno tem casos de mais de um operador
        </span>
      ) : null}
      <span data-campo="responsavel-reativa">
        responsável no ReATIVA: <strong>{item?.responsabilidade === "A_DEFINIR" ? "a definir" : (nomeCurto(reativa) || "ninguém")}</strong>
      </span>
      <span data-campo="atendente-mensageria">
        atendente na Mensageria: <strong>{ulbra || "não informado"}</strong>
      </span>
    </>
  );
}

function Cartao({ n, total, rotulo, nota }) {
  return (
    <div className={`ulbra-cartao ${n > 0 ? "ulbra-cartao--destaque" : ""}`}>
      <div className="ulbra-cartao-numero">{n}</div>
      <div className="ulbra-cartao-titulo">{rotulo}</div>
      <div className="ulbra-cartao-sub">
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
  // Fila "sem interação" pela CARTEIRA, consultada no servidor (RLS + filtros).
  const [carteira, setCarteira] = useState({ linhas: [], temMais: false, erro: null, pagina: 0 });
  // Histórico SOB DEMANDA por conversa (chave da lista -> estado). Nunca é lido ao selecionar.
  const [historicos, setHistoricos] = useState({});
  // Conexão individual do operador com a Mensageria (estado lido do servidor; nunca token).
  const [conexao, setConexao] = useState(null);
  // Backend de conversa publicado? Trava de etapa: ver o useEffect abaixo.
  const [conversaNoAr, setConversaNoAr] = useState(false);

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

  // Carteira só na visão de conversas. Operador: o próprio e-mail. Gestão: o
  // operador do filtro ou, sem filtro, TODAS as carteiras (cada linha traz o
  // operador). O "eh_gestao" vem do banco, não da tela.
  const operadorCarteira = dados?.eh_gestao ? filtros.operador : (dados?.operador || email);
  const todasCarteiras = dados?.eh_gestao === true && !filtros.operador;
  useEffect(() => {
    if (filtros.visao !== "conversas" || (!operadorCarteira && !todasCarteiras)) return undefined;
    let ativo = true;
    (async () => {
      const r = await buscarFilaCarteira(supabase, { operador: operadorCarteira, todas: todasCarteiras, pagina: 0 });
      if (ativo) setCarteira({ linhas: r.linhas, temMais: r.temMais, erro: r.erro, pagina: 0 });
    })();
    return () => { ativo = false; };
  }, [filtros.visao, operadorCarteira, todasCarteiras]);

  async function carregarMaisCarteira() {
    const proxima = carteira.pagina + 1;
    const r = await buscarFilaCarteira(supabase, { operador: operadorCarteira, todas: todasCarteiras, pagina: proxima });
    setCarteira((c) => ({ linhas: [...c.linhas, ...r.linhas], temMais: r.temMais, erro: r.erro, pagina: proxima }));
  }

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

  // Seleção e voltar empilham histórico: o "voltar" do navegador desfaz a escolha.
  function selecionarConversa(chave) {
    setParams(new URLSearchParams(paraBusca({ ...filtros, conv: chave }).replace(/^\?/, "")));
  }
  function voltarParaLista() {
    setParams(new URLSearchParams(paraBusca({ ...filtros, conv: "" }).replace(/^\?/, "")));
  }

  // Conexão: lida uma vez ao entrar na visão de conversas. Função ausente/sem
  // configuração = estado SEM_CONEXAO com motivo, nunca "conectado".
  //
  // `conversaNoAr` é a trava desta etapa: só é true quando a `ulbra-conversa`
  // RESPONDEU (`ok: true`). Enquanto ela não estiver publicada, a resposta é
  // `ok` falso e o botão "Conectar minha conta" não é oferecido -- caminho sem
  // backend não vai para a tela. O histórico não passa por aqui: ele fala com
  // a `ulbra-historico`, por isso pode ser implantado sozinho.
  useEffect(() => {
    if (filtros.visao !== "conversas" || !email) return undefined;
    let ativo = true;
    (async () => {
      const r = await conexaoEstado();
      if (!ativo) return;
      setConversaNoAr(r?.ok === true);
      setConexao(r?.ok ? { estado: r.estado, pessoa: r.pessoa, envioReal: r.envio_real === true } : { estado: "SEM_CONEXAO", pessoa: null, envioReal: false, motivo: r?.motivo || r?.erro || null });
    })();
    return () => { ativo = false; };
  }, [filtros.visao, email]);

  const conversaIdDe = (sel) => sel?.bruto?.conversa_id || (String(sel?.chave || "").startsWith("r:") ? String(sel.chave).slice(2) : null);

  async function carregarHistorico(sel, antesDe = null) {
    const conversaId = conversaIdDe(sel);
    if (!conversaId) {
      setHistoricos((h) => ({ ...h, [sel.chave]: { estado: "erro", mensagens: [], erro: "Esta linha não tem conversa coletada na Mensageria (só carteira interna)." } }));
      return;
    }
    const anterior = antesDe ? historicos[sel.chave] : null;
    setHistoricos((h) => ({ ...h, [sel.chave]: { ...(h[sel.chave] || { mensagens: [] }), estado: "carregando" } }));
    const r = await lerHistorico(conversaId, antesDe);
    const novo = mapearHistorico(r, anterior);
    setHistoricos((h) => ({
      ...h,
      [sel.chave]: {
        ...novo,
        onTentar: () => carregarHistorico(sel, antesDe),
        onCarregarAnteriores: novo.antesDe ? () => carregarHistorico(sel, novo.antesDe) : undefined,
      },
    }));
  }

  async function conectar() {
    const r = await conexaoIniciar();
    if (r?.ok && r.url) {
      // A autorização é do OPERADOR, na tela da própria Mensageria. Abre em nova aba.
      window.open(r.url, "_blank", "noopener,noreferrer");
      setRecado("Autorize na aba da Mensageria. Ao voltar, a conexão aparece aqui.");
    } else {
      setRecado(`Não foi possível iniciar a conexão: ${r?.motivo || r?.erro || "função indisponível"}.`);
    }
  }
  async function desconectar() {
    const r = await conexaoDesconectar();
    setConexao({ estado: r?.estado || "REVOGADA", pessoa: null, envioReal: conexao?.envioReal === true });
  }
  async function previaDe(sel, texto) {
    const conversaId = conversaIdDe(sel);
    if (!conversaId) return { ok: false, recusa: "Esta linha não tem conversa na Mensageria.", custo_usd: null, janela_aberta: null };
    return resumirPrevia(await envioPrevia(conversaId, texto));
  }
  async function enviarDe(sel, texto, chave, previa) {
    const conversaId = conversaIdDe(sel);
    if (!conversaId) return { situacao: "BLOQUEADO", motivos: ["SEM_CONVERSA"] };
    const r = await envioConfirmar(conversaId, texto, chave, previa || {});
    if (r?.situacao === "PROCESSADO" && r?.envio?.status === "ENVIADO") {
      setRecado("Mensagem enviada em seu nome. A Central reflete a Mensageria só na próxima coleta.");
    }
    return r;
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
    return <div className="ulbra-pagina">Você não tem acesso à Central ULBRA.</div>;
  }
  if (situacao === "indisponivel") {
    return (
      <div className="ulbra-pagina" data-testid="central-indisponivel">
        <h1 className="ulbra-titulo">Central ULBRA</h1>
        <div className={`ulbra-aviso ${TOM.cinza}`}>
          <strong>A Central ainda não está disponível.</strong> A consulta do banco que alimenta esta tela não foi
          aplicada. Isto não significa fila vazia: nenhum dado foi lido.
        </div>
      </div>
    );
  }
  if (situacao === "erro") {
    return (
      <div className="ulbra-pagina">
        <h1 className="ulbra-titulo">Central ULBRA</h1>
        <div className={`ulbra-aviso ${TOM.vermelho}`}>
          Não foi possível ler a Central: {erro || "erro desconhecido"}.{" "}
          <button type="button" className="ulbra-link" onClick={() => atualizarAgora()}>Tentar de novo</button>
        </div>
      </div>
    );
  }
  if (situacao === "carregando" || !dados) {
    return <div className="ulbra-pagina ulbra-texto-desativado">Carregando a Central ULBRA…</div>;
  }

  const coleta = descreverColeta(dados.coleta);
  const totais = dados.totais || {};
  const semInteracao = filtrarSemInteracao(dados.sem_interacao, filtros.faixa);
  const faltam = haMais(totais, dados);
  const Ficha = ({ alunoId }) =>
    alunoId ? (
      <Link className="ulbra-link" to={hrefFicha(alunoId)} onClick={aoAbrirFicha}>
        Abrir ficha
      </Link>
    ) : (
      <span className="ulbra-texto-desativado">sem vínculo confirmado por CPF — ficha não abre</span>
    );

  return (
    <div ref={raizRef} className="ulbra-pagina" data-testid="central-ulbra">
      <div className="ulbra-cabecalho">
        <h1 className="ulbra-titulo">Central ULBRA</h1>
        <span className="ulbra-faixa" data-testid="recorte">
          {dados.eh_gestao
            ? dados.operador ? `fila de ${nomeCurto(dados.operador)}` : "todas as carteiras"
            : `sua fila · ${nomeCurto(dados.operador)}`}
        </span>
      </div>

      <div className={`ulbra-aviso ${TOM[coleta.tom]}`} data-testid="faixa-coleta" data-estado={dados.coleta?.estado}>
        <strong>{coleta.titulo}</strong> · {coleta.texto}
        {coleta.detalhe ? <span className="ulbra-aviso-detalhe" data-testid="coleta-detalhe">{coleta.detalhe}</span> : null}
        <span className="ulbra-aviso-detalhe">
          Responder ao aluno é na Mensageria ULBRA. Aqui você vê a fila, abre a ficha e registra.{" "}
          <button type="button" className="ulbra-link" onClick={() => atualizarAgora()}>Atualizar lista</button>
          {" "}(relê os dados já coletados; não consulta a ULBRA)
        </span>
      </div>

      <div className="ulbra-filtros" data-testid="filtros">
        {dados.eh_gestao ? (
          <select
            aria-label="Operador"
            className="ulbra-select"
            value={filtros.operador}
            onChange={(e) => mudarFiltro("operador", e.target.value)}
          >
            <option value="">todos os operadores</option>
            {(dados.operadores || []).map((o) => <option key={o} value={o}>{nomeCurto(o)}</option>)}
          </select>
        ) : null}
        <select
          aria-label="Faixa de prazo"
          className="ulbra-select"
          value={filtros.faixa}
          onChange={(e) => mudarFiltro("faixa", e.target.value)}
        >
          <option value="">todas as faixas de prazo</option>
          {ORDEM_FAIXAS.map((f) => <option key={f} value={f}>{FAIXAS[f].rotulo}</option>)}
        </select>
      </div>

      {recado ? <div className="ulbra-recado" role="status">{recado}</div> : null}

      <div className="ulbra-visao" role="group" aria-label="Visão da Central">
        <button type="button" className="ulbra-botao" aria-pressed={filtros.visao === "mensageria"} onClick={() => mudarFiltro("visao", "mensageria")}>
          Mensageria (período)
        </button>
        <button type="button" className="ulbra-botao" aria-pressed={filtros.visao === "conversas"} onClick={() => mudarFiltro("visao", "conversas")}>
          Carteira interna
        </button>
        <button type="button" className="ulbra-botao" aria-pressed={filtros.visao === "cartoes"} onClick={() => mudarFiltro("visao", "cartoes")}>
          Cartões
        </button>
      </div>

      {filtros.visao === "mensageria" ? (
        <MensageriaPeriodo
          ehGestao={dados.eh_gestao === true}
          operador={filtros.operador}
          respostas={dados.respostas || []}
          coleta={dados.coleta || null}
          aoAbrirFicha={aoAbrirFicha}
        />
      ) : filtros.visao === "conversas" ? (
        <>
        {todasCarteiras ? (
          <p className="ulbra-aviso ulbra-aviso--cinza" data-testid="aviso-todas-carteiras">
            Carteira interna (não é a Mensageria): a fila de todos os operadores, mais antigo primeiro, com o operador em cada linha.
            Escolha um operador no filtro para ver só a carteira dele.
          </p>
        ) : null}
        {!operadorCarteira && !todasCarteiras ? (
          <p className="ulbra-aviso ulbra-aviso--cinza">Escolha um operador no filtro para ver a fila da carteira.</p>
        ) : null}
        {carteira.erro ? (
          <p className="ulbra-aviso ulbra-aviso--vermelho" role="alert">Não foi possível ler a carteira: {carteira.erro}</p>
        ) : null}
        <CentralConversas
          itens={listaPrioridade({ ...dados, sem_interacao: carteira.linhas }, filtros.faixa)}
          selecionadoChave={filtros.conv}
          onSelecionar={selecionarConversa}
          onVoltar={voltarParaLista}
          historico={historicos[filtros.conv] || { estado: "indisponivel", mensagens: [] }}
          aoAbrirFicha={aoAbrirFicha}
          vazio="nenhuma conversa nesta fila"
          onCarregarHistorico={carregarHistorico}
          conexao={conexao}
          onConectar={conversaNoAr ? conectar : undefined}
          onDesconectar={conversaNoAr ? desconectar : undefined}
          onPrevia={previaDe}
          onEnviar={enviarDe}
        />
        {carteira.temMais ? (
          <button type="button" className="ulbra-botao" onClick={carregarMaisCarteira}>Carregar mais da carteira</button>
        ) : null}
        </>
      ) : (
      <>

      <div className="ulbra-cartoes ulbra-cartoes--tres" data-testid="cartoes">
        <Cartao n={dados.respostas.length} total={totais.respostas} rotulo="respostas aguardando ação" nota="mais antiga primeiro; a definir pela gestão fora dos avisos" />
        <Cartao n={semInteracao.length} total={filtros.faixa ? semInteracao.length : totais.sem_interacao} rotulo="sem interação válida" nota="fora do prazo de 7 dias, mais tempo primeiro" />
        <Cartao n={dados.novos.length} total={totais.novos} rotulo="novos atendimentos" nota="destinados ao operador, mais antigos primeiro" />
      </div>

      <section className="ulbra-bloco" data-testid="fila-respostas">
        <h2 className="ulbra-bloco-titulo">1. Respostas aguardando ação <Selo>{dados.respostas.length}</Selo></h2>
        <p className="ulbra-bloco-sub">
          A última mensagem da conversa é do aluno. A linha só sai quando a Mensageria mostrar resposta ao aluno:
          marcar como lida ou registrar acionamento não comprova resposta e não a retira.
        </p>
        {dados.respostas.length === 0 ? (
          <div className="ulbra-bloco-vazio">nenhuma resposta aguardando</div>
        ) : dados.respostas.map((r) => (
          <div key={r.conversa_id} className="ulbra-linha" data-linha="resposta">
            <div className="ulbra-linha-topo">
              <span className="ulbra-linha-nome">{r.nome || "sem nome"}</span>
              <span className="ulbra-linha-tempo">
                aguardando há <strong>{fmtEspera(r.espera_min)}</strong>
                <br /><span className="ulbra-linha-tempo-data">{fmtDataHora(r.mensagem_em)}</span>
              </span>
            </div>
            {r.previa ? <div className="ulbra-linha-previa">“{r.previa}”</div> : null}
            <div className="ulbra-meta">
              <Selo tom="vermelho">resposta do aluno sem retorno na Mensageria</Selo>
              {r.notificar ? <Selo tom="verde">aviso para você</Selo> : null}
              <Responsaveis item={r} reativa={r.responsavel_reativa} ulbra={r.atendente_ulbra} />
            </div>
            <div className="ulbra-meta" data-campo="informacoes">
              <span>
                {r.acionamento_posterior
                  ? `acionamento no ReATIVA em ${fmtData(r.ultimo_acionamento)} — não comprova resposta à mensagem`
                  : `último acionamento no ReATIVA: ${fmtData(r.ultimo_acionamento)}`}
              </span>
              <span>{r.lida ? "você marcou como lida — segue aguardando resposta" : "não lida por você"}</span>
            </div>
            <div className="ulbra-acoes">
              <Ficha alunoId={r.aluno_id} />
              {!r.lida ? (
                <button type="button" className="ulbra-link" onClick={() => marcarLida(r)}>
                  marcar como lida
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </section>

      <section className="ulbra-bloco" data-testid="fila-sem-interacao">
        <h2 className="ulbra-bloco-titulo">2. Sem interação válida há mais tempo <Selo>{semInteracao.length}</Selo></h2>
        <p className="ulbra-bloco-sub">
          Alunos com conversa ou atendimento na Mensageria, pela regra de prazo da carteira: dias desde o último
          acionamento registrado no ReATIVA.
        </p>
        {semInteracao.length === 0 ? (
          <div className="ulbra-bloco-vazio">{filtros.faixa ? "ninguém nesta faixa" : "todos dentro do prazo"}</div>
        ) : semInteracao.map((x) => (
          <div key={x.aluno_id} className="ulbra-linha" data-linha="sem-interacao">
            <div className="ulbra-linha-topo">
              <span className="ulbra-linha-nome">{x.nome || "sem nome"}</span>
              <span className="ulbra-linha-tempo">
                {x.dias_sem_acionamento === null || x.dias_sem_acionamento === undefined
                  ? <strong>nunca acionado</strong>
                  : <><strong>{x.dias_sem_acionamento} dias</strong> sem acionamento</>}
                <br /><span className="ulbra-linha-tempo-data">último: {fmtData(x.ultimo_acionamento)}</span>
              </span>
            </div>
            <div className="ulbra-meta">
              <Selo tom={FAIXAS[x.faixa]?.tom}>{FAIXAS[x.faixa]?.rotulo || x.faixa}</Selo>
              <Responsaveis item={x} reativa={x.responsavel_reativa} ulbra={x.atendente_ulbra} />
              <span>origem: {x.origem}</span>
            </div>
            <div className="ulbra-acoes"><Ficha alunoId={x.aluno_id} /></div>
          </div>
        ))}
      </section>

      <section className="ulbra-bloco" data-testid="fila-novos">
        <h2 className="ulbra-bloco-titulo">3. Novos atendimentos destinados ao operador <Selo>{dados.novos.length}</Selo></h2>
        <p className="ulbra-bloco-sub">
          Entraram em espera na Mensageria com CPF confirmado e ninguém assumiu no ReATIVA. Não são respostas: ficam
          separados.
        </p>
        {dados.novos.length === 0 ? (
          <div className="ulbra-bloco-vazio">nenhum atendimento novo</div>
        ) : dados.novos.map((a) => (
          <div key={a.atendimento_id} className="ulbra-linha" data-linha="novo">
            <div className="ulbra-linha-topo">
              <span className="ulbra-linha-nome">{a.nome || "sem nome"}</span>
              <span className="ulbra-linha-tempo">
                em espera há <strong>{fmtEspera(a.espera_min)}</strong>
                <br /><span className="ulbra-linha-tempo-data">{fmtDataHora(a.entrou_em)}</span>
              </span>
            </div>
            <div className="ulbra-meta">
              <Selo tom="azul">{DESTINO[a.destino_motivo] || a.destino_motivo}</Selo>
              <span>destino sugerido: <strong>{nomeCurto(a.destino_email) || "ninguém"}</strong></span>
              <Responsaveis item={a} reativa={a.responsavel_reativa} ulbra={null} />
            </div>
            <div className="ulbra-acoes">
              <Ficha alunoId={a.aluno_id} />
              <span className="ulbra-texto-desativado">assumir — indisponível nesta etapa</span>
            </div>
          </div>
        ))}
      </section>

      </>
      )}

      {faltam ? (
        <div className="ulbra-rodape" style={{ textAlign: "center" }}>
          <button type="button" className="ulbra-botao" onClick={() => setPaginas((p) => p + 1)}>
            Carregar mais
          </button>
          <div style={{ marginTop: 4 }}>há linhas no banco que ainda não estão na tela</div>
        </div>
      ) : null}

      <section className="ulbra-aviso ulbra-aviso--cinza" style={{ borderStyle: "dashed" }} data-testid="oferta-indisponivel">
        <strong>Oferta e aceite de atendimentos livres: indisponível nesta etapa.</strong> Nenhum atendimento está
        sendo ofertado, e não há botão de aceitar. Quando a gestão ativar, a ação será “Aceitar e abrir ficha”, e a
        ficha só abrirá depois que o banco confirmar o aceite para uma única pessoa.
      </section>

      <p className="ulbra-rodape">
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
