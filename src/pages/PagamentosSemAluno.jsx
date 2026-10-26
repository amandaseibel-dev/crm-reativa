// Fila de pagamentos sem vinculo -- a fila de excecao do dinheiro.
//
// POR QUE EXISTE. O extrato de pagamentos nao traz CPF, e ate 28/08/2026 a
// importacao tambem descartava a matricula (coluna B vem como
// "2026002333 - Nome"). Resultado: pagamento entrava sem nenhum vinculo com a
// base.
//
// MUDANCA DE 14/09/2026. A fila deixou de ser "pagamento sem aluno" e passou a
// ser "pagamento que nao baixou". O eixo antigo era `aluno_id IS NULL`, e ele
// escondia o caso mais caro: pagamento com aluno JA identificado (por boleto
// exato ou por numero Ulbra unico) cuja parcela nao baixou. Medido no arquivo
// de 14/09: 11 linhas / R$ 4.655,12 entravam sem registro nenhum do motivo.
// Agora entra na fila tudo que `pagamentos.status_conciliacao` diz que nao
// terminou em BAIXADO, com ou sem aluno.
//
// MUDANCA DE 12/09/2026. O nome deixou de vincular. A regra agora e, em ordem:
// CPF -> boleto exato -> prefixo UNICO -> numero_ulbra UNICO -> SEM VINCULO.
// O que nao tem identificador financeiro cai aqui e exige decisao humana.
// Medido: em lotes reais, 30 a 40% das linhas caem nesta fila. Por isso a fila
// entrou no menu -- antes a rota existia e ninguem a alcancava.
//
// Cada linha mostra DOIS motivos, que respondem perguntas diferentes:
//   motivo FINANCEIRO  -> por que nenhum identificador resolveu (vem de
//                         fila_pagamento_sem_vinculo.motivo)
//   motivo por NOME    -> NOME_REPETIDO / SEM_CADASTRO, so para a pessoa saber
//                         se existe homonimo antes de decidir
//
// Os candidatos por nome sao SUGESTAO. Nenhum deles vincula sozinho, nem aqui
// nem no banco: quem grava e pagamento_vincular_aluno, que exige gestao,
// registra origem_vinculo = 'GESTAO_MANUAL' e fecha a linha da fila com quem
// decidiu e quando.
//
// MUDANCA DE 16/09/2026. A acao da linha corresponde ao ponto exato em que o
// pagamento travou (`pagamentos_trava`). Em AGUARDANDO_ACORDO com aluno provado
// por matricula + nome, a trava e o acordo, nao o aluno: a linha diz "Aluno
// identificado · acordo nao encontrado" e oferece "Registrar acordo a vista" --
// nunca "Vincular aluno".
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import CadastroNovoAluno from "../components/CadastroNovoAluno";
import {
  STATUS_CONCILIACAO,
  acaoDaLinha,
  ACOES_DA_FILA,
  contarPorStatus,
  AVISO_PROJECAO,
  podeEncerrarPendencia,
  CONCLUSOES_FEITO,
  MOTIVOS_REJEICAO,
  FEITO_AVISO,
  REJEITAR_AVISO,
  finalizacaoInvalida,
  evidenciasDaLinha,
} from "../utils/conciliacaoPagamento";
import RegistrarAcordoAvista from "../components/RegistrarAcordoAvista";
import EncaminharPendencia from "../components/EncaminharPendencia";
import Aluno from "./Aluno";
import DadosAcademicos from "../components/DadosAcademicos";
import { useSearchParams } from "react-router-dom";
import {
  resumoPorCategoria,
  totalDaTriagem,
  indexarTriagem,
  pendenciasSoNaTriagem,
  filtrarPorCategoria,
  rotuloSubcategoria,
  resumoPorArquivo,
  recorteDoArquivo,
} from "../utils/filaPagamentoTriagem";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function dataCurta(d) {
  if (!d) return "-";
  const [a, m, dia] = String(d).slice(0, 10).split("-");
  return `${dia}/${m}/${a}`;
}
function mesAtual() {
  const h = new Date();
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}`;
}

export default function PagamentosSemAluno() {
  const [mes, setMes] = useState(mesAtual());
  // Pendencia NAO se esconde atras do mes corrente. Os pagamentos em aberto
  // hoje sao todos de 2026-07: com o filtro no mes corrente a tela abria
  // dizendo "tudo baixado" com 6 pendencias na base -- pior que uma fila
  // cheia, porque parece resolvido. O checkbox continua ali para restringir a
  // um mes quando alguem quiser; o padrao e ver tudo que esta em aberto.
  const [todosOsMeses, setTodosOsMeses] = useState(true);
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [filtro, setFiltro] = useState("TODOS");
  const [abertoId, setAbertoId] = useState(null);
  const [fichaId, setFichaId] = useState(null);
  const [nomeCopiado, setNomeCopiado] = useState("");
  const [travas, setTravas] = useState(null);
  const [registrando, setRegistrando] = useState(null);
  // TRIAGEM (22/10/2026). Classificacao das pendencias em 4 categorias, vinda
  // inteira do banco (`vw_fila_pagamento_triagem`). A tela nao classifica nada:
  // conta, filtra e mostra. `triagemErro` existe para a faixa poder dizer
  // "indisponivel" sem apagar a fila -- ver o tratamento no `carregar`.
  const [triagem, setTriagem] = useState([]);
  const [triagemErro, setTriagemErro] = useState("");
  // RECORTE POR ARQUIVO (23/10/2026). A conferencia "Por arquivo" da Central de
  // Pagamentos manda para ca com `?importacao=<id>`; esta fila continua sendo a
  // UNICA que decide. O recorte mora na URL de proposito: o link da conferencia
  // precisa ser compartilhavel, e voltar para "ver todos os arquivos" nao pode
  // perder o resto do estado da tela.
  const [params, setParams] = useSearchParams();
  const importacaoFiltro = params.get("importacao") || "";
  const [categoria, setCategoria] = useState("TODAS");

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("pagamentos_sem_aluno", {
      p_mes: mes,
      p_todos_os_meses: todosOsMeses,
    });
    if (error) {
      // `permission denied for function` e a ACL do Postgres respondendo: a
      // requisicao chegou sem JWT valido e o PostgREST usou a chave anonima.
      // Nao e erro de permissao da pessoa -- e sessao vencida. Jogar o texto
      // cru do banco na tela nao diz isso a ninguem.
      if (/permission denied for function/i.test(error.message))
        setErro("Sua sessão expirou. Recarregue a página e entre novamente.");
      // O portao interno da RPC, quando quem chama nao e da gestao financeira.
      else if (/gest[aã]o financeira/i.test(error.message))
        setErro("Esta fila é da gestão financeira.");
      else setErro(error.message);
    }
    setLinhas(data || []);
    setCarregando(false);

    // Em que ponto cada "aguardando acordo" travou. Sem esta resposta a linha
    // fica sem acao -- acao generica e o que a regra da tela proibe.
    const ids = (data || [])
      .filter((l) => l.status_conciliacao === "AGUARDANDO_ACORDO")
      .map((l) => l.pagamento_id);
    if (ids.length === 0) { setTravas({}); return; }
    setTravas(null);
    const { data: t, error: erroTrava } = await supabase.rpc("pagamentos_trava", { p_pagamento_ids: ids });
    const mapa = {};
    if (!erroTrava) for (const x of t || []) if (x && x.pagamento_id) mapa[x.pagamento_id] = x;
    setTravas(mapa);
  }, [mes, todosOsMeses]);

  // A TRIAGEM E UMA LEITURA SEPARADA, DE PROPOSITO.
  //
  // Ela NAO passa por `pagamentos_sem_aluno`, e isso e o ponto: aquela RPC
  // exclui quem tem decisao registrada na fila (`and not exists (... decisao is
  // not null)`), e sao justamente essas 33 pendencias -- decididas, com status
  // ainda pendente -- que ninguem ve hoje. O mesmo predicado esta em
  // `fluxo_pagamentos_incremental`, entao a rodada tambem as pula. Lendo a
  // triagem por fora, elas voltam para a conferencia sem que a RPC da lista
  // principal -- compartilhada com outras frentes -- precise ser alterada.
  //
  // FALHA AQUI NAO APAGA A FILA. Se a funcao nao existir (rollback aplicado) ou
  // recusar, a faixa diz "indisponivel" e a lista segue como antes. Faixa some
  // e fila fica -- nunca o contrario.
  const carregarTriagem = useCallback(async () => {
    const { data, error } = await supabase.rpc("fila_pagamento_triagem_ler", {
      p_categoria: null,
      p_limite: 2000,
      // `null` quando nao ha recorte: o filtro e opcional no banco, e mandar
      // string vazia faria a funcao comparar com '' e devolver zero linha.
      p_importacao_id: importacaoFiltro || null,
    });
    if (error) {
      setTriagem([]);
      // O TEXTO CRU DO BANCO NAO VAZA PARA A TELA -- a mesma regra que a lista
      // principal ja segue logo acima. Alem de nao dizer nada a quem le,
      // repetir aqui a mensagem que a lista ja mostrou duplica o mesmo erro em
      // dois lugares. A unica distincao que interessa a quem opera e "a funcao
      // ainda nao existe no banco" (migration nao aplicada, ou rollback feito)
      // contra "falhou por outro motivo".
      const naoPublicada = /does not exist|could not find|schema cache/i.test(error.message || "");
      setTriagemErro(
        naoPublicada
          ? "Triagem ainda não publicada no banco."
          : "Triagem indisponível nesta carga.",
      );
      return;
    }
    setTriagemErro("");
    setTriagem(data || []);
  }, [importacaoFiltro]);

  useEffect(() => { carregarTriagem(); }, [carregarTriagem]);

  useEffect(() => { carregar(); }, [carregar]);

  // O filtro passou a ser pelo ESTADO da conciliacao. O motivo por nome
  // (NOME_REPETIDO / SEM_CADASTRO) continua aparecendo na linha, mas nao serve
  // mais de filtro: ele so existe para as linhas sem aluno, e a fila agora tem
  // linhas com aluno.
  const mapaTriagem = useMemo(() => indexarTriagem(triagem), [triagem]);
  const resumoTriagem = useMemo(() => resumoPorCategoria(triagem), [triagem]);
  const totalTriagem = useMemo(() => totalDaTriagem(triagem), [triagem]);
  const arquivosDaTriagem = useMemo(() => resumoPorArquivo(triagem), [triagem]);
  const recorte = useMemo(
    () => recorteDoArquivo(triagem, importacaoFiltro),
    [triagem, importacaoFiltro],
  );

  // Os dois filtros se acumulam: a faixa recorta por CATEGORIA (o que se pode
  // fazer com a pendencia) e o select por ESTADO da conciliacao (o que o motor
  // disse). Perguntas diferentes, nenhuma substitui a outra.
  const visiveis = useMemo(() => {
    const porEstado =
      filtro === "TODOS"
        ? linhas
        : linhas.filter((l) => (l.status_conciliacao || "SEM_ESTADO") === filtro);
    return filtrarPorCategoria(porEstado, mapaTriagem, categoria);
  }, [linhas, filtro, mapaTriagem, categoria]);

  // As pendencias que a lista principal nao mostra: decisao registrada e status
  // ainda pendente. Em producao sao 33 / R$ 83.203,30.
  const foraDaLista = useMemo(
    () => pendenciasSoNaTriagem(triagem, linhas),
    [triagem, linhas],
  );

  const porStatus = useMemo(() => contarPorStatus(linhas), [linhas]);
  const total = useMemo(
    () => visiveis.reduce((s, l) => s + Number(l.valor_pago || 0), 0),
    [visiveis],
  );

  function copiarNome(nome) {
    navigator.clipboard.writeText(nome || "").then(() => {
      setNomeCopiado(nome);
      setTimeout(() => setNomeCopiado(""), 1500);
    });
  }

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Pagamentos a conciliar</h1>
          <p style={S.sub}>
            Pagamento que entrou e <b>não baixou parcela</b> — falta o acordo, falta amarrar
            o boleto, a parcela já estava paga, ou há divergência. Também entra aqui o que
            nenhum identificador financeiro resolveu. <b>Nome não vincula</b>: aparece só
            como sugestão, e a decisão é sua. {AVISO_PROJECAO}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { carregar(); carregarTriagem(); }}
          style={S.btnGhost}
          disabled={carregando}
        >
          {carregando ? "Carregando…" : "Atualizar"}
        </button>
      </div>

      {/* DE QUE ARQUIVO VEIO. Quando a fila foi aberta a partir da conferencia
          "Por arquivo", diz qual arquivo e oferece a saida do recorte. Sem
          recorte, lista os arquivos de origem das pendencias -- o dado ja
          estava gravado na fila e ninguem via. */}
      {!triagemErro && recorte ? (
        <div style={faixaWrap}>
          <div style={faixaTopo}>
            <span style={faixaTitulo}>Arquivo</span>
            <span style={faixaResumo}>
              {recorte.arquivo_nome || "arquivo sem nome registrado"} ·{" "}
              {recorte.itens === 0
                ? "nenhuma pendência deste arquivo"
                : `${recorte.itens} pendências · ${moeda(recorte.valor)}`}
            </span>
            <button
              type="button"
              onClick={() => {
                // Tira SO o recorte e preserva o resto da URL: a tela pode ter
                // outros parametros, e limpar tudo seria perder estado alheio.
                const proximo = new URLSearchParams(params);
                proximo.delete("importacao");
                setParams(proximo, { replace: true });
              }}
              style={faixaLimpar}
            >
              Ver todos os arquivos ✕
            </button>
          </div>
        </div>
      ) : null}
      {!triagemErro && !recorte && arquivosDaTriagem.length > 1 ? (
        <div style={faixaWrap}>
          <div style={faixaTopo}>
            <span style={faixaTitulo}>Arquivos de origem</span>
            {arquivosDaTriagem.slice(0, 6).map((a) => (
              <span key={a.arquivo_nome} style={faixaResumo}>
                {a.arquivo_nome} · {a.itens}
              </span>
            ))}
            {arquivosDaTriagem.length > 6 ? (
              <span style={faixaResumo}>+{arquivosDaTriagem.length - 6}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* FAIXA DA TRIAGEM. Cada categoria e um botao de filtro: clicar recorta a
          lista abaixo. Mostra as quatro sempre, inclusive de contagem zero --
          esconder a vazia faria a pessoa achar que a categoria nao existe. */}
      {triagemErro ? (
        <div style={{ ...S.erroBox, background: "var(--rv-fundo-suave)", color: "var(--rv-texto-suave)", border: "1px solid var(--rv-borda)" }}>
          {triagemErro} A fila continua listada abaixo, sem a classificação.
        </div>
      ) : (
        <div style={faixaWrap}>
          <div style={faixaTopo}>
            <span style={faixaTitulo}>Triagem</span>
            <span style={faixaResumo}>
              {totalTriagem.quantidade} pendências · {moeda(totalTriagem.valor)}
            </span>
            {categoria !== "TODAS" ? (
              <button type="button" onClick={() => setCategoria("TODAS")} style={faixaLimpar}>
                Ver todas ✕
              </button>
            ) : null}
          </div>
          <div style={faixaCartoes}>
            {resumoTriagem.map((c) => {
              const ativo = categoria === c.categoria;
              return (
                <button
                  key={c.categoria}
                  type="button"
                  onClick={() => setCategoria(ativo ? "TODAS" : c.categoria)}
                  title={c.ajuda}
                  style={{
                    ...faixaCartao,
                    ...(tomDoCartao[c.tom] || {}),
                    ...(ativo ? faixaCartaoAtivo : {}),
                    opacity: c.quantidade === 0 ? 0.55 : 1,
                  }}
                >
                  <span style={faixaCartaoRotulo}>{c.rotulo}</span>
                  <span style={faixaCartaoNumero}>{c.quantidade}</span>
                  <span style={faixaCartaoValor}>{moeda(c.valor)}</span>
                  {c.etapa ? (
                    <span style={faixaCartaoEtapa}>etapa: {c.etapa}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {/* Os submotivos da categoria escolhida. Sem categoria escolhida a
              faixa fica curta de proposito: detalhe de tudo ao mesmo tempo nao
              e informacao, e parede. */}
          {categoria !== "TODAS" ? (
            <div style={faixaSubmotivos}>
              {(resumoTriagem.find((c) => c.categoria === categoria)?.submotivos || []).map((s) => (
                <span key={s.subcategoria} style={faixaSubmotivo}>
                  {rotuloSubcategoria(s.subcategoria)} · <b>{s.quantidade}</b> · {moeda(s.valor)}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )}

      <div style={S.barra}>
        <input
          type="month"
          value={mes}
          onChange={(e) => setMes(e.target.value)}
          style={{ ...S.select, opacity: todosOsMeses ? 0.5 : 1 }}
          disabled={todosOsMeses}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--rv-texto)" }}>
          <input
            type="checkbox"
            checked={todosOsMeses}
            onChange={(e) => setTodosOsMeses(e.target.checked)}
          />
          Toda a pendência, qualquer mês
        </label>
        <select value={filtro} onChange={(e) => setFiltro(e.target.value)} style={S.select}>
          <option value="TODOS">Todos ({linhas.length})</option>
          {Object.entries(STATUS_CONCILIACAO)
            .filter(([chave]) => chave !== "BAIXADO")
            .map(([chave, def]) => (
              <option key={chave} value={chave}>
                {def.rotulo} ({porStatus[chave] || 0})
              </option>
            ))}
          <option value="SEM_ESTADO">Anterior à regra ({porStatus.SEM_ESTADO || 0})</option>
        </select>
        <div style={S.contadores}>
          <span style={S.contadorAlunos}>{visiveis.length} pagamentos</span>
          <span style={S.contadorValor}>{moeda(total)}</span>
        </div>
      </div>

      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {/* "Tudo baixado" so pode ser dito quando NADA esta filtrado. Com um
          recorte ativo, lista vazia significa "nada NESTE recorte" -- dizer
          "tudo baixado" ali seria falso, e e o tipo de falso que faz a pessoa
          fechar a tela. */}
      {!carregando && visiveis.length === 0 ? (
        <p style={S.muted}>
          {categoria !== "TODAS" || filtro !== "TODOS"
            ? "Nenhum pagamento neste recorte. Limpe o filtro para ver a fila inteira."
            : "Nenhum pagamento pendente de conciliação neste mês. Tudo baixado."}
        </p>
      ) : null}

      <div style={S.cards}>
        {visiveis.map((l) => (
          <Linha
            key={l.pagamento_id}
            item={l}
            acao={acaoDaLinha(l, travas)}
            // A ACAO DECLARADA PELA TRIAGEM, para a linha poder oferece-la
            // (Etapa 2). Vem do mesmo indice que a faixa de categorias usa --
            // sem segunda consulta e sem classificar nada aqui.
            triagem={mapaTriagem.get(l.pagamento_id)}
            onRegistrar={() => setRegistrando(l)}
            aberto={abertoId === l.pagamento_id}
            onAbrir={() => setAbertoId(abertoId === l.pagamento_id ? null : l.pagamento_id)}
            onVinculado={carregar}
            onVerFicha={setFichaId}
            onCopiar={copiarNome}
            nomeCopiado={nomeCopiado}
          />
        ))}
      </div>

      {/* AS PENDENCIAS QUE A LISTA ACIMA NAO MOSTRA.
          `pagamentos_sem_aluno` exclui quem tem decisao registrada na fila, e
          `fluxo_pagamentos_incremental` usa o MESMO predicado -- entao estas
          nao aparecem na tela nem voltam para a rodada. Em producao sao 33
          (R$ 83.203,30) com status de conciliacao ainda pendente.
          Bloco SO DE LEITURA: nenhuma acao, porque o que falta aqui e
          conferencia, nao acao nova. O caminho e abrir a ficha. */}
      {foraDaLista.length > 0 && (categoria === "TODAS" || categoria === "CONFERENCIA_HUMANA") ? (
        <div style={foraWrap}>
          <div style={foraTopo}>
            <span style={foraTitulo}>
              {foraDaLista.length} com decisão registrada e ainda pendentes
            </span>
            <span style={foraValor}>
              {moeda(foraDaLista.reduce((s, l) => s + Number(l.valor_pago || 0), 0))}
            </span>
          </div>
          <p style={foraAjuda}>
            A fila já registrou uma decisão para estas, mas o estado da conciliação do
            pagamento continua pendente. Elas não aparecem na lista acima e a rodada
            horária também não as reprocessa — <b>só conferência resolve</b>. Nenhuma ação
            automática é oferecida aqui.
          </p>
          <div style={foraLinhas}>
            {foraDaLista.map((l) => (
              <div key={l.pagamento_id} style={foraLinha}>
                <span style={foraLinhaData}>{dataCurta(l.data_pagamento)}</span>
                <span style={foraLinhaValor}>{moeda(l.valor_pago)}</span>
                <span style={foraLinhaChip}>{l.decisao}</span>
                <span style={foraLinhaBoleto}>{l.boleto || "—"}</span>
                <span style={foraLinhaMotivo} title={l.motivo || ""}>
                  {rotuloSubcategoria(l.subcategoria)}
                </span>
                {l.aluno_id ? (
                  <button
                    type="button"
                    style={{ ...S.btnGhost, marginLeft: "auto", padding: "4px 10px", fontSize: 12 }}
                    onClick={() => setFichaId(l.aluno_id)}
                  >
                    Abrir ficha
                  </button>
                ) : (
                  <span style={{ ...foraLinhaChip, marginLeft: "auto" }}>sem aluno</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {registrando ? (
        <RegistrarAcordoAvista
          item={registrando}
          onFechar={() => setRegistrando(null)}
          onRegistrado={carregar}
        />
      ) : null}

      {fichaId && (
        <div style={S.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...S.modalFechar, marginLeft: "auto" }}
                onClick={() => setFichaId(null)}
              >
                Fechar ✕
              </button>
            </div>
            <div style={{ padding: "0 16px" }}>
              <DadosAcademicos aluno={{ id: fichaId }} />
            </div>
            <div style={S.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Linha({ item, acao, triagem, onRegistrar, aberto, onAbrir, onVinculado, onVerFicha, onCopiar, nomeCopiado }) {
  const [termo, setTermo] = useState("");
  const [resultados, setResultados] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState("");
  // null | "FEITO" | "REJEITAR"
  const [finalizando, setFinalizando] = useState(null);
  const [escolha, setEscolha] = useState("");
  const [observacao, setObservacao] = useState("");

  const repetido = item.motivo === "NOME_REPETIDO";
  const podeVincular = acao.acao === "VINCULAR_ALUNO";
  // sugestoes vem da fila (jsonb). Nunca sao aplicadas: so oferecidas.
  const sugestoes = Array.isArray(item.sugestoes) ? item.sugestoes.filter((x) => x && x.aluno_id) : [];

  async function buscar() {
    const t = termo.trim();
    if (t.length < 3) { setMsg("Digite ao menos 3 letras ou o CPF."); return; }
    setBuscando(true); setMsg("");
    const { data, error } = await supabase.rpc("buscar_aluno", { p_termo: t });
    if (error) setMsg("Erro na busca: " + error.message);
    setResultados(data || []);
    setBuscando(false);
  }

  async function vincular(alunoId, nomeAluno) {
    if (!window.confirm(
      `Vincular o pagamento de ${moeda(item.valor_pago)} (${dataCurta(item.data_pagamento)}) ao aluno ${nomeAluno}?`
    )) return;
    setSalvando(true); setMsg("");
    const { data, error } = await supabase.rpc("pagamento_vincular_aluno", {
      p_pagamento_id: item.pagamento_id,
      p_aluno_id: alunoId,
      p_observacao:
        `Fila de pagamentos sem vínculo. Boleto ${item.numero_parcela_completo || "(sem)"}. ` +
        `Motivo: ${item.motivo_financeiro || item.motivo}.`,
    });
    setSalvando(false);
    if (error) { setMsg("Erro: " + error.message); return; }
    if (!data?.ok) { setMsg("Não foi possível: " + (data?.motivo || "desconhecido")); return; }
    onVinculado();
  }

  // FEITO e REJEITAR sao decisoes de revisao, nao correcao financeira: o banco
  // so grava a decisao da fila e a auditoria com o estado anterior. Rejeitar,
  // em particular, NAO apaga nada e NAO desfaz o pagamento.
  async function finalizar() {
    const impede = finalizacaoInvalida({ acao: finalizando, escolha, observacao });
    if (impede) { setMsg(impede); return; }

    const aviso = finalizando === "REJEITAR" ? REJEITAR_AVISO : FEITO_AVISO;
    const verbo = finalizando === "REJEITAR" ? "Rejeitar" : "Concluir";
    if (!window.confirm(
      `${verbo} a pendência do pagamento de ${moeda(item.valor_pago)} (${dataCurta(item.data_pagamento)})? ${aviso}`
    )) return;

    setSalvando(true); setMsg("");
    const obs = observacao.trim() === "" ? null : observacao.trim();
    const { data, error } = finalizando === "REJEITAR"
      ? await supabase.rpc("conciliacao_rejeitar", {
          p_pagamento_id: item.pagamento_id, p_motivo: escolha, p_observacao: obs,
        })
      : await supabase.rpc("conciliacao_feito", {
          p_pagamento_id: item.pagamento_id, p_conclusao: escolha, p_observacao: obs,
        });
    setSalvando(false);
    if (error) { setMsg("Erro: " + error.message); return; }
    if (!data?.ok) { setMsg("Não foi possível: " + (data?.motivo || "desconhecido")); return; }
    setFinalizando(null); setEscolha(""); setObservacao("");
    onVinculado();
  }

  function abrirFinalizacao(acao) {
    setMsg("");
    setEscolha("");
    setFinalizando((v) => (v === acao ? null : acao));
  }

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <div style={S.cardHeadInfo}>
          <span style={S.cardNome}>{item.aluno_nome || "(sem nome no arquivo)"}</span>
          {item.aluno_nome ? (
            <button
              type="button"
              onClick={() => onCopiar && onCopiar(item.aluno_nome)}
              style={btnCopiarNome}
              title="Copiar o nome como veio no arquivo"
            >
              {nomeCopiado === item.aluno_nome ? "✓ Copiado" : "📋 Copiar"}
            </button>
          ) : null}
          <span style={S.cardCpf}>
            {dataCurta(item.data_pagamento)} · boleto {item.numero_parcela_completo || "(sem)"}
            {item.titulo_numero ? ` · título ${item.titulo_numero}` : ""}
            {item.matricula ? ` · matrícula ${item.matricula}` : ""}
            {item.arquivo_nome ? ` · ${item.arquivo_nome}` : ""}
          </span>
        </div>
        <div style={S.cardHeadDir}>
          <span style={seloEstado} title={acao.explica}>{acao.rotulo}</span>
          {podeVincular ? (
            <span style={repetido ? selo.repetido : selo.semCadastro}>
              {repetido ? `${item.candidatos} alunos com esse nome` : "sem cadastro na base"}
            </span>
          ) : null}
          <span style={S.contadorValor}>{moeda(item.valor_pago)}</span>
          <span style={S.cardCpf}>{item.operador_nome || "(sem operador)"}</span>
          {acao.acao === "REGISTRAR_ACORDO_AVISTA" ? (
            <button type="button" onClick={onRegistrar} style={S.btnGhost}>
              {ACOES_DA_FILA.REGISTRAR_ACORDO_AVISTA}
            </button>
          ) : podeVincular ? (
            <button type="button" onClick={onAbrir} style={S.btnGhost}>
              {aberto ? "Fechar" : ACOES_DA_FILA.VINCULAR_ALUNO}
            </button>
          ) : acao.carregando ? null : (
            // Sem acao manual para este ponto. A pendencia e de amarracao, de
            // estrutura do acordo, de rodada ou de revisao -- nenhuma delas se
            // resolve trocando o aluno, e oferecer "Vincular" aqui so daria a
            // chance de sobrescrever um vinculo correto. Enquanto o diagnostico
            // carrega, nada aqui: "sem acao manual" ainda nao e verdade.
            <span style={S.cardCpf} title={acao.explica}>
              {item.tem_aluno ? "aluno já identificado" : "sem ação manual"}
            </span>
          )}
          {podeEncerrarPendencia(item) ? (
            <>
              <button
                type="button"
                onClick={() => abrirFinalizacao("FEITO")}
                style={btnEncerrar}
                title={FEITO_AVISO}
              >
                {finalizando === "FEITO" ? "Fechar" : ACOES_DA_FILA.FEITO}
              </button>
              <button
                type="button"
                onClick={() => abrirFinalizacao("REJEITAR")}
                style={btnEncerrar}
                title={REJEITAR_AVISO}
              >
                {finalizando === "REJEITAR" ? "Fechar" : ACOES_DA_FILA.REJEITAR}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {finalizando ? (
        <div style={encerrarCaixa}>
          <div style={{ fontWeight: 700, color: "var(--rv-tinta)", fontSize: 13 }}>
            {finalizando === "REJEITAR" ? ACOES_DA_FILA.REJEITAR : ACOES_DA_FILA.FEITO}
          </div>
          <p style={{ ...S.muted, margin: "6px 0 10px" }}>
            {finalizando === "REJEITAR" ? REJEITAR_AVISO : FEITO_AVISO}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              value={escolha}
              onChange={(e) => setEscolha(e.target.value)}
              style={S.input}
              aria-label={finalizando === "REJEITAR" ? "Motivo da rejeição" : "Conclusão"}
            >
              <option value="">
                {finalizando === "REJEITAR" ? "Motivo da rejeição…" : "Conclusão…"}
              </option>
              {(finalizando === "REJEITAR" ? MOTIVOS_REJEICAO : CONCLUSOES_FEITO).map((o) => (
                <option key={o.valor} value={o.valor}>{o.rotulo}</option>
              ))}
            </select>
            <input
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder={
                finalizacaoInvalida({ acao: finalizando, escolha, observacao: "" })
                  && escolha ? "Observação (obrigatória)" : "Observação (opcional)"
              }
              style={S.input}
            />
            <button
              type="button"
              onClick={finalizar}
              disabled={salvando || !!finalizacaoInvalida({ acao: finalizando, escolha, observacao })}
              style={S.btnGhost}
            >
              {salvando ? "…" : finalizando === "REJEITAR" ? "Confirmar rejeição" : "Confirmar conclusão"}
            </button>
          </div>
        </div>
      ) : null}

      <div style={motivoBox}>
        <span style={motivoRotulo}>por que caiu aqui</span>
        {acao.trava ? (
          // O motor so sabe que o boleto nao achou parcela; a trava diz o que
          // falta de fato. O texto do motor fica como registro, em segundo plano.
          <span style={motivoTexto}>
            {acao.explica}
            <span style={{ display: "block", color: "var(--rv-texto-suave)", fontSize: 11.5 }}>
              motor: {item.motivo_financeiro || "—"}
            </span>
          </span>
        ) : (
          <span style={motivoTexto}>{item.motivo_financeiro || "—"}</span>
        )}
      </div>

      {/* CONFERENCIA MANUAL (23/09/2026). A gestao decidiu conferir os
          AGUARDANDO_ACORDO um a um em vez de reclassificar por rotina -- entao
          o que ela precisa olhar fica aqui, na propria linha: o acordo que o
          boleto aponta, as evidencias que existem e o saldo de hoje. Tudo
          leitura; nada aqui vincula, cria ou baixa. */}
      <div style={conferenciaBox}>
        <div style={conferenciaTopo}>
          <span style={motivoRotulo}>conferência</span>
          {item.acordo_identificado ? (
            <span style={conferenciaAcordo}>acordo {item.acordo_identificado}</span>
          ) : (
            <span style={S.cardCpf}>boleto fora do padrão: sem acordo identificável</span>
          )}
          <span style={{ flex: 1 }} />
          <span style={S.cardCpf}>
            saldo atual{" "}
            <b style={{ color: "var(--rv-tinta)" }}>
              {item.saldo_total == null ? "—" : moeda(item.saldo_total)}
            </b>
            {item.saldo_vencido != null && Number(item.saldo_vencido) > 0
              ? ` · vencido ${moeda(item.saldo_vencido)}`
              : ""}
          </span>
        </div>
        <div style={conferenciaGrade}>
          {evidenciasDaLinha(item).map((e) => (
            <div key={e.chave} style={conferenciaItem}>
              <span style={conferenciaRotulo}>{e.rotulo}</span>
              <span style={e.alerta ? conferenciaValorAlerta : conferenciaValor}>{e.valor}</span>
            </div>
          ))}
        </div>
      </div>

      {aberto && podeVincular ? (
        <div style={{ padding: "14px 16px" }}>
          {sugestoes.length > 0 ? (
            <div style={sugestaoCaixa}>
              <div style={sugestaoTopo}>
                {sugestoes.length === 1 ? "1 sugestão por nome" : `${sugestoes.length} sugestões por nome`}
                <span style={sugestaoAviso}>
                  nome não é prova — confira a ficha antes de vincular
                </span>
              </div>
              {sugestoes.map((sg) => (
                <div key={sg.aluno_id} style={resultadoLinha}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: "var(--rv-tinta)", fontSize: 13.5 }}>{sg.nome}</div>
                    <div style={S.cardCpf}>
                      CPF {sg.cpf_mascarado || "-"}
                      {sg.matricula ? ` · matrícula ${sg.matricula}` : ""}
                      {sg.tem_acordo_ativo ? " · tem acordo ATIVO" : " · sem acordo ativo"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => onVerFicha && onVerFicha(sg.aluno_id)}
                      style={{ ...S.btnGhost, background: "var(--rv-roxo-fundo)", color: "var(--rv-roxo-texto)" }}
                      title="Conferir a ficha antes de vincular, sem sair da fila"
                    >
                      Ver ficha
                    </button>
                    <button
                      type="button"
                      onClick={() => vincular(sg.aluno_id, sg.nome)}
                      disabled={salvando}
                      style={S.btnGhost}
                    >
                      {salvando ? "…" : "Vincular"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") buscar(); }}
              placeholder="Buscar aluno por nome ou CPF"
              style={S.input}
            />
            <button type="button" onClick={buscar} style={S.btnGhost} disabled={buscando}>
              {buscando ? "Buscando…" : "Buscar"}
            </button>
            {item.motivo === "SEM_CADASTRO" ? (
              <CadastroNovoAluno
                onSucesso={(novo) => { if (novo?.id) vincular(novo.id, novo.nome || "novo cadastro"); }}
              />
            ) : null}
          </div>

          {msg ? <p style={{ ...S.muted, marginTop: 10 }}>{msg}</p> : null}

          {resultados ? (
            resultados.length === 0 ? (
              <p style={{ ...S.muted, marginTop: 10 }}>
                Nenhum aluno encontrado com esse termo.
              </p>
            ) : (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {resultados.slice(0, 12).map((a) => (
                  <div key={a.id} style={resultadoLinha}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: "var(--rv-tinta)", fontSize: 13.5 }}>{a.nome}</div>
                      <div style={S.cardCpf}>
                        CPF {a.cpf || "-"}
                        {a.responsavel_atual_nome ? ` · ${a.responsavel_atual_nome}` : " · sem responsável"}
                        {a.status_atual ? ` · ${a.status_atual}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => onVerFicha && onVerFicha(a.id)}
                        style={{ ...S.btnGhost, background: "var(--rv-roxo-fundo)", color: "var(--rv-roxo-texto)" }}
                        title="Conferir a ficha antes de vincular, sem sair da fila"
                      >
                        Ver ficha
                      </button>
                      <button
                        type="button"
                        onClick={() => vincular(a.id, a.nome)}
                        disabled={salvando}
                        style={S.btnGhost}
                      >
                        {salvando ? "…" : "Vincular"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : null}
        </div>
      ) : null}

      {/* ENCAMINHAMENTO (26/10/2026, Etapa 2). Aparece SO em CONFERIR_E_ENCERRAR
          -- a unica acao desta etapa -- e abre a conferencia antes de qualquer
          confirmacao. Nao da baixa, nao quita, nao vincula aluno, nao reatribui
          caso e nao altera valor. A busca manual de aluno acima continua sendo
          o unico caminho de vinculo, como era antes desta etapa. */}
      <EncaminharPendencia triagem={triagem} moeda={moeda} onConcluido={onVinculado} />
    </div>
  );
}

const btnEncerrar = {
  border: "1px solid var(--rv-borda)",
  background: "transparent",
  color: "var(--rv-texto-suave)",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};
const conferenciaBox = {
  margin: "8px 0 0", padding: "10px 12px", borderRadius: 10,
  background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda-suave)",
};
const conferenciaTopo = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 };
const conferenciaAcordo = {
  fontSize: 12, fontWeight: 800, color: "var(--rv-roxo-texto)", background: "var(--rv-roxo-fundo)",
  border: "1px solid var(--rv-roxo-borda)", borderRadius: 999, padding: "2px 10px",
};
const conferenciaGrade = {
  display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "6px 16px",
};
const conferenciaItem = { display: "flex", flexDirection: "column", gap: 1 };
const conferenciaRotulo = {
  fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em",
  color: "var(--rv-texto-fraco)",
};
const conferenciaValor = { fontSize: 12.5, color: "var(--rv-texto-forte)" };
const conferenciaValorAlerta = { fontSize: 12.5, color: "var(--rv-vermelho-texto)", fontWeight: 700 };

const encerrarCaixa = {
  padding: "12px 16px",
  borderTop: "1px solid var(--rv-borda)",
  background: "var(--rv-fundo-suave)",
};
const motivoBox = {
  display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
  padding: "8px 16px", borderTop: "1px solid var(--rv-borda)", background: "var(--rv-fundo-cartao)",
};
const motivoRotulo = {
  fontSize: 10.5, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase",
  color: "var(--rv-texto-suave)", whiteSpace: "nowrap",
};
const motivoTexto = { fontSize: 12.5, color: "var(--rv-texto)", minWidth: 0 };
const sugestaoCaixa = {
  border: "1px solid var(--rv-ambar-borda)", background: "var(--rv-ambar-fundo)",
  borderRadius: 10, padding: "10px 12px", marginBottom: 12,
  display: "flex", flexDirection: "column", gap: 8,
};
const sugestaoTopo = {
  display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
  fontSize: 12.5, fontWeight: 800, color: "var(--rv-ambar-texto)",
};
const sugestaoAviso = { fontWeight: 600, fontSize: 11.5, color: "var(--rv-ambar-texto)", opacity: 0.85 };
const btnCopiarNome = { background: "var(--rv-superficie)", color: "var(--rv-texto)", border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "3px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" };
const selo = {
  repetido: { fontSize: 12, fontWeight: 800, color: "var(--rv-ambar-texto)", background: "var(--rv-ambar-fundo)", border: "1px solid var(--rv-ambar-borda)", borderRadius: 999, padding: "4px 12px" },
  semCadastro: { fontSize: 12, fontWeight: 800, color: "var(--rv-vermelho-texto)", background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", borderRadius: 999, padding: "4px 12px" },
};
// Selo do estado da conciliacao. Cor por papel (nunca hex inline): roxo e o
// neutro informativo da casa, e o estado nao e alerta -- alerta e o selo de
// nome, que so aparece quando falta aluno.
const seloEstado = {
  fontSize: 12, fontWeight: 800, color: "var(--rv-roxo-texto)",
  background: "var(--rv-roxo-fundo)", border: "1px solid var(--rv-borda-forte)",
  borderRadius: 999, padding: "4px 12px", whiteSpace: "nowrap",
};
const resultadoLinha = {
  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
  border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "10px 12px", background: "var(--rv-fundo-cartao)",
};

// ---------------------------------------------------------------------------
// ESTILOS DA FAIXA DE TRIAGEM. Cor por PAPEL, nunca hex inline -- e o que faz a
// tela funcionar nos dois temas. O tom de cada categoria diz o que ela pede:
// verde = da para agir, azul = informativo, ambar = parado esperando decisao,
// vermelho = divergencia.
// ---------------------------------------------------------------------------
const faixaWrap = {
  border: "1px solid var(--rv-borda)", borderRadius: 12, padding: 12,
  background: "var(--rv-fundo-cartao)", marginBottom: 14,
};
const faixaTopo = { display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" };
const faixaTitulo = { fontSize: 13, fontWeight: 800, color: "var(--rv-texto)" };
const faixaResumo = { fontSize: 12.5, fontWeight: 700, color: "var(--rv-texto-suave)" };
const faixaLimpar = {
  marginLeft: "auto", fontSize: 12, fontWeight: 700, cursor: "pointer",
  background: "transparent", color: "var(--rv-texto-suave)",
  border: "1px solid var(--rv-borda)", borderRadius: 999, padding: "3px 10px",
};
const faixaCartoes = {
  display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10,
};
const faixaCartao = {
  display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start",
  textAlign: "left", cursor: "pointer", padding: "9px 12px",
  border: "1px solid var(--rv-borda)", borderRadius: 10,
  background: "var(--rv-fundo-suave)", color: "var(--rv-texto)",
};
const faixaCartaoAtivo = { borderColor: "var(--rv-borda-forte)", boxShadow: "inset 0 0 0 1px var(--rv-borda-forte)" };
const faixaCartaoRotulo = { fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.2 };
const faixaCartaoNumero = { fontSize: 20, fontWeight: 800, lineHeight: 1.1 };
const faixaCartaoValor = { fontSize: 12, fontWeight: 700, opacity: 0.85 };
const faixaCartaoEtapa = { fontSize: 10.5, fontWeight: 700, opacity: 0.75, fontFamily: "ui-monospace, monospace" };
const tomDoCartao = {
  verde: { background: "var(--rv-verde-ok-fundo)", color: "var(--rv-verde-ok-texto)", borderColor: "var(--rv-verde-ok-borda)" },
  azul: { background: "var(--rv-roxo-fundo)", color: "var(--rv-roxo-texto)" },
  ambar: { background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)", borderColor: "var(--rv-ambar-borda)" },
  vermelho: { background: "var(--rv-vermelho-fundo)", color: "var(--rv-vermelho-texto)", borderColor: "var(--rv-vermelho-borda)" },
};
const faixaSubmotivos = { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 };
const faixaSubmotivo = {
  fontSize: 11.5, fontWeight: 600, color: "var(--rv-texto)",
  background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda)",
  borderRadius: 999, padding: "3px 10px",
};

// Bloco das pendencias que a lista principal nao mostra. Vermelho porque e
// divergencia, e sem nenhum controle de acao: so leitura e a ficha.
const foraWrap = {
  border: "1px solid var(--rv-vermelho-borda)", borderRadius: 12, padding: 12,
  background: "var(--rv-vermelho-fundo)", marginTop: 16,
};
const foraTopo = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
const foraTitulo = { fontSize: 13, fontWeight: 800, color: "var(--rv-vermelho-texto)" };
const foraValor = { marginLeft: "auto", fontSize: 13, fontWeight: 800, color: "var(--rv-vermelho-texto)" };
const foraAjuda = { fontSize: 12.5, lineHeight: 1.5, color: "var(--rv-vermelho-texto)", margin: "8px 0 10px" };
const foraLinhas = { display: "flex", flexDirection: "column", gap: 6 };
const foraLinha = {
  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
  background: "var(--rv-fundo-cartao)", border: "1px solid var(--rv-borda)",
  borderRadius: 10, padding: "7px 10px",
};
const foraLinhaData = { fontSize: 12, fontWeight: 700, color: "var(--rv-texto-suave)" };
const foraLinhaValor = { fontSize: 13, fontWeight: 800, color: "var(--rv-texto)" };
const foraLinhaChip = {
  fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "2px 9px",
  background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda)", color: "var(--rv-texto)",
  whiteSpace: "nowrap",
};
const foraLinhaBoleto = { fontSize: 11.5, fontFamily: "ui-monospace, monospace", color: "var(--rv-texto-suave)" };
const foraLinhaMotivo = { fontSize: 12, fontWeight: 600, color: "var(--rv-texto)" };
