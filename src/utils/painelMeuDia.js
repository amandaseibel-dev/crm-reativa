// Visao "Meu dia" da tela inicial do operador (PainelCarteira): os retornos
// agendados para hoje e os boletos de acordo proximos do vencimento.
// Funcoes PURAS -- nada aqui le nem grava no banco; o chamador passa o que ja
// carregou para a carteira.
//
// Recorte decidido pela gestao em 15/10/2026, com as contagens medidas na base
// no mesmo dia:
//
//  * RETORNO = so o que o OPERADOR agendou (`retorno_origem` comecando em
//    "OPERADOR"). No dia da medicao eram 157 agendados a mao contra 6.051
//    vindos do prazo automatico da tabulacao -- num operador so, 8 contra 405.
//    Misturar os dois devolve centenas de linhas e a visao do dia deixa de ser
//    visao (e o que o painel Agenda faz hoje). O automatico entra como
//    CONTADOR, que abre a fila filtrada por `retornosHoje`.
//    A tela abre em HOJE e tem a semana (hoje + JANELA_RETORNOS_DIAS) atras de
//    um toque, agrupada por dia -- pedido da gestao em 15/10/2026, junto com
//    "nao quero deixar a pagina poluida".
//
//  * BOLETO PROXIMO = parcela VIVA de acordo ATIVO com vencimento entre hoje e
//    hoje + JANELA_BOLETOS_DIAS. Na janela de 5 dias eram 184 parcelas, ~18 por
//    operador. Mensalidade a vencer ficou fora de proposito: quem cobra
//    mensalidade antes do vencimento e a tela Preventivo.
//
// O alerta D-2 (`acordo_alertas_parcela`, cron 56) NAO e a fonte desta lista --
// ele cobre so o segundo dia anterior ao vencimento (20 linhas pendentes na
// medicao). Aqui ele entra como MARCA (`tem_alerta`) na parcela que ja tem
// alerta aberto, para o operador saber que aquele caso tambem esta na rotina.
import { diasParaData, nomeAluno } from "./carteiraFila";
import { ordenarAlertas } from "./alertasParcela";
// `parcela ainda cobravel` tem dono: src/utils/parcelaStatus.js, que espelha
// public.parcela_viva(). Este arquivo nao reescreve a regra -- so a usa.
import { parcelaViva } from "./parcelaStatus";

// Janela do bloco de boletos, em dias corridos a partir de hoje (inclusive).
export const JANELA_BOLETOS_DIAS = 5;

// Visao semanal dos retornos: hoje + 6 = a semana a frente, inclusive hoje.
export const JANELA_RETORNOS_DIAS = 6;

// Retornos que o operador marcou, de hoje ate hoje + `dias` (0 = so hoje).
// Confirmados continuam na lista, marcados, para o operador ver o que ja tratou
// -- quem conta pendencia usa `retornosPendentes`.
export function retornosAgendados(casos, hoje, dias = 0) {
  const inicio = String(hoje || "").slice(0, 10);
  if (!inicio) return [];
  const limite = Number.isFinite(Number(dias)) ? Number(dias) : 0;
  return (Array.isArray(casos) ? casos : [])
    .filter((a) => {
      if (!a || !a.data_retorno) return false;
      if (!String(a.retorno_origem || "").startsWith("OPERADOR")) return false;
      const distancia = diasParaData(inicio, a.data_retorno);
      return distancia !== null && distancia >= 0 && distancia <= limite;
    })
    .map((a) => ({
      id: a.id,
      aluno_id: a.id,
      nome: nomeAluno(a),
      telefone: a.telefone || "",
      data: String(a.data_retorno).slice(0, 10),
      hora_retorno: a.hora_retorno ? String(a.hora_retorno).slice(0, 5) : "",
      prioritario: Boolean(a.retorno_prioritario),
      valor_em_aberto: Number(a.valor_em_aberto || 0),
      responsavel_email: a.responsavel_atual_email || "",
      tratado: Boolean(a.retorno_confirmado_em),
    }))
    .sort(
      (x, y) =>
        String(x.data).localeCompare(String(y.data)) ||
        // Dentro do dia, o que o operador marcou como prioritario vem primeiro;
        // depois a hora combinada. A ordem ENTRE dias nunca muda: prioridade
        // nao faz o retorno de quinta aparecer antes do de hoje.
        Number(Boolean(y.prioritario)) - Number(Boolean(x.prioritario)) ||
        String(x.hora_retorno || "99:99").localeCompare(String(y.hora_retorno || "99:99")) ||
        String(x.nome || "").localeCompare(String(y.nome || ""), "pt-BR")
    );
}

// So os de hoje, dentro de uma lista que pode ser da semana inteira.
export function retornosDoDia(retornos, hoje) {
  const dia = String(hoje || "").slice(0, 10);
  return (Array.isArray(retornos) ? retornos : []).filter((r) => r && r.data === dia);
}

const DIA_DA_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

