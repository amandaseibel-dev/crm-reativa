// Catálogo de tabulações -- fonte única do frontend.
//
// Antes, a lista de tabulações e as regras derivadas dela (rótulo visível,
// próxima ação, prazo de retorno automático, bloco da ficha que abre) estavam
// hardcoded e DUPLICADAS em 5 arquivos, já divergentes entre si. Agora tudo
// vem da tabela public.tabulacoes, que a gestão edita pela tela /tabulacoes.
//
// REGRA CENTRAL -- "respeitar o que já está agendado até o novo agendamento":
// este módulo só é consultado no MOMENTO em que o operador tabula. Ele nunca
// reescreve `data_retorno` de ninguém. Mudar o prazo de uma tabulação, ou
// desativá-la, não mexe em nenhum agendamento existente -- quem está marcado
// pro dia 25 continua no dia 25 até ser tabulado de novo.
//
// FALLBACK: se a consulta ao catálogo falhar (rede, RLS, migration ainda não
// aplicada), o CRM NÃO pode ficar sem lista de tabular. Cai no FALLBACK abaixo,
// que é uma cópia exata do que estava hardcoded antes desta mudança.

import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Cópia fiel do comportamento anterior ao catálogo. Só entra em cena se o
// banco não responder -- não é a fonte de verdade.
export const FALLBACK_TABULACOES = [
  { codigo: "CONTATAR", rotulo: "A contatar", ordem: 10, grupo: "CONTATO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: null, exige_processo: false, bloqueia_acionamento: false, sistema: false, ativa: true },
  { codigo: "MENSAGEM_ENVIADA", rotulo: "Mensagem enviada", ordem: 20, grupo: "CONTATO", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 2, proxima_acao: "CONTATAR", bloco_ficha: null, exige_processo: false, bloqueia_acionamento: false, sistema: false, ativa: true },
  { codigo: "EM_ATENDIMENTO", rotulo: "Em atendimento", ordem: 30, grupo: "CONTATO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: null, exige_processo: false, bloqueia_acionamento: false, sistema: false, ativa: true },
  { codigo: "ALUNO_EM_NEGOCIACAO_24H", rotulo: "Em negociação", ordem: 40, grupo: "CONTATO", retorno_modo: "MANUAL", retorno_dias_uteis: null, proxima_acao: "RETORNAR", bloco_ficha: null, exige_processo: false, bloqueia_acionamento: false, sistema: false, ativa: true },
  { codigo: "RETORNAR_DEPOIS", rotulo: "Retornar depois", ordem: 50, grupo: "CONTATO", retorno_modo: "MANUAL", retorno_dias_uteis: null, proxima_acao: "RETORNAR", bloco_ficha: null, exige_processo: false, bloqueia_acionamento: false, sistema: false, ativa: true },
  { codigo: "SEM_RETORNO", rotulo: "Sem retorno", ordem: 60, grupo: "CONTATO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: null, exige_processo: false, bloqueia_acionamento: false, sistema: false, ativa: true },
  { codigo: "NAO_LOCALIZADO", rotulo: "Não localizado", ordem: 70, grupo: "CONTATO", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 1, proxima_acao: "TENTAR_NOVO_CONTATO", bloco_ficha: null, exige_processo: false, bloqueia_acionamento: false, sistema: false, ativa: true },
  { codigo: "AGUARDANDO_LINK", rotulo: "Aguardando link", ordem: 110, grupo: "LINK", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 1, proxima_acao: "CONTATAR", bloco_ficha: "link", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "SOLICITADO_LINK", rotulo: "Link solicitado", ordem: 120, grupo: "LINK", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 1, proxima_acao: "CONTATAR", bloco_ficha: "link", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "LINK_PRONTO_PARA_ENVIO", rotulo: "Link pronto p/ envio", ordem: 130, grupo: "LINK", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 1, proxima_acao: "ENVIAR_LINK_AO_ALUNO", bloco_ficha: "link", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "LINK_ENVIADO_AO_ALUNO", rotulo: "Link enviado ao aluno", ordem: 140, grupo: "LINK", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: "link", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: false },
  { codigo: "AGUARDANDO_COMPROVANTE", rotulo: "Aguardando comprovante", ordem: 150, grupo: "LINK", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 3, proxima_acao: "CONTATAR", bloco_ficha: "link", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "TERMO_ENVIADO_ALUNO", rotulo: "Termo enviado ao aluno", ordem: 210, grupo: "TERMO", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 2, proxima_acao: "CONTATAR", bloco_ficha: "termo", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "TERMO_ENVIADO_ADM", rotulo: "Enviado ao ADM", ordem: 220, grupo: "TERMO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: "termo", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "TERMO_RECEBIDO_LIBERADO", rotulo: "Termo liberado", ordem: 230, grupo: "TERMO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: "termo", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "TERMO_REJEITADO", rotulo: "Termo rejeitado", ordem: 240, grupo: "TERMO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: "termo", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "ACORDO_FECHADO", rotulo: "Acordo fechado", ordem: 250, grupo: "TERMO", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 2, proxima_acao: "ACOMPANHAR_PAGAMENTO", bloco_ficha: "termo", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "AGUARDANDO_BAIXA", rotulo: "Aguardando baixa", ordem: 310, grupo: "FINANCEIRO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: "financeiro", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "BAIXA_REALIZADA", rotulo: "Baixa realizada", ordem: 320, grupo: "FINANCEIRO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: "confirmar", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "BAIXA_DEVOLVIDA", rotulo: "Baixa devolvida", ordem: 330, grupo: "FINANCEIRO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: "confirmar", exige_processo: false, bloqueia_acionamento: false, sistema: true, ativa: true },
  { codigo: "ELOGIO_ATENDIMENTO", rotulo: "Elogio de atendimento", ordem: 410, grupo: "ENCERRAMENTO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: null, exige_processo: false, bloqueia_acionamento: false, sistema: false, ativa: true },
  { codigo: "CANCELAMENTO_COBRANCA", rotulo: "Cancelamento definitivo de cobrança", ordem: 420, grupo: "ENCERRAMENTO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: null, exige_processo: true, bloqueia_acionamento: true, sistema: true, ativa: true },
  { codigo: "SUSPENSAO_COBRANCA", rotulo: "Suspensão de cobrança", ordem: 430, grupo: "ENCERRAMENTO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: null, exige_processo: true, bloqueia_acionamento: true, sistema: true, ativa: true },
  { codigo: "JURIDICO", rotulo: "Jurídico", ordem: 440, grupo: "ENCERRAMENTO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: null, exige_processo: true, bloqueia_acionamento: true, sistema: true, ativa: true },
  { codigo: "QUITADO_MANUAL", rotulo: "Quitado", ordem: 450, grupo: "ENCERRAMENTO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR", bloco_ficha: null, exige_processo: false, bloqueia_acionamento: true, sistema: true, ativa: false },
];

export const GRUPOS_TABULACAO = [
  { chave: "CONTATO", rotulo: "Contato" },
  { chave: "LINK", rotulo: "Link de pagamento" },
  { chave: "TERMO", rotulo: "Termo / acordo" },
  { chave: "FINANCEIRO", rotulo: "Financeiro / baixa" },
  { chave: "ENCERRAMENTO", rotulo: "Encerramento" },
];

export const MODOS_RETORNO = [
  { chave: "NENHUM", rotulo: "Não agenda retorno" },
  { chave: "MANUAL", rotulo: "Operador escolhe a data" },
  { chave: "DIAS_UTEIS", rotulo: "Agenda em X dias úteis" },
];

export const PROXIMAS_ACOES = [
  "CONTATAR",
  "RETORNAR",
  "TENTAR_NOVO_CONTATO",
  "ENVIAR_LINK_AO_ALUNO",
  "ACOMPANHAR_PAGAMENTO",
];

// Cache de módulo: o catálogo muda raramente e é lido em várias telas ao mesmo
// tempo (carteira, ficha, fila, agenda). Sem isto, cada tela faria seu próprio
// SELECT a cada montagem.
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
        .select(
          "codigo,rotulo,ativa,ordem,grupo,retorno_modo,retorno_dias_uteis," +
            "proxima_acao,bloco_ficha,exige_processo,bloqueia_acionamento,sistema"
        )
        .order("ordem", { ascending: true })
        .order("rotulo", { ascending: true });
      if (error) throw error;
      if (!data?.length) throw new Error("catálogo de tabulações vazio");
      cacheCatalogo = data;
    } catch (err) {
      // Não derruba o CRM: sem catálogo, o operador ainda tabula pela lista
      // que existia antes. O erro fica no console pra diagnóstico.
      console.error("Falha ao carregar tabulações; usando fallback local:", err);
      cacheCatalogo = FALLBACK_TABULACOES;
    } finally {
      cachePromessa = null;
    }
    return cacheCatalogo;
  })();

  return cachePromessa;
}

// Hook padrão das telas. Devolve o catálogo completo (ativas + inativas) --
// as inativas são necessárias pra resolver rótulo de quem já está nelas.
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

  return { tabulacoes, carregando, recarregar: () => carregarTabulacoes({ forcar: true }).then(setTabulacoes) };
}

export function acharTabulacao(catalogo, codigo) {
  if (!codigo) return null;
  const alvo = String(codigo).trim().toUpperCase();
  return (catalogo || []).find((t) => String(t.codigo).toUpperCase() === alvo) || null;
}

// Opções que o operador pode escolher AGORA. `codigoAtual` é sempre incluído
// mesmo se estiver inativo -- senão o <select> não acharia o valor corrente e
// o navegador trocaria silenciosamente a tabulação do aluno pela primeira da
// lista, sem ninguém pedir.
export function opcoesTabulacao(catalogo, codigoAtual, { podeVerTudo = false } = {}) {
  const lista = (catalogo || []).filter((t) => {
    if (!t.ativa) return false;
    if (t.bloqueia_acionamento && !podeVerTudo) return false;
    return true;
  });

  const atual = String(codigoAtual || "").trim().toUpperCase();
  if (atual && !lista.some((t) => String(t.codigo).toUpperCase() === atual)) {
    const conhecida = acharTabulacao(catalogo, atual);
    lista.unshift(
      conhecida
        ? { ...conhecida, rotulo: `${conhecida.rotulo} (inativa)` }
        : { codigo: atual, rotulo: `${rotuloTabulacao(catalogo, atual)} (fora do catálogo)`, ordem: -1, grupo: "CONTATO" }
    );
  }
  return lista;
}

// Rótulo visível. Se o código não estiver no catálogo (status legado tipo
// "Novo caso", "Em cobrança", ou uma tabulação que já foi removida antes deste
// catálogo existir), devolve uma versão legível em vez de quebrar.
export function rotuloTabulacao(catalogo, codigo) {
  if (!codigo) return "-";
  const t = acharTabulacao(catalogo, codigo);
  if (t) return t.rotulo;
  const cru = String(codigo).trim();
  if (!/^[A-Z0-9_]+$/.test(cru)) return cru; // já é texto livre legível
  return cru.charAt(0) + cru.slice(1).toLowerCase().replace(/_/g, " ");
}

export function proximaAcaoDeTabulacao(catalogo, codigo) {
  return acharTabulacao(catalogo, codigo)?.proxima_acao || "CONTATAR";
}

export function blocoDaTabulacao(catalogo, codigo) {
  return acharTabulacao(catalogo, codigo)?.bloco_ficha || null;
}

export function exigeProcesso(catalogo, codigo) {
  return Boolean(acharTabulacao(catalogo, codigo)?.exige_processo);
}

export function bloqueiaAcionamento(catalogo, codigo) {
  return Boolean(acharTabulacao(catalogo, codigo)?.bloqueia_acionamento);
}

function adicionarDiasUteisData(base, n) {
  const d = new Date(base);
  let add = 0;
  while (add < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) add += 1;
  }
  return d;
}

// Data "YYYY-MM-DD" sugerida quando o operador tabula SEM digitar data.
// Devolve null quando a tabulação não agenda sozinha (modo NENHUM ou MANUAL) --
// nesses casos nada é gravado em data_retorno, exatamente como antes.
//
// Só é chamada no ato de tabular. Nunca reprocessa agendamento antigo: se o
// prazo desta tabulação mudar amanhã, quem já está agendado não se mexe.
export function retornoAutomaticoDeTabulacao(catalogo, codigo, hoje = new Date()) {
  const t = acharTabulacao(catalogo, codigo);
  if (!t || t.retorno_modo !== "DIAS_UTEIS") return null;
  const dias = Number(t.retorno_dias_uteis);
  if (!Number.isFinite(dias) || dias < 0) return null;

  const base = new Date(hoje);
  base.setHours(0, 0, 0, 0);
  const d = dias === 0 ? base : adicionarDiasUteisData(base, dias);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// true quando a tabulação espera que o operador escolha a data na mão.
export function retornoEhManual(catalogo, codigo) {
  return acharTabulacao(catalogo, codigo)?.retorno_modo === "MANUAL";
}
