import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../services/supabase";
import ResolverEmConfirmacao from "../components/ResolverEmConfirmacao";
import Aluno from "./Aluno";
import { modalBox as modalBoxBase } from "../ui/cards";
import { podeGerirFinanceiro } from "../utils/operadores";
import { S, moeda, num, dataCurta } from "../components/situacoesDaSafraFormato";

// A politica de atualizacao exige DD/MM/AAAA HH:mm: so a data esconderia se a
// fotografia e de agora ou de 23 horas atras.
const dataHora = (v) =>
  v ? new Date(v).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";

// FILA UNICA DE CONFIRMACAO — a tela de TRATAMENTO das pendencias.
//
// A Efetividade responde "quanto esta pendente e por que"; aqui se trata. Cada
// valor que aparece como pendente lá chega aqui como REGISTRO INDIVIDUAL:
// aluno, CPF, titulo, safra, valor, motivo, situacao atual, evidencia
// disponivel, responsavel, data de entrada na pendencia e a acao necessaria.
//
// NAO E FILA PARALELA. Esta tela nao tem motor proprio, nao tem tabela propria
// e nao decide nada: ela LE `carteira_pendencias_itens` e, para resolver,
// embute o fluxo que ja existe. Em `Em confirmacao de pagamento` quem resolve e
// `ResolverEmConfirmacao` — o MESMO componente que ja vive na fila do extrato e
// na ficha do aluno, chamando as MESMAS RPCs da Conferencia Prime
// (`prime_conferencia_vincular` / `_seguir_pagamento` / `_rejeitar`), com motivo
// obrigatorio, as mesmas travas e a mesma auditoria. O selo "Aguardando
// confirmacao de pagamento", a Fila Operacional e a Conferencia Prime seguem
// funcionando como antes; nada aqui duplica aquele mecanismo.
//
// SUBMOTIVO SEM ACAO SEGURA NAO GANHA BOTAO. `carteira_pendencia_acao` diz, em
// SQL, qual acao a regra existente permite. Hoje so `em_confirmacao` tem
// caminho por caso; os outros quatro aparecem com motivo e evidencia, marcados
// como "sem acao automatica segura", e a tela oferece apenas abrir a ficha do
// aluno. Criar aqui uma acao generica que edite valor ou status final seria
// atuar fora da origem do dado, sem historico e sem auditoria — e e exatamente
// o que nao se pode fazer.
//
// DEPOIS DA RESOLUCAO (politica de 08/10/2026). Resolvido um caso, a linha sai
// da lista NA HORA -- com base na resposta da propria acao, que diz o que ainda
// esta em confirmacao naquele titulo -- e a tela SOLICITA a reconstrucao da
// fotografia. Nao releia a foto aqui: ela ainda nao foi reconstruida, e reler
// traria o caso resolvido de volta. Era o que acontecia antes desta politica.
//
// A FICHA ABRE AQUI, EMBUTIDA (correcao de 08/10/2026). Antes o nome do aluno
// nao era controle nenhum -- clicar nele nao fazia nada -- e o unico caminho
// era um botao secundario que NAVEGAVA para `/aluno`. Navegar tira a pessoa da
// fila, e `/aluno` monta a lista de alunos com a ficha abaixo dela, sem rolar
// ate ela (`abrirAlunoPorId` nao rola, ao contrario de `abrirAluno`): a ficha
// tecnicamente "abria" e na pratica nao aparecia na tela. Agora o aluno e
// clicavel e a ficha abre NA PROPRIA FILA, pelo modo embutido que a casa ja
// usa em Fora da Cobranca, Confirmacoes sem valor e Casos sem valor
// (`<Aluno fichaEmbedId={id} />`): e a MESMA ficha, com as mesmas abas, as
// mesmas RPCs e as mesmas travas -- nao ha segunda ficha. Fechar o modal devolve
// a fila no mesmo motivo e na mesma pagina, e rele os dados (o que foi resolvido
// agora continua fora da lista, ver `resolvidos`).
//
// UM TITULO RESOLVIDO NAO ESPERA OS IRMAOS (correcao de 08/10/2026).
// `ResolverEmConfirmacao` avisa quem o chamou com TUDO o que ainda esta em
// confirmacao DAQUELE ALUNO -- nao daquele titulo. A fila lia essa lista como
// se fosse do titulo da linha e, com qualquer outro titulo do mesmo aluno
// pendente, recusava-se a tirar a linha e dizia "ainda ha item em confirmacao
// neste titulo". Era falso: a decisao JA tinha sido executada na origem pela
// RPC da Conferencia Prime. Em producao isso atinge 81 dos 92 casos
// resolviveis (um aluno chega a ter 12 titulos em confirmacao), ou seja: na
// quase totalidade dos casos o botao funcionava e a tela dizia que nao. Agora a
// fila filtra a resposta pelo `titulo_id` da linha antes de decidir.
//
// LE FOTOGRAFIA (ajuste de 07/10/2026). A contagem vem de
// `carteira_efetividade_ler` e os itens de `carteira_pendencias_itens_ler`, que
// e uma leitura indexada da tabela de fotografia. A consulta viva de 2026/1
// passa por `carteira_2026_1_classificar`, medida em ~21 s em producao, e o
// teto do papel `authenticated` e 8 s — a fila nao podia depender dela.
//
// CONSEQUENCIA QUE A TELA DIZ: resolver um caso o resolve na origem na hora (as
// RPCs da Conferencia Prime sao as mesmas) e o retira desta LISTA na hora. A
// CONTAGEM por motivo vem da fotografia e acompanha na proxima reconstrucao --
// solicitada automaticamente a cada resolucao, sem esperar a rotina das :40. O
// rodape declara a data da fotografia e avisa quando ha mudanca posterior a ela,
// para ninguem ler a lista como estado ao vivo.

