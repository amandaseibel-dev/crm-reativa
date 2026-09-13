// DONO DO ACORDO -- a regra, num lugar so.
//
// Bug operacional de 12/09/2026: operadora via acordo que nao e dela, e o
// acordo que e dela, de aluno cuja ficha esta com outra pessoa, nao aparecia em
// lugar nenhum. A causa era backend (tres RPCs decidiam o dono do ACORDO pelo
// responsavel da FICHA), mas a tela ajudava a confundir: quando o acordo nao
// tinha responsavel, ela nao dizia nada e a operadora lia o responsavel da
// ficha, logo acima, como se fosse o dono do acordo.
//
// Regra definitiva:
//
//   acordos.operador_responsavel_email  -> de quem e o ACORDO
//   alunos.responsavel_atual_email      -> de quem e a FICHA/MENSALIDADE
//
// Nenhum herda do outro. Acordo com responsavel vazio e SEM RESPONSAVEL: nao e
// de ninguem, e isso precisa aparecer escrito.

// E-mail de dono normalizado, ou null quando nao ha dono. O mesmo
// `lower(nullif(trim(...), ''))` que as RPCs usam.
export function donoDoAcordo(acordo) {
  const e = String(acordo?.operador_responsavel_email || "").trim().toLowerCase();
  return e || null;
}

// Acumula, para um aluno, de quem sao os acordos dele.
//   { donos: Set<email>, semResponsavel: boolean }
export function acumularDonos(alvo, acordo) {
  const destino = alvo || { donos: new Set(), semResponsavel: false };
  const dono = donoDoAcordo(acordo);
  if (dono) destino.donos.add(dono);
  else destino.semResponsavel = true;
  return destino;
}

// Rotulo de quem e o ACORDO, para a linha da carteira. null = nada a dizer
// (nao ha acordo, ou o acordo e de quem tem a ficha). "sem responsavel" e dito
// em voz alta de proposito.
export function rotuloDonosDoAcordo(fa, nomeDaFicha, nomePorEmail = (e) => e) {
  if (!fa) return null;
  const donos = [...(fa.acordoDonos || [])].map((e) => nomePorEmail(e));
  if (fa.acordoSemResponsavel) donos.push("sem responsável");
  if (!donos.length) return null;
  if (donos.length === 1 && donos[0] === nomeDaFicha) return null;
  return donos.join(", ");
}

// VOCABULARIO UNICO do estado "3 ou mais parcelas vencidas".
//
// O nome tecnico e QUEBRADO -- e o valor que `carteira_acordos_detalhe` exige
// em `p_estado`. O resumo `carteira_acordos_por_operador` nascia com a chave
// `a_renegociar` para o MESMO estado, e a tela falava as duas linguas: mandava
// "QUEBRADO" no drill e lia "a_renegociar" no numero. Batia por sorte (a RPC
// normaliza RENEGOCIAR -> QUEBRADO), mas era uma incompatibilidade esperando
// para aparecer. O resumo passa a emitir `quebrados`; estes leitores aceitam o
// apelido antigo para a tela nao quebrar entre o deploy do front e a aplicacao
// da migration. O rotulo para a operacao continua "Quebrado".
export const ESTADO_QUEBRADO = "QUEBRADO";

export function qtdQuebrados(o) {
  return Number(o?.quebrados ?? o?.a_renegociar ?? 0);
}

export function vencidoQuebrado(o) {
  return Number(o?.vencido_quebrado ?? o?.vencido_renegociar ?? 0);
}
