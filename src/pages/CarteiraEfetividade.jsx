import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import EfetividadePorVencimento from "../components/EfetividadePorVencimento";
import EfetividadeCompetencias from "../components/EfetividadeCompetencias";
import SeisLinhasDaSafra from "../components/SeisLinhasDaSafra";
import ComposicaoAcademicaDoSaldo from "../components/ComposicaoAcademicaDoSaldo";
import PendenciasDeValidacao from "../components/PendenciasDeValidacao";
import ComparativoSafras from "../components/ComparativoSafras";
import CasosPendentes from "../components/CasosPendentes";

// EFETIVIDADE DA COBRANÇA — visão executiva, um layout só para toda safra.
//
// ---------------------------------------------------------------------------
// A PÁGINA EM QUATRO BLOCOS (redesenho pedido pela gestão em 07/10/2026)
//
//   1. RESUMO DA CARTEIRA ..... Universo recebido → Recuperado → Em aberto →
//                               Efetividade, nessa ordem de leitura, com alunos
//                               e títulos como apoio.
//   2. SITUAÇÃO FINANCEIRA .... as cinco classes (Pago, Negociado, Em aberto,
//                               Pendente, Cancelado) sobre o universo — as seis
//                               linhas, intocadas.
//   3. COMPOSIÇÃO DO ABERTO ... quem compõe o saldo, por situação acadêmica
//                               real, com alunos, títulos, saldo e percentual.
//   4. PENDÊNCIAS ............. por que o pendente está pendente, por motivo
//                               real, com caminho para a Fila Única.
//
// A Efetividade é tela de ANÁLISE. O tratamento caso a caso é na Fila Única de
// Confirmação — nenhum caso é corrigido aqui.
//
// O QUE SAIU POR DUPLICAÇÃO, e para onde foi:
//   • "Situação da carteira" (as barras de Convertido / Em aberto sem
//     negociação / Em conferência / Encerrado, em 2026/1; e as quatro linhas
//     históricas em 2024/2025) contava a MESMA história das seis linhas, com
//     outros rótulos e outra régua. Ficaram as seis linhas, que valem para toda
//     safra. Em 2026/2 o bloco PERMANECE: lá ele mostra os estados do acordo
//     (Quitado / Regular / Em atraso / Quebrado / Cancelado), que é conceito
//     diferente e não tem equivalente nas seis linhas.
//   • Os quatro indicadores por natureza de período (um conjunto em 2026/1,
//     outro em 2024/2025) viraram UM conjunto só, igual em toda safra, lido da
//     mesma fonte das seis linhas — por isso o topo e o cartão não podem
//     divergir.
//   • "Alunos por status" (dentro das seis linhas) e o card "Status acadêmico
//     por safra" listavam as mesmas categorias da mesma importação. Os dois
//     saíram; entrou a composição financeira do bloco 3, que traz o que os dois
//     traziam e o saldo, que faltava.
//   • O comparativo entre safras ficou compacto — Safra, Universo, Recuperado,
//     Em aberto, Efetividade — e carrega SOB DEMANDA: são três consultas ao
//     vivo, e abri-las em toda visita custaria caro sem ninguém ter pedido.
//
// ATUALIZAÇÃO DOS DADOS (política de 08/10/2026). Parte é lida ao vivo e parte
// vem de fotografia, e a tela diz qual é qual.
//
// Ao vivo, nos pontos definidos (abrir, trocar de safra, trocar de visão,
// "Atualizar dados" — o contador `recarga`): os indicadores de 2026/2 e o
// histórico por ano.
//
// De FOTOGRAFIA: os blocos agregados (seis linhas, composição, pendências). O
// cálculo ao vivo de 2026/1 custa ~34,6 s e o teto do papel `authenticated` é
// 8 s — não cabe na requisição. Quem reconstrói é o dreno de 5 em 5 min (quando
// alguma ação interna do CRM marcou a fotografia como desatualizada) e a rotina
// das :40 (rede de segurança, que também reconcilia o que entra por fora do
// CRM, com defasagem máxima de até uma hora mais o tempo da reconstrução).
//
// A tela NUNCA apresenta fotografia antiga como dado ao vivo: declara
// "Dados atualizados em DD/MM/AAAA HH:mm" e, quando houve mudança depois dela,
// "Atualização pendente". Não há polling nem realtime — a própria leitura da
// fotografia já devolve se há pendência.
//
// O que muda entre 2024, 2025, 2026/1 e 2026/2 é o DADO e o CONCEITO do
// período, nunca o desenho da página. Em qualquer safra a Diretoria encontra,
// sempre no mesmo lugar: quanto há em carteira, quantos alunos são, quanto foi
// convertido, quanto entrou em dinheiro, a situação atual e o perfil dos alunos.
//
// Três naturezas de período, cada uma com a régua que os dados permitem:
//   CARTEIRA CONSOLIDADA (2026/1) — safra fechada; as quatro faixas somam 100%.
//   SEMESTRE VIGENTE (2026/2)     — em curso; só o que já foi negociado. Sem
//                                   inadimplência: há título a vencer.
//   COBERTURA HISTÓRICA (2024/25) — o CRM não guarda nada anterior a julho/2026,
//                                   então não há percentual de efetividade: o
//                                   que existe é o saldo residual e o que foi
//                                   convertido desde a entrada em cobrança.
//
// Nenhuma conta acontece aqui. Os valores vêm prontos das RPCs; o front só
// desenha. Detalhe por CPF/título existe no banco, mas fora da visão executiva.

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const moedaCurta = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1e6) return "R$ " + (n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " mi";
  if (Math.abs(n) >= 1e3) return "R$ " + (n / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
  return moeda(n);
};
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const data = (v) => (v ? new Date(v.length === 10 ? v + "T12:00:00" : v).toLocaleDateString("pt-BR") : "—");
// A politica de atualizacao exige DD/MM/AAAA HH:mm: so a data esconderia se a
// fotografia e de agora ou de 23 horas atras.
const dataHora = (v) =>
  v ? new Date(v).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
const pctTexto = (parte, todo, casas = 2) =>
  Number(todo) > 0
    ? (Number(parte) / Number(todo) * 100).toLocaleString("pt-BR",
        { minimumFractionDigits: casas, maximumFractionDigits: casas }) + "%"
    : "—";

// ---------------------------------------------------------------- LIBERAÇÃO
// Enquanto a área está sendo finalizada, só a Amanda vê os indicadores. Angela,
// Gustavo e o resto da diretoria entram pelo menu normalmente e encontram a
// tela "Em breve" — é preparação de funcionalidade, não bloqueio de segurança
// (a autorização de verdade segue nas RPCs, que já são de gestão + diretoria).
//
// PARA LIBERAR PARA TODA A DIRETORIA: troque o corpo de `podeVerIndicadores`
// por `return true`. Nada mais na página precisa mudar.
const EMAILS_COM_ACESSO_TOTAL = ["amanda.seibel@aelbra.com.br"];
function podeVerIndicadores(email) {
  return EMAILS_COM_ACESSO_TOTAL.includes(String(email || "").toLowerCase().trim());
}

// Cores por PAPEL, sempre em token: o tema escuro troca o valor de cada token e
// a tela acompanha sem mudar JSX. Hex fixo aqui reprovava no escuro — o verde
// #1f7a3d e o vermelho #b4232a ficavam ilegíveis sobre fundo escuro.
const AZUL = "var(--rv-azul)", VERDE = "var(--rv-verde-ok)", VERMELHO = "var(--rv-vermelho)",
      AMBAR = "var(--rv-ambar)", CINZA = "var(--rv-texto-suave)";

export default function CarteiraEfetividade() {
  const [ano, setAno] = useState("2026");
  const [sem, setSem] = useState("1");
  // 2026/2 tem duas leituras do MESMO dado: o consolidado do semestre e o
  // recorte por competência (mês de vencimento da mensalidade). As outras
  // safras têm só o consolidado.
  const [vista, setVista] = useState("consolidado");
  const [consolidada, setConsolidada] = useState(null);
  const [vigente, setVigente] = useState(null);
  const [contexto, setContexto] = useState(null);
  const [historico, setHistorico] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [metodologia, setMetodologia] = useState(false);
  const [obraAberta, setObraAberta] = useState(false);
  const [email, setEmail] = useState(null);
  // `recarga` é a dependência única da política de atualização: incrementar faz
  // TODA consulta ao vivo desta tela refazer — a da página e a de cada bloco
  // filho, que o recebem por prop. É o que o botão "Atualizar dados" faz.
  const [recarga, setRecarga] = useState(0);
  const [comparativo, setComparativo] = useState(false);
  // O que a propria leitura da fotografia disse: quando foi gerada e se houve
  // mudanca DEPOIS dela. Nao e polling -- vem junto com a leitura que a tela
  // ja fazia. `null` = ainda nao leu.
  const [fotografia, setFotografia] = useState(null);
  const [pedindoAtualizacao, setPedindoAtualizacao] = useState(false);
  const [avisoAtualizacao, setAvisoAtualizacao] = useState("");
  // As seis linhas da safra selecionada, buscadas AQUI e não dentro do cartão:
  // o mesmo payload alimenta o resumo executivo do topo e o cartão das seis
  // linhas. Duas chamadas seriam duas fotografias de instantes diferentes na
  // mesma tela — e uma consulta ao vivo cara, repetida à toa.
  const [situacoes, setSituacoes] = useState(null);
  const [erroSituacoes, setErroSituacoes] = useState("");
  const [carregandoSituacoes, setCarregandoSituacoes] = useState(true);
  // A composicao academica tambem e buscada AQUI, e nao dentro do bloco: o
  // total dela e o indicador "Saldo em aberto atual" do resumo. Buscar nos dois
  // lugares daria dois saldos em aberto na mesma tela.
  const [composicao, setComposicao] = useState(null);
  const [erroComposicao, setErroComposicao] = useState("");
  const [carregandoComposicao, setCarregandoComposicao] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data: sessao } = await supabase.auth.getUser();
      const quem = sessao?.user?.email || "";
      if (!ativo) return;
      if (!podeVerIndicadores(quem)) { setEmail(quem); setCarregando(false); return; }
      const [indicadores2026_1, negociacoes, contexto2026_2, historicoPorAno] = await Promise.all([
        supabase.rpc("carteira_2026_1_indicadores"),
        supabase.rpc("carteira_2026_2_negociacoes"),
        supabase.rpc("carteira_2026_2_contexto"),
        supabase.rpc("carteira_saldo_historico_por_ano"),
      ]);
      if (!ativo) return;
      // Nomes em vez de a/b/c/e/f: a lista encolheu quando
      // `carteira_2026_1_academico` saiu, e com letras posicionais um retorno
      // passaria calado para o estado errado.
      const respostas = [indicadores2026_1, negociacoes, contexto2026_2, historicoPorAno];
      const primeiro = respostas.find((r) => r.error);
      if (primeiro) setErro(primeiro.error.message);
      setConsolidada(indicadores2026_1.data?.vazio ? null : indicadores2026_1.data);
      setVigente(negociacoes.data || null);
      setContexto(contexto2026_2.data || null);
      setHistorico(historicoPorAno.data || null);
      setEmail(quem);
      setCarregando(false);
    })();
    return () => { ativo = false; };
    // `recarga` entra na lista: "Atualizar dados" também refaz o contexto de
    // 2026/2 e o histórico por ano, não só as seis linhas.
  }, [recarga]);

  // Os dois blocos da safra selecionada, lidos da CAMADA RAPIDA.
  //
  // POR QUE NAO SAO MAIS AS FUNCOES VIVAS (ajuste de 07/10/2026). Medido em
  // producao: `carteira_safra_situacoes('2026','1')` custa 34,6 s e ESTOURA o
  // `statement_timeout` de 8 s do papel `authenticated` -- o cartao das seis
  // linhas de 2026/1 ja falhava antes deste PR. `carteira_efetividade_ler`
  // devolve a fotografia pronta em uma leitura indexada; quem reconstroi e a
  // rotina da hora, fora da requisicao. A fonte viva segue sendo a origem da
  // verdade, e nenhuma regra financeira mudou: o recalculo chama as MESMAS
  // funcoes.
  //
  // Efeito proprio porque depende da escolha de periodo -- e porque a falha de
  // um bloco nao pode derrubar o outro nem o resto da pagina.
  // 2026/2 nao entra: aquela safra tem caminho proprio (`carteira_2026_2_*`).
  useEffect(() => {
    let ativo = true;
    (async () => {
      if (ano === "2026" && sem === "2") {
        setSituacoes(null); setErroSituacoes(""); setCarregandoSituacoes(false);
        setComposicao(null); setErroComposicao(""); setCarregandoComposicao(false);
        return;
      }
      setCarregandoSituacoes(true);
      setCarregandoComposicao(true);
      setErroSituacoes("");
      setErroComposicao("");
      const p_semestre = ano === "2026" ? sem : null;
      const [seis, comp] = await Promise.all([
        supabase.rpc("carteira_efetividade_ler",
          { p_bloco: "seis_linhas", p_ano: ano, p_semestre }),
        supabase.rpc("carteira_efetividade_ler",
          { p_bloco: "composicao_academica", p_ano: ano, p_semestre }),
      ]);
      if (!ativo) return;
      if (seis.error) { setErroSituacoes(seis.error.message || "falha ao consultar"); setSituacoes(null); }
      else setSituacoes(seis.data || null);
      if (comp.error) { setErroComposicao(comp.error.message || "falha ao consultar"); setComposicao(null); }
      else setComposicao(comp.data || null);
      // A FOTOGRAFIA SE DECLARA. `carteira_efetividade_ler` devolve
      // `snapshot.gerado_em` e `snapshot.atualizacao_pendente`; a tela mostra os
      // dois em vez de apresentar foto antiga como dado ao vivo. Basta UM bloco
      // pendente para a tela avisar -- os dois saem do mesmo recorte e e o lado
      // seguro de errar.
      const metas = [seis.data?.snapshot, comp.data?.snapshot].filter(Boolean);
      setFotografia(metas.length ? {
        gerado_em: metas.map((m) => m.gerado_em).filter(Boolean).sort()[0] || null,
        pendente: metas.some((m) => m.atualizacao_pendente),
        sem_snapshot: Boolean(seis.data?.sem_snapshot || comp.data?.sem_snapshot),
      } : { gerado_em: null, pendente: false, sem_snapshot: true });
      setCarregandoSituacoes(false);
      setCarregandoComposicao(false);
    })();
    return () => { ativo = false; };
  }, [ano, sem, recarga]);

  // "ATUALIZAR DADOS" -- a ordem importa e e a da politica.
  //
  //   1. RELE a fotografia (incrementa `recarga`, dependencia de toda consulta
  //      desta tela). Barato, e e o que resolve o caso comum: o dreno ja
  //      reconstruiu e a tela so nao sabia.
  //   2. se a leitura anterior disse `pendente`, REGISTRA o pedido de
  //      reconstrucao -- `carteira_efetividade_solicitar_atualizacao` grava a
  //      marca e volta na hora.
  //
  // O que esta funcao NUNCA faz e chamar `carteira_efetividade_recalcular`: sao
  // ~60 s nos tres recortes e o teto do papel `authenticated` e 8 s. A
  // reconstrucao e do dreno, fora desta requisicao.
  //
  // DUAS CORRECOES DE 08/10/2026.
  //
  // 1. O BOTAO NAO DAVA RETORNO NENHUM no caso comum. Com a fotografia em dia
  //    -- que e o normal, agora que a rede automatica e de 20 min -- ele
  //    incrementava `recarga`, caia no `return` e nao dizia nada: nenhum aviso,
  //    nenhum numero diferente na tela. Clicar e nao ver nada acontecer e
  //    indistinguivel de botao quebrado. Agora ele SEMPRE responde, inclusive
  //    para dizer "ja esta atualizado, e esta e a hora da foto".
  //
  // 2. A DECISAO USAVA ESTADO VELHO. `fotografia` e o resultado da leitura
  //    ANTERIOR: `setRecarga` apenas agenda a releitura, e o `if` logo abaixo
  //    rodava antes de ela chegar. Depois de uma resolucao, a marca de
  //    "atualizacao pendente" podia existir no banco e o botao nao registrar
  //    pedido nenhum. Agora a decisao vem de uma leitura FRESCA do bloco, feita
  //    aqui -- leitura por chave primaria da tabela de fotografia, barata.
  //
  // O que esta funcao continua NUNCA fazendo e chamar
  // `carteira_efetividade_recalcular`.
  async function atualizarDados() {
    setAvisoAtualizacao("");
    setRecarga((v) => v + 1);
    setPedindoAtualizacao(true);
    const p_semestre = ano === "2026" ? sem : null;
    const { data: agora, error: erroLeitura } = await supabase.rpc("carteira_efetividade_ler",
      { p_bloco: "seis_linhas", p_ano: ano, p_semestre });
    if (erroLeitura) {
      setPedindoAtualizacao(false);
      setAvisoAtualizacao("Não foi possível reler a fotografia (" + (erroLeitura.message || "falha")
        + "). A reconstrução automática de 20 em 20 minutos continua valendo.");
      return;
    }
    const precisa = Boolean(agora?.sem_snapshot || agora?.snapshot?.atualizacao_pendente);
    if (!precisa) {
      setPedindoAtualizacao(false);
      setAvisoAtualizacao("Dados já estão atualizados — fotografia de "
        + dataHora(agora?.snapshot?.gerado_em) + ". Nada a reconstruir.");
      return;
    }
    const { data: pedido, error } = await supabase.rpc("carteira_efetividade_solicitar_atualizacao");
    setPedindoAtualizacao(false);
    // Falha no pedido nao pode virar silencio: sem aviso a pessoa conclui que
    // atualizou. A rede automatica de 20 min continua sendo o fallback.
    setAvisoAtualizacao(error
      ? "Não foi possível registrar o pedido de atualização (" + (error.message || "falha") +
        "). A reconstrução automática de 20 em 20 minutos continua valendo."
      : "Atualização solicitada — " + (pedido?.previsao || "sai na próxima reconstrução") + ".");
  }

  if (carregando) return <Carregando />;

  if (!podeVerIndicadores(email)) {
    return (
      <div style={S.pagina}>
        <h1 style={S.h1}>Efetividade</h1>
        <div style={S.emBreve}>
          <span style={{ fontSize: 30, lineHeight: 1 }} aria-hidden="true">🧭</span>
          <strong style={{ fontSize: 20, fontWeight: 700 }}>Em breve</strong>
          <p style={{ margin: 0, fontSize: 14, color: "var(--rv-texto-suave)", lineHeight: 1.6, maxWidth: 520 }}>
            Estamos finalizando esta nova área de acompanhamento da efetividade da cobrança. Em breve os indicadores
            estarão disponíveis para consulta.
          </p>
        </div>
      </div>
    );
  }

  // 2024 e 2025 são lidos por ANO (os dois semestres unificados); só 2026 tem
  // semestre, porque só ali o semestre muda a natureza do período.
  const safra = ano + "/" + sem;
  const periodo = ano === "2026" ? safra : ano;
  const natureza = safra === "2026/1" ? "Carteira consolidada"
                 : safra === "2026/2" ? "Semestre vigente" : "Cobertura histórica";

  // ---- os quatro indicadores, a situação e o rodapé de cada natureza de período
  let indicadores = [], situacao = [], referencia = 0, rodape = null, tituloSituacao = "Situação da carteira";
  // O que é 100% na barra muda com a natureza do período; dizer qual é a base
  // evita a leitura errada de um percentual sem denominador declarado.
  let referenciaRotulo = "";

  // -------------------------------------------------- BLOCO 1, EM TODA SAFRA
  // Um conjunto só de indicadores, lido da MESMA fonte das seis linhas, na
  // ordem de leitura que a gestão pediu: Universo recebido → Recuperado →
  // Em aberto → Efetividade. Antes havia um conjunto por natureza de período
  // (quatro rótulos em 2026/1, outros quatro em 2024/2025) e os mesmos valores
  // reapareciam mais abaixo com outros nomes.
  //
  // A ÚNICA CONTA DO FRONT AQUI é o share — `parte ÷ todo` sobre números que a
  // RPC já devolveu prontos. É exatamente a mesma participação que as seis
  // linhas desenham na barra de cada situação, pelo mesmo helper. Nenhum valor
  // financeiro é recomposto, somado ou ajustado no navegador.
  // AS DUAS REGUAS, DECLARADAS (ajuste de 07/10/2026). "Universo recebido" e
  // "Recuperado" sao a regua das SEIS LINHAS -- o que entrou em cobranca e o
  // que foi recuperado dele. "Saldo em aberto atual" e a regua HISTORICA
  // OFICIAL, a mesma de `carteira_saldo_historico_por_ano().aberto`, e vem do
  // bloco de composicao -- que e exatamente o que o bloco 3 decompoe por status
  // academico.
  //
  // As duas nao se igualam, de proposito: em 2024 a regua das seis linhas da
  // R$ 4,99 mi de aberto e a oficial da R$ 3,67 mi, porque a oficial exclui o
  // que nao e mais cobravel por nos (outro portador, liquidado na Prime,
  // portador 166 sem acordo, confirmacao pendente, caso cancelado, aluno ja
  // coberto por pagamentos). Sao duas perguntas diferentes, as duas validadas,
  // e a tela diz qual e qual em vez de forcar um numero so.
  //
  // A efetividade segue sendo recuperado / universo recebido -- as duas pontas
  // da MESMA regua. Dividir o recuperado de uma regua pelo aberto da outra
  // seria a conta errada.
  function indicadoresDaSafra(s, comp) {
    const entrou = Number(s.entrou?.valor || 0);
    const pago = Number(s.pago?.valor || 0);
    const temOficial = comp && !comp.sem_snapshot && comp.total;
    const aberto = temOficial ? Number(comp.total.valor || 0) : null;
    return [
      { rotulo: "Universo recebido", valor: moedaCurta(entrou),
        apoio: num(s.entrou?.alunos) + " alunos · " + num(s.entrou?.titulos) + " títulos",
        cor: "var(--rv-tinta)" },
      { rotulo: "Recuperado", valor: moedaCurta(pago),
        apoio: pctTexto(pago, entrou, 1) + " do universo recebido", cor: VERDE },
      { rotulo: "Saldo em aberto atual",
        valor: temOficial ? moedaCurta(aberto) : "—",
        apoio: temOficial
          ? num(comp.total.alunos) + " alunos · " + num(comp.total.titulos) + " títulos"
          : "sem fotografia ainda",
        cor: VERMELHO },
      { rotulo: "Efetividade", valor: pctTexto(pago, entrou, 1),
        apoio: "recuperado ÷ universo recebido", cor: AZUL },
    ];
  }

  if (safra !== "2026/2" && situacoes?.situacoes) {
    referencia = Number(situacoes.situacoes.entrou?.valor || 0);
    indicadores = indicadoresDaSafra(situacoes.situacoes, composicao);
    // `situacao` fica vazio de propósito fora de 2026/2: as barras de
    // "Situação da carteira" diziam o mesmo que as seis linhas. Ver o cabeçalho
    // do arquivo.
    situacao = [];
  }

  if (safra === "2026/1" && consolidada) {
    // `carteira_2026_1_indicadores` continua sendo chamada, mas SÓ pelo
    // contexto do rodapé — a data de congelamento e a da fotografia. Os valores
    // dela não aparecem como indicador: quem publica carteira, recuperado e
    // aberto é `carteira_safra_situacoes`, ao vivo, e dois números de universo
    // na mesma tela seriam a duplicação que este redesenho veio remover.
    rodape = "Carteira congelada em " + data(consolidada.base?.congelada_em)
           + " · fotografia de referência de " + data(consolidada.gerado_em)
           + " · os valores acima são lidos ao vivo, não desta fotografia";
  }

  if (safra === "2026/2" && vigente) {
    const t = vigente.total || {};
    referencia = Number(t.negociado || 0);
    indicadores = [
      // "268 títulos negociados" era verdade e ainda assim confundia: a outra
      // visão da MESMA tela conta 2.522 mensalidades, e ninguém sabia que uma é
      // recorte da outra. Medido em 29/09: as duas consultas usam o MESMO
      // recorte de 2026/2 -- mesma série do Prime, mesmo fallback por
      // vencimento, mesmas exclusões -- e diferem numa linha só, o INNER JOIN
      // em acordo aqui. O Consolidado é subconjunto perfeito: zero títulos só
      // nele. Declarar a base resolve a leitura sem tocar em conta nenhuma.
      //
      // Os dois números vêm das consultas, nunca escritos à mão: se a carteira
      // crescer, o texto acompanha. Sem o contexto carregado, some a segunda
      // metade em vez de mostrar "de 0".
      { rotulo: "Valor negociado", valor: moedaCurta(t.negociado),
        apoio: "Mensalidades com acordo: " + num(t.titulos)
             + (Number(contexto?.carteira_titulos) > 0
                  ? " de " + num(contexto.carteira_titulos) + " da carteira"
                  : ""),
        cor: AZUL },
      { rotulo: "Valor recebido", valor: moedaCurta(t.recebido), apoio: pctTexto(t.recebido, t.negociado, 1) + " do negociado", cor: VERDE },
      { rotulo: "Alunos negociados", valor: num(t.cpfs) + " alunos", apoio: num(t.acordos) + " acordos", cor: "var(--rv-tinta)" },
      { rotulo: "Saldo negociado", valor: moedaCurta(t.saldo), apoio: "ainda a receber", cor: AMBAR },
    ];
    const CORES = { "Quitado": VERDE, "Regular": AZUL, "Em atraso": AMBAR, "Acordo quebrado": VERMELHO, "Acordo cancelado": CINZA };
    const NOMES = { "Acordo quebrado": "Quebrado", "Acordo cancelado": "Cancelado" };
    situacao = (vigente.estados || []).map((e) => ({
      rotulo: NOMES[e.estado] || e.estado, valor: e.negociado, cor: CORES[e.estado] || AZUL,
    }));
    referenciaRotulo = "do valor negociado";
    rodape = "Carteira recebida: " + moedaCurta(contexto?.carteira_valor) + " · "
           // "CPFs", não "alunos": este número conta CPF e os cartões por
           // vencimento contam ficha do CRM. Dizer qual é qual custa uma
           // palavra; deixar os dois como "alunos" custa a confiança no painel.
           + num(contexto?.carteira_titulos) + " títulos · " + num(contexto?.carteira_cpfs) + " CPFs · "
           + num(contexto?.remessas) + " remessas (" + data(contexto?.primeira_remessa) + " a "
           + data(contexto?.ultima_remessa) + ")";
  }

  const hist = ano !== "2026" ? (historico?.anos || []).find((x) => x.ano === ano) : null;
  if (hist) {
    const carteira = hist.carteira || {};
    // Mesma decisão de 2026/1: `carteira_saldo_historico_por_ano` continua
    // sendo lida, mas agora pelo CONTEXTO (quando a carteira entrou em
    // cobrança, quando a Prime foi coletada) e pela composição por curso lá
    // embaixo. Os quatro indicadores do ano saíram: diziam, com outros
    // rótulos, o que o resumo único já diz — e por régua diferente, o que fazia
    // o mesmo "em aberto" aparecer com dois valores na mesma página.
    //
    // "Negociado direto com a Ulbra, a confirmar" saiu das barras junto com o
    // bloco "Situação da carteira". Ele não foi perdido: é exposição por CPF,
    // não por título, e continua descrito na metodologia — virar barra ao lado
    // de valores por título era justamente o que confundia a régua.
    rodape = "Carteira residual do ano: " + moeda(carteira.valor_original) + " · " + num(carteira.titulos)
           + " títulos · " + num(carteira.cpfs) + " alunos · entrada em cobrança de " + data(carteira.entrada_de)
           + " a " + data(carteira.entrada_ate) + " · situação na Prime coletada em "
           + data(historico?.prime_coletado_em)
           + (Number(hist.ulbra_166?.valor) > 0
                ? " · negociado direto com a Ulbra, a confirmar: " + moeda(hist.ulbra_166.valor)
                  + " em " + num(hist.ulbra_166.mensalidades) + " mensalidades (exposição por CPF)"
                : "");
  }

  // De que curso vem o saldo em aberto — só 2024/2025. A situação acadêmica
  // de qualquer safra mora em "Alunos por status", dentro de SeisLinhasDaSafra.
  const cursos = hist ? (hist.cursos || []) : null;
  const cursosTotal = Number(hist?.aberto?.valor || 0);

  return (
    <div style={S.pagina}>
      <header style={S.tituloLinha}>
        <h1 style={S.h1}>Efetividade da Cobrança</h1>
        {/* Selo discreto: sinaliza que a AREA ainda esta sendo finalizada -- de
            proposito nao fala de dados nem de calculo, para nao passar a
            impressao de que os numeros sao provisorios. */}
        <button onClick={() => setObraAberta((v) => !v)}
                title="Esta área ainda está em construção e pode receber ajustes de layout, nomenclatura e visualização."
                style={S.selo}>
          Em construção
        </button>
        {/* ATUALIZAR DADOS. Não há polling nem realtime nesta tela de
            propósito: o financeiro é lido ao vivo nos pontos definidos — abrir,
            trocar de safra, trocar de visão e este botão. Ele só incrementa
            `recarga`, que é dependência de todas as consultas. */}
        <button onClick={atualizarDados} disabled={pedindoAtualizacao}
                title="Relê a fotografia dos indicadores. Se houver mudança posterior a ela, solicita a reconstrução — que roda fora desta tela, nunca no clique."
                style={{ ...S.selo, marginLeft: "auto" }}>
          {pedindoAtualizacao ? "Solicitando…" : "↻ Atualizar dados"}
        </button>
      </header>
      {obraAberta ? (
        <p style={S.seloTexto}>
          Esta área ainda está em construção e pode receber ajustes de layout, nomenclatura e visualização.
        </p>
      ) : null}

      {/* A IDADE DA FOTOGRAFIA, SEMPRE DECLARADA.
          Os blocos agregados vêm da camada de leitura, não ao vivo (2026/1 ao
          vivo custa ~34,6 s e estoura o teto de 8 s). Apresentar isso como dado
          ao vivo seria mentir; então a tela diz quando a fotografia foi gerada
          e, quando houve mudança depois dela, que há atualização pendente. */}
      {fotografia ? (
        <p style={{ ...S.seloTexto, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {fotografia.sem_snapshot && !fotografia.gerado_em ? (
            <strong>Sem fotografia ainda — a reconstrução automática ainda não rodou para esta safra.</strong>
          ) : (
            <span>Dados atualizados em <strong>{dataHora(fotografia.gerado_em)}</strong></span>
          )}
          {fotografia.pendente ? (
            <span title="Houve pagamento, acordo, baixa, ajuste ou resolução de pendência depois desta fotografia. A reconstrução roda fora da tela."
                  style={{ padding: "2px 8px", borderRadius: 999, fontWeight: 700,
                           color: "var(--rv-ambar)", background: "rgba(180,83,9,0.14)" }}>
              Atualização pendente
            </span>
          ) : null}
          {avisoAtualizacao ? <span>{avisoAtualizacao}</span> : null}
        </p>
      ) : null}

      {/* Escolha do período e identidade do período no MESMO bloco: o que se
          seleciona e o que se está vendo não podem morar longe um do outro. */}
      <div style={S.painelPeriodo}>
        <div style={S.navegacao}>
          <div style={S.navBloco}>
            <span style={S.navRotulo}>Ano</span>
            <div style={S.grupo} role="group" aria-label="Ano">
              {["2024", "2025", "2026"].map((a) => (
                <button key={a} onClick={() => setAno(a)} aria-pressed={ano === a}
                        style={{ ...S.opcao, ...(ano === a ? S.opcaoAtiva : null) }}>{a}</button>
              ))}
            </div>
          </div>
          {ano === "2026" ? (
            <div style={S.navBloco}>
              <span style={S.navRotulo}>Semestre</span>
              <div style={S.grupo} role="group" aria-label="Semestre">
                {[["1", "1º semestre"], ["2", "2º semestre"]].map(([k, r]) => (
                  <button key={k} onClick={() => setSem(k)} aria-pressed={sem === k}
                          style={{ ...S.opcao, ...(sem === k ? S.opcaoAtiva : null) }}>{r}</button>
                ))}
              </div>
            </div>
          ) : (
            <span style={S.chip}>Ano inteiro: em 2024 e 2025 os dois semestres são lidos juntos.</span>
          )}
          {/* Só 2026/2 tem recorte por competência: é a safra em curso, em que
              as mensalidades do mês ainda estão entrando em cobrança. */}
          {ano === "2026" && sem === "2" ? (
            <div style={S.navBloco}>
              <span style={S.navRotulo}>Visão</span>
              <div style={S.grupo} role="group" aria-label="Visão de 2026/2">
                {/* Três leituras de 2026/2, nunca duas ao mesmo tempo na tela.
                    "Por competência" e "Resumo por vencimento" quebram o mesmo
                    universo pelo mesmo mês, mas respondem a perguntas
                    diferentes: uma decompõe em Convertido/Conferência/
                    Acadêmico/Sem negociação, a outra em Entrou/Pago/Negociado/
                    Cancelado/Em aberto. Nenhuma recalcula a outra. */}
                {[["consolidado", "Consolidado"], ["competencia", "Por competência"],
                  ["vencimento", "Resumo por vencimento"]].map(([k, r]) => (
                  <button key={k} onClick={() => setVista(k)} aria-pressed={vista === k}
                          style={{ ...S.opcao, ...(vista === k ? S.opcaoAtiva : null) }}>{r}</button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div style={S.periodo}>
          <strong style={S.periodoValor}>{periodo}</strong>
          <span style={S.periodoNatureza}>· {natureza}</span>
        </div>
      </div>

      {/* ÁREA GLOBAL — EM DESTAQUE, e fora da análise por safra.
          "Casos ainda pendentes" é indicador da CARTEIRA INTEIRA: caso sem
          nenhum pagamento registrado OU com acordo ativo ainda a receber, união
          sem contar o mesmo caso duas vezes. A regra é a de
          `casos_pendentes_contar()` e nenhuma conta acontece aqui.

          POR QUE SUBIU PARA O TOPO (08/10/2026). Ele estava no fim da página,
          abaixo do comparativo e da metodologia, e na prática ninguém o via --
          a gestão o reportou como ausente. Subiu para cá, acima dos blocos por
          safra, porque é o número que responde "quanto ainda há para trabalhar
          hoje" e isso não depende de qual safra está selecionada.

          FICA FORA DE TODO CONDICIONAL DE VISÃO, de propósito: o número é o
          mesmo em 2024, 2025, 2026/1 e nas três visões de 2026/2, e por isso
          aparece em todas. A régua e o rótulo continuam dizendo que ele NÃO é da
          safra selecionada e não se soma a nenhum número dos blocos abaixo --
          era essa separação que o lugar antigo garantia pela distância, e que
          agora é garantida pelo texto. */}
      <div style={S.areaGlobal}>
        <span style={S.areaGlobalRotulo}>Visão operacional da carteira inteira</span>
        <CasosPendentes />
        <p style={S.discreto}>
          Este número <strong>não é da safra selecionada</strong>: é a carteira operacional de hoje,
          inteira. Não se soma nem se compara com os blocos por safra abaixo.
        </p>
      </div>

      {erro ? <p style={S.erro}>{erro}</p> : null}

      {safra === "2026/2" && vista === "competencia" ? (
        <div style={{ marginTop: 18 }}>
          <EfetividadeCompetencias />
        </div>
      ) : safra === "2026/2" && vista === "vencimento" ? (
        <div style={{ marginTop: 18 }}>
          <EfetividadePorVencimento />
        </div>
      ) : (
        <>
          {/* BLOCO 1. RESUMO DA CARTEIRA — mesmo tamanho e mesma posição em
              toda safra. Some quando a consulta da safra falha; os blocos
              abaixo seguem montando, cada um com o próprio aviso de erro. Antes
              uma falha aqui trocava a página inteira por "Sem dados", e quem
              lia não sabia se não havia dado ou se a consulta tinha caído. */}
          {indicadores.length === 0 ? (
            <p style={{ ...S.discreto, marginTop: 24 }}>Sem dados para {periodo}.</p>
          ) : (
          <div style={S.linhaIndicadores}>
            {indicadores.map((i) => (
              <div key={i.rotulo} style={S.indicador}>
                <span style={{ ...S.indAcento, background: i.cor }} aria-hidden="true" />
                <span style={S.indRotulo}>{i.rotulo}</span>
                <strong style={{ ...S.indValor, color: i.cor }}>{i.valor}</strong>
                <span style={S.indApoio}>{i.apoio}</span>
              </div>
            ))}
          </div>
          )}
          {rodape ? <p style={S.rodapeDiscreto}>{rodape}</p> : null}
          {/* As duas reguas, ditas no lugar onde os dois numeros se encontram. */}
          {safra !== "2026/2" && indicadores.length > 0 ? (
            <p style={S.rodapeDiscreto}>
              <strong>Duas réguas, de propósito.</strong> <em>Universo recebido</em> e{" "}
              <em>Recuperado</em> são a régua da carteira — o que entrou em cobrança e o que foi
              recuperado dele —, e é dela que sai a efetividade. <em>Saldo em aberto atual</em> é a régua
              histórica oficial: a exposição de hoje, já sem o que não é mais cobrável por nós. Por isso os
              dois não se somam nem se subtraem, e é o saldo em aberto atual que o bloco “Quem compõe o
              saldo em aberto” decompõe por status acadêmico.
            </p>
          ) : null}

          {/* BLOCO 2. SITUAÇÃO FINANCEIRA — "as seis linhas da safra" — Entrou, Pago, Negociado,
              Cancelado, Em aberto e Pendente, no mesmo desenho de 2026/2. O
              payload é o mesmo que alimenta o bloco 1 acima: a página busca uma
              vez e passa para os dois, para o topo e o cartão nunca divergirem. */}
          {safra !== "2026/2" ? (
            <SeisLinhasDaSafra ano={ano} semestre={ano === "2026" ? sem : null}
                               dados={situacoes} erro={erroSituacoes}
                               carregando={carregandoSituacoes} />
          ) : null}

          {/* BLOCO 3. QUEM COMPÕE O SALDO EM ABERTO — composição financeira por
              situação acadêmica real. Fora de 2026/2 de propósito: aquela safra
              não tem fonte acadêmica equivalente, e a própria RPC recusa o
              recorte em vez de devolver uma lista vazia. */}
          {safra !== "2026/2" ? (
            <ComposicaoAcademicaDoSaldo dados={composicao} erro={erroComposicao}
                                        carregando={carregandoComposicao} />
          ) : null}

          {/* BLOCO 4. PENDÊNCIAS DE VALIDAÇÃO — por que o pendente está
              pendente, por motivo real, com caminho para a Fila Única. */}
          {safra !== "2026/2" ? (
            <PendenciasDeValidacao ano={ano} semestre={ano === "2026" ? sem : null}
                                   recarga={recarga} />
          ) : null}

          {/* SITUAÇÃO DA CARTEIRA — barras simples, nunca tabela. Só sobrevive
              onde `situacao` tem linha, e hoje isso é SÓ 2026/2: ali as barras
              são os estados do acordo (Quitado / Regular / Em atraso /
              Quebrado / Cancelado), conceito que não tem equivalente nas seis
              linhas. Nas outras safras elas contavam a mesma história das seis
              linhas com outros rótulos, e por isso saíram. */}
          {situacao.length > 0 ? (
          <section style={S.cartao}>
            <div style={S.cartaoCabecalho}>
              <h2 style={S.h2}>{tituloSituacao}</h2>
              {referencia > 0 && referenciaRotulo ? (
                <span style={S.cartaoApoio}>% {referenciaRotulo} · {moeda(referencia)}</span>
              ) : null}
            </div>
            <div>
              {situacao.map((l) => {
                const share = referencia > 0 ? (Number(l.valor || 0) / referencia) * 100 : 0;
                return (
                  <div key={l.rotulo} style={S.linha}>
                    <div style={S.linhaTopo}>
                      <span style={S.linhaRotulo}>
                        <span style={{ ...S.ponto, background: l.cor }} />{l.rotulo}
                      </span>
                      <strong style={S.linhaValor}>{moeda(l.valor)}</strong>
                      <span style={{ ...S.linhaPct, color: l.cor }}>
                        {share.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                      </span>
                    </div>
                    <div style={S.trilho}>
                      <div style={{ ...S.barraPreenchida, width: Math.min(share, 100) + "%",
                                    minWidth: Number(l.valor || 0) > 0 ? 4 : 0, background: l.cor }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          ) : null}

          {/* 3. DE QUE CURSO VEM O SALDO EM ABERTO — só 2024/2025.
              Em 2026/1 esta seção mostrava "Perfil dos alunos", que é a MESMA
              situação acadêmica que `SeisLinhasDaSafra` já desenha em "Alunos
              por status" logo acima: o mesmo conteúdo duas vezes, com dois
              títulos. Ficou o bloco novo, que vale para toda safra. */}
          {cursos ? (
          <section style={S.cartao}>
            <div style={S.cartaoCabecalho}>
              <h2 style={S.h2}>Saldo em aberto por curso</h2>
              {cursos && cursosTotal > 0 ? (
                <span style={S.cartaoApoio}>% do saldo em aberto · {moeda(cursosTotal)}</span>
              ) : null}
            </div>
            {cursos.length > 0 ? (
                <div>
                  {cursos.map((c) => {
                    const share = cursosTotal > 0 ? (Number(c.valor || 0) / cursosTotal) * 100 : 0;
                    return (
                      <div key={c.curso} style={S.linha}>
                        <div style={S.linhaTopo}>
                          <span style={S.linhaRotulo}>
                            <span style={{ ...S.ponto, background: AZUL }} />{c.curso}
                          </span>
                          <strong style={S.linhaValor}>{moeda(c.valor)}</strong>
                          <span style={{ ...S.linhaPct, color: AZUL }}>
                            {share.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                          </span>
                        </div>
                        <span style={S.linhaApoio}>{num(c.alunos)} alunos · {num(c.mensalidades)} mensalidades</span>
                        <div style={S.trilho}>
                          <div style={{ ...S.barraPreenchida, width: Math.min(share, 100) + "%",
                                        minWidth: Number(c.valor || 0) > 0 ? 4 : 0, background: AZUL }} />
                        </div>
                      </div>
                    );
                  })}
                  <p style={{ ...S.discreto, marginTop: 10 }}>
                    Alunos contados uma vez por curso; quem tem mensalidade em dois cursos aparece nos dois.
                    {historico?.sem_semestre?.mensalidades
                      ? " Fora de 2024 e 2025: " + num(historico.sem_semestre.mensalidades)
                        + " mensalidades (" + moeda(historico.sem_semestre.valor) + ") que a Prime não liga a nenhuma série."
                      : ""}
                  </p>
                </div>
              ) : (
                <p style={{ ...S.discreto, marginTop: 8 }}>Sem saldo em aberto neste ano</p>
              )}
          </section>
          ) : null}

          {/* COMPARATIVO ENTRE SAFRAS — compacto e SOB DEMANDA. São três
              consultas ao vivo; abri-las em toda visita custaria caro sem
              ninguém ter pedido a comparação. Fechado, a página não as dispara. */}
          <div style={{ marginTop: 22 }}>
            <button onClick={() => setComparativo((v) => !v)} aria-expanded={comparativo}
                    style={S.linkMetodologia}>
              <span aria-hidden="true">{comparativo ? "▾" : "▸"}</span>
              {comparativo ? "Ocultar comparativo entre safras" : "Comparar as safras"}
            </button>
            {comparativo ? (
              <ComparativoSafras selecionada={safra === "2026/1" ? "2026/1" : ano} recarga={recarga} />
            ) : null}
          </div>

        </>
      )}

      {/* 4. METODOLOGIA — tudo o que é técnico mora aqui, e vale para as duas
          visões de 2026/2: consolidado e por competência. */}
          <div style={{ marginTop: 20 }}>
            <button onClick={() => setMetodologia((v) => !v)} aria-expanded={metodologia}
                    style={S.linkMetodologia}>
              <span aria-hidden="true">{metodologia ? "▾" : "▸"}</span>
              {metodologia ? "Ocultar metodologia" : "Ver metodologia"}
            </button>
            {metodologia ? (
              <div style={{ ...S.cartao, marginTop: 10, gap: 10 }}>
                <p style={S.texto}>
                  <strong>As três naturezas de período.</strong> <em>Carteira consolidada</em> (2026/1): safra fechada,
                  em que as quatro faixas somam 100% da carteira congelada. <em>Semestre vigente</em> (2026/2): o
                  semestre está em curso e há título a vencer, então não se calcula inadimplência — mostra-se só o que
                  já foi negociado e recebido. <em>Cobertura histórica</em> (2024 e 2025): o CRM não guarda nada
                  anterior a julho de 2026, então não há percentual de efetividade — o que existe é o saldo residual
                  que ainda estava aberto quando a carteira entrou em cobrança e as conversões comprovadas desde então.
                  2024 e 2025 são lidos pelo ano inteiro, com os dois semestres juntos; só 2026 se divide por semestre,
                  porque só ali o semestre muda a natureza do período.
                </p>
                <p style={S.texto}>
                  <strong>O saldo em aberto de 2024 e 2025.</strong> Conta só mensalidade original de graduação e pós
                  ainda no portador da Reativa, com o semestre vindo da série de cobrança da Prime — nunca do mês do
                  vencimento, que erra quando há matrícula antecipada. Ficam fora: acordo e parcela de acordo, título
                  que a Prime registra liquidado mais de 30 dias após o vencimento, confirmação de pagamento pendente,
                  caso cancelado ou jurídico, e aluno cujos pagamentos desde julho de 2026 já cobrem tudo o que ele
                  tem aberto no recorte. Cada aluno é contado uma vez no ano.
                </p>
                <p style={S.texto}>
                  <strong>Negociado direto com a Ulbra, a confirmar.</strong> Quando o CPF está no portador 166 da
                  Prime e não há acordo ativo no CRM, houve negociação fora daqui. Isso sai do saldo em aberto e
                  aparece em linha própria, porque a lista do portador existe por CPF e não por título: ela não diz
                  qual mensalidade foi negociada, então o valor é teto de exposição, não prova título a título.
                </p>
                <p style={S.texto}>
                  <strong>Como estes nomes se chamam na metodologia.</strong> Carteira convertida ={" "}
                  <em>efetividade comprovada</em>. Valor recebido = <em>recuperação financeira</em>. Em aberto sem
                  negociação = <em>inadimplência confirmada</em>. Em conferência = <em>em validação</em>. Na situação
                  do valor convertido, “negociado, hoje quebrado” e “negociado, hoje cancelado” continuam dentro do
                  convertido de propósito: a conversão é histórica — o valor foi alcançado pela cobrança, e o que mudou
                  depois foi a situação do acordo.
                </p>
                <p style={S.texto}>
                  <strong>Efetividade comprovada.</strong> Considera somente valores com evidência rastreável de
                  pagamento ou negociação. A efetividade de um título nunca passa do valor original — juros, multa e
                  honorários não aumentam a carteira recuperada. Um título negociado e depois pago não soma duas vezes:
                  o valor apenas muda de linha.
                </p>
                <p style={S.texto}>
                  <strong>Em conferência.</strong> Casos com indício de conversão, mas sem evidência suficiente para
                  classificação definitiva. Aparecem separados e não aumentam a carteira convertida.
                </p>
                <p style={S.texto}>
                  <strong>Precedência das fontes.</strong> A situação atual é do Prime — série e semestre do título,
                  título aberto ou liquidado, portador, matrícula e situação acadêmica. O estado do CRM não sobrepõe
                  informação disponível no Prime. O histórico de conversão (acordos, parcelas, pagamentos recebidos e
                  eventos de cobrança) vem do CRM e das importações operacionais, porque a API do Prime não entrega
                  esses dados. Quando o Prime não tem linha para o título, ninguém confirma que ele segue aberto: o
                  valor fica em conferência, nunca em aberto sem negociação.
                </p>
                <p style={S.texto}>
                  <strong>Situação atual não decide histórico.</strong> Está medido que um título negociado pode voltar
                  a aparecer aberto no Prime quando o acordo quebra — em 28,7% dos casos. Por isso “aberto hoje” nunca
                  é lido como “nunca foi negociado”.
                </p>
                <p style={S.texto}>
                  <strong>Histórico.</strong> O histórico estruturado de pagamentos disponível no CRM inicia em julho
                  de 2026. Vínculos anteriores ou não preservados integralmente podem permanecer em conferência até sua
                  reconstrução.
                </p>
                <p style={S.texto}>
                  <strong>Perfil dos alunos.</strong> Situação acadêmica vinda do Prime, por CPF único, para os alunos
                  que ainda têm pendência na carteira. Matrícula confirmada com dívida aberta aparece como exceção — o
                  aluno só efetiva matrícula com a ficha regularizada — e o painel não afirma a razão da exceção.
                </p>
                <p style={S.texto}>
                  <strong>2026/2 por competência.</strong> Mesmo dado do consolidado, quebrado pelo mês de
                  competência da mensalidade — o mês do vencimento. Não é o borderô, que é artefato interno de
                  importação e não identifica nada para quem lê: quatro borderôs caem em agosto de 2026 e quatro em
                  julho, e o que os separa é a modalidade, que só existe dentro do nome do arquivo. Também não é a
                  coluna de competência do título, que está nula em toda a safra. O título pertence ao semestre pela
                  série de cobrança do Prime e, só onde a série não existe, pelo vencimento — nunca pela data em que o
                  arquivo foi importado nem pelo semestre do cadastro do aluno, que rotula o aluno inteiro e não serve
                  como dimensão de carteira.
                  <em>Entradas</em> é entrada na carteira, não entrada financeira de acordo. <em>Recuperado</em> é a
                  mesma recuperação financeira do consolidado: o valor original rateado pelo percentual de parcelas
                  pagas do acordo, ou o valor original menos o saldo quando o próprio título está pago — nunca acima do
                  valor original. <em>Cancelados</em> conta o título cuja cobrança saiu da base; acordo cancelado é
                  outro conceito, fica em campo próprio e não retira o que já havia sido convertido, porque a conversão
                  é histórica. Recuperação e conversão têm a mesma base declarada em cada card: o valor original que
                  entrou naquela competência.
                </p>
              </div>
            ) : null}
          </div>
    </div>
  );
}

const S = {
  pagina: { padding: "28px 24px 56px", color: "var(--rv-tinta)", maxWidth: 1120, margin: "0 auto" },
  h1: { margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em", fontFamily: "'Sora', Inter, sans-serif" },
  h2: { margin: 0, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)" },
  tituloLinha: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },

  // ---- escolha do período (controles + identidade, no mesmo bloco) ----
  painelPeriodo: { marginTop: 18, background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)",
                   borderRadius: 14, padding: "12px 16px", display: "flex", alignItems: "center",
                   justifyContent: "space-between", gap: 14, flexWrap: "wrap", boxShadow: "var(--rv-sombra)",
                   maxWidth: "100%" },
  navegacao: { display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" },
  // flexWrap + minWidth 0: em 375px de largura os dois botões de semestre não
  // caberiam na linha e vazavam a tela; aqui eles quebram dentro da própria
  // pílula em vez de criar rolagem horizontal.
  navBloco: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 },
  navRotulo: { fontSize: 11, color: "var(--rv-texto-fraco)", fontWeight: 700, textTransform: "uppercase",
               letterSpacing: "0.06em" },
  grupo: { display: "inline-flex", flexWrap: "wrap", maxWidth: "100%", background: "var(--rv-fundo-suave)",
           borderRadius: 10, padding: 3, gap: 3 },
  opcao: { background: "none", border: "none", cursor: "pointer", padding: "7px 15px", borderRadius: 8,
           fontSize: 14, fontWeight: 500, color: "var(--rv-texto-suave)", fontFamily: "inherit" },
  opcaoAtiva: { background: "var(--rv-superficie)", color: "var(--rv-tinta)", fontWeight: 700,
                boxShadow: "0 1px 3px rgba(15,23,42,0.10)" },
  chip: { fontSize: 12.5, color: "var(--rv-texto-suave)", background: "var(--rv-fundo-suave)",
          border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "5px 12px" },

  periodo: { display: "flex", alignItems: "baseline", gap: 8, marginLeft: "auto" },
  periodoValor: { fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em",
                  fontFamily: "'Sora', Inter, sans-serif" },
  periodoNatureza: { fontSize: 13.5, color: "var(--rv-texto-suave)" },

  // ---- os quatro indicadores ----
  linhaIndicadores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(214px, 1fr))", gap: 16,
                      marginTop: 20 },
  indicador: { position: "relative", display: "flex", flexDirection: "column", gap: 5, minHeight: 104,
               background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 14,
               padding: "16px 18px 15px", boxShadow: "var(--rv-sombra)", overflow: "hidden" },
  indAcento: { position: "absolute", top: 0, left: 0, right: 0, height: 3 },
  // minHeight reserva DUAS linhas de rótulo: sem isso, "Em aberto sem
  // negociação" quebra em duas e o valor desce, desalinhando dos outros três.
  indRotulo: { fontSize: 12, fontWeight: 700, letterSpacing: "0.03em", textTransform: "uppercase",
               color: "var(--rv-texto-fraco)", lineHeight: 1.3, minHeight: 31 },
  indValor: { fontSize: 29, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em",
              fontFamily: "'Sora', Inter, sans-serif", fontVariantNumeric: "tabular-nums" },
  indApoio: { fontSize: 12.5, color: "var(--rv-texto-suave)", marginTop: "auto" },
  rodapeDiscreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)", marginTop: 14, lineHeight: 1.6 },

  // ---- cartões de seção ----
  cartao: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16,
            padding: "18px 22px 20px", marginTop: 20,
            boxShadow: "var(--rv-sombra)", display: "flex", flexDirection: "column", gap: 4 },
  cartaoCabecalho: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12,
                     flexWrap: "wrap", paddingBottom: 10, borderBottom: "1px solid var(--rv-borda-suave)",
                     marginBottom: 4 },
  cartaoApoio: { fontSize: 12, color: "var(--rv-texto-fraco)", fontVariantNumeric: "tabular-nums" },

  // ---- linha com barra: rótulo | valor | percentual, sempre alinhados ----
  linha: { padding: "11px 0" },
  linhaTopo: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "baseline",
               columnGap: 14 },
  linhaRotulo: { fontSize: 14, fontWeight: 600, minWidth: 0 },
  linhaValor: { fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  linhaPct: { fontSize: 14, fontWeight: 700, minWidth: 58, textAlign: "right",
              fontVariantNumeric: "tabular-nums" },
  linhaApoio: { display: "block", fontSize: 12, color: "var(--rv-texto-fraco)", marginTop: 3 },
  ponto: { display: "inline-block", width: 9, height: 9, borderRadius: 3, marginRight: 8 },
  trilho: { background: "var(--rv-fundo-suave)", borderRadius: 999, height: 7, overflow: "hidden", marginTop: 8 },
  // minWidth de 4px na barra: 1% de uma carteira de R$ 5 mi é real e não pode
  // desaparecer no trilho.
  barraPreenchida: { height: "100%", borderRadius: 999 },

  linkMetodologia: { display: "inline-flex", alignItems: "center", gap: 7, background: "var(--rv-superficie)",
                     border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "7px 14px",
                     cursor: "pointer", fontFamily: "inherit", color: "var(--rv-azul-texto)", fontSize: 13,
                     fontWeight: 600 },
  texto: { margin: 0, fontSize: 13, color: "var(--rv-texto-suave)", lineHeight: 1.6 },
  discreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)", lineHeight: 1.6 },
  selo: { background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda-suave)",
          color: "var(--rv-texto-suave)", borderRadius: 999, padding: "3px 10px", fontSize: 11.5,
          fontWeight: 600, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.02em" },
  seloTexto: { margin: "8px 0 0", fontSize: 12.5, color: "var(--rv-texto-fraco)", maxWidth: 620, lineHeight: 1.5 },
  emBreve: { marginTop: 28, background: "var(--rv-superficie)", borderRadius: 16, padding: "40px 32px",
             boxShadow: "var(--rv-sombra)", border: "1px solid var(--rv-borda-suave)",
             display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 },
  erro: { color: "var(--rv-vermelho-texto)", fontSize: 13, marginTop: 14 },

  // A régua que separa a análise por safra da visão operacional global. É
  // visual de propósito: os dois universos não se somam, e a tela precisa
  // dizer isso antes do número, não depois.
  areaGlobal: { marginTop: 18, paddingBottom: 18, borderBottom: "2px solid var(--rv-borda-suave)" },
  areaGlobalRotulo: { display: "block", fontSize: 11, fontWeight: 700, letterSpacing: "0.07em",
                      textTransform: "uppercase", color: "var(--rv-texto-fraco)", marginBottom: 6 },
};