const SAFRAS = [
  { chave: "2024",   ano: "2024", semestre: null, rotulo: "2024" },
  { chave: "2025",   ano: "2025", semestre: null, rotulo: "2025" },
  { chave: "2026/1", ano: "2026", semestre: "1",  rotulo: "2026/1" },
];

const POR_PAGINA = 50;

const soDigitos = (v) => String(v || "").replace(/\D/g, "");
// CPF mascarado só para leitura; a busca e a identificacao usam o valor cru.
const cpf = (v) => {
  const d = soDigitos(v);
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : (v || "—");
};

export default function FilaUnicaConfirmacao() {
  const navegar = useNavigate();
  const [params, setParams] = useSearchParams();

  // A safra e o motivo vem da URL: e assim que a Efetividade "entrega" o caso
  // aqui, e e o que faz o link ser compartilhavel e o botao voltar funcionar.
  // A URL manda sempre: e assim que a Efetividade entrega um caso aqui, e e o
  // que faz o link ser compartilhavel. `null` quando a URL nao nomeia safra --
  // ai quem decide e `safraPadrao`, abaixo.
  const safraDaUrl = useMemo(() => {
    const ano = params.get("ano");
    const semestre = params.get("semestre");
    return SAFRAS.find((s) => s.ano === ano && (s.semestre || null) === (semestre || null)) || null;
  }, [params]);
  const motivoUrl = params.get("motivo") || null;

  const [resumo, setResumo] = useState(null);
  const [erroResumo, setErroResumo] = useState("");
  const [itens, setItens] = useState(null);
  const [erroItens, setErroItens] = useState("");
  const [carregandoItens, setCarregandoItens] = useState(false);
  const [pagina, setPagina] = useState(0);
  // Incrementado a cada resolucao e a cada "Atualizar dados": e a dependencia
  // que faz as duas consultas refazerem sem reload da aplicacao.
  const [recarga, setRecarga] = useState(0);
  // RESOLVIDOS NESTA SESSAO DA TELA. A fotografia so sera reconstruida pelo
  // dreno, fora desta requisicao; ate la a lista lida continua trazendo o caso
  // que acabou de ser resolvido na origem. Guardar o `titulo_id` aqui permite
  // retirar a linha NA HORA, usando a resposta da propria acao -- sem inventar
  // numero e sem reler a foto velha (reler a traria de volta).
  const [resolvidos, setResolvidos] = useState(() => new Set());
  const [avisoResolucao, setAvisoResolucao] = useState("");
  const [pedindoAtualizacao, setPedindoAtualizacao] = useState(false);
  // Ficha embutida: guarda o aluno cuja ficha esta aberta sobre a fila.
  const [fichaId, setFichaId] = useState(null);
  // Quantos titulos de cada safra tem caminho de resolucao por caso. Serve para
  // a ausencia de botao ser LEGIVEL: hoje `em_confirmacao` so existe em 2024 e
  // 2025, e quem cai em 2026/1 (a safra padrao) ve tres motivos sem acao e nao
  // tem como saber que os resolviveis estao em outra safra. O numero vem da
  // MESMA fotografia por motivo -- nenhuma contagem nova.
  const [resolviveisPorSafra, setResolviveisPorSafra] = useState({});
  // SO A GESTAO FINANCEIRA DECIDE -- a MESMA regra que a ficha do aluno aplica
  // (`FinanceiroAluno`: `podeDecidir={podeGerirFinanceiro(email)}`). Nao e regra
  // nova nem trava nova: as RPCs da Conferencia Prime ja recusam quem nao pode,
  // e isto so evita oferecer um botao que vai dar erro. Para os demais, o
  // proprio componente diz onde a decisao e tomada.
  const [emailLogado, setEmailLogado] = useState(null);
  useEffect(() => {
    let ativo = true;
    supabase.auth.getUser().then(({ data }) => {
      if (ativo) setEmailLogado(data?.user?.email || "");
    });
    return () => { ativo = false; };
  }, []);
  const podeDecidir = podeGerirFinanceiro(emailLogado || "");

  // ENTRAR ONDE HA O QUE FAZER (correcao de 08/10/2026).
  //
  // Amanda, 08/10/2026: "fila unica de confirmacao nao tem um botao". Tinha
  // causa: a tela abria SEMPRE em 2026/1 -- a safra corrente -- e em 2026/1
  // nenhum motivo tem resolucao por caso (convertido_origem_comprovada,
  // em_validacao e ajuste_academico sao todos SEM_ACAO_AUTOMATICA_SEGURA).
  // Quem entrava pelo menu caia, portanto, na unica safra onde botao de decisao
  // nao existe, e a tela parecia quebrada.
  //
  // A entrada passa a ser DERIVADA DO DADO: a safra com mais titulos de
  // resolucao por caso, pelo catalogo em SQL (`carteira_pendencia_acao`). Nao e
  // regra nova e nao e numero escrito aqui -- se amanha 2026/1 ganhar um motivo
  // resolvivel, a tela abre nele sozinha; se nenhuma safra tiver, volta a abrir
  // na corrente, porque ai nao ha onde entrar melhor.
  //
  // A URL continua tendo prioridade absoluta: link da Efetividade, link
  // compartilhado e o botao voltar levam exatamente onde apontam, mesmo que
  // seja uma safra sem botao.
  const safraPadrao = useMemo(() => {
    const comAcao = SAFRAS
      .filter((s) => Number(resolviveisPorSafra[s.chave] || 0) > 0)
      .sort((a, b) => Number(resolviveisPorSafra[b.chave]) - Number(resolviveisPorSafra[a.chave]));
    return comAcao[0] || SAFRAS[2];
  }, [resolviveisPorSafra]);
  // Enquanto a URL nao nomeia safra E as contagens nao chegaram, NAO ha safra:
  // as duas consultas esperam. Isso nao e zelo estetico -- `carteira_pendencias
  // _itens_ler` em 2026/1 cai na consulta ao vivo (~21 s, teto de 8 s), e
  // buscar 2026/1 para trocar logo depois gastaria justamente a mais caras das
  // consultas para jogar o resultado fora.
  const contagensProntas = Object.keys(resolviveisPorSafra).length > 0;
  const safraUrl = safraDaUrl || (contagensProntas ? safraPadrao : null);

  // `useMemo` e não `resumo?.motivos || []` solto: o array literal do fallback
  // nasceria novo a cada render e faria o `useMemo` do motivo recalcular
  // sempre (a catraca do lint aponta exatamente isso).
  const motivos = useMemo(() => resumo?.motivos || [], [resumo]);
  const semFotografia = Boolean(resumo?.sem_snapshot);
  // Motivo efetivo: o da URL, se existir nesta safra. Sem URL, o que TEM
  // resolucao por caso -- entrar na safra certa e cair no motivo sem botao
  // (`pago_sem_lastro` tem 289 titulos em 2025 e nenhuma acao) deixaria a tela
  // igualmente sem botao. Nenhum motivo resolvivel: o de maior valor, como antes.
  const motivo = useMemo(() => {
    if (motivoUrl && motivos.some((m) => m.chave === motivoUrl)) return motivoUrl;
    const comAcao = motivos.find((m) => m.acao === "CONFERENCIA_PRIME");
    return (comAcao || motivos[0])?.chave || null;
  }, [motivoUrl, motivos]);
  const motivoAtual = motivos.find((m) => m.chave === motivo) || null;

  // A lista exibida e a da fotografia MENOS o que foi resolvido agora. A
  // fotografia nao e reescrita pela tela: `itens` continua sendo o que o banco
  // devolveu, e `itensVisiveis` e a leitura honesta dele neste instante.
  const itensVisiveis = useMemo(
    () => (itens || []).filter((i) => !resolvidos.has(i.titulo_id)),
    [itens, resolvidos]);
  // Quantos desta pagina sairam por resolucao agora -- o contador do motivo vem
  // da fotografia e ficaria maior que a lista sem este desconto.
  const resolvidosNaPagina = (itens || []).length - itensVisiveis.length;

  // ---------------------------------------------------------------- resumo
  useEffect(() => {
    let ativo = true;
    if (!safraUrl) return undefined;
    (async () => {
      setErroResumo("");
      const { data, error } = await supabase.rpc("carteira_efetividade_ler",
        { p_bloco: "pendencias_por_motivo", p_ano: safraUrl.ano, p_semestre: safraUrl.semestre });
      if (!ativo) return;
      if (error) { setErroResumo(error.message || "falha ao consultar"); setResumo(null); }
      else setResumo(data || null);
    })();
    return () => { ativo = false; };
  }, [safraUrl, recarga]);

  // ----------------------------------------- resolviveis por safra (rotulo)
  // Tres leituras indexadas da fotografia (a mesma que o resumo usa), uma por
  // safra. Nao chama nada pesado e nao calcula nada: le `acao`, que o catalogo
  // em SQL (`carteira_pendencia_acao`) ja declarou por motivo.
  useEffect(() => {
    let ativo = true;
    (async () => {
      const entradas = await Promise.all(SAFRAS.map(async (s) => {
        const { data, error } = await supabase.rpc("carteira_efetividade_ler",
          { p_bloco: "pendencias_por_motivo", p_ano: s.ano, p_semestre: s.semestre });
        if (error) return [s.chave, null];
        const total = (data?.motivos || [])
          .filter((m) => m.acao === "CONFERENCIA_PRIME")
          .reduce((acc, m) => acc + Number(m.titulos || 0), 0);
        return [s.chave, total];
      }));
      if (ativo) setResolviveisPorSafra(Object.fromEntries(entradas));
    })();
    return () => { ativo = false; };
  }, [recarga]);

  // ----------------------------------------------------------------- itens
  const buscarItens = useCallback(async () => {
    if (!motivo || !safraUrl) return;
    setCarregandoItens(true);
    setErroItens("");
    const { data, error } = await supabase.rpc("carteira_pendencias_itens_ler", {
      p_motivo: motivo, p_ano: safraUrl.ano, p_semestre: safraUrl.semestre,
      p_limite: POR_PAGINA, p_offset: pagina * POR_PAGINA,
    });
    if (error) { setErroItens(error.message || "falha ao consultar"); setItens([]); }
    else setItens(data || []);
    setCarregandoItens(false);
  }, [motivo, safraUrl, pagina]);

  useEffect(() => {
    let ativo = true;
    (async () => { if (ativo) await buscarItens(); })();
    return () => { ativo = false; };
  }, [buscarItens, recarga]);

  // RESOLVIDO UM CASO. Tres coisas, nesta ordem, e nenhuma delas e reler a
  // fotografia:
  //
  //   1. RETIRA a linha da fila agora. `ResolverEmConfirmacao` devolve o que
  //      AINDA esta em confirmacao para aquele titulo; lista vazia significa que
  //      a pendencia daquele titulo acabou -- isso vem da resposta da acao, nao
  //      de suposicao nossa. Se ainda houver item, o caso continua pendente e a
  //      linha FICA.
  //   2. SOLICITA a reconstrucao da fotografia afetada -- barato, volta na hora,
  //      e o dreno reconstroi fora desta requisicao.
  //   3. AVISA que a contagem por motivo ainda e a da foto.
  //
  // POR QUE NAO `setRecarga` AQUI. Recarregar releria a MESMA fotografia, que
  // ainda nao foi reconstruida -- e o caso resolvido voltaria para a lista. Era
  // exatamente o que acontecia antes desta mudanca.
  // "ATUALIZAR DADOS" -- mesma politica da Efetividade: primeiro RELE a
  // fotografia; so pede reconstrucao se a leitura disser que ha mudanca
  // posterior a ela. Nunca chama a funcao pesada (~21 s em 2026/1, teto 8 s).
  async function atualizarDados() {
    setAvisoResolucao("");
    setRecarga((v) => v + 1);
    if (!resumo?.snapshot?.atualizacao_pendente && !resumo?.sem_snapshot) return;
    setPedindoAtualizacao(true);
    const { data: pedido, error } = await supabase.rpc("carteira_efetividade_solicitar_atualizacao");
    setPedindoAtualizacao(false);
    setAvisoResolucao(error
      ? "Não foi possível registrar o pedido de atualização (" + (error.message || "falha")
        + "). A rotina das :40 continua valendo."
      : "Atualização solicitada — " + (pedido?.previsao || "sai na próxima reconstrução") + ".");
  }

  async function aoResolver(titulo_id, aindaEmConfirmacao) {
    // `aindaEmConfirmacao` e a resposta da propria acao, mas ela cobre o ALUNO
    // inteiro -- e um aluno pode ter varios titulos em confirmacao (em producao,
    // ate 12). A linha so fica se o titulo DESTA linha continuar pendente;
    // titulo de irmao nao e motivo para a fila negar o que a origem ja fez.
    const aindaNesteTitulo = (Array.isArray(aindaEmConfirmacao) ? aindaEmConfirmacao : [])
      .filter((x) => String(x.titulo_id) === String(titulo_id));
    if (aindaNesteTitulo.length > 0) {
      setAvisoResolucao("Ainda há item em confirmação neste título — a linha continua na fila.");
      return;
    }
    setResolvidos((atual) => {
      const proximo = new Set(atual);
      proximo.add(titulo_id);
      return proximo;
    });
    const { error } = await supabase.rpc("carteira_efetividade_solicitar_atualizacao");
    setAvisoResolucao(error
      ? "Caso resolvido na origem e retirado desta lista. Não foi possível registrar o pedido de "
        + "reconstrução (" + (error.message || "falha") + "); a rotina das :40 reconcilia."
      : "Caso resolvido na origem e retirado desta lista. Reconstrução da fotografia solicitada — "
        + "a contagem por motivo acima ainda é a da fotografia até ela sair.");
  }

  // Fechar a ficha rele a fila. Reler e seguro aqui: `resolvidos` continua
  // filtrando o que foi resolvido nesta sessao da tela, entao nada ressuscita.
  function fecharFicha() {
    setFichaId(null);
    setRecarga((v) => v + 1);
  }

  function trocarSafra(s) {
    // Trocar de safra zera a pagina e solta o motivo: nem todo motivo existe em
    // toda safra, e manter um motivo inexistente deixaria a fila vazia sem
    // dizer por que.
    setPagina(0);
    const q = { ano: s.ano, ...(s.semestre ? { semestre: s.semestre } : {}) };
    setParams(new URLSearchParams(q));
  }

  function trocarMotivo(chave) {
    setPagina(0);
    if (!safraUrl) return;
    const q = { ano: safraUrl.ano, ...(safraUrl.semestre ? { semestre: safraUrl.semestre } : {}), motivo: chave };
    setParams(new URLSearchParams(q));
  }

  const temAcao = motivoAtual?.acao === "CONFERENCIA_PRIME";

  return (
    <div style={E.pagina}>
      <header style={E.topo}>
        <div>
          <h1 style={E.h1}>Fila Única de Confirmação</h1>
          <p style={E.sub}>
            Onde as pendências da Efetividade são tratadas, caso a caso. Cada linha é um título real, com o
            motivo, a evidência e o responsável. A resolução acontece pelo fluxo oficial de cada tipo — esta
            tela não corrige valor nem status por fora.
          </p>
        </div>
        <div style={E.acoesTopo}>
          <button type="button" style={E.botaoNeutro} onClick={atualizarDados} disabled={pedindoAtualizacao}>
            {pedindoAtualizacao ? "Solicitando…" : "Atualizar dados"}
          </button>
          <button type="button" style={E.botaoNeutro} onClick={() => navegar("/carteira-2026-1")}>
            ← Efetividade
          </button>
        </div>
      </header>

      <div style={E.filtros}>
        <div style={E.filtroBloco}>
          <span style={E.filtroRotulo}>Safra</span>
          <div style={E.grupo} role="group" aria-label="Safra">
            {SAFRAS.map((s) => (
              <button key={s.chave} type="button" onClick={() => trocarSafra(s)}
                      aria-pressed={s.chave === safraUrl?.chave}
                      title={resolviveisPorSafra[s.chave] > 0
                        ? resolviveisPorSafra[s.chave] + " título(s) com resolução por caso nesta safra"
                        : "Nesta safra nenhum motivo tem resolução por caso: a fila mostra motivo e evidência para análise humana"}
                      style={{ ...E.opcao, ...(s.chave === safraUrl?.chave ? E.opcaoAtiva : null) }}>
                {s.rotulo}
                {resolviveisPorSafra[s.chave] > 0 ? (
                  <span style={E.selinhoSafra}>{num(resolviveisPorSafra[s.chave])} resolvíveis</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        {motivos.length ? (
          <div style={E.filtroBloco}>
            <span style={E.filtroRotulo}>Motivo da pendência</span>
            <div style={E.grupo} role="group" aria-label="Motivo da pendência">
              {motivos.map((m) => (
                <button key={m.chave} type="button" onClick={() => trocarMotivo(m.chave)}
                        aria-pressed={m.chave === motivo}
                        title={m.acao === "CONFERENCIA_PRIME"
                          ? "Resolve-se pelo fluxo da Conferência Prime"
                          : "Sem ação automática segura: entra na fila com motivo e evidência"}
                        style={{ ...E.opcao, ...(m.chave === motivo ? E.opcaoAtiva : null) }}>
                  {m.rotulo} · {num(m.titulos)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {erroResumo ? <p style={S.erro}>Não foi possível contar as pendências: {erroResumo}</p> : null}

      {semFotografia ? (
        <p style={{ ...S.rodape, color: "var(--rv-ambar-texto)" }}>
          <strong>Esta safra ainda não tem fotografia das pendências.</strong> A rotina da hora reconstrói;
          assim que ela rodar, a fila aparece. Isto é diferente de “nenhuma pendência”.
        </p>
      ) : null}

      {motivoAtual ? (
        <div style={E.cabecalhoMotivo}>
          <strong style={E.motivoNome}>{motivoAtual.rotulo}</strong>
          <span style={E.motivoApoio}>
            {num(motivoAtual.alunos)} {Number(motivoAtual.alunos) === 1 ? "aluno" : "alunos"} ·{" "}
            {num(motivoAtual.titulos)} {Number(motivoAtual.titulos) === 1 ? "título" : "títulos"} ·{" "}
            {moeda(motivoAtual.valor)} · safra {safraUrl?.rotulo}
          </span>
          {temAcao ? (
            <span style={E.seloOk}>resolve pela Conferência Prime</span>
          ) : (
            <span style={E.seloAviso}>sem ação automática segura</span>
          )}
        </div>
      ) : null}

      {!temAcao && motivoAtual ? (
        <p style={E.explicacao}>
          <strong>Não existe regra de resolução por caso para este motivo.</strong> A fila mostra o registro
          com motivo e evidência para análise humana, e não oferece botão de resolução — atuar aqui no valor
          ou no status final seria mexer fora da origem do dado, sem histórico e sem auditoria. O caminho é
          abrir a ficha do aluno e tratar na origem correta.
          {(() => {
            const outras = SAFRAS
              .filter((s) => s.chave !== safraUrl?.chave && resolviveisPorSafra[s.chave] > 0);
            if (!outras.length) return null;
            return (
              <>
                {" "}<strong>Com resolução por caso hoje:{" "}
                {outras.map((s) => s.rotulo + " (" + num(resolviveisPorSafra[s.chave]) + ")").join(", ")}.</strong>
              </>
            );
          })()}
        </p>
      ) : null}

      {erroItens ? <p style={S.erro}>Não foi possível listar os casos: {erroItens}</p> : null}

      {avisoResolucao ? <p style={S.discreto}>{avisoResolucao}</p> : null}

      {!safraUrl ? (
        <p style={S.discreto}>Abrindo na safra que tem caso a tratar…</p>
      ) : carregandoItens && itens === null ? (
        <p style={S.discreto}>Carregando os casos desta pendência…</p>
      ) : !itensVisiveis.length ? (
        <p style={S.discreto}>
          {resolvidosNaPagina > 0
            ? "Todos os casos desta página foram resolvidos agora. A contagem por motivo acima ainda é a da fotografia."
            : motivo ? "Nenhum caso nesta pendência." : "Nenhuma pendência nesta safra."}
        </p>
      ) : (
        <>
          <div style={E.lista}>
            {itensVisiveis.map((i) => (
              <article key={i.titulo_id} style={E.caso}>
                <div style={E.casoTopo}>
                  <div style={{ minWidth: 0 }}>
                    {/* O ALUNO E O CONTROLE. Clicar no nome abre a ficha --
                        era o que a tela nao fazia: o nome era texto morto. */}
                    <button type="button" style={E.alunoBotao} onClick={() => setFichaId(i.aluno_id)}
                            title="Abrir a ficha deste aluno sem sair da fila">
                      {i.aluno_nome || "— sem nome na base —"}
                    </button>
                    <div style={E.linhaDados}>
                      CPF {cpf(i.cpf)} · boleto {i.documento || "—"} · venc. {dataCurta(i.vencimento)} ·
                      safra {i.safra}
                    </div>
                  </div>
                  <strong style={E.casoValor}>{moeda(i.valor)}</strong>
                </div>

                <dl style={E.campos}>
                  <div style={E.campo}>
                    <dt style={E.dt}>Motivo</dt>
                    <dd style={E.dd}>{i.motivo_rotulo}</dd>
                  </div>
                  <div style={E.campo}>
                    <dt style={E.dt}>Situação atual</dt>
                    <dd style={E.dd}>{i.situacao_titulo || "—"}</dd>
                  </div>
                  <div style={E.campo}>
                    <dt style={E.dt}>Responsável</dt>
                    <dd style={E.dd}>{i.responsavel_email || "— sem responsável —"}</dd>
                  </div>
                  <div style={E.campo}>
                    <dt style={E.dt}>Na pendência desde</dt>
                    <dd style={E.dd}>{dataCurta(i.desde)}</dd>
                  </div>
                </dl>

                <p style={E.evidencia}>
                  <span style={E.evidenciaRotulo}>Evidência disponível:</span> {i.evidencia}
                </p>

                <div style={E.casoAcoes}>
                  {/* AÇÃO NECESSÁRIA. Em confirmação de pagamento reaproveita o
                      fluxo existente, inteiro: o componente consulta
                      `conferencia_em_confirmacao_do_aluno`, mostra o efeito que
                      o banco calculou e executa pelas RPCs da Conferência
                      Prime. Limitado ao título DESTA linha, para a fila tratar
                      um caso por vez. */}
                  {i.acao === "CONFERENCIA_PRIME" ? (
                    <div style={E.resolver}>
                      <ResolverEmConfirmacao
                        alunoId={i.aluno_id}
                        tituloId={i.titulo_id}
                        podeDecidir={podeDecidir}
                        onResolvido={(aindaEmConfirmacao) => aoResolver(i.titulo_id, aindaEmConfirmacao)}
                      />
                    </div>
                  ) : (
                    <span style={E.semAcao}>Sem ação automática segura — análise humana</span>
                  )}
                  <button type="button" style={E.botaoNeutro} onClick={() => setFichaId(i.aluno_id)}>
                    Abrir ficha do aluno
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div style={E.paginacao}>
            <button type="button" style={E.botaoNeutro} disabled={pagina === 0 || carregandoItens}
                    onClick={() => setPagina((p) => Math.max(0, p - 1))}>
              ← Anteriores
            </button>
            <span style={E.paginaTexto}>
              Casos {pagina * POR_PAGINA + 1}–{pagina * POR_PAGINA + itens.length}
              {motivoAtual ? " de " + num(motivoAtual.titulos) : ""}
            </span>
            <button type="button" style={E.botaoNeutro}
                    disabled={itens.length < POR_PAGINA || carregandoItens}
                    onClick={() => setPagina((p) => p + 1)}>
              Próximos →
            </button>
          </div>
        </>
      )}

      <p style={S.rodape}>
        <strong>Esta fila não substitui nenhuma outra.</strong> “Em confirmação de pagamento” é o mesmo
        universo que a Conferência Prime e o selo “Aguardando confirmação de pagamento” já tratam, com as
        mesmas RPCs e a mesma auditoria — aqui ele aparece organizado por safra e por motivo, junto das
        outras pendências que compõem o número da Efetividade. Resolver um caso aqui o resolve lá, e
        vice-versa.
      </p>
      {resumo?.snapshot?.gerado_em ? (
        <p style={S.rodape}>
          <strong>Dados atualizados em {dataHora(resumo.snapshot.gerado_em)}</strong>
          {resumo.snapshot.atualizacao_pendente ? (
            <strong style={{ color: "var(--rv-ambar)" }}> · Atualização pendente</strong>
          ) : null}
          {" "}— a contagem por motivo vem da fotografia, reconstruída fora da requisição desta tela (o
          cálculo ao vivo passa do teto de 8s em 2026/1). Resolver um caso o resolve na origem NA HORA e o
          retira desta lista na hora; a contagem acima acompanha na próxima reconstrução, solicitada
          automaticamente a cada resolução — não é preciso esperar a rotina das :40. Pagamento ou
          negociação feitos fora do CRM não disparam pedido: para esses, a rotina das :40 é a reconciliação,
          com defasagem máxima de até uma hora mais o tempo da reconstrução.
        </p>
      ) : null}

      {/* FICHA DO ALUNO, EMBUTIDA. Mesmo padrao de Fora da Cobranca /
          Confirmacoes sem valor: a MESMA ficha (`src/pages/Aluno.jsx`) em modo
          embutido, por cima da fila. Nao e copia e nao tem regra propria -- as
          abas, as RPCs, as travas e a auditoria sao as da ficha. Fechar rele a
          fila: o que foi resolvido agora segue fora da lista (`resolvidos`),
          e uma correcao feita na ficha aparece sem recarregar a aplicacao. */}
      {fichaId ? (
        <div style={E.overlay} role="dialog" aria-modal="true" aria-label="Ficha do aluno"
             onClick={fecharFicha}>
          <div style={E.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={E.modalTopo}>
              <strong>Ficha do aluno</strong>
              <button type="button" style={E.botaoNeutro} onClick={fecharFicha}>Fechar ✕</button>
            </div>
            <div style={{ overflow: "auto", flex: 1 }}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const E = {
  pagina: { padding: "22px clamp(14px, 3vw, 30px) 40px", maxWidth: 1180, margin: "0 auto" },
  topo: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
          flexWrap: "wrap", marginBottom: 16 },
  h1: { margin: 0, fontSize: "clamp(20px, 3vw, 26px)", fontWeight: 800, letterSpacing: "-0.02em",
        fontFamily: "'Sora', Inter, sans-serif" },
  sub: { margin: "6px 0 0", fontSize: 13, color: "var(--rv-texto-suave)", lineHeight: 1.55,
         maxWidth: 680 },
  acoesTopo: { display: "flex", gap: 8, flexWrap: "wrap" },

  filtros: { display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 14 },
  filtroBloco: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
  filtroRotulo: { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
                  color: "var(--rv-texto-fraco)" },
  grupo: { display: "flex", gap: 6, flexWrap: "wrap" },
  opcao: { background: "var(--rv-superficie)", color: "var(--rv-texto)",
           border: "1px solid var(--rv-borda-forte)", borderRadius: 999, padding: "5px 12px",
           fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  // `border` inteiro, não `borderColor`: misturar shorthand com propriedade
  // isolada no mesmo elemento faz o React avisar de bug de estilo na rerender.
  opcaoAtiva: { background: "var(--rv-azul)", color: "#fff", border: "1px solid var(--rv-azul)" },

  cabecalhoMotivo: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap",
                     padding: "10px 0 6px", borderTop: "1px solid var(--rv-borda-suave)" },
  motivoNome: { fontSize: 16, fontWeight: 800, fontFamily: "'Sora', Inter, sans-serif" },
  motivoApoio: { fontSize: 12.5, color: "var(--rv-texto-suave)", fontVariantNumeric: "tabular-nums" },
  seloOk: { fontSize: 10.5, fontWeight: 700, color: "var(--rv-verde-ok)",
            border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "2px 9px" },
  seloAviso: { fontSize: 10.5, fontWeight: 700, color: "var(--rv-ambar-texto)",
               border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "2px 9px" },
  explicacao: { fontSize: 12.5, color: "var(--rv-texto-suave)", lineHeight: 1.6, margin: "8px 0 0",
                maxWidth: 820 },

  lista: { display: "flex", flexDirection: "column", gap: 12, marginTop: 14 },
  caso: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)",
          borderRadius: 14, padding: "14px 16px", boxShadow: "var(--rv-sombra)" },
  casoTopo: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12,
              flexWrap: "wrap" },
  alunoNome: { fontSize: 14.5, fontWeight: 800, display: "block" },
  alunoBotao: { display: "block", background: "none", border: "none", padding: 0,
                textAlign: "left", font: "inherit", fontSize: 14.5, fontWeight: 800,
                color: "var(--rv-azul)", cursor: "pointer", textDecoration: "underline",
                textUnderlineOffset: 3, overflowWrap: "anywhere" },
  linhaDados: { fontSize: 12, color: "var(--rv-texto-fraco)", marginTop: 2,
                fontVariantNumeric: "tabular-nums" },
  casoValor: { fontSize: 18, fontWeight: 800, fontVariantNumeric: "tabular-nums",
               fontFamily: "'Sora', Inter, sans-serif", whiteSpace: "nowrap" },

  campos: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10,
            margin: "12px 0 0" },
  campo: { minWidth: 0 },
  dt: { fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)" },
  dd: { margin: "2px 0 0", fontSize: 12.5, color: "var(--rv-texto)", overflowWrap: "anywhere" },

  evidencia: { fontSize: 12, color: "var(--rv-texto-suave)", lineHeight: 1.55,
               margin: "12px 0 0", paddingTop: 10, borderTop: "1px solid var(--rv-borda-suave)" },
  evidenciaRotulo: { fontWeight: 800, color: "var(--rv-texto)" },

  casoAcoes: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 10 },
  resolver: { flex: "1 1 320px", minWidth: 0 },
  semAcao: { fontSize: 12, fontWeight: 700, color: "var(--rv-ambar-texto)" },

  paginacao: { display: "flex", gap: 10, alignItems: "center", justifyContent: "center",
               flexWrap: "wrap", marginTop: 16 },
  paginaTexto: { fontSize: 12, color: "var(--rv-texto-fraco)", fontVariantNumeric: "tabular-nums" },

  selinhoSafra: { marginLeft: 6, fontSize: 10, fontWeight: 800, opacity: 0.85 },

  overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", display: "flex",
             alignItems: "flex-start", justifyContent: "center", padding: "3vh 2vw", zIndex: 1000 },
  modalBox: { ...modalBoxBase, width: "min(1100px, 96vw)", maxHeight: "94vh", display: "flex",
              flexDirection: "column", overflow: "hidden", padding: 0 },
  modalTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
               padding: "12px 16px", borderBottom: "1px solid var(--rv-borda-suave)" },

  botaoNeutro: { background: "var(--rv-superficie)", color: "var(--rv-texto)",
                 border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "6px 12px",
                 fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
};
