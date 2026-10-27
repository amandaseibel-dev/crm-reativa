// Catálogo de tabulações -- fonte única do frontend para PRAZO de retorno e
// PRÓXIMA AÇÃO de cada tabulação.
//
// Antes, a régua de retorno estava duplicada e divergente: o modal da Minha
// Carteira tinha uma tabela fixa no código (Mensagem enviada = 2 dias úteis),
// o botão rápido "✅ Mensagem enviada" não agendava retorno nenhum (o caso
// voltava para a fila no dia seguinte), a ficha só gravava a data digitada e
// o e-mail usava o prazo da arte. A gestão mudou o catálogo (public.tabulacoes)
// e nada aconteceu, porque ninguém lia o catálogo.
//
// REGRA CENTRAL -- "respeitar o que já está agendado até o novo agendamento":
// este módulo só é consultado no MOMENTO em que o operador tabula. Ele nunca
// reescreve `data_retorno` de ninguém. Mudar o prazo de uma tabulação não mexe
// em agendamento existente.
//
// FALLBACK: se a consulta ao catálogo falhar (rede, RLS), o CRM não pode ficar
// sem régua. Cai no FALLBACK abaixo, cópia do catálogo de produção.

import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Cópia do catálogo de produção (04/09/2026). Só entra em cena se o banco não
// responder -- não é a fonte de verdade.
export const FALLBACK_TABULACOES = [
  { codigo: "CONTATAR", rotulo: "A contatar", ordem: 10, grupo: "CONTATO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  // 5 dias úteis = a mesma data da semana seguinte (7 dias corridos, sempre em
  // dia útil): fecha com a fidelização de 10 dias e com o rótulo "Dentro do
  // prazo" (até 7 dias) da carteira. Ver migration 20260904150000.
  { codigo: "MENSAGEM_ENVIADA", rotulo: "Mensagem enviada", ordem: 20, grupo: "CONTATO", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 5, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "EM_ATENDIMENTO", rotulo: "Em atendimento", ordem: 30, grupo: "CONTATO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "ALUNO_EM_NEGOCIACAO_24H", rotulo: "Em negociação", ordem: 40, grupo: "CONTATO", retorno_modo: "MANUAL", retorno_dias_uteis: null, proxima_acao: "RETORNAR", ativa: true },
  { codigo: "RETORNAR_DEPOIS", rotulo: "Retornar depois", ordem: 50, grupo: "CONTATO", retorno_modo: "MANUAL", retorno_dias_uteis: null, proxima_acao: "RETORNAR", ativa: true },
  { codigo: "SEM_RETORNO", rotulo: "Sem retorno", ordem: 60, grupo: "CONTATO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "NAO_LOCALIZADO", rotulo: "Não localizado", ordem: 70, grupo: "CONTATO", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 1, proxima_acao: "TENTAR_NOVO_CONTATO", ativa: true },
  { codigo: "AGUARDANDO_LINK", rotulo: "Aguardando link", ordem: 110, grupo: "LINK", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 1, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "SOLICITADO_LINK", rotulo: "Link solicitado", ordem: 120, grupo: "LINK", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 1, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "LINK_PRONTO_PARA_ENVIO", rotulo: "Link pronto p/ envio", ordem: 130, grupo: "LINK", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 1, proxima_acao: "ENVIAR_LINK_AO_ALUNO", ativa: true },
  { codigo: "LINK_ENVIADO_AO_ALUNO", rotulo: "Link enviado ao aluno", ordem: 140, grupo: "LINK", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: false },
  { codigo: "AGUARDANDO_COMPROVANTE", rotulo: "Aguardando comprovante", ordem: 150, grupo: "LINK", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 3, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "TERMO_ENVIADO_ALUNO", rotulo: "Termo enviado ao aluno", ordem: 210, grupo: "TERMO", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 2, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "TERMO_ENVIADO_ADM", rotulo: "Enviado ao ADM", ordem: 220, grupo: "TERMO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "TERMO_RECEBIDO_LIBERADO", rotulo: "Termo liberado", ordem: 230, grupo: "TERMO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "TERMO_REJEITADO", rotulo: "Termo rejeitado", ordem: 240, grupo: "TERMO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "ACORDO_FECHADO", rotulo: "Acordo fechado", ordem: 250, grupo: "TERMO", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 2, proxima_acao: "ACOMPANHAR_PAGAMENTO", ativa: true },
  { codigo: "AGUARDANDO_BAIXA", rotulo: "Aguardando baixa", ordem: 310, grupo: "FINANCEIRO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "BAIXA_REALIZADA", rotulo: "Baixa realizada", ordem: 320, grupo: "FINANCEIRO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "BAIXA_DEVOLVIDA", rotulo: "Baixa devolvida", ordem: 330, grupo: "FINANCEIRO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "ELOGIO_ATENDIMENTO", rotulo: "Elogio de atendimento", ordem: 410, grupo: "ENCERRAMENTO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "CANCELAMENTO_COBRANCA", rotulo: "Cancelamento definitivo de cobrança", ordem: 420, grupo: "ENCERRAMENTO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "SUSPENSAO_COBRANCA", rotulo: "Suspensão de cobrança", ordem: 430, grupo: "ENCERRAMENTO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "JURIDICO", rotulo: "Jurídico", ordem: 440, grupo: "ENCERRAMENTO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: true },
  { codigo: "QUITADO_MANUAL", rotulo: "Quitado", ordem: 450, grupo: "ENCERRAMENTO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", ativa: false },
];

const COLUNAS = "codigo,rotulo,ativa,ordem,grupo,retorno_modo,retorno_dias_uteis,proxima_acao";

// Cache de módulo: o catálogo muda raramente e é lido em várias telas ao mesmo
// tempo. Sem isto, cada tabulação faria seu próprio SELECT.
let cacheCatalogo = null;
let cachePromessa = null;

export function invalidarCacheTabulacoes() {
  cacheCatalogo = null;
  cachePromessa = null;
}

export async function carregarTabulacoes({ forcar = false } = {}) {
  if (!forcar && cacheCatalogo) return cacheCatalogo;
  if (!forcar && cachePromessa) return cachePromessa;

  cachePromessa = (async () => {
    try {
      const { data, error } = await supabase
        .from("tabulacoes")
        .select(COLUNAS)
        .order("ordem", { ascending: true })
        .order("rotulo", { ascending: true });
      if (error) throw error;
      if (!data?.length) throw new Error("catálogo de tabulações vazio");
      cacheCatalogo = data;
    } catch (err) {
      // Não derruba o CRM: sem catálogo, o operador ainda tabula pela régua
      // de produção copiada acima. O erro fica no console para diagnóstico.
      console.error("Falha ao carregar tabulações; usando fallback local:", err);
      cacheCatalogo = FALLBACK_TABULACOES;
    } finally {
      cachePromessa = null;
    }
    return cacheCatalogo;
  })();

  return cachePromessa;
}

// Hook para telas que mostram a regra ao vivo (ex.: "Retorno: 5 dias úteis"
// embaixo do select). Enquanto carrega, usa o fallback.
export function useTabulacoes() {
  const [tabulacoes, setTabulacoes] = useState(cacheCatalogo || FALLBACK_TABULACOES);
  const [carregando, setCarregando] = useState(!cacheCatalogo);

  useEffect(() => {
    let vivo = true;
    carregarTabulacoes().then((lista) => {
      if (!vivo) return;
      setTabulacoes(lista);
      setCarregando(false);
    });
    return () => {
      vivo = false;
    };
  }, []);

  return { tabulacoes, carregando };
}

export function acharTabulacao(catalogo, codigo) {
  if (!codigo) return null;
  const alvo = String(codigo).trim().toUpperCase();
  return (catalogo || []).find((t) => String(t.codigo).toUpperCase() === alvo) || null;
}

export function proximaAcaoDeTabulacao(catalogo, codigo) {
  return acharTabulacao(catalogo, codigo)?.proxima_acao || "CONTATAR";
}

// true quando a tabulação espera que o operador escolha a data na mão.
export function retornoEhManual(catalogo, codigo) {
  return acharTabulacao(catalogo, codigo)?.retorno_modo === "MANUAL";
}

// "YYYY-MM-DD" em data LOCAL. Nunca toISOString(): depois das 21h o fuso
// jogaria a data um dia para frente.
export function formatarDataISOLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "YYYY-MM-DD" -> "DD/MM/YYYY" sem passar por Date (que leria como UTC e
// mostraria o dia anterior).
export function dataBRDeISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
}

// Soma n dias úteis (seg-sex; feriados não entram) a partir de `base`.
export function adicionarDiasUteis(base, n) {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  let add = 0;
  while (add < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) add += 1;
  }
  return d;
}

// Data "YYYY-MM-DD" que a tabulação agenda sozinha quando o operador não
// digita data. null quando a tabulação não agenda (NENHUM, MANUAL, código
// fora do catálogo).
export function retornoAutomaticoDeTabulacao(catalogo, codigo, hoje = new Date()) {
  const t = acharTabulacao(catalogo, codigo);
  if (!t || t.retorno_modo !== "DIAS_UTEIS") return null;
  const dias = Number(t.retorno_dias_uteis);
  if (!Number.isFinite(dias) || dias < 0) return null;
  return formatarDataISOLocal(adicionarDiasUteis(hoje, dias));
}

// Texto humano da regra, para o operador saber o que vai acontecer.
export function descreverPrazo(catalogo, codigo) {
  const t = acharTabulacao(catalogo, codigo);
  if (!t) return "sem retorno automático";
  if (t.retorno_modo === "MANUAL") return "data escolhida pelo operador";
  if (t.retorno_modo !== "DIAS_UTEIS") return "sem retorno automático";
  const n = Number(t.retorno_dias_uteis);
  if (!Number.isFinite(n) || n < 0) return "sem retorno automático";
  if (n === 0) return "hoje";
  return n === 1 ? "1 dia útil" : `${n} dias úteis`;
}

// O que gravar na ficha ao tabular `codigo`. Uma regra só para o botão rápido,
// o modal da Carteira, a ficha do aluno e o e-mail:
//   1. data digitada pelo operador -> vale ela, origem OPERADOR (compromisso,
//      aparece na Agenda);
//   2. sem data digitada, mas já existe uma data FUTURA marcada pelo operador
//      -> fica (a tabulação de hoje não apaga o compromisso de amanhã);
//   3. senão, a tabulação agenda pelo catálogo, origem AUTOMATICO;
//   4. tabulação sem prazo -> não mexe em data_retorno (o motor da fila cuida).
// Devolve `motivo` para a tela explicar o que fez.
// COMPROMISSO FUTURO DO OPERADOR -- o predicado que diz "aqui tem combinado
// com o aluno, e ainda não chegou a hora". Uma função só, usada pelo
// `desfechoDaTabulacao` (caso MANTIDA) e pelo `camposDeRetorno` (prazo
// automático que não pode passar por cima do combinado). `hoje` é a data
// LOCAL: comparar com `current_date` em UTC vira retorno vencido às 21h.
export function compromissoFuturoDoOperador(retornoAtual, hoje = new Date()) {
  const hojeISO = formatarDataISOLocal(new Date(hoje));
  const atualData = String(retornoAtual?.data || "").slice(0, 10);
  const atualOrigem = String(retornoAtual?.origem || "");
  if (!atualData || !atualOrigem.startsWith("OPERADOR")) return null;
  if (!(atualData > hojeISO)) return null;
  return { data: atualData, origem: atualOrigem };
}

export function desfechoDaTabulacao(catalogo, codigo, { hoje = new Date(), dataDigitada = "", retornoAtual = null } = {}) {
  const proxima_acao = proximaAcaoDeTabulacao(catalogo, codigo);
  const digitada = String(dataDigitada || "").trim();
  if (digitada) {
    return { proxima_acao, data_retorno: digitada, retorno_origem: "OPERADOR", motivo: "DIGITADA" };
  }
  const mantido = compromissoFuturoDoOperador(retornoAtual, hoje);
  if (mantido) {
    return { proxima_acao, data_retorno: mantido.data, retorno_origem: mantido.origem, motivo: "MANTIDA" };
  }
  const automatica = retornoAutomaticoDeTabulacao(catalogo, codigo, hoje);
  if (automatica) {
    return { proxima_acao, data_retorno: automatica, retorno_origem: "AUTOMATICO", motivo: "AUTOMATICA" };
  }
  return { proxima_acao, motivo: "NENHUMA" };
}

// ---------------------------------------------------------------------------
// CARIMBO DO RETORNO -- `data_retorno` sem `retorno_origem` é retorno sem dono.
//
// `desfechoDaTabulacao`, acima, resolve o caminho da TABULAÇÃO -- o único que
// consulta o catálogo. Mas nem todo retorno nasce de tabulação: o lote de
// e-mail agenda pelo prazo da arte, o financeiro e o ADM empurram +7 dias ao
// encaminhar o caso, e a troca de responsável aceita uma data digitada. Esses
// pontos gravavam `data_retorno` e deixavam `retorno_origem` como estava --
// então o prazo de máquina herdava o selo OPERADOR do compromisso anterior (e
// aparecia no "Meu dia" como compromisso que ninguém marcou), enquanto a data
// que o operador digitou fora da tabulação nascia AUTOMATICO e não aparecia.
// Medido em 15 e 22/10/2026: só 3,2% dos 13.293 retornos tinham selo OPERADOR,
// e 141 dos 183 "retornos de hoje" vinham de um lote de quatro meses antes.
//
// Quem chama DECLARA a origem -- aqui não há inferência:
//   * OPERADOR   -> um humano digitou aquela data naquele atendimento;
//   * AUTOMATICO -> a data vem de regra ou de prazo do sistema.
//
// Hora e prioridade pertencem ao COMPROMISSO, não ao prazo: o prazo automático
// que substitui o retorno anterior apaga as duas; a data do operador preserva
// o que já havia (ou grava o que ele digitou, quando a tela tem os campos).
// Sem data não se grava nada -- apagar retorno é decisão de quem chama.
//
// PRESERVAÇÃO DO COMBINADO (decisão da gestão, 27/10/2026): prazo AUTOMATICO
// não passa por cima de compromisso OPERADOR com data futura. Quem passa
// `retornoAtual` ganha a proteção: o helper devolve `{}` e a tela grava só o
// status, deixando data, hora e prioridade intactas. É o mesmo predicado do
// caso MANTIDA da tabulação (`compromissoFuturoDoOperador`), não uma régua
// nova. Sem `retornoAtual` o comportamento é o de antes -- sobrescreve --, e é
// por isso que a catraca dos testes cobra a leitura nos pontos automáticos.
// A ORIGEM OPERADOR NÃO É PROTEGIDA CONTRA SI MESMA: operador digitando data
// nova é o novo combinado, e deve mesmo substituir o anterior.
export const RETORNO_ORIGEM_OPERADOR = "OPERADOR";
export const RETORNO_ORIGEM_AUTOMATICO = "AUTOMATICO";

// Apagar o retorno também é decisão com carimbo: sai a data, sai a origem, sai
// a hora e cai a prioridade (as duas últimas eram do compromisso que acabou).
// Em `public.alunos` o gatilho `limpar_retorno_origem` ainda é rede de
// segurança para a origem; mandar os quatro explicitamente é o que faz a tela
// não depender dela.
export const CAMPOS_RETORNO_LIMPO = Object.freeze({
  data_retorno: null,
  retorno_origem: null,
  hora_retorno: null,
  retorno_prioritario: false,
});

export function camposDeRetorno(origem, data, { hora = null, prioritario = null, retornoAtual = null, hoje = new Date() } = {}) {
  if (origem !== RETORNO_ORIGEM_OPERADOR && origem !== RETORNO_ORIGEM_AUTOMATICO) {
    throw new Error("camposDeRetorno: origem tem que ser OPERADOR ou AUTOMATICO");
  }
  // O valor da data passa INTACTO (pode ser "YYYY-MM-DD" ou timestamp ISO,
  // conforme a tela); só a checagem de vazio o converte para texto.
  if (data === null || data === undefined || String(data).trim() === "") return {};
  if (origem === RETORNO_ORIGEM_AUTOMATICO) {
    if (compromissoFuturoDoOperador(retornoAtual, hoje)) return {};
    return {
      data_retorno: data,
      retorno_origem: RETORNO_ORIGEM_AUTOMATICO,
      hora_retorno: null,
      retorno_prioritario: false,
    };
  }
  const campos = { data_retorno: data, retorno_origem: RETORNO_ORIGEM_OPERADOR };
  if (hora !== null) campos.hora_retorno = hora || null;
  if (prioritario !== null) campos.retorno_prioritario = Boolean(prioritario);
  return campos;
}

// O prazo automático precisa saber o que já está marcado na ficha antes de
// gravar. Esta é a única leitura do repositório para isso, para que os três
// pontos automáticos (lote de e-mail, +7 do financeiro, +7 do ADM) não
// escrevam cada um a sua consulta.
//
// FALHA FECHA, NÃO ABRE: `ok: false` quer dizer "não consegui saber", e quem
// chama então NÃO toca em `data_retorno`. Perder o prazo de acompanhamento por
// uma falha de rede é menos grave que apagar um compromisso combinado com o
// aluno -- e o encaminhamento em si (o status) continua sendo gravado.
export async function lerRetornoAtual(alunoId) {
  if (!alunoId) return { ok: false, retorno: null };
  const { data, error } = await supabase
    .from("alunos")
    .select("data_retorno,retorno_origem")
    .eq("id", alunoId)
    .maybeSingle();
  if (error) return { ok: false, retorno: null };
  return { ok: true, retorno: data ? { data: data.data_retorno, origem: data.retorno_origem } : null };
}

// Açúcar para os pontos automáticos: lê a ficha e devolve os campos a gravar,
// já com a preservação do combinado aplicada. `{}` significa "não mexa no
// retorno" -- por compromisso futuro do operador OU por leitura que falhou.
export async function camposDeRetornoAutomatico(alunoId, data, { hoje = new Date() } = {}) {
  const atual = await lerRetornoAtual(alunoId);
  if (!atual.ok) return {};
  return camposDeRetorno(RETORNO_ORIGEM_AUTOMATICO, data, { retornoAtual: atual.retorno, hoje });
}
