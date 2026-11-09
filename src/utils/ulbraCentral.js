// ===========================================================================
// CENTRAL ULBRA — regras da tela, sem React e sem rede.
//
// A fila vem pronta e RECORTADA do banco (`ulbra_central_operador`): quem não é
// gestão recebe só o próprio universo, decidido lá. Aqui ficam só rótulos,
// filtros de URL, junção de páginas e o que a tela precisa lembrar para o
// operador voltar da ficha no mesmo ponto.
// ===========================================================================
import { podeVerCrmUlbra } from "./ulbraPainel";

// Enquanto a consulta do banco não for aplicada e a gestão não liberar, a
// Central aparece SÓ para a gestão. Liberar operador é decisão dela: muda-se
// esta linha, numa PR própria, depois da migration aplicada.
export const CENTRAL_ULBRA_LIBERADA_OPERADORES = false;

export function podeVerCentralUlbra(email, liberada = CENTRAL_ULBRA_LIBERADA_OPERADORES) {
  const e = String(email || "").toLowerCase().trim();
  if (!e) return false;
  return podeVerCrmUlbra(e) || liberada === true;
}

export const LIMITE_PAGINA = 100;

export function fmtDataHora(iso) {
  if (!iso) return "sem registro";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "sem registro";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Data pura (`casos.data_ultimo_acionamento` é date): sem fuso, sem hora. */
export function fmtData(data) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(data || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "nunca";
}

export function fmtEspera(min) {
  const n = Number(min);
  if (min === null || min === undefined || !Number.isFinite(n)) return "tempo não disponível";
  const m = Math.max(0, Math.round(n));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

/** Rótulo de responsabilidade, sem nome alheio: 'a definir' nunca vira um operador. */
export function rotuloResponsabilidade(item) {
  if (item?.responsabilidade === "A_DEFINIR") return "Responsabilidade a definir pela gestão";
  if (item?.minha) return "responsabilidade sua";
  if (item?.responsavel_e_outro) return "responsável: outro operador";
  return null;
}

/** Só o responsável comprovado recebe aviso individual. */
export function deveNotificar(item) {
  return item?.notificar === true && item?.responsabilidade !== "A_DEFINIR";
}

export function nomeCurto(email) {
  const e = String(email || "").trim();
  return e ? e.split("@")[0] : null;
}

/**
 * Estado da coleta em palavras. MANUAL não é alerta: sem sincronização
 * automática, atraso é informação. ATRASADA só existe com coleta automática.
 * FALHA é do último ciclo. Coleta incompleta ou pulada vai SEMPRE em `detalhe`.
 */
export function descreverColeta(coleta) {
  const c = coleta || {};
  const quando = fmtDataHora(c.ultima_execucao);
  const ha = c.atraso_min === null || c.atraso_min === undefined ? "" : ` (há ${fmtEspera(c.atraso_min)})`;
  let detalhe = null;
  if (c.ultimo_ciclo === "INCOMPLETO") {
    detalhe = `A última coleta ficou incompleta${c.ultimo_erro ? ` (${c.ultimo_erro})` : ""}: pode faltar conversa ou atendimento nesta lista.`;
  } else if (c.ultimo_ciclo === "PULADO_ORCAMENTO") {
    detalhe = "O último ciclo foi pulado por falta de orçamento de chamadas: nada novo foi lido, os dados são do ciclo anterior.";
  }
  switch (c.estado) {
    case "SEM_CICLO":
      return { tom: "cinza", titulo: "Nenhuma coleta feita ainda", texto: "A lista só passa a ter dados depois da primeira coleta da Mensageria.", detalhe };
    case "FALHA":
      return { tom: "vermelho", titulo: "Falha na última coleta", texto: `${c.ultimo_erro ? `${c.ultimo_erro} · ` : ""}tentativa em ${quando}${ha}. O que aparece aqui pode estar incompleto.`, detalhe };
    case "ATRASADA":
      return { tom: "ambar", titulo: "Coleta automática atrasada", texto: `Última coleta em ${quando}${ha}. Pode haver resposta de aluno que ainda não apareceu: confira a Mensageria antes de concluir que não há nada.`, detalhe };
    case "EM_DIA":
      return { tom: detalhe ? "ambar" : "verde", titulo: "Coleta automática em dia", texto: `Última coleta em ${quando}${ha}.`, detalhe };
    case "MANUAL":
      return { tom: detalhe ? "ambar" : "cinza", titulo: "Atualização manual", texto: `Última coleta em ${quando}${ha}. Não há sincronização automática ativa: os dados mudam só quando a gestão dispara uma coleta.`, detalhe };
    default:
      return { tom: "cinza", titulo: "Estado da coleta não disponível", texto: `Última coleta em ${quando}${ha}.`, detalhe };
  }
}

export const FAIXAS = {
  PERDENDO: { rotulo: "perdendo o caso", tom: "vermelho" },
  CRITICO: { rotulo: "crítico", tom: "laranja" },
  ATENCAO: { rotulo: "atenção", tom: "ambar" },
  NOVO: { rotulo: "nunca acionado", tom: "azul" },
};
export const ORDEM_FAIXAS = ["PERDENDO", "CRITICO", "ATENCAO", "NOVO"];

export const DESTINO = {
  CARTEIRA: "novo — aluno da carteira",
  RODIZIO: "novo — rodízio do receptivo",
};

// ------------------------------------------------------------------ filtros
// Vivem na URL: abrir a ficha e voltar devolve a mesma lista.
export function lerFiltros(search) {
  const p = new URLSearchParams(search || "");
  const faixa = String(p.get("faixa") || "").toUpperCase();
  return {
    operador: String(p.get("operador") || "").toLowerCase().trim(),
    faixa: ORDEM_FAIXAS.includes(faixa) ? faixa : "",
  };
}

export function paraBusca(filtros) {
  const p = new URLSearchParams();
  if (filtros?.operador) p.set("operador", filtros.operador);
  if (filtros?.faixa) p.set("faixa", filtros.faixa);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Só a faixa é filtrada na tela; o operador é filtrado NO BANCO. */
export function filtrarSemInteracao(linhas, faixa) {
  const l = Array.isArray(linhas) ? linhas : [];
  return faixa ? l.filter((x) => x.faixa === faixa) : l;
}

// ------------------------------------------------------------------ páginas
const CHAVES = { respostas: "conversa_id", sem_interacao: "aluno_id", novos: "atendimento_id" };

/** Junta páginas sem repetir linha (a ordem é a do banco, que tem desempate). */
export function juntarPaginas(paginas) {
  const saida = { respostas: [], sem_interacao: [], novos: [] };
  for (const [lista, chave] of Object.entries(CHAVES)) {
    const vistos = new Set();
    for (const pg of paginas || []) {
      for (const linha of pg?.[lista] || []) {
        const id = linha?.[chave];
        if (id === undefined || id === null || vistos.has(id)) continue;
        vistos.add(id);
        saida[lista].push(linha);
      }
    }
  }
  return saida;
}

/** Há linha no banco que a tela ainda não carregou? */
export function haMais(totais, listas) {
  const t = totais || {};
  return ["respostas", "sem_interacao", "novos"].some(
    (k) => Number(t[k] || 0) > (listas?.[k]?.length || 0),
  );
}

// --------------------------------------------------- posição ao voltar da ficha
const CHAVE_POSICAO = "rv_central_ulbra_posicao";

export function salvarPosicao({ busca, rolagem, paginas }) {
  try {
    sessionStorage.setItem(CHAVE_POSICAO, JSON.stringify({ busca: busca || "", rolagem: Number(rolagem) || 0, paginas: Number(paginas) || 1 }));
  } catch {
    // armazenamento indisponível: volta ao topo, com os filtros da URL
  }
}

/** Só vale para a MESMA combinação de filtros; lida uma vez e apagada. */
export function tomarPosicao(busca) {
  try {
    const raw = sessionStorage.getItem(CHAVE_POSICAO);
    if (!raw) return null;
    sessionStorage.removeItem(CHAVE_POSICAO);
    const p = JSON.parse(raw);
    if ((p?.busca || "") !== (busca || "")) return null;
    return { rolagem: Math.max(0, Number(p.rolagem) || 0), paginas: Math.min(20, Math.max(1, Number(p.paginas) || 1)) };
  } catch {
    return null;
  }
}

export function hrefFicha(alunoId) {
  return `/aluno?alunoId=${encodeURIComponent(alunoId)}&origem=ulbra`;
}
