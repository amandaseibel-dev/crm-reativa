// Fila "sem interação" pela CARTEIRA do ReATIVA.
//
// Quem entra: os casos da carteira que o operador JÁ PODE VER pelas permissões
// internas do ReATIVA (casos.operador_email, carteira e responsabilidade). O
// vínculo ULBRA alta_cpf NÃO é exigido aqui: ele só serve para associar e
// acessar dados da Mensageria. Esta função não chama a ULBRA.
//
// Regras (as mesmas de carteiraFila.seloPrazo):
//   até 7 dias sem acionamento ........ dentro do prazo (fora da fila)
//   8 dias ............................ ATENCAO
//   9 e 10 dias ....................... CRITICO
//   11 dias ou mais ................... PERDENDO
// Caso sem data de acionamento não entra aqui: é "Novo", outra fila.
import { diasSemContato } from "./carteiraFila";

export const PRAZO_DIAS = 7;

export function faixaDeDias(dias) {
  if (dias <= PRAZO_DIAS) return null;
  if (dias === 8) return "ATENCAO";
  if (dias <= 10) return "CRITICO";
  return "PERDENDO";
}

/**
 * @param {Array<{aluno_id:string, nome?:string, data_ultimo_acionamento?:string|null}>} carteira
 *   casos que o operador já pode ver, pelas permissões do ReATIVA.
 * @param {number} agoraMs
 * @returns {Array<{aluno_id, nome, dias, faixa}>} ordenada: mais dias primeiro, depois aluno_id.
 */
export function filaSemInteracaoCarteira(carteira, agoraMs) {
  const linhas = [];
  const vistos = new Set();
  for (const c of carteira || []) {
    if (!c?.aluno_id || vistos.has(c.aluno_id)) continue; // um caso por aluno
    vistos.add(c.aluno_id);
    const dias = diasSemContato(c, agoraMs);
    if (dias === null) continue; // sem acionamento registrado: não é "sem interação"
    const faixa = faixaDeDias(dias);
    if (!faixa) continue; // dentro do prazo
    linhas.push({ aluno_id: c.aluno_id, nome: c.nome || c.nome_aluno || "Aluno sem nome", dias, faixa });
  }
  return linhas.sort((a, b) => b.dias - a.dias || (a.aluno_id < b.aluno_id ? -1 : a.aluno_id > b.aluno_id ? 1 : 0));
}