// "Hoje", "Amanhã" ou "qui 17/10" -- sem depender do locale da maquina, que no
// CI (UTC, en-US) devolveria outro texto e quebraria o teste.
export function rotuloDoDia(iso, hoje) {
  const dia = String(iso || "").slice(0, 10);
  const distancia = diasParaData(String(hoje || "").slice(0, 10), dia);
  if (distancia === 0) return "Hoje";
  if (distancia === 1) return "Amanhã";
  const d = new Date(`${dia}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dia;
  const diaMes = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  return `${DIA_DA_SEMANA[d.getDay()]} ${diaMes}`;
}

// Visao semanal: um grupo por dia que tem retorno (dia sem nada nao vira linha
// vazia na tela), na ordem do calendario.
export function agruparRetornosPorDia(retornos, hoje) {
  const grupos = new Map();
  for (const r of Array.isArray(retornos) ? retornos : []) {
    if (!r || !r.data) continue;
    if (!grupos.has(r.data)) grupos.set(r.data, []);
    grupos.get(r.data).push(r);
  }
  return [...grupos.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([data, itens]) => ({
      data,
      rotulo: rotuloDoDia(data, hoje),
      itens,
      pendentes: retornosPendentes(itens).length,
    }));
}

export function retornosPendentes(retornos) {
  return (Array.isArray(retornos) ? retornos : []).filter((r) => r && !r.tratado);
}

// Quantos retornos de hoje vieram do prazo automatico da tabulacao, e nao de
// um compromisso do operador. `totalRetornosHoje` e a contagem escopada que a
// carteira ja faz (kpis.retornosHoje, acionaveis com data_retorno = hoje);
// `agendados` sao os desta visao. Nunca negativo: se a contagem chegar menor
// que a lista (teto de paginacao), o numero vira 0 em vez de mentir.
export function contarRetornoAutomaticoHoje(totalRetornosHoje, agendados) {
  const total = Number(totalRetornosHoje);
  if (!Number.isFinite(total)) return 0;
  const manuais = Array.isArray(agendados) ? agendados.length : 0;
  return Math.max(0, Math.round(total) - manuais);
}

// Boletos de acordo a vencer na janela, a partir das parcelas que a carteira ja
// carregou. `acordoById` e `alunoById` sao Maps montados pelo chamador;
// `alertasPorParcela` e o Set de parcela_id com alerta D-2 aberto (opcional).
// Devolve uma linha por parcela, na mesma forma do alerta D-2, para reusar os
// rotulos de src/utils/alertasParcela.js.
export function boletosProximosDoVencimento(
  parcelas,
  { acordoById, alunoById, hoje, dias = JANELA_BOLETOS_DIAS, alertasPorParcela } = {}
) {
  const dia = String(hoje || "").slice(0, 10);
  if (!dia || !acordoById) return [];
  const limite = Number.isFinite(Number(dias)) ? Number(dias) : JANELA_BOLETOS_DIAS;
  const linhas = [];

  for (const p of Array.isArray(parcelas) ? parcelas : []) {
    if (!p || !p.vencimento) continue;
    if (!parcelaViva(p.status)) continue;
    const acordo = acordoById.get ? acordoById.get(p.acordo_id) : acordoById[p.acordo_id];
    // Acordo nao ATIVO nao gera cobranca de parcela: cancelado, quitado e
    // re-acordado saem daqui (a parcela do re-acordo entra pelo acordo novo).
    if (!acordo || acordo.status !== "ATIVO" || !acordo.aluno_id) continue;
    const restantes = diasParaData(dia, p.vencimento);
    if (restantes === null || restantes < 0 || restantes > limite) continue;
    const aluno = (alunoById && (alunoById.get ? alunoById.get(String(acordo.aluno_id)) : alunoById[String(acordo.aluno_id)])) || null;
    const nome = aluno ? nomeAluno(aluno) : "";
    linhas.push({
      aluno_id: String(acordo.aluno_id),
      aluno_nome: nome && nome !== "Aluno sem nome" ? nome : aluno?.nome || "Aluno",
      acordo_id: p.acordo_id,
      numero_acordo: acordo.numero_acordo ?? null,
      parcela_id: p.id,
      numero_parcela: p.numero ?? null,
      valor: Number(p.valor || 0),
      vencimento: String(p.vencimento).slice(0, 10),
      dias_restantes: restantes,
      // Numero do boleto so quando a importacao marcou como confiavel: boleto
      // errado na mao do operador faz o aluno pagar o titulo de outra pessoa.
      boleto: p.boleto_confiavel === false ? "" : p.boleto || "",
      responsavel_email: acordo.operador_responsavel_email || "",
      tem_alerta: Boolean(alertasPorParcela && p.id && alertasPorParcela.has(String(p.id))),
    });
  }

  return ordenarAlertas(linhas);
}

// Soma dos boletos da janela (o que entra se todo mundo pagar no prazo).
export function somaBoletos(boletos) {
  return (Array.isArray(boletos) ? boletos : []).reduce((s, b) => s + Number(b?.valor || 0), 0);
}

// Ultimo dia da janela, em ISO -- para o texto "ate dd/mm" do cabecalho.
export function fimDaJanela(hoje, dias = JANELA_BOLETOS_DIAS) {
  const dia = String(hoje || "").slice(0, 10);
  const d = new Date(`${dia}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + (Number.isFinite(Number(dias)) ? Number(dias) : JANELA_BOLETOS_DIAS));
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const diaFim = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${diaFim}`;
}
